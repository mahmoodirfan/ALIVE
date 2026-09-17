/** Public kernel types (ARCHITECTURE §3, §4). */
import type { Draft, Patch } from 'immer';
import type { JsonValue } from './json.js';
import type { RandomApi } from './rng.js';

export type Millis = number;
export type BranchId = string;
export type CommitId = string;
export type EventId = string;
export type ScheduledId = string;
export type CommandId = string;

export type ViewMode = 'live' | 'scrubbing';
export type RunState = 'ready' | 'ended' | 'faulted';

/** INV-17: fixed, versioned priority bands. Lower executes first. Priority 0 is intervention-only. */
export const PRIORITY = {
  intervention: 0,
  exogenous: 10,
  domain: 20,
  derived: 30,
  observation: 40,
} as const;

export interface AliveEvent<T = JsonValue> {
  readonly id: EventId;
  readonly type: string;
  readonly commitId: CommitId;
  readonly virtualTime: Millis;
  readonly withinCommitOrder: number;
  readonly depth: number;
  readonly actorId?: string;
  readonly entityId?: string;
  readonly slot?: string;
  readonly key?: string;
  readonly parentEventId?: EventId;
  readonly causeId: string;
  readonly payload: T;
}

export type ScheduledOrigin = 'bootstrap' | 'exogenous' | 'handler';

export interface ScheduledItem<P = JsonValue> {
  readonly scheduledId: ScheduledId;
  readonly virtualTime: Millis;
  readonly priority: number;
  readonly sequence: number;
  readonly type: string;
  readonly payload: P;
  readonly actorId?: string;
  readonly entityId?: string;
  readonly slot?: string;
  readonly key?: string;
  readonly parentEventId?: EventId;
  readonly origin: ScheduledOrigin;
  readonly streamId?: string;
  readonly ordinal?: number;
}

export interface TimelineCursor {
  readonly virtualTime: Millis;
  readonly afterCommitId: CommitId | null;
  readonly branchId: BranchId;
}

export interface SerializableCommand<P = JsonValue> {
  readonly type: string;
  readonly payload: P;
}

export interface InterventionItem {
  readonly commandId: CommandId;
  readonly anchor: TimelineCursor;
  readonly virtualTime: Millis;
  readonly priority: number;
  readonly sequence: number;
  readonly command: SerializableCommand;
}

export type CommitSource =
  | { readonly kind: 'scheduled'; readonly item: ScheduledItem }
  | { readonly kind: 'intervention'; readonly item: InterventionItem };

export interface CommandRejection {
  readonly code:
    | 'ALIVE_HISTORICAL_VIEW'
    | 'ALIVE_UNKNOWN_COMMAND'
    | 'ALIVE_INVALID_COMMAND'
    | 'ALIVE_PRECONDITION_FAILED';
  readonly message: string;
  readonly details?: JsonValue;
}

export interface EmitSpec<P = JsonValue> {
  type: string;
  payload: P;
  actorId?: string;
  entityId?: string;
  slot?: string;
  key?: string;
}

export interface ScheduleSpec<P = JsonValue> {
  type: string;
  virtualTime: Millis;
  payload: P;
  priority?: number;
  actorId?: string;
  entityId?: string;
  slot?: string;
  key?: string;
}

export interface HandlerContext<W> {
  readonly time: Millis;
  readonly commitId: CommitId;
  readonly random: RandomApi;
  emit(spec: EmitSpec): void;
  schedule(spec: ScheduleSpec): ScheduledId;
  cancel(scheduledId: ScheduledId): boolean;
  reschedule(scheduledId: ScheduledId, virtualTime: Millis): boolean;
}

export type EventHandler<W> = (
  draft: Draft<W>,
  event: AliveEvent,
  ctx: HandlerContext<W>,
) => void;

export interface CommandContext {
  readonly time: Millis;
  readonly commandId: CommandId;
  readonly commitId: CommitId;
  readonly random: RandomApi;
}

/** INV-76: command handlers emit event specs; they never mutate world state. */
export interface CommandHandler<W> {
  validate?(state: Readonly<W>, command: SerializableCommand): CommandRejection | void;
  events(
    state: Readonly<W>,
    command: SerializableCommand,
    ctx: CommandContext,
  ): readonly EmitSpec[];
}

/** INV-77: rules emit events; they never mutate the draft. */
export interface RuleDefinition<W> {
  id: string;
  when: string | readonly string[];
  if?(state: Readonly<W>, event: AliveEvent): boolean;
  emit(state: Readonly<W>, event: AliveEvent): readonly EmitSpec[];
}

