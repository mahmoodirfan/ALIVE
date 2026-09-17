/**
 * Transactional commit machinery, virtual clock and dispatch (ARCHITECTURE §3.1, §5, §6).
 * Phase 3 scope: deterministic kernel, time navigation/replay, observables and counterfactual comparison.
 */
import { applyPatches, current, enablePatches, freeze, produceWithPatches, setAutoFreeze, type Draft, type Objectish, type Patch } from 'immer';
import { AliveError } from './errors.js';
import { assertJsonSafe, canonicalJson, snapshotJson, type JsonValue } from './json.js';
import { createRandomApi, RNG_ALGORITHM, RNG_VERSION } from './rng.js';
import {
  ROOT_BRANCH_ID,
  anchorKey,
  commitIdForIntervention,
  commitIdForScheduled,
  deriveBranchId,
  deriveCommandId,
  eventIdChild,
  eventIdFromCommand,
  scheduledIdBootstrap,
  scheduledIdExogenous,
  scheduledIdHandler,
  type Discriminator,
} from './identity.js';
import { Frontier, sortsStrictlyAfter, type FrontierEntry, type FrontierSnapshot } from './frontier.js';
import { isSafeMillis, isScheduledPriority, validateLimits, validateScenario } from './validate.js';
import {
  DEFAULT_LIMITS,
  PRIORITY,
  type AliveEvent,
  type Branch,
  type BranchId,
  type CommandId,
  type CompareOptions,
  type ComparisonReport,
  type CommitId,
  type CommitNotification,
  type CommitRecord,
  type CommitSource,
  type CreateSimulationOptions,
  type DispatchResult,
  type ExportOptions,
  type ForkOptions,
  type EmitSpec,
  type EventId,
  type EventFinding,
  type EventObservable,
  type HandlerContext,
  type InstantGuard,
  type InterventionItem,
  type Millis,
  type NumericStateFinding,
  type NumericStateObservable,
  type Occurrence,
  type RunResult,
  type ReplayBranch,
  type ReplayFile,
  type ReplayIntervention,
  type RunState,
  type SafetyLimits,
  type StateFinding,
  type StateObservable,
  type Scenario,
  type ScheduleSpec,
  type ScheduledId,
  type ScheduledItem,
  type SerializableCommand,
  type StepResult,
  type TextStateFinding,
  type TimelineChangeNotification,
  type TimelineCursor,
  type TimelineCursorInput,
  type Unsubscribe,
  type ViewMode,
} from './types.js';

enablePatches();
setAutoFreeze(true);

export const SEMANTICS_VERSION = 1;
export const ENGINE_VERSION = '0.3.0';
export const REPLAY_FORMAT_VERSION = 1 as const;

interface StagedAdd {
  entry: FrontierEntry;
  scheduledId: ScheduledId;
}

interface Transaction {
  scratchSequence: number;
  /** Frontier uid allocations are transaction-local until publish (item 4). */
  scratchUid: number;
  adds: StagedAdd[];
  cancels: number[];
  events: AliveEvent[];
  newEventIds: Set<EventId>;
  newScheduledIds: Set<ScheduledId>;
  exoStreamId?: string;
  exoOrdinal?: number;
  exoExhausted?: boolean;
}

/** What an exogenous stream produced, before any scheduler identity is assigned. */
interface ExogenousMaterialization {
  scheduledId: ScheduledId;
  virtualTime: Millis;
  type: string;
  payload: JsonValue;
  actorId?: string;
  key?: string;
  streamId: string;
  ordinal: number;
}

/** Diagnostics for a commit that rolled back (item 2). */
export interface FaultInfo {
  sourceKind: 'scheduled' | 'intervention';
  sourceId: string;
  attemptedVirtualTime: Millis;
  originalError: unknown;
}

/** A `committed`/`timeline:changed` listener threw. Never faults the simulation (item 12). */
export interface ListenerError {
  channel: 'committed' | 'timeline:changed';
  error: unknown;
  commitId?: CommitId;
}

interface CommitOutcome {
  commitId: CommitId;
  events: readonly AliveEvent[];
}

function discOf(s: {
  key?: string | undefined;
  slot?: string | undefined;
  entityId?: string | undefined;
  actorId?: string | undefined;
}): Discriminator {
  return { key: s.key, slot: s.slot, entityId: s.entityId, actorId: s.actorId };
}

function subjectOf(e: AliveEvent): string {
  return e.actorId ?? e.entityId ?? 'scenario';
}

function assign<T extends object>(base: T, extra: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) out[k] = v;
  return out as T;
}

function assertRuntimeMillis(value: number, label: string): void {
  if (!isSafeMillis(value)) {
    throw new AliveError(
      'ALIVE_INVALID_TIME',
      `${label} must be a non-negative safe-integer millisecond value`,
      { label, value },
    );
  }
}

function assertRuntimePriority(value: number, label: string): void {
  if (!isScheduledPriority(value)) {
    throw new AliveError(
      'ALIVE_INVALID_PRIORITY',
      `${label} must be a safe integer >= 1; priority 0 is reserved for interventions`,
      { label, value },
    );
  }
}

function incrementSafeCounter(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) {
    throw new AliveError('ALIVE_COUNTER_OVERFLOW', `${label} cannot be incremented safely`, {
      label,
      value,
    });
  }
  return value + 1;
}

function frozenScheduledEntry(uid: number, item: ScheduledItem): FrontierEntry {
  const frozenItem = freeze(item, true);
  const source = freeze({ kind: 'scheduled' as const, item: frozenItem }, true);
  return freeze({ uid, source }, true);
}

/**
 * Detaches the scenario's mutable registry/array structure from caller-owned objects.
 * Function identities are intentionally retained; ALIVE cannot and should not clone
 * executable code, but callers cannot swap handlers/rules/streams after construction.
 */
function snapshotScenario<W>(scenario: Scenario<W>): Scenario<W> {
  const events = Object.freeze({ ...scenario.events });
  const commands = Object.freeze({ ...scenario.commands });
  const rules = scenario.rules
    ? Object.freeze(
        scenario.rules.map((rule) =>
          Object.freeze({
            ...rule,
            when: Array.isArray(rule.when) ? Object.freeze([...rule.when]) : rule.when,
          }),
        ),
      )
    : undefined;
  const exogenous = scenario.exogenous
    ? Object.freeze(scenario.exogenous.map((stream) => Object.freeze({ ...stream })))
    : undefined;
  const bootstrap = scenario.bootstrap
    ? Object.freeze(scenario.bootstrap.map((item) => Object.freeze({ ...item })))
    : undefined;
  const stateObservables = scenario.stateObservables
    ? Object.freeze(
        Object.fromEntries(
          Object.entries(scenario.stateObservables).map(([key, observable]) => [
            key,
            Object.freeze({ ...observable }),
          ]),
        ),
      )
    : undefined;
  const eventObservables = scenario.eventObservables
    ? Object.freeze(
        Object.fromEntries(
          Object.entries(scenario.eventObservables).map(([key, observable]) => [
            key,
            Object.freeze({ ...observable }),
          ]),
        ),
      )
    : undefined;
  return Object.freeze({
    ...scenario,
    events,
    commands,
    rules,
    exogenous,
    bootstrap,
    stateObservables,
    eventObservables,
  });
}

function frozenDiagnosticError(error: unknown): unknown {
  if (error instanceof Error) {
    const copy = new Error(error.message);
    copy.name = error.name;
    if (error.stack !== undefined) copy.stack = error.stack;
    return Object.freeze(copy);
  }
  if (error !== null && typeof error === 'object') {
    return Object.freeze({ description: String(error) });
  }
  return error;
}

interface ResolvedCursor {
  readonly cursor: TimelineCursor;
  /** Number of commits applied at this boundary. */
  readonly commitCount: number;
}

interface RuntimeSnapshot<W> {
  readonly branchId: BranchId;
  readonly world: W;
  readonly headTime: Millis;
  readonly nextSequence: number;
  readonly runState: RunState;
  readonly fault?: FaultInfo;
  readonly lastCommitId: CommitId | null;
  readonly frontier: FrontierSnapshot;
  readonly commitLog: readonly CommitRecord[];
  readonly eventIds: readonly EventId[];
  readonly exogenousCursors: Readonly<Record<string, number>>;
  readonly exhaustedStreams: readonly string[];
  readonly anchorOrdinals: readonly (readonly [string, number])[];
  readonly instantGuard: InstantGuard;
}

interface InternalCheckpoint<W> {
  readonly commitCount: number;
  readonly cursor: TimelineCursor;
  readonly snapshot: RuntimeSnapshot<W>;
}

interface BranchNode<W> {
  info: Branch;
  interventions: ReplayIntervention[];
  checkpoints: InternalCheckpoint<W>[];
  headSnapshot: RuntimeSnapshot<W>;
  /** Number of commits inherited from the parent at the fork boundary. */
  forkCommitCount: number;
  forkOrdinals: Map<string, number>;
}

export class Simulation<W> {
  private readonly scenario: Scenario<W>;
  private readonly seed: string;
  private readonly limits: SafetyLimits;

  private activeBranchId: BranchId = ROOT_BRANCH_ID;
  private world: W;
  private headTime: Millis = 0;
  private nextSequence = 0;
  private runState: RunState = 'ready';
  private viewMode: ViewMode = 'live';
  private fault: FaultInfo | undefined = undefined;
  private lastCommitId: CommitId | null = null;
  private viewWorld: W | null = null;
  private scrubCursor: TimelineCursor | null = null;

  private frontier = new Frontier();
  private commitLog: CommitRecord[] = [];
  private eventIds = new Set<EventId>();
  private exogenousCursors: Record<string, number> = {};
  private exhaustedStreams = new Set<string>();
  private anchorOrdinals = new Map<string, number>();
  private instantGuard: InstantGuard = { at: null, count: 0 };

  private readonly checkpointEvery: number;
  private readonly branches = new Map<BranchId, BranchNode<W>>();
  private replaying = false;

  private readonly commitListeners: ((n: CommitNotification) => void)[] = [];
  private readonly timelineListeners: ((n: TimelineChangeNotification) => void)[] = [];
  private readonly errorListeners: ((e: ListenerError) => void)[] = [];
  private pendingNotifications: CommitNotification[] = [];
  private readonly listenerErrors: ListenerError[] = [];