export interface ExogenousItem {
  virtualTime: Millis;
  type: string;
  payload: JsonValue;
  actorId?: string;
  key?: string;
}

/** INV-38: receives no world state, by signature. */
export interface ExogenousStream {
  id: string;
  from: Millis;
  until?: Millis;
  next(args: { ordinal: number; lastTime: Millis; random: RandomApi }): ExogenousItem | null;
}

export interface BootstrapItem<P = JsonValue> {
  key: string;
  type: string;
  virtualTime: Millis;
  payload: P;
  priority?: number;
  actorId?: string;
  entityId?: string;
  slot?: string;
}

export interface InitContext {
  readonly epoch: string;
  readonly random: RandomApi;
}


export type ObservableFormat = "currency" | "integer" | "percent" | "text";
export type ObservableDirection = "higher-is-better" | "lower-is-better" | "neutral";

export interface NumericStateObservable<W> {
  readonly kind: "numeric";
  readonly label: string;
  readonly select: (state: Readonly<W>) => number | null;
  readonly format?: Exclude<ObservableFormat, "text">;
  readonly sample: "at-horizon" | "every-commit";
  readonly direction?: ObservableDirection;
}

export interface TextStateObservable<W> {
  readonly kind: "text";
  readonly label: string;
  readonly select: (state: Readonly<W>) => string | null;
  readonly format?: "text";
  readonly sample: "at-horizon";
}

export type StateObservable<W> = NumericStateObservable<W> | TextStateObservable<W>;

export interface EventObservable {
  readonly label: string;
  readonly match: (event: AliveEvent) => boolean;
  readonly expect?: "at-most-once" | "any";
}

export interface Scenario<W> {
  id: string;
  version: string;
  name: string;
  epoch: string;
  endTime?: Millis;
  initialState: (ctx: InitContext) => W;
  events: Record<string, EventHandler<W>>;
  commands: Record<string, CommandHandler<W>>;
  rules?: readonly RuleDefinition<W>[];
  exogenous?: readonly ExogenousStream[];
  bootstrap?: readonly BootstrapItem[];
  stateObservables?: Readonly<Record<string, StateObservable<W>>>;
  eventObservables?: Readonly<Record<string, EventObservable>>;
}

export interface SafetyLimits {
  maxCausalDepth: number;
  maxEventsPerCommit: number;
  maxCommitsPerInstant: number;
}

export const DEFAULT_LIMITS: SafetyLimits = {
  maxCausalDepth: 32,
  maxEventsPerCommit: 512,
  maxCommitsPerInstant: 4096,
};

export interface CommitRecord {
  readonly commitId: CommitId;
  readonly branchId: BranchId;
  readonly virtualTime: Millis;
  readonly source: { kind: 'scheduled' | 'intervention'; id: ScheduledId | CommandId };
  readonly schedulerTuple: { virtualTime: Millis; priority: number; sequence: number };
  readonly events: readonly AliveEvent[];
  readonly patches: readonly Patch[];
  readonly inversePatches: readonly Patch[];
}

export interface CommitNotification {
  readonly commitId: CommitId;
  readonly branchId: BranchId;
  readonly virtualTime: Millis;
  readonly events: readonly AliveEvent[];
}

export type TimelineChangeReason =
  | 'scrub-enter'
  | 'scrub-move'
  | 'scrub-exit'
  | 'fork'
  | 'branch-switch'
  | 'reset'
  | 'replay-load';

export interface TimelineChangeNotification {
  readonly reason: TimelineChangeReason;
  readonly branchId: BranchId;
  readonly cursor: TimelineCursor | null;
  readonly invalidateAll: boolean;
}

export type Unsubscribe = () => void;

export interface RunResult {
  readonly commits: number;
  readonly eventsProcessed: number;
  readonly virtualTime: Millis;
  readonly stoppedBecause: 'target-reached' | 'scenario-end';
}

export interface StepResult {
  readonly committed: boolean;
  readonly commitId?: CommitId;
  readonly eventsProcessed: number;
  readonly virtualTime: Millis;
  readonly stoppedBecause: 'committed' | 'no-work' | 'scenario-end';
}

export interface DispatchResult {
  readonly accepted: boolean;
  readonly rejection?: CommandRejection;
  readonly commandId?: CommandId;
  readonly commitId?: CommitId;
  readonly emitted?: readonly EventId[];
}