  constructor(options: CreateSimulationOptions<W>) {
    this.seed = options.seed;
    this.limits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) };
    this.checkpointEvery = options.checkpointEvery ?? 0;
    if (!Number.isSafeInteger(this.checkpointEvery) || this.checkpointEvery < 0) {
      throw new AliveError('ALIVE_INVALID_SCENARIO', 'checkpointEvery must be a non-negative safe integer', {
        checkpointEvery: this.checkpointEvery,
      });
    }
    // Fail fast on a malformed scenario, then detach mutable registry/array structure
    // before any work is seeded.
    validateLimits(this.limits);
    validateScenario(options.scenario);
    this.scenario = snapshotScenario(options.scenario);

    const initRandom = createRandomApi({
      seed: this.seed,
      subject: 'scenario',
      cause: 'init',
    });
    const initial = this.scenario.initialState({ epoch: this.scenario.epoch, random: initRandom });
    // Scenario initialisation is always validated — a bad initial world can never be
    // recovered from and must not reach the first commit (item 6).
    // Detach the canonical world from caller-owned references and freeze it before the
    // first commit. Every later Immer result is auto-frozen as well.
    this.world = snapshotJson(initial, 'initialState');

    this.seedBootstrap();
    this.seedExogenous();

    const rootCursor = this.liveCursor();
    const rootInfo: Branch = Object.freeze({
      id: ROOT_BRANCH_ID,
      name: 'Baseline',
      createdBy: Object.freeze({ type: 'system' as const, description: 'root branch' }),
      createdAt: 0,
      ranTo: 0,
      head: rootCursor,
    });
    const rootSnapshot = this.captureRuntime();
    this.branches.set(ROOT_BRANCH_ID, {
      info: rootInfo,
      interventions: [],
      checkpoints: [Object.freeze({ commitCount: 0, cursor: rootCursor, snapshot: rootSnapshot })],
      headSnapshot: rootSnapshot,
      forkCommitCount: 0,
      forkOrdinals: new Map(),
    });
  }

  // ---------------------------------------------------------------- timeline/runtime snapshots

  private liveCursor(branchId: BranchId = this.activeBranchId): TimelineCursor {
    return Object.freeze({
      virtualTime: this.headTime,
      afterCommitId: this.lastCommitId,
      branchId,
    });
  }

  private captureRuntime(): RuntimeSnapshot<W> {
    return Object.freeze({
      branchId: this.activeBranchId,
      world: this.world,
      headTime: this.headTime,
      nextSequence: this.nextSequence,
      runState: this.runState,
      ...(this.fault === undefined ? {} : { fault: this.fault }),
      lastCommitId: this.lastCommitId,
      frontier: this.frontier.snapshot(),
      commitLog: Object.freeze([...this.commitLog]),
      eventIds: Object.freeze([...this.eventIds]),
      exogenousCursors: Object.freeze({ ...this.exogenousCursors }),
      exhaustedStreams: Object.freeze([...this.exhaustedStreams]),
      anchorOrdinals: Object.freeze([...this.anchorOrdinals.entries()].map((x) => Object.freeze(x))),
      instantGuard: Object.freeze({ ...this.instantGuard }),
    });
  }

  private restoreRuntime(snapshot: RuntimeSnapshot<W>, branchId = snapshot.branchId): void {
    this.activeBranchId = branchId;
    this.world = snapshot.world;
    this.headTime = snapshot.headTime;
    this.nextSequence = snapshot.nextSequence;
    this.runState = snapshot.runState;
    this.fault = snapshot.fault;
    this.lastCommitId = snapshot.lastCommitId;
    this.frontier = new Frontier();
    this.frontier.restore(snapshot.frontier);
    this.commitLog = snapshot.commitLog.map((c) =>
      c.branchId === branchId ? c : freeze({ ...c, branchId }, true),
    );
    this.eventIds = new Set(snapshot.eventIds);
    this.exogenousCursors = { ...snapshot.exogenousCursors };
    this.exhaustedStreams = new Set(snapshot.exhaustedStreams);
    this.anchorOrdinals = new Map(snapshot.anchorOrdinals.map(([k, v]) => [k, v]));
    this.instantGuard = { ...snapshot.instantGuard };
    this.viewMode = 'live';
    this.viewWorld = null;
    this.scrubCursor = null;
    this.pendingNotifications = [];
  }

  private touchActiveBranchInfo(): void {
    if (this.replaying) return;
    const node = this.branches.get(this.activeBranchId);
    if (!node) return;
    node.info = Object.freeze({ ...node.info, ranTo: this.headTime, head: this.liveCursor() });
  }

  private cloneBranchGraph(): Map<BranchId, BranchNode<W>> {
    const out = new Map<BranchId, BranchNode<W>>();
    for (const [id, node] of this.branches) {
      out.set(id, {
        info: node.info,
        interventions: [...node.interventions],
        checkpoints: [...node.checkpoints],
        headSnapshot: node.headSnapshot,
        forkCommitCount: node.forkCommitCount,
        forkOrdinals: new Map(node.forkOrdinals),
      });
    }
    return out;
  }

  private restoreBranchGraph(snapshot: Map<BranchId, BranchNode<W>>): void {
    this.branches.clear();
    for (const [id, node] of snapshot) this.branches.set(id, node);
  }

  private saveActiveBranchHead(): void {
    const node = this.branches.get(this.activeBranchId);
    if (!node) return;
    const cursor = this.liveCursor();
    node.info = Object.freeze({ ...node.info, ranTo: this.headTime, head: cursor });
    node.headSnapshot = this.captureRuntime();
  }

  private maybeCheckpoint(): void {
    if (this.replaying || this.checkpointEvery <= 0) return;
    if (this.commitLog.length === 0 || this.commitLog.length % this.checkpointEvery !== 0) return;
    const node = this.branches.get(this.activeBranchId);
    if (!node) return;
    const cursor = this.liveCursor();
    const cp: InternalCheckpoint<W> = Object.freeze({
      commitCount: this.commitLog.length,
      cursor,
      snapshot: this.captureRuntime(),
    });
    const existing = node.checkpoints.findIndex((x) => x.commitCount === cp.commitCount);
    if (existing >= 0) node.checkpoints[existing] = cp;
    else node.checkpoints.push(cp);
  }

  private emitTimeline(reason: TimelineChangeNotification['reason'], cursor: TimelineCursor | null): void {
    const n: TimelineChangeNotification = Object.freeze({
      reason,
      branchId: this.activeBranchId,
      cursor,
      invalidateAll: true,
    });
    for (const fn of [...this.timelineListeners]) {
      try {
        fn(n);
      } catch (error) {
        this.reportListenerError({ channel: 'timeline:changed', error });
      }
    }
  }

  private resolveCursor(input: TimelineCursorInput): ResolvedCursor {
    if ('time' in input) {
      assertRuntimeMillis(input.time, 'cursor.time');
      if (input.time > this.headTime) {
        throw new AliveError('ALIVE_INVALID_CURSOR', 'cursor time is beyond the branch head', {
          time: input.time, headTime: this.headTime,
        });
      }
      let count = 0;
      for (const c of this.commitLog) {
        if (c.virtualTime <= input.time) count += 1;
        else break;
      }
      const after = count === 0 ? null : (this.commitLog[count - 1] as CommitRecord).commitId;
      return {
        commitCount: count,
        cursor: Object.freeze({ virtualTime: input.time, afterCommitId: after, branchId: this.activeBranchId }),
      };
    }
    if ('afterCommitId' in input) {
      const idx = this.commitLog.findIndex((c) => c.commitId === input.afterCommitId);
      if (idx < 0) throw new AliveError('ALIVE_INVALID_CURSOR', 'commit is not on the active branch', { commitId: input.afterCommitId });
      const c = this.commitLog[idx] as CommitRecord;
      return {
        commitCount: idx + 1,
        cursor: Object.freeze({ virtualTime: c.virtualTime, afterCommitId: c.commitId, branchId: this.activeBranchId }),
      };
    }
    if (!Number.isSafeInteger(input.commitIndex) || input.commitIndex < 0 || input.commitIndex > this.commitLog.length) {
      throw new AliveError('ALIVE_INVALID_CURSOR', 'commitIndex must be a commit count from 0 through branch length', {
        commitIndex: input.commitIndex, commits: this.commitLog.length,
      });
    }
    const count = input.commitIndex;
    const c = count === 0 ? undefined : this.commitLog[count - 1];
    return {
      commitCount: count,
      cursor: Object.freeze({
        virtualTime: c?.virtualTime ?? 0,
        afterCommitId: c?.commitId ?? null,
        branchId: this.activeBranchId,
      }),
    };
  }

  private worldAtCommitCount(commitCount: number): W {
    let state = this.world;
    for (let i = this.commitLog.length - 1; i >= commitCount; i -= 1) {
      state = applyPatches(state as Objectish, (this.commitLog[i] as CommitRecord).inversePatches) as W;
    }
    return freeze(state, true);
  }

  // ---------------------------------------------------------------- setup

  private takeSequence(): number {
    const sequence = this.nextSequence;
    this.nextSequence = incrementSafeCounter(this.nextSequence, 'scheduler sequence');
    return sequence;
  }

  private takeTxSequence(tx: Transaction): number {
    const sequence = tx.scratchSequence;
    tx.scratchSequence = incrementSafeCounter(tx.scratchSequence, 'scheduler sequence');
    return sequence;
  }

  private takeTxUid(tx: Transaction): number {
    const uid = tx.scratchUid;
    tx.scratchUid = incrementSafeCounter(tx.scratchUid, 'frontier uid');
    return uid;
  }

  private seedBootstrap(): void {
    const seen = new Set<string>();
    for (const b of this.scenario.bootstrap ?? []) {
      if (!b.key) {
        throw new AliveError('ALIVE_INVALID_SCENARIO', 'bootstrap item requires a stable `key`', {
          type: b.type,
        });
      }
      if (seen.has(b.key)) {
        throw new AliveError('ALIVE_INVALID_SCENARIO', `duplicate bootstrap key "${b.key}"`);
      }
      seen.add(b.key);
      const scheduledId = scheduledIdBootstrap(this.scenario.id, this.scenario.version, b.key);
      const payload = snapshotJson(b.payload, `bootstrap(${b.key}).payload`) as JsonValue;
      const item = assign<ScheduledItem>(
        {
          scheduledId,
          virtualTime: b.virtualTime,
          priority: b.priority ?? PRIORITY.domain,
          sequence: this.takeSequence(),
          type: b.type,
          payload,
          origin: 'bootstrap',
        },
        { actorId: b.actorId, entityId: b.entityId, slot: b.slot, key: b.key },
      );
      this.frontier.push(frozenScheduledEntry(this.frontier.allocateUid(), item));
    }
  }

  private seedExogenous(): void {
    for (const stream of this.scenario.exogenous ?? []) {
      const produced = this.materializeExogenous(stream.id, 0, stream.from);
      if (produced) {
        const item = this.scheduledItemFor(produced, this.takeSequence());
        this.frontier.push(frozenScheduledEntry(this.frontier.allocateUid(), item));
        this.exogenousCursors[stream.id] = 0;
      } else {
        this.exhaustedStreams.add(stream.id);
      }
    }
  }

  /** Assigns scheduler identity to a materialization. Sequence is supplied by the caller. */
  private scheduledItemFor(m: ExogenousMaterialization, sequence: number): ScheduledItem {
    return freeze(
      assign<ScheduledItem>(
        {
          scheduledId: m.scheduledId,
          virtualTime: m.virtualTime,
          priority: PRIORITY.exogenous,
          sequence,
          type: m.type,
          payload: m.payload,
          origin: 'exogenous',
          streamId: m.streamId,
          ordinal: m.ordinal,
        },
        { actorId: m.actorId, key: m.key },
      ),
      true,
    );
  }

  /**
   * Builds the next materialization for a stream, or null when exhausted. No world
   * access (INV-38) and no mutation of the simulation's sequence counter (item 5):
   * scheduler identity is assigned by the caller at staging time.
   */
  private materializeExogenous(
    streamId: string,
    ordinal: number,
    lastTime: Millis,
  ): ExogenousMaterialization | null {
    const stream = (this.scenario.exogenous ?? []).find((s) => s.id === streamId);
    if (!stream) return null;
    if (!Number.isSafeInteger(ordinal) || ordinal < 0) {
      throw new AliveError('ALIVE_COUNTER_OVERFLOW', 'exogenous ordinal is not a safe counter', {
        streamId,
        ordinal,
      });
    }
    assertRuntimeMillis(lastTime, `exogenous(${streamId}).lastTime`);
    const random = createRandomApi({
      seed: this.seed,
      subject: streamId,
      cause: `exo:${streamId}:${ordinal}`,
    });
    const produced = stream.next({ ordinal, lastTime, random });
    if (!produced) return null;
    assertRuntimeMillis(produced.virtualTime, `exogenous(${streamId}#${ordinal}).virtualTime`);
    if (stream.until !== undefined && produced.virtualTime > stream.until) return null;
    if (produced.virtualTime < lastTime) {
      throw new AliveError(
        'ALIVE_RETROACTIVE_SCHEDULE',
        `exogenous stream "${streamId}" produced an item before its predecessor`,
        { streamId, ordinal, virtualTime: produced.virtualTime, lastTime },
      );
    }
    const payload = snapshotJson(
      produced.payload,
      `exogenous(${streamId}#${ordinal}).payload`,
    ) as JsonValue;
    return assign<ExogenousMaterialization>(
      {
        scheduledId: scheduledIdExogenous(streamId, ordinal),
        virtualTime: produced.virtualTime,
        type: produced.type,
        payload,
        streamId,
        ordinal,
      },
      { actorId: produced.actorId, key: produced.key },
    );
  }

  // ---------------------------------------------------------------- guards

  private assertRunnable(): void {
    if (this.runState === 'faulted') {
      throw new AliveError('ALIVE_FAULTED', 'branch is faulted; reset or load a replay', {
        branchId: this.activeBranchId,
      });
    }
    if (this.viewMode === 'scrubbing') {
      throw new AliveError('ALIVE_HISTORICAL_VIEW', 'cannot advance a historical view');
    }
  }

  // ---------------------------------------------------------------- commit

  private executeCommit(source: CommitSource, entry: FrontierEntry | null): CommitOutcome {
    const isIntervention = source.kind === 'intervention';
    const commitId = isIntervention
      ? commitIdForIntervention((source.item as InterventionItem).commandId)
      : commitIdForScheduled((source.item as ScheduledItem).scheduledId);
    const commitTime = source.item.virtualTime;
    const tuple = {
      virtualTime: source.item.virtualTime,
      priority: source.item.priority,
      sequence: source.item.sequence,
    };
    assertRuntimeMillis(commitTime, 'commit.virtualTime');
    if (!Number.isSafeInteger(tuple.sequence) || tuple.sequence < 0) {
      throw new AliveError('ALIVE_COUNTER_OVERFLOW', 'commit sequence is not a safe counter', {
        sequence: tuple.sequence,
      });
    }
    if (isIntervention) {
      if (tuple.priority !== PRIORITY.intervention) {
        throw new AliveError(
          'ALIVE_INVALID_PRIORITY',
          'interventions must use reserved priority 0',
          { priority: tuple.priority },
        );
      }
    } else {
      assertRuntimePriority(tuple.priority, 'scheduled.priority');
    }

    const tx: Transaction = {
      scratchSequence: isIntervention
        ? incrementSafeCounter(this.nextSequence, 'scheduler sequence')
        : this.nextSequence,
      scratchUid: this.frontier.uidCursor,
      adds: [],
      cancels: [],
      events: [],
      newEventIds: new Set(),
      newScheduledIds: new Set(),
    };

    try {
      const [nextWorld, patches, inversePatches] = produceWithPatches(this.world, (draft: Draft<W>) => {
        this.runCascade(draft, tx, source, commitId, commitTime, tuple);
      });

      if (!isIntervention) {
        const item = source.item as ScheduledItem;
        if (item.origin === 'exogenous' && item.streamId !== undefined) {
          this.stageExogenousSuccessor(tx, item, tuple);
        }
      }

      if (
        this.instantGuard.at === commitTime &&
        this.instantGuard.count >= this.limits.maxCommitsPerInstant
      ) {
        throw new AliveError(
          'ALIVE_CASCADE_LIMIT',
          `maxCommitsPerInstant (${this.limits.maxCommitsPerInstant}) exceeded at t=${commitTime}`,
          { limit: 'maxCommitsPerInstant', virtualTime: commitTime, commitId },
        );
      }

      assertJsonSafe(nextWorld, 'world');

      this.publish(
        source,
        entry,
        commitId,
        commitTime,
        tuple,
        tx,
        nextWorld,
        patches,
        inversePatches,
      );
      return { commitId, events: tx.events };
    } catch (e) {
      // Total rollback (INV-21): nothing staged was published, the source is still in
      // the frontier, the uid cursor never advanced, and head time never moved (item 2).
      this.frontier.abortActive();
      this.runState = 'faulted';
      this.fault = Object.freeze({
        sourceKind: source.kind,
        sourceId: isIntervention
          ? (source.item as InterventionItem).commandId
          : (source.item as ScheduledItem).scheduledId,
        attemptedVirtualTime: commitTime,
        originalError: frozenDiagnosticError(e),
      });
      throw e;
    }
  }

  private stageExogenousSuccessor(
    tx: Transaction,
    item: ScheduledItem,
    tuple: { virtualTime: number; priority: number; sequence: number },
  ): void {
    const streamId = item.streamId as string;
    const nextOrdinal = incrementSafeCounter(item.ordinal as number, `exogenous(${streamId}).ordinal`);
    const produced = this.materializeExogenous(streamId, nextOrdinal, item.virtualTime);
    tx.exoStreamId = streamId;
    if (!produced) {
      tx.exoExhausted = true;
      return;
    }
    const successor = this.scheduledItemFor(produced, this.takeTxSequence(tx));
    this.assertNotRetroactive(
      {
        virtualTime: successor.virtualTime,
        priority: successor.priority,
        sequence: successor.sequence,
      },
      tuple,
      successor.type,
    );
    tx.exoOrdinal = nextOrdinal;
    tx.adds.push({
      entry: frozenScheduledEntry(this.takeTxUid(tx), successor),
      scheduledId: successor.scheduledId,
    });
    tx.newScheduledIds.add(successor.scheduledId);
  }

  private assertNotRetroactive(
    next: { virtualTime: number; priority: number; sequence: number },
    current: { virtualTime: number; priority: number; sequence: number },
    type: string,
  ): void {
    if (!sortsStrictlyAfter(next, current)) {
      throw new AliveError(
        'ALIVE_RETROACTIVE_SCHEDULE',
        `"${type}" would be positioned at or before the commit scheduling it`,
        { next, current, type },
      );
    }
  }

  private runCascade(
    draft: Draft<W>,
    tx: Transaction,
    source: CommitSource,
    commitId: CommitId,
    commitTime: Millis,
    tuple: { virtualTime: number; priority: number; sequence: number },
  ): void {
    interface Pending {
      id: EventId;
      type: string;
      depth: number;
      parentEventId?: string;
      actorId?: string;
      entityId?: string;
      slot?: string;
      key?: string;
      payload: JsonValue;
    }
    const queue: Pending[] = [];

    if (source.kind === 'scheduled') {
      const item = source.item;
      queue.push(
        assign<Pending>(
          { id: item.scheduledId, type: item.type, depth: 0, payload: item.payload as JsonValue },
          {
            parentEventId: item.parentEventId,
            actorId: item.actorId,
            entityId: item.entityId,
            slot: item.slot,
            key: item.key,
          },
        ),
      );
    } else {
      const item = source.item;
      const cmdCtx = {
        time: commitTime,
        commandId: item.commandId,
        commitId,
        random: createRandomApi({
          seed: this.seed,
          subject: 'scenario',
          cause: item.commandId,
        }),
      };
      const handler = this.scenario.commands[item.command.type];
      if (!handler) {
        throw new AliveError('ALIVE_UNKNOWN_COMMAND', `no handler for "${item.command.type}"`);
      }
      const specs = handler.events(this.world, item.command, cmdCtx);
      for (const spec of specs) {
        queue.push(
          assign<Pending>(
            {
              id: eventIdFromCommand(item.commandId, spec.type, discOf(spec)),
              type: spec.type,
              depth: 0,
              payload: snapshotJson(
                spec.payload,
                `command(${item.command.type}).event(${spec.type}).payload`,
              ) as JsonValue,
            },
            {
              actorId: spec.actorId,
              entityId: spec.entityId,
              slot: spec.slot,
              key: spec.key,
            },
          ),
        );
      }
    }

    while (queue.length > 0) {
      const p = queue.shift() as Pending;

      if (tx.events.length + 1 > this.limits.maxEventsPerCommit) {
        throw new AliveError(
          'ALIVE_CASCADE_LIMIT',
          `maxEventsPerCommit (${this.limits.maxEventsPerCommit}) exceeded`,
          { limit: 'maxEventsPerCommit', commitId, type: p.type },
        );
      }
      if (p.depth > this.limits.maxCausalDepth) {
        throw new AliveError(
          'ALIVE_CASCADE_LIMIT',
          `maxCausalDepth (${this.limits.maxCausalDepth}) exceeded at "${p.type}"`,
          { limit: 'maxCausalDepth', commitId, type: p.type, depth: p.depth },
        );
      }
      if (this.eventIds.has(p.id) || tx.newEventIds.has(p.id)) {
        throw new AliveError(
          'ALIVE_EVENT_ID_COLLISION',
          `two events derive the same id; supply a stable \`key\` or \`slot\``,
          {
            eventId: p.id,
            type: p.type,
            parentEventId: p.parentEventId ?? null,
            entityId: p.entityId ?? null,
          },
        );
      }
      tx.newEventIds.add(p.id);
      assertJsonSafe(p.payload, `event(${p.type}).payload`);

      const event = assign<AliveEvent>(
        {
          id: p.id,
          type: p.type,
          commitId,
          virtualTime: commitTime,
          withinCommitOrder: tx.events.length,
          depth: p.depth,
          causeId: p.parentEventId ?? commitId,
          payload: p.payload,
        },
        {
          actorId: p.actorId,
          entityId: p.entityId,
          slot: p.slot,
          key: p.key,
          parentEventId: p.parentEventId,
        },
      );
      // INV-8: recorded events are immutable in fact, not only in the type.
      tx.events.push(freeze(event, true));

      const emitted: EmitSpec[] = [];
      const ctx = this.makeHandlerContext(tx, event, commitId, commitTime, tuple, emitted);
      const handler = this.scenario.events[event.type];
      if (handler) handler(draft, event, ctx);

      for (const spec of emitted) {
        queue.push(this.childOf(event, spec, spec.slot));
      }
      for (const rule of this.scenario.rules ?? []) {
        const when = typeof rule.when === 'string' ? [rule.when] : rule.when;
        if (!when.includes(event.type)) continue;
        const currentState =
          draft !== null && typeof draft === 'object'
            ? current(draft as Draft<object>)
            : (draft as unknown);
        const state = snapshotJson(currentState, `rule(${rule.id}).state`) as Readonly<W>;
        if (rule.if && !rule.if(state, event)) continue;
        for (const spec of rule.emit(state, event)) {
          queue.push(this.childOf(event, spec, spec.slot ?? `rule:${rule.id}`));
        }
      }
    }
  }

  private childOf(
    parent: AliveEvent,
    spec: EmitSpec,
    slot: string | undefined,
  ): {
    id: EventId;
    type: string;
    depth: number;
    parentEventId?: string;
    actorId?: string;
    entityId?: string;
    slot?: string;
    key?: string;
    payload: JsonValue;
  } {
    const d: Discriminator = {
      key: spec.key,
      slot,
      entityId: spec.entityId,
      actorId: spec.actorId,
    };
    return assign(
      {
        id: eventIdChild(parent.id, spec.type, d),
        type: spec.type,
        depth: parent.depth + 1,
        parentEventId: parent.id,
        payload: snapshotJson(
          spec.payload,
          `event(${spec.type}).payload`,
        ) as JsonValue,
      },
      { actorId: spec.actorId, entityId: spec.entityId, slot, key: spec.key },
    );
  }

  private makeHandlerContext(
    tx: Transaction,
    event: AliveEvent,
    commitId: CommitId,
    commitTime: Millis,
    tuple: { virtualTime: number; priority: number; sequence: number },
    emitted: EmitSpec[],
  ): HandlerContext<W> {
    const findStaged = (id: ScheduledId): number =>
      tx.adds.findIndex((a) => a.scheduledId === id);

    /**
     * Published items that this transaction has already staged for cancellation are
     * invisible to later staged operations in the same commit. Without this, a handler
     * that cancels X and then schedules an item deriving X's id would see a phantom
     * collision against work that will not survive the commit.
     */
    const liveFind = (id: ScheduledId): FrontierEntry | undefined => {
      const e = this.frontier.find(id);
      if (!e || tx.cancels.includes(e.uid)) return undefined;
      return e;
    };

    return {
      time: commitTime,
      commitId,
      random: createRandomApi({
        seed: this.seed,
        subject: subjectOf(event),
        cause: event.id,
      }),
      emit(spec: EmitSpec): void {
        emitted.push(
          assign<EmitSpec>(
            { type: spec.type, payload: snapshotJson(spec.payload, `event(${spec.type}).payload`) },
            {
              actorId: spec.actorId,
              entityId: spec.entityId,
              slot: spec.slot,
              key: spec.key,
            },
          ),
        );
      },
      schedule: (spec: ScheduleSpec): ScheduledId => {
        const d: Discriminator = {
          key: spec.key,
          slot: spec.slot,
          entityId: spec.entityId,
          actorId: spec.actorId,
        };
        const scheduledId = scheduledIdHandler(event.id, spec.type, d);
        if (liveFind(scheduledId) || tx.newScheduledIds.has(scheduledId)) {
          throw new AliveError(
            'ALIVE_SCHEDULED_ID_COLLISION',
            `two scheduled items derive the same id; supply a stable \`key\` or \`slot\``,
            { scheduledId, type: spec.type, parentEventId: event.id },
          );
        }
        const payload = snapshotJson(spec.payload, `scheduled(${spec.type}).payload`) as JsonValue;
        assertRuntimeMillis(spec.virtualTime, `scheduled(${spec.type}).virtualTime`);
        const priority = spec.priority ?? PRIORITY.domain;
        assertRuntimePriority(priority, `scheduled(${spec.type}).priority`);
        const sequence = this.takeTxSequence(tx);
        this.assertNotRetroactive(
          { virtualTime: spec.virtualTime, priority, sequence },
          tuple,
          spec.type,
        );
        const item = assign<ScheduledItem>(
          {
            scheduledId,
            virtualTime: spec.virtualTime,
            priority,
            sequence,
            type: spec.type,
            payload,
            origin: 'handler',
            parentEventId: event.id,
          },
          {
            actorId: spec.actorId,
            entityId: spec.entityId,
            slot: spec.slot,
            key: spec.key,
          },
        );
        tx.adds.push({
          entry: frozenScheduledEntry(this.takeTxUid(tx), item),
          scheduledId,
        });
        tx.newScheduledIds.add(scheduledId);
        return scheduledId;
      },
      cancel: (scheduledId: ScheduledId): boolean => {
        const stagedIdx = findStaged(scheduledId);
        if (stagedIdx >= 0) {
          tx.adds.splice(stagedIdx, 1);
          tx.newScheduledIds.delete(scheduledId);
          return true;
        }
        const entry = liveFind(scheduledId);
        if (!entry) return false;
        tx.cancels.push(entry.uid);
        return true;
      },
      reschedule: (scheduledId: ScheduledId, virtualTime: Millis): boolean => {
        const stagedIdx = findStaged(scheduledId);
        const existing =
          stagedIdx >= 0
            ? (tx.adds[stagedIdx] as StagedAdd).entry.source
            : liveFind(scheduledId)?.source;
        if (!existing || existing.kind !== 'scheduled') return false;
        const old = existing.item;
        assertRuntimeMillis(virtualTime, `reschedule(${old.type}).virtualTime`);
        const sequence = this.takeTxSequence(tx);
        this.assertNotRetroactive(
          { virtualTime, priority: old.priority, sequence },
          tuple,
          old.type,
        );
        const moved: ScheduledItem = { ...old, virtualTime, sequence };
        if (stagedIdx >= 0) {
          tx.adds[stagedIdx] = {
            entry: frozenScheduledEntry(this.takeTxUid(tx), moved),
            scheduledId,
          };
        } else {
          const entry = liveFind(scheduledId) as FrontierEntry;
          tx.cancels.push(entry.uid);
          tx.adds.push({
            entry: frozenScheduledEntry(this.takeTxUid(tx), moved),
            scheduledId,
          });
          tx.newScheduledIds.add(scheduledId);
        }
        return true;
      },
    };
  }

  private publish(
    source: CommitSource,
    entry: FrontierEntry | null,
    commitId: CommitId,
    commitTime: Millis,
    tuple: { virtualTime: number; priority: number; sequence: number },
    tx: Transaction,
    nextWorld: W,
    patches: readonly Patch[],
    inversePatches: readonly Patch[],
  ): void {
    this.world = nextWorld;
    // The source leaves the frontier only now, as part of publication (item 1).
    if (entry) this.frontier.completeActive(entry);
    for (const uid of tx.cancels) this.frontier.cancel(uid);
    for (const add of tx.adds) this.frontier.push(add.entry);
    this.frontier.commitUidCursor(tx.scratchUid);
    this.nextSequence = tx.scratchSequence;
    this.headTime = commitTime;
    for (const id of tx.newEventIds) this.eventIds.add(id);

    if (tx.exoStreamId !== undefined) {
      if (tx.exoExhausted) this.exhaustedStreams.add(tx.exoStreamId);
      else if (tx.exoOrdinal !== undefined) this.exogenousCursors[tx.exoStreamId] = tx.exoOrdinal;
    }

    this.instantGuard =
      this.instantGuard.at === commitTime
        ? {
            at: commitTime,
            count: incrementSafeCounter(this.instantGuard.count, 'instant guard count'),
          }
        : { at: commitTime, count: 1 };

    const record: CommitRecord = {
      commitId,
      branchId: this.activeBranchId,
      virtualTime: commitTime,
      source:
        source.kind === 'scheduled'
          ? { kind: 'scheduled', id: (source.item as ScheduledItem).scheduledId }
          : { kind: 'intervention', id: (source.item as InterventionItem).commandId },
      schedulerTuple: tuple,
      events: tx.events,
      patches: [...patches],
      inversePatches: [...inversePatches],
    };
    this.commitLog.push(freeze(record, true));
    this.lastCommitId = commitId;

    if (!this.replaying) {
      this.pendingNotifications.push(
        freeze(
          {
            commitId,
            branchId: this.activeBranchId,
            virtualTime: commitTime,
            events: tx.events,
          },
          true,
        ),
      );
    }
    this.touchActiveBranchInfo();
    this.maybeCheckpoint();
  }

  /**
   * Item 12: a listener is application integration code. A throwing listener must not
   * undo a published commit, must not fault the branch, and must not stop the remaining
   * listeners from being notified. Errors are reported on the separate `error` channel.
   */
  private flush(): void {
    const batch = this.pendingNotifications;
    this.pendingNotifications = [];
    for (const n of batch) {
      for (const fn of [...this.commitListeners]) {
        try {
          fn(n);
        } catch (error) {
          this.reportListenerError({ channel: 'committed', error, commitId: n.commitId });
        }
      }
    }
  }

  private reportListenerError(e: ListenerError): void {
    const recorded = Object.freeze({ ...e, error: frozenDiagnosticError(e.error) });
    this.listenerErrors.push(recorded);
    if (this.listenerErrors.length > 100) this.listenerErrors.shift();
    for (const fn of [...this.errorListeners]) {
      try {
        fn(recorded);
      } catch {
        // An error listener that itself throws is dropped; there is nowhere left to go.
      }
    }
  }

  // ---------------------------------------------------------------- replay / branch reconstruction

  private resetRuntimeToRootInitial(): void {
    this.activeBranchId = ROOT_BRANCH_ID;
    this.headTime = 0;
    this.nextSequence = 0;
    this.runState = 'ready';
    this.viewMode = 'live';
    this.fault = undefined;
    this.lastCommitId = null;
    this.viewWorld = null;
    this.scrubCursor = null;
    this.frontier = new Frontier();
    this.commitLog = [];
    this.eventIds = new Set();
    this.exogenousCursors = {};
    this.exhaustedStreams = new Set();
    this.anchorOrdinals = new Map();
    this.instantGuard = { at: null, count: 0 };
    this.pendingNotifications = [];

    const initRandom = createRandomApi({ seed: this.seed, subject: 'scenario', cause: 'init' });
    this.world = snapshotJson(
      this.scenario.initialState({ epoch: this.scenario.epoch, random: initRandom }),
      'initialState',
    );
    this.seedBootstrap();
    this.seedExogenous();
  }

  private retagRuntimeBranch(branchId: BranchId): void {
    this.activeBranchId = branchId;
    this.commitLog = this.commitLog.map((c) =>
      c.branchId === branchId ? c : freeze({ ...c, branchId }, true),
    );
    this.anchorOrdinals = new Map();
    this.runState = 'ready';
    this.fault = undefined;
    this.viewMode = 'live';
    this.viewWorld = null;
    this.scrubCursor = null;
  }

  private executeRecordedIntervention(record: ReplayIntervention): void {
    if (record.anchor.branchId !== this.activeBranchId) {
      throw new AliveError('ALIVE_REPLAY_DIVERGED', 'intervention anchor belongs to a different branch', {
        expected: this.activeBranchId, actual: record.anchor.branchId, commandId: record.commandId,
      });
    }
    if (record.anchor.afterCommitId !== this.lastCommitId || record.anchor.virtualTime < this.headTime) {
      throw new AliveError('ALIVE_REPLAY_DIVERGED', 'intervention anchor does not match reconstructed history', {
        commandId: record.commandId, anchor: record.anchor, head: this.liveCursor(),
      });
    }
    if (record.sequence !== this.nextSequence || record.priority !== PRIORITY.intervention) {
      throw new AliveError('ALIVE_REPLAY_DIVERGED', 'intervention ordering differs from recorded replay', {
        commandId: record.commandId, recordedSequence: record.sequence, nextSequence: this.nextSequence,
      });
    }
    this.headTime = record.virtualTime;
    const handler = this.scenario.commands[record.command.type];
    if (!handler) throw new AliveError('ALIVE_REPLAY_DIVERGED', 'replay command handler is missing', { type: record.command.type });
    const rejection = handler.validate?.(this.world, record.command);
    if (rejection) {
      throw new AliveError('ALIVE_REPLAY_DIVERGED', 'previously accepted intervention is now rejected', {
        commandId: record.commandId, rejection,
      });
    }
    const item: InterventionItem = freeze({
      commandId: record.commandId,
      anchor: record.anchor,
      virtualTime: record.virtualTime,
      priority: record.priority,
      sequence: record.sequence,
      command: record.command,
    }, true);
    this.executeCommit(freeze({ kind: 'intervention' as const, item }, true), null);
    const k = anchorKey(record.anchor);
    this.anchorOrdinals.set(k, (this.anchorOrdinals.get(k) ?? 0) + 1);
  }

  private reconstructBranchTo(branchId: BranchId, target: ResolvedCursor): RuntimeSnapshot<W> {
    const node = this.branches.get(branchId);
    if (!node) throw new AliveError('ALIVE_UNKNOWN_BRANCH', `unknown branch "${branchId}"`);

    const previousReplaying = this.replaying;
    this.replaying = true;
    try {
      const candidates = node.checkpoints
        .filter((cp) => cp.commitCount <= target.commitCount)
        .sort((a, b) => b.commitCount - a.commitCount);
      const cp = candidates[0];
      if (cp) {
        this.restoreRuntime(cp.snapshot, branchId);
      } else if (node.info.parentBranchId) {
        const parent = this.branches.get(node.info.parentBranchId);
        if (!parent || !node.info.forkCursor) {
          throw new AliveError('ALIVE_REPLAY_DIVERGED', 'branch ancestry is incomplete', { branchId });
        }
        const parentForkCount = node.forkCommitCount;
        if (target.commitCount <= parentForkCount) {
          const parentTarget: ResolvedCursor = {
            commitCount: target.commitCount,
            cursor: Object.freeze({ ...target.cursor, branchId: parent.info.id }),
          };
          this.reconstructBranchTo(parent.info.id, parentTarget);
          this.retagRuntimeBranch(branchId);
        } else {
          const parentTarget: ResolvedCursor = {
            commitCount: parentForkCount,
            cursor: Object.freeze({ ...node.info.forkCursor, branchId: parent.info.id }),
          };
          this.reconstructBranchTo(parent.info.id, parentTarget);
          this.retagRuntimeBranch(branchId);
          this.headTime = node.info.forkCursor.virtualTime;
        }
      } else {
        this.resetRuntimeToRootInitial();
        this.activeBranchId = branchId;
      }

      const already = new Set(this.commitLog.map((c) => c.commitId));
      let interventionIndex = 0;
      while (interventionIndex < node.interventions.length && already.has(commitIdForIntervention(node.interventions[interventionIndex]!.commandId))) {
        interventionIndex += 1;
      }

      while (this.commitLog.length < target.commitCount) {
        const intervention = node.interventions[interventionIndex];
        if (intervention && intervention.anchor.afterCommitId === this.lastCommitId) {
          if (intervention.anchor.virtualTime < this.headTime) {
            throw new AliveError('ALIVE_REPLAY_DIVERGED', 'intervention anchor moved behind reconstructed head');
          }
          this.headTime = intervention.anchor.virtualTime;
          this.executeRecordedIntervention(intervention);
          interventionIndex += 1;
          continue;
        }
        const entry = this.frontier.select();
        if (!entry) {
          throw new AliveError('ALIVE_REPLAY_DIVERGED', 'replay ran out of scheduled work before target cursor', {
            branchId, target: target.cursor, commits: this.commitLog.length,
          });
        }
        if (entry.source.item.virtualTime > target.cursor.virtualTime) {
          this.frontier.abortActive();
          throw new AliveError('ALIVE_REPLAY_DIVERGED', 'next scheduled item lies after target cursor before expected commit count', {
            branchId, nextTime: entry.source.item.virtualTime, target: target.cursor,
          });
        }
        this.executeCommit(entry.source, entry);
      }

      if (target.cursor.afterCommitId !== this.lastCommitId) {
        throw new AliveError('ALIVE_REPLAY_DIVERGED', 'target commit does not match reconstructed history', {
          branchId, expected: target.cursor.afterCommitId, actual: this.lastCommitId,
        });
      }
      this.headTime = target.cursor.virtualTime;
      this.runState = this.scenario.endTime !== undefined && this.headTime >= this.scenario.endTime ? 'ended' : 'ready';
      this.fault = undefined;
      return this.captureRuntime();
    } finally {
      this.replaying = previousReplaying;
      this.pendingNotifications = [];
    }
  }

  // ---------------------------------------------------------------- clock

  private runToTarget(target: Millis): RunResult {
    assertRuntimeMillis(target, 'run.target');
    const end = this.scenario.endTime;
    const cap = end === undefined ? target : Math.min(target, end);
    let commits = 0;
    let eventsProcessed = 0;
    try {
      for (;;) {
        const top = this.frontier.peekLive();
        if (!top || top.source.item.virtualTime > cap) break;
        const entry = this.frontier.select() as FrontierEntry;
        // head time advances inside publish(), only on success (item 2)
        const out = this.executeCommit(entry.source, entry);
        commits += 1;
        eventsProcessed += out.events.length;
      }
      this.headTime = cap;
      this.touchActiveBranchInfo();
      const stopped: RunResult['stoppedBecause'] =
        end !== undefined && cap >= end ? 'scenario-end' : 'target-reached';
      if (stopped === 'scenario-end') this.runState = 'ended';
      return { commits, eventsProcessed, virtualTime: this.headTime, stoppedBecause: stopped };
    } finally {
      this.flush();
    }
  }

  advance(duration: Millis): RunResult {
    this.assertRunnable();
    if (!Number.isSafeInteger(duration) || duration < 0) {
      throw new AliveError(
        'ALIVE_INVALID_DURATION',
        `advance requires a non-negative safe-integer duration`,
        { duration },
      );
    }
    if (duration > Number.MAX_SAFE_INTEGER - this.headTime) {
      throw new AliveError('ALIVE_INVALID_DURATION', 'advance would overflow virtual time', {
        duration,
        headTime: this.headTime,
      });
    }
    return this.runToTarget(this.headTime + duration);
  }

  runUntil(target: Millis): RunResult {
    this.assertRunnable();
    assertRuntimeMillis(target, 'runUntil.target');
    if (target < this.headTime) {
      throw new AliveError(
        'ALIVE_BACKWARD_RUN',
        `runUntil(${target}) is before head time ${this.headTime}; use scrub to inspect history`,
        { target, headTime: this.headTime },
      );
    }
    return this.runToTarget(target);
  }

  runNext(): StepResult {
    this.assertRunnable();
    const top = this.frontier.peekLive();
    if (!top) {
      return {
        committed: false,
        eventsProcessed: 0,
        virtualTime: this.headTime,
        stoppedBecause: 'no-work',
      };
    }
    const end = this.scenario.endTime;
    if (end !== undefined && top.source.item.virtualTime > end) {
      this.headTime = end;
      this.runState = 'ended';
      this.touchActiveBranchInfo();
      return {
        committed: false,
        eventsProcessed: 0,
        virtualTime: this.headTime,
        stoppedBecause: 'scenario-end',
      };
    }
    const entry = this.frontier.select() as FrontierEntry;
    try {
      const out = this.executeCommit(entry.source, entry);
      return {
        committed: true,
        commitId: out.commitId,
        eventsProcessed: out.events.length,
        virtualTime: this.headTime,
        stoppedBecause: 'committed',
      };
    } finally {
      this.flush();
    }
  }

  // ---------------------------------------------------------------- commands

  dispatch(command: SerializableCommand): DispatchResult {
    if (this.runState === 'faulted') {
      throw new AliveError('ALIVE_FAULTED', 'branch is faulted; reset or load a replay');
    }
    if (this.viewMode === 'scrubbing') {
      throw new AliveError('ALIVE_HISTORICAL_VIEW', 'cannot modify a historical view', {
        hint: 'Fork from this point to intervene.',
      });
    }
    const handler = this.scenario.commands[command.type];
    if (!handler) {
      return {
        accepted: false,
        rejection: {
          code: 'ALIVE_UNKNOWN_COMMAND',
          message: `no command handler for "${command.type}"`,
        },
      };
    }
    let safeCommand: SerializableCommand;
    try {
      const payload = snapshotJson(command.payload, 'command.payload') as JsonValue;
      safeCommand = freeze({ type: command.type, payload }, true);
    } catch (e) {
      return {
        accepted: false,
        rejection: {
          code: 'ALIVE_INVALID_COMMAND',
          message: e instanceof Error ? e.message : 'invalid command payload',
        },
      };
    }
    const rejection = handler.validate?.(this.world, safeCommand);
    if (rejection) return { accepted: false, rejection };

    const anchor: TimelineCursor = freeze(
      {
        virtualTime: this.headTime,
        afterCommitId: this.lastCommitId,
        branchId: this.activeBranchId,
      },
      true,
    );
    const key = anchorKey(anchor);
    const nth = this.anchorOrdinals.get(key) ?? 0;
    const nextNth = incrementSafeCounter(nth, 'command ordinal');
    // An accepted intervention consumes one scheduler sequence. Validate before deriving
    // identity/executing so a counter overflow cannot happen after publication.
    incrementSafeCounter(this.nextSequence, 'scheduler sequence');
    const commandId: CommandId = deriveCommandId(
      this.activeBranchId,
      anchor,
      safeCommand.type,
      safeCommand.payload as JsonValue,
      nth,
    );
    const item: InterventionItem = freeze(
      {
        commandId,
        anchor,
        virtualTime: this.headTime,
        priority: PRIORITY.intervention,
        sequence: this.nextSequence,
        command: safeCommand,
      },
      true,
    );
    const interventionSource = freeze({ kind: 'intervention' as const, item }, true);
    try {
      const out = this.executeCommit(interventionSource, null);
      this.anchorOrdinals.set(key, nextNth);
      if (!this.replaying) {
        const node = this.branches.get(this.activeBranchId);
        if (node) {
          node.interventions.push(
            freeze(
              {
                commandId,
                anchor,
                command: safeCommand,
                virtualTime: item.virtualTime,
                priority: item.priority,
                sequence: item.sequence,
              } satisfies ReplayIntervention,
              true,
            ),
          );
          this.touchActiveBranchInfo();
        }
      }
      return {
        accepted: true,
        commandId,
        commitId: out.commitId,
        emitted: out.events.map((e) => e.id),
      };
    } finally {
      this.flush();
    }
  }

  // ---------------------------------------------------------------- scrub / branches / replay

  enterScrub(target: TimelineCursorInput): TimelineCursor {
    if (this.viewMode === 'scrubbing') {
      return this.moveScrub(target);
    }
    const resolved = this.resolveCursor(target);
    this.viewWorld = this.worldAtCommitCount(resolved.commitCount);
    this.scrubCursor = resolved.cursor;
    this.viewMode = 'scrubbing';
    this.emitTimeline('scrub-enter', resolved.cursor);
    return resolved.cursor;
  }

  moveScrub(target: TimelineCursorInput): TimelineCursor {
    if (this.viewMode !== 'scrubbing') {
      throw new AliveError('ALIVE_INVALID_CURSOR', 'moveScrub requires an active scrub session');
    }
    const resolved = this.resolveCursor(target);
    this.viewWorld = this.worldAtCommitCount(resolved.commitCount);
    this.scrubCursor = resolved.cursor;
    this.emitTimeline('scrub-move', resolved.cursor);
    return resolved.cursor;
  }

  exitScrub(): void {
    if (this.viewMode !== 'scrubbing') return;
    this.viewMode = 'live';
    this.viewWorld = null;
    this.scrubCursor = null;
    this.emitTimeline('scrub-exit', null);
  }

  getScrubCursor(): TimelineCursor | null {
    return this.scrubCursor;
  }

  forkAt(target: TimelineCursorInput, opts: ForkOptions = {}): Branch {
    const parentId = this.activeBranchId;
    const parentNode = this.branches.get(parentId);
    if (!parentNode) throw new AliveError('ALIVE_UNKNOWN_BRANCH', `unknown branch "${parentId}"`);
    const resolved = this.resolveCursor(target);
    if (this.viewMode === 'scrubbing') this.exitScrub();
    const parentHead = this.captureRuntime();
    parentNode.headSnapshot = parentHead;
    parentNode.info = Object.freeze({ ...parentNode.info, ranTo: this.headTime, head: this.liveCursor() });

    const key = anchorKey(resolved.cursor);
    const ordinal = parentNode.forkOrdinals.get(key) ?? 0;
    const branchId = deriveBranchId(parentId, resolved.cursor, ordinal);
    if (this.branches.has(branchId)) {
      throw new AliveError('ALIVE_REPLAY_DIVERGED', 'derived fork branch id already exists', { branchId });
    }

    try {
      const reconstructed = this.reconstructBranchTo(parentId, resolved);
      this.restoreRuntime(reconstructed, parentId);
      this.retagRuntimeBranch(branchId);
      this.headTime = resolved.cursor.virtualTime;

      const childCursor: TimelineCursor = Object.freeze({
        virtualTime: resolved.cursor.virtualTime,
        afterCommitId: resolved.cursor.afterCommitId,
        branchId,
      });
      const childInfo: Branch = Object.freeze({
        id: branchId,
        ...(opts.name === undefined ? {} : { name: opts.name }),
        parentBranchId: parentId,
        forkCursor: resolved.cursor,
        createdBy: Object.freeze({
          type: 'user' as const,
          ...(opts.description === undefined ? {} : { description: opts.description }),
        }),
        createdAt: resolved.cursor.virtualTime,
        ranTo: resolved.cursor.virtualTime,
        head: childCursor,
      });
      const childSnapshot = this.captureRuntime();
      const childNode: BranchNode<W> = {
        info: childInfo,
        interventions: [],
        checkpoints: [Object.freeze({ commitCount: resolved.commitCount, cursor: childCursor, snapshot: childSnapshot })],
        headSnapshot: childSnapshot,
        forkCommitCount: resolved.commitCount,
        forkOrdinals: new Map(),
      };
      this.branches.set(branchId, childNode);
      parentNode.forkOrdinals.set(key, incrementSafeCounter(ordinal, 'fork ordinal'));
      this.viewMode = 'live';
      this.viewWorld = null;
      this.scrubCursor = null;
      this.emitTimeline('fork', childCursor);
      return childInfo;
    } catch (error) {
      this.restoreRuntime(parentHead, parentId);
      throw error;
    }
  }

  switchBranch(branchId: BranchId): void {
    if (!this.branches.has(branchId)) {
      throw new AliveError('ALIVE_UNKNOWN_BRANCH', `unknown branch "${branchId}"`);
    }
    if (this.viewMode === 'scrubbing') this.exitScrub();
    if (branchId === this.activeBranchId) return;
    this.saveActiveBranchHead();
    const node = this.branches.get(branchId) as BranchNode<W>;
    this.restoreRuntime(node.headSnapshot, branchId);
    this.emitTimeline('branch-switch', this.liveCursor());
  }

  getBranches(): readonly Branch[] {
    this.touchActiveBranchInfo();
    return Object.freeze([...this.branches.values()].map((n) => n.info));
  }

  getActiveBranchId(): BranchId {
    return this.activeBranchId;
  }

  // ---------------------------------------------------------------- counterfactual comparison

  private branchNode(branchId: BranchId): BranchNode<W> {
    const node = this.branches.get(branchId);
    if (!node) throw new AliveError('ALIVE_UNKNOWN_BRANCH', `unknown branch "${branchId}"`);
    return node;
  }

  private branchLineage(branchId: BranchId): BranchId[] {
    const path: BranchId[] = [];
    let current: BranchId | undefined = branchId;
    const seen = new Set<BranchId>();
    while (current !== undefined) {
      if (seen.has(current)) {
        throw new AliveError('ALIVE_REPLAY_DIVERGED', 'branch graph contains a cycle', { branchId });
      }
      seen.add(current);
      path.push(current);
      current = this.branchNode(current).info.parentBranchId;
    }
    path.reverse();
    return path;
  }

  private commitCountThroughCursor(snapshot: RuntimeSnapshot<W>, cursor: TimelineCursor): number {
    if (cursor.afterCommitId === null) return 0;
    const idx = snapshot.commitLog.findIndex((c) => c.commitId === cursor.afterCommitId);
    if (idx < 0) {
      throw new AliveError('ALIVE_REPLAY_DIVERGED', 'ancestry cursor commit is absent from branch history', {
        branchId: snapshot.branchId,
        commitId: cursor.afterCommitId,
      });
    }
    return idx + 1;
  }

  private cursorAtTime(snapshot: RuntimeSnapshot<W>, time: Millis, branchId: BranchId): TimelineCursor {
    let afterCommitId: CommitId | null = null;
    for (const commit of snapshot.commitLog) {
      if (commit.virtualTime > time) break;
      afterCommitId = commit.commitId;
    }
    return Object.freeze({ virtualTime: time, afterCommitId, branchId });
  }

  /**
   * Deepest graph-ancestry boundary shared by A and B. Identical causal events that
   * happen independently after a fork do not extend ancestry merely because their ids
   * happen to align.
   */
  private commonAncestryOf(a: BranchId, b: BranchId, horizon: Millis): TimelineCursor | null {
    const pathA = this.branchLineage(a);
    const pathB = this.branchLineage(b);
    let commonIndex = -1;
    const n = Math.min(pathA.length, pathB.length);
    for (let i = 0; i < n; i += 1) {
      if (pathA[i] !== pathB[i]) break;
      commonIndex = i;
    }
    if (commonIndex < 0) return null;

    const lcaId = pathA[commonIndex] as BranchId;
    let cursor: TimelineCursor;
    if (a === b) {
      cursor = this.branchNode(a).info.head;
    } else {
      const nextA = pathA[commonIndex + 1];
      const nextB = pathB[commonIndex + 1];
      const forkA = nextA === undefined ? undefined : this.branchNode(nextA).info.forkCursor;
      const forkB = nextB === undefined ? undefined : this.branchNode(nextB).info.forkCursor;
      const candidates = [forkA, forkB].filter((x): x is TimelineCursor => x !== undefined);
      if (candidates.length === 0) {
        cursor = this.branchNode(lcaId).info.head;
      } else {
        const chosen = [...candidates].sort((x, y) => {
          if (x.afterCommitId === y.afterCommitId) return x.virtualTime - y.virtualTime;
          const lcaSnapshot = this.branchNode(lcaId).headSnapshot;
          const cx = this.commitCountThroughCursor(lcaSnapshot, Object.freeze({ ...x, branchId: lcaId }));
          const cy = this.commitCountThroughCursor(lcaSnapshot, Object.freeze({ ...y, branchId: lcaId }));
          return cx !== cy ? cx - cy : x.virtualTime - y.virtualTime;
        })[0] as TimelineCursor;
        cursor = Object.freeze({ ...chosen, branchId: lcaId });
      }
    }

    if (cursor.virtualTime <= horizon) return cursor;
    // The branches do not diverge until after the requested horizon. Comparison ancestry
    // is therefore the shared parent history through the horizon itself.
    const reference = this.branchNode(a).headSnapshot;
    return this.cursorAtTime(reference, horizon, lcaId);
  }

  private assertHorizonComplete(branchId: BranchId, horizon: Millis): BranchNode<W> {
    const node = this.branchNode(branchId);
    if (node.info.ranTo < horizon) {
      throw new AliveError(
        'ALIVE_HORIZON_NOT_REACHED',
        `branch "${branchId}" has only been simulated to ${node.info.ranTo}, before comparison horizon ${horizon}`,
        { branchId, ranTo: node.info.ranTo, horizon },
      );
    }
    const pendingAtOrBefore = node.headSnapshot.frontier.entries.find(
      (entry) => entry.source.item.virtualTime <= horizon,
    );
    if (pendingAtOrBefore) {
      throw new AliveError(
        'ALIVE_HORIZON_NOT_REACHED',
        `branch "${branchId}" still has pending work at or before comparison horizon ${horizon}`,
        {
          branchId,
          horizon,
          pendingTime: pendingAtOrBefore.source.item.virtualTime,
        },
      );
    }
    return node;
  }

  private stateAtTime(snapshot: RuntimeSnapshot<W>, time: Millis): W {
    let state = snapshot.world;
    for (let i = snapshot.commitLog.length - 1; i >= 0; i -= 1) {
      const commit = snapshot.commitLog[i] as CommitRecord;
      if (commit.virtualTime <= time) break;
      state = applyPatches(state as Objectish, commit.inversePatches) as W;
    }
    return freeze(state, true);
  }

  private numericValue(observable: NumericStateObservable<W>, state: Readonly<W>, key: string): number | null {
    const value = observable.select(state);
    if (value !== null && !Number.isFinite(value)) {
      throw new AliveError(
        'ALIVE_INVALID_OBSERVABLE_VALUE',
        `numeric observable "${key}" returned a non-finite value`,
        { key, value },
      );
    }
    return value;
  }

  private textValue(observable: Extract<StateObservable<W>, { kind: 'text' }>, state: Readonly<W>, key: string): string | null {
    const value = observable.select(state);
    if (value !== null && typeof value !== 'string') {
      throw new AliveError(
        'ALIVE_INVALID_OBSERVABLE_VALUE',
        `text observable "${key}" returned a non-string value`,
        { key, value: String(value) },
      );
    }
    return value;
  }

  private numericSeriesValues(
    snapshot: RuntimeSnapshot<W>,
    observable: NumericStateObservable<W>,
    key: string,
    times: readonly Millis[],
  ): Map<Millis, number | null> {
    let state = snapshot.world;
    for (let i = snapshot.commitLog.length - 1; i >= 0; i -= 1) {
      state = applyPatches(state as Objectish, (snapshot.commitLog[i] as CommitRecord).inversePatches) as W;
    }
    state = freeze(state, true);

    const out = new Map<Millis, number | null>();
    let commitIndex = 0;
    for (const time of times) {
      while (
        commitIndex < snapshot.commitLog.length &&
        (snapshot.commitLog[commitIndex] as CommitRecord).virtualTime <= time
      ) {
        state = applyPatches(state as Objectish, (snapshot.commitLog[commitIndex] as CommitRecord).patches) as W;
        commitIndex += 1;
      }
      out.set(time, this.numericValue(observable, freeze(state, true), key));
    }
    return out;
  }

  private selectedObservables(keys?: readonly string[]): {
    state: readonly [string, StateObservable<W>][];
    event: readonly [string, EventObservable][];
  } {
    const stateEntries = Object.entries(this.scenario.stateObservables ?? {}) as [string, StateObservable<W>][];
    const eventEntries = Object.entries(this.scenario.eventObservables ?? {}) as [string, EventObservable][];
    if (keys === undefined) return { state: stateEntries, event: eventEntries };

    const stateMap = new Map(stateEntries);
    const eventMap = new Map(eventEntries);
    const seen = new Set<string>();
    const selectedState: [string, StateObservable<W>][] = [];
    const selectedEvent: [string, EventObservable][] = [];
    for (const key of keys) {
      if (seen.has(key)) continue;
      seen.add(key);
      const s = stateMap.get(key);
      if (s) {
        selectedState.push([key, s]);
        continue;
      }
      const e = eventMap.get(key);
      if (e) {
        selectedEvent.push([key, e]);
        continue;
      }
      throw new AliveError('ALIVE_UNKNOWN_OBSERVABLE', `unknown observable "${key}"`, { key });
    }
    return { state: selectedState, event: selectedEvent };
  }

  private occurrenceFor(snapshot: RuntimeSnapshot<W>, key: string, observable: EventObservable, horizon: Millis): Occurrence {
    const matches: { event: AliveEvent; commit: CommitRecord }[] = [];
    for (const commit of snapshot.commitLog) {
      for (const event of commit.events) {
        if (observable.match(event)) matches.push({ event, commit });
      }
    }
    if ((observable.expect ?? 'any') === 'at-most-once' && matches.length > 1) {
      throw new AliveError(
        'ALIVE_OBSERVABLE_CARDINALITY',
        `event observable "${key}" expected at most one match but found ${matches.length}`,
        { key, matches: matches.length, branchId: snapshot.branchId },
      );
    }
    const first = matches[0];
    if (!first) return Object.freeze({ status: 'not-before-horizon' as const });
    if (first.event.virtualTime <= horizon) {
      return Object.freeze({
        status: 'before-horizon' as const,
        at: first.event.virtualTime,
        eventId: first.event.id,
        commitId: first.commit.commitId,
      });
    }
    return Object.freeze({
      status: 'after-horizon' as const,
      at: first.event.virtualTime,
      eventId: first.event.id,
      commitId: first.commit.commitId,
    });
  }

  private occurrenceChanged(a: Occurrence, b: Occurrence): boolean {
    if (a.status !== b.status) return true;
    if (a.status === 'not-before-horizon' || b.status === 'not-before-horizon') return false;
    return a.at !== b.at;
  }

  private interventionMap(): Map<CommandId, ReplayIntervention> {
    const map = new Map<CommandId, ReplayIntervention>();
    for (const node of this.branches.values()) {
      for (const intervention of node.interventions) map.set(intervention.commandId, intervention);
    }
    return map;
  }

  private interventionsAfter(
    snapshot: RuntimeSnapshot<W>,
    ancestry: TimelineCursor | null,
    horizon: Millis,
    map: Map<CommandId, ReplayIntervention>,
  ): readonly ReplayIntervention[] {
    const start = ancestry === null ? 0 : this.commitCountThroughCursor(snapshot, ancestry);
    const out: ReplayIntervention[] = [];
    for (const commit of snapshot.commitLog.slice(start)) {
      if (commit.virtualTime > horizon) break;
      if (commit.source.kind !== 'intervention') continue;
      const intervention = map.get(commit.source.id as CommandId);
      if (!intervention) {
        throw new AliveError('ALIVE_REPLAY_DIVERGED', 'intervention commit lacks replay metadata', {
          branchId: snapshot.branchId,
          commandId: commit.source.id,
        });
      }
      out.push(intervention);
    }
    return Object.freeze(out);
  }

  private commitSignature(commit: CommitRecord): string {
    const events = commit.events.map((event) => ({
      id: event.id,
      type: event.type,
      commitId: event.commitId,
      virtualTime: event.virtualTime,
      withinCommitOrder: event.withinCommitOrder,
      depth: event.depth,
      actorId: event.actorId ?? null,
      entityId: event.entityId ?? null,
      slot: event.slot ?? null,
      key: event.key ?? null,
      parentEventId: event.parentEventId ?? null,
      causeId: event.causeId,
      payload: event.payload,
    }));
    return canonicalJson({
      commitId: commit.commitId,
      virtualTime: commit.virtualTime,
      source: commit.source,
      schedulerTuple: commit.schedulerTuple,
      events,
    });
  }

  private historiesMatchThrough(
    a: RuntimeSnapshot<W>,
    b: RuntimeSnapshot<W>,
    ancestry: TimelineCursor | null,
  ): boolean {
    if (ancestry === null) return false;
    const countA = this.commitCountThroughCursor(a, ancestry);
    const countB = this.commitCountThroughCursor(b, ancestry);
    if (countA !== countB) return false;
    for (let i = 0; i < countA; i += 1) {
      if (this.commitSignature(a.commitLog[i] as CommitRecord) !== this.commitSignature(b.commitLog[i] as CommitRecord)) {
        return false;
      }
    }
    return true;
  }

  private exogenousSignature(snapshot: RuntimeSnapshot<W>, horizon: Millis): string {
    const eventById = new Map<EventId, AliveEvent>();
    for (const commit of snapshot.commitLog) {
      for (const event of commit.events) eventById.set(event.id, event);
    }
    const streams: JsonValue[] = [];
    for (const stream of this.scenario.exogenous ?? []) {
      const maxOrdinal = snapshot.exogenousCursors[stream.id];
      const items: JsonValue[] = [];
      if (maxOrdinal !== undefined) {
        for (let ordinal = 0; ordinal <= maxOrdinal; ordinal += 1) {
          const id = scheduledIdExogenous(stream.id, ordinal);
          const event = eventById.get(id);
          // Streams materialise at most one pending item at a time, so once an ordinal
          // has not committed, no later ordinal can have committed either.
          if (!event) break;
          if (event.virtualTime > horizon) break;
          items.push({
            ordinal,
            id: event.id,
            at: event.virtualTime,
            type: event.type,
            actorId: event.actorId ?? null,
            key: event.key ?? null,
            payload: event.payload,
          });
        }
      }
      streams.push({ id: stream.id, items });
    }
    return canonicalJson(streams);
  }

  compareBranches(a: BranchId, b: BranchId, opts: CompareOptions): ComparisonReport {
    this.saveActiveBranchHead();

    const horizon =
      opts.until === 'scenario-end'
        ? this.scenario.endTime
        : opts.until;
    if (horizon === undefined) {
      throw new AliveError(
        'ALIVE_INVALID_HORIZON',
        'comparison requested "scenario-end" but the scenario has no endTime',
      );
    }
    assertRuntimeMillis(horizon, 'comparison.horizon');
    if (this.scenario.endTime !== undefined && horizon > this.scenario.endTime) {
      throw new AliveError('ALIVE_INVALID_HORIZON', 'comparison horizon lies after scenario.endTime', {
        horizon,
        endTime: this.scenario.endTime,
      });
    }

    const nodeA = this.assertHorizonComplete(a, horizon);
    const nodeB = this.assertHorizonComplete(b, horizon);
    const snapA = nodeA.headSnapshot;
    const snapB = nodeB.headSnapshot;
    const ancestry = this.commonAncestryOf(a, b, horizon);
    const selected = this.selectedObservables(opts.observables);

    const stateA = this.stateAtTime(snapA, horizon);
    const stateB = this.stateAtTime(snapB, horizon);
    const stateFindings: StateFinding[] = [];

    const seriesStart = Math.min(ancestry?.virtualTime ?? 0, horizon);
    const unionTimes = new Set<Millis>([seriesStart, horizon]);
    for (const commit of snapA.commitLog) {
      if (commit.virtualTime >= seriesStart && commit.virtualTime <= horizon) unionTimes.add(commit.virtualTime);
    }
    for (const commit of snapB.commitLog) {
      if (commit.virtualTime >= seriesStart && commit.virtualTime <= horizon) unionTimes.add(commit.virtualTime);
    }
    const grid = [...unionTimes].sort((x, y) => x - y);

    for (const [key, observable] of selected.state) {
      if (observable.kind === 'numeric') {
        const aAtHorizon = this.numericValue(observable, stateA, key);
        const bAtHorizon = this.numericValue(observable, stateB, key);
        let series: readonly { readonly time: Millis; readonly a: number | null; readonly b: number | null }[] | undefined;
        if (observable.sample === 'every-commit') {
          const valuesA = this.numericSeriesValues(snapA, observable, key, grid);
          const valuesB = this.numericSeriesValues(snapB, observable, key, grid);
          series = Object.freeze(
            grid.map((time) =>
              Object.freeze({ time, a: valuesA.get(time) ?? null, b: valuesB.get(time) ?? null }),
            ),
          );
        }
        const finding: NumericStateFinding = {
          kind: 'numeric',
          key,
          label: observable.label,
          ...(observable.format === undefined ? {} : { format: observable.format }),
          ...(observable.direction === undefined ? {} : { direction: observable.direction }),
          aAtHorizon,
          bAtHorizon,
          ...(aAtHorizon === null || bAtHorizon === null ? {} : { delta: bAtHorizon - aAtHorizon }),
          ...(series === undefined ? {} : { series }),
        };
        stateFindings.push(Object.freeze(finding));
      } else {
        const aAtHorizon = this.textValue(observable, stateA, key);
        const bAtHorizon = this.textValue(observable, stateB, key);
        const finding: TextStateFinding = {
          kind: 'text',
          key,
          label: observable.label,
          aAtHorizon,
          bAtHorizon,
          changed: aAtHorizon !== bAtHorizon,
        };
        stateFindings.push(Object.freeze(finding));
      }
    }

    const eventFindings: EventFinding[] = [];
    for (const [key, observable] of selected.event) {
      const oa = this.occurrenceFor(snapA, key, observable, horizon);
      const ob = this.occurrenceFor(snapB, key, observable, horizon);
      eventFindings.push(
        Object.freeze({
          key,
          label: observable.label,
          a: oa,
          b: ob,
          changed: this.occurrenceChanged(oa, ob),
        }),
      );
    }

    const interventionLookup = this.interventionMap();
    const interventionsA = this.interventionsAfter(snapA, ancestry, horizon, interventionLookup);
    const interventionsB = this.interventionsAfter(snapB, ancestry, horizon, interventionLookup);

    const blocked: string[] = [];
    if (ancestry === null || !this.historiesMatchThrough(snapA, snapB, ancestry)) {
      blocked.push('history-before-common-ancestry-is-not-identical');
    }
    if (interventionsA.length !== 0) blocked.push('baseline-has-post-ancestry-interventions');
    if (interventionsB.length !== 1) blocked.push('fork-does-not-have-exactly-one-post-ancestry-intervention');
    if (this.exogenousSignature(snapA, horizon) !== this.exogenousSignature(snapB, horizon)) {
      blocked.push('exogenous-world-diverged');
    }

    const causalCandidate = eventFindings.find(
      (finding) =>
        finding.a.status === 'before-horizon' &&
        (finding.b.status === 'not-before-horizon' || finding.b.status === 'after-horizon'),
    );
    if (!causalCandidate) blocked.push('no-selected-event-observable-shows-prevention');

    const report: ComparisonReport = {
      horizon,
      branches: Object.freeze({ a, b }),
      commonAncestry: ancestry,
      interventions: Object.freeze({ a: interventionsA, b: interventionsB }),
      stateFindings: Object.freeze(stateFindings),
      eventFindings: Object.freeze(eventFindings),
      causalLanguagePermitted: blocked.length === 0,
      ...(blocked.length === 0 && causalCandidate ? { causalEventKey: causalCandidate.key } : {}),
      ...(blocked.length === 0 ? {} : { causalLanguageBlockedBy: Object.freeze(blocked) }),
    };
    return freeze(report, true);
  }

  exportReplay(opts: ExportOptions = {}): ReplayFile {
    this.saveActiveBranchHead();
    let allow: Set<BranchId> | null = null;
    if (opts.branches) {
      allow = new Set();
      for (const requested of opts.branches) {
        let cur: BranchId | undefined = requested;
        while (cur !== undefined) {
          if (allow.has(cur)) break;
          const node = this.branches.get(cur);
          if (!node) throw new AliveError('ALIVE_UNKNOWN_BRANCH', `unknown branch "${cur}"`);
          allow.add(cur);
          cur = node.info.parentBranchId;
        }
      }
    }
    const branches: ReplayBranch[] = [];
    for (const node of this.branches.values()) {
      if (allow && !allow.has(node.info.id)) continue;
      branches.push(
        freeze(
          {
            id: node.info.id,
            ...(node.info.name === undefined ? {} : { name: node.info.name }),
            ...(node.info.parentBranchId === undefined ? {} : { parentBranchId: node.info.parentBranchId }),
            ...(node.info.forkCursor === undefined ? {} : { forkAt: node.info.forkCursor }),
            head: node.info.head,
            headCommitCount: node.headSnapshot.commitLog.length,
            ...(node.info.parentBranchId === undefined ? {} : { forkCommitCount: node.forkCommitCount }),
            interventions: Object.freeze([...node.interventions]),
            ranTo: node.info.ranTo,
          } satisfies ReplayBranch,
          true,
        ),
      );
    }
    const replay: ReplayFile = {
      formatVersion: REPLAY_FORMAT_VERSION,
      semanticsVersion: SEMANTICS_VERSION,
      engineVersion: ENGINE_VERSION,
      scenario: Object.freeze({ id: this.scenario.id, version: this.scenario.version }),
      rng: Object.freeze({ algorithm: RNG_ALGORITHM, version: RNG_VERSION, seed: this.seed }),
      branches: Object.freeze(branches),
      activeBranchId: allow && !allow.has(this.activeBranchId)
        ? (branches.at(-1)?.id ?? ROOT_BRANCH_ID)
        : this.activeBranchId,
    };
    assertJsonSafe(replay, 'replay');
    return freeze(replay, true);
  }

  loadReplay(replay: ReplayFile): void {
    const backupRuntime = this.captureRuntime();
    const backupBranches = this.cloneBranchGraph();
    const backupActive = this.activeBranchId;
    const backupViewMode = this.viewMode;
    const backupViewWorld = this.viewWorld;
    const backupScrubCursor = this.scrubCursor;
    replay = snapshotJson(replay, 'replay') as unknown as ReplayFile;
    try {
      if (replay.formatVersion !== REPLAY_FORMAT_VERSION ||
          replay.semanticsVersion !== SEMANTICS_VERSION ||
          replay.scenario.id !== this.scenario.id ||
          replay.scenario.version !== this.scenario.version ||
          replay.rng.algorithm !== RNG_ALGORITHM ||
          replay.rng.version !== RNG_VERSION ||
          replay.rng.seed !== this.seed) {
        throw new AliveError('ALIVE_REPLAY_INCOMPATIBLE', 'replay is incompatible with this simulation', {
          replayFormat: replay.formatVersion, semantics: replay.semanticsVersion,
          scenario: replay.scenario, rng: replay.rng,
        });
      }
      const replayIds = new Set<BranchId>();
      for (const b of replay.branches) {
        if (replayIds.has(b.id)) throw new AliveError('ALIVE_REPLAY_INCOMPATIBLE', 'replay contains duplicate branch ids', { branchId: b.id });
        replayIds.add(b.id);
        if (!Number.isSafeInteger(b.headCommitCount) || b.headCommitCount < 0) {
          throw new AliveError('ALIVE_REPLAY_INCOMPATIBLE', 'invalid replay head commit count', { branchId: b.id, headCommitCount: b.headCommitCount });
        }
        if (b.head.branchId !== b.id || b.head.virtualTime !== b.ranTo) {
          throw new AliveError('ALIVE_REPLAY_INCOMPATIBLE', 'branch head cursor is inconsistent', { branchId: b.id, head: b.head, ranTo: b.ranTo });
        }
        if (b.parentBranchId !== undefined) {
          if (!b.forkAt || b.forkCommitCount === undefined || !Number.isSafeInteger(b.forkCommitCount) || b.forkCommitCount < 0 || b.forkCommitCount > b.headCommitCount) {
            throw new AliveError('ALIVE_REPLAY_INCOMPATIBLE', 'invalid child fork metadata', { branchId: b.id });
          }
          if (b.forkAt.branchId !== b.parentBranchId) {
            throw new AliveError('ALIVE_REPLAY_INCOMPATIBLE', 'fork cursor must belong to parent branch', { branchId: b.id, parentBranchId: b.parentBranchId, forkAt: b.forkAt });
          }
        }
        for (const intervention of b.interventions) {
          if (intervention.anchor.branchId !== b.id || intervention.priority !== PRIORITY.intervention || intervention.virtualTime !== intervention.anchor.virtualTime) {
            throw new AliveError('ALIVE_REPLAY_INCOMPATIBLE', 'invalid replay intervention metadata', { branchId: b.id, commandId: intervention.commandId });
          }
        }
      }
      const root = replay.branches.find((b) => b.id === ROOT_BRANCH_ID);
      if (!root) throw new AliveError('ALIVE_REPLAY_INCOMPATIBLE', 'replay has no root branch');

      this.branches.clear();
      this.resetRuntimeToRootInitial();
      const rootCursor = this.liveCursor(ROOT_BRANCH_ID);
      const initial = this.captureRuntime();
      this.branches.set(ROOT_BRANCH_ID, {
        info: Object.freeze({
          id: ROOT_BRANCH_ID,
          ...(root.name === undefined ? { name: 'Baseline' } : { name: root.name }),
          createdBy: Object.freeze({ type: 'system' as const, description: 'root branch' }),
          createdAt: 0,
          ranTo: 0,
          head: rootCursor,
        }),
        interventions: [...root.interventions],
        checkpoints: [Object.freeze({ commitCount: 0, cursor: rootCursor, snapshot: initial })],
        headSnapshot: initial,
        forkCommitCount: 0,
        forkOrdinals: new Map(),
      });

      const rootTarget: ResolvedCursor = { commitCount: root.headCommitCount, cursor: root.head };
      const rootHead = this.reconstructBranchTo(ROOT_BRANCH_ID, rootTarget);
      const rootNode = this.branches.get(ROOT_BRANCH_ID) as BranchNode<W>;
      rootNode.headSnapshot = rootHead;
      rootNode.info = Object.freeze({ ...rootNode.info, ranTo: root.ranTo, head: root.head });

      const pending = replay.branches.filter((b) => b.id !== ROOT_BRANCH_ID);
      const built = new Set<BranchId>([ROOT_BRANCH_ID]);
      while (pending.length > 0) {
        const idx = pending.findIndex((b) => b.parentBranchId !== undefined && built.has(b.parentBranchId));
        if (idx < 0) throw new AliveError('ALIVE_REPLAY_INCOMPATIBLE', 'replay branch graph is cyclic or references a missing parent');
        const rb = pending.splice(idx, 1)[0] as ReplayBranch;
        const parentId = rb.parentBranchId as BranchId;
        const parentNode = this.branches.get(parentId) as BranchNode<W>;
        if (!rb.forkAt || rb.forkCommitCount === undefined) {
          throw new AliveError('ALIVE_REPLAY_INCOMPATIBLE', 'child branch lacks fork metadata', { branchId: rb.id });
        }
        const parentTarget: ResolvedCursor = {
          commitCount: rb.forkCommitCount,
          cursor: Object.freeze({ ...rb.forkAt, branchId: parentId }),
        };
        const atFork = this.reconstructBranchTo(parentId, parentTarget);
        this.restoreRuntime(atFork, parentId);
        this.retagRuntimeBranch(rb.id);
        const childCursor = Object.freeze({ ...rb.forkAt, branchId: rb.id });
        const initialChild = this.captureRuntime();
        this.branches.set(rb.id, {
          info: Object.freeze({
            id: rb.id,
            ...(rb.name === undefined ? {} : { name: rb.name }),
            parentBranchId: parentId,
            forkCursor: rb.forkAt,
            createdBy: Object.freeze({ type: 'user' as const }),
            createdAt: rb.forkAt.virtualTime,
            ranTo: rb.forkAt.virtualTime,
            head: childCursor,
          }),
          interventions: [...rb.interventions],
          checkpoints: [Object.freeze({ commitCount: rb.forkCommitCount, cursor: childCursor, snapshot: initialChild })],
          headSnapshot: initialChild,
          forkCommitCount: rb.forkCommitCount,
          forkOrdinals: new Map(),
        });
        const childTarget: ResolvedCursor = { commitCount: rb.headCommitCount, cursor: rb.head };
        const childHead = this.reconstructBranchTo(rb.id, childTarget);
        const childNode = this.branches.get(rb.id) as BranchNode<W>;
        childNode.headSnapshot = childHead;
        childNode.info = Object.freeze({ ...childNode.info, ranTo: rb.ranTo, head: rb.head });
        const forkKey = anchorKey(rb.forkAt);
        parentNode.forkOrdinals.set(forkKey, (parentNode.forkOrdinals.get(forkKey) ?? 0) + 1);
        built.add(rb.id);
      }

      const active = this.branches.get(replay.activeBranchId);
      if (!active) throw new AliveError('ALIVE_REPLAY_INCOMPATIBLE', 'active replay branch is missing');
      this.restoreRuntime(active.headSnapshot, replay.activeBranchId);
      this.emitTimeline('replay-load', this.liveCursor());
    } catch (error) {
      this.restoreBranchGraph(backupBranches);
      this.restoreRuntime(backupRuntime, backupActive);
      this.viewMode = backupViewMode;
      this.viewWorld = backupViewWorld;
      this.scrubCursor = backupScrubCursor;
      throw error;
    }
  }
  reset(): void {
    this.branches.clear();
    this.resetRuntimeToRootInitial();
    const cursor = this.liveCursor(ROOT_BRANCH_ID);
    const snap = this.captureRuntime();
    this.branches.set(ROOT_BRANCH_ID, {
      info: Object.freeze({
        id: ROOT_BRANCH_ID,
        name: 'Baseline',
        createdBy: Object.freeze({ type: 'system' as const, description: 'root branch' }),
        createdAt: 0,
        ranTo: 0,
        head: cursor,
      }),
      interventions: [],
      checkpoints: [Object.freeze({ commitCount: 0, cursor, snapshot: snap })],
      headSnapshot: snap,
      forkCommitCount: 0,
      forkOrdinals: new Map(),
    });
    this.emitTimeline('reset', cursor);
  }

  // ---------------------------------------------------------------- reads

  getState(): Readonly<W> {
    return this.viewMode === 'scrubbing' && this.viewWorld !== null ? this.viewWorld : this.world;
  }

  getHeadState(): Readonly<W> {
    return this.world;
  }

  getTime(): Millis {
    return this.viewMode === 'scrubbing' && this.scrubCursor !== null
      ? this.scrubCursor.virtualTime
      : this.headTime;
  }

  getHeadTime(): Millis {
    return this.headTime;
  }

  getViewMode(): ViewMode {
    return this.viewMode;
  }

  getRunState(): RunState {
    return this.runState;
  }

  getFault(): FaultInfo | undefined {
    return this.fault === undefined ? undefined : Object.freeze({ ...this.fault });
  }

  /** Errors thrown by notification listeners. Never affects simulation state (item 12). */
  getListenerErrors(): readonly ListenerError[] {
    return Object.freeze([...this.listenerErrors]);
  }

  getBranchId(): BranchId {
    return this.activeBranchId;
  }

  getCommits(): readonly CommitRecord[] {
    return Object.freeze([...this.commitLog]);
  }

  getEvents(): readonly AliveEvent[] {
    return Object.freeze(this.commitLog.flatMap((c) => c.events));
  }

  getPendingSources(): readonly CommitSource[] {
    return Object.freeze([...this.frontier.pendingSorted()]);
  }

  getNextSequence(): number {
    return this.nextSequence;
  }

  getInstantGuard(): Readonly<InstantGuard> {
    return Object.freeze({ ...this.instantGuard });
  }

  getExogenousCursors(): Readonly<Record<string, number>> {
    return Object.freeze({ ...this.exogenousCursors });
  }

  getCursor(): TimelineCursor {
    return this.viewMode === 'scrubbing' && this.scrubCursor !== null
      ? this.scrubCursor
      : this.liveCursor();
  }

  on(channel: 'committed', fn: (n: CommitNotification) => void): Unsubscribe;
  on(channel: 'timeline:changed', fn: (n: TimelineChangeNotification) => void): Unsubscribe;
  on(channel: 'error', fn: (e: ListenerError) => void): Unsubscribe;
  on(
    channel: 'committed' | 'timeline:changed' | 'error',
    fn: (n: never) => void,
  ): Unsubscribe {
    if (channel === 'error') {
      const l = fn as unknown as (e: ListenerError) => void;
      this.errorListeners.push(l);
      return () => {
        const i = this.errorListeners.indexOf(l);
        if (i >= 0) this.errorListeners.splice(i, 1);
      };
    }
    if (channel === 'committed') {
      const l = fn as unknown as (n: CommitNotification) => void;
      this.commitListeners.push(l);
      return () => {
        const i = this.commitListeners.indexOf(l);
        if (i >= 0) this.commitListeners.splice(i, 1);
      };
    }
    const l = fn as unknown as (n: TimelineChangeNotification) => void;
    this.timelineListeners.push(l);
    return () => {
      const i = this.timelineListeners.indexOf(l);
      if (i >= 0) this.timelineListeners.splice(i, 1);
    };
  }

  dispose(): void {
    this.commitListeners.length = 0;
    this.timelineListeners.length = 0;
    this.errorListeners.length = 0;
  }
}

export function createSimulation<W>(options: CreateSimulationOptions<W>): Simulation<W> {
  return new Simulation(options);
}