export interface InstantGuard {
  readonly at: Millis | null;
  readonly count: number;
}

export type TimelineCursorInput =
  | { readonly time: Millis }
  | { readonly afterCommitId: CommitId }
  | { readonly commitIndex: number };

export interface ForkOptions {
  readonly name?: string;
  readonly description?: string;
}

export interface Branch {
  readonly id: BranchId;
  readonly name?: string;
  readonly parentBranchId?: BranchId;
  readonly forkCursor?: TimelineCursor;
  readonly createdBy: { readonly type: 'user' | 'system'; readonly description?: string };
  readonly createdAt: Millis;
  readonly ranTo: Millis;
  readonly head: TimelineCursor;
}

export interface ReplayIntervention {
  readonly commandId: CommandId;
  readonly anchor: TimelineCursor;
  readonly command: SerializableCommand;
  readonly virtualTime: Millis;
  readonly priority: number;
  readonly sequence: number;
}

export interface ReplayBranch {
  readonly id: BranchId;
  readonly name?: string;
  readonly parentBranchId?: BranchId;
  readonly forkAt?: TimelineCursor;
  readonly head: TimelineCursor;
  readonly headCommitCount: number;
  readonly forkCommitCount?: number;
  readonly interventions: readonly ReplayIntervention[];
  readonly ranTo: Millis;
}

export interface ReplayFile {
  readonly formatVersion: 1;
  readonly semanticsVersion: number;
  readonly engineVersion: string;
  readonly scenario: { readonly id: string; readonly version: string };
  readonly rng: { readonly algorithm: string; readonly version: number; readonly seed: string };
  readonly branches: readonly ReplayBranch[];
  readonly activeBranchId: BranchId;
}

export interface ExportOptions {
  readonly branches?: readonly BranchId[];
}

export interface TimelineCheckpoint<W> {
  readonly branchId: BranchId;
  readonly cursor: TimelineCursor;
  readonly world: W;
  readonly pending: readonly ScheduledItem[];
  readonly nextSequence: number;
  readonly exogenousCursors: Readonly<Record<string, number>>;
  readonly scenarioId: string;
  readonly scenarioVersion: string;
  readonly rngVersion: number;
  readonly semanticsVersion: number;
  readonly engineVersion: string;
}

export interface CompareOptions {
  readonly until: Millis | "scenario-end";
  readonly observables?: readonly string[];
}

export interface NumericSeriesPoint {
  readonly time: Millis;
  readonly a: number | null;
  readonly b: number | null;
}

export interface NumericStateFinding {
  readonly kind: "numeric";
  readonly key: string;
  readonly label: string;
  readonly format?: Exclude<ObservableFormat, "text">;
  readonly direction?: ObservableDirection;
  readonly aAtHorizon: number | null;
  readonly bAtHorizon: number | null;
  readonly delta?: number;
  readonly series?: readonly NumericSeriesPoint[];
}

export interface TextStateFinding {
  readonly kind: "text";
  readonly key: string;
  readonly label: string;
  readonly aAtHorizon: string | null;
  readonly bAtHorizon: string | null;
  readonly changed: boolean;
}

export type StateFinding = NumericStateFinding | TextStateFinding;

export type Occurrence =
  | { readonly status: "before-horizon"; readonly at: Millis; readonly eventId: EventId; readonly commitId: CommitId }
  | { readonly status: "not-before-horizon" }
  | { readonly status: "after-horizon"; readonly at: Millis; readonly eventId: EventId; readonly commitId: CommitId };

export interface EventFinding {
  readonly key: string;
  readonly label: string;
  readonly a: Occurrence;
  readonly b: Occurrence;
  readonly changed: boolean;
}

export interface ComparisonReport {
  readonly horizon: Millis;
  readonly branches: { readonly a: BranchId; readonly b: BranchId };
  readonly commonAncestry: TimelineCursor | null;
  readonly interventions: {
    readonly a: readonly ReplayIntervention[];
    readonly b: readonly ReplayIntervention[];
  };
  readonly stateFindings: readonly StateFinding[];
  readonly eventFindings: readonly EventFinding[];
  readonly causalLanguagePermitted: boolean;
  readonly causalEventKey?: string;
  readonly causalLanguageBlockedBy?: readonly string[];
}

export interface CreateSimulationOptions<W> {
  scenario: Scenario<W>;
  seed: string;
  limits?: Partial<SafetyLimits>;
  checkpointEvery?: number;
}
