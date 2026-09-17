/**
 * Deterministic identity derivation (DETERMINISM §5-§10).
 * Nothing here consumes `sequence` (INV-13), `withinCommitOrder` (INV-14),
 * a UUID or a clock.
 */
import { hashHex } from './hash.js';
import type { TupleComponent } from './encoding.js';
import { canonicalJson } from './json.js';
import type { JsonValue } from './json.js';

export const ROOT_BRANCH_ID = 'branch:root';

export interface Discriminator {
  readonly key?: string | undefined;
  readonly slot?: string | undefined;
  readonly entityId?: string | undefined;
  readonly actorId?: string | undefined;
}

/**
 * key ?? slot ?? entityId ?? actorId, or an explicit null component.
 * Absent must not collide with empty string (INV-75).
 */
export function discriminatorComponent(d: Discriminator): TupleComponent {
  const v = d.key ?? d.slot ?? d.entityId ?? d.actorId;
  return v === undefined ? (['z', null] as const) : (['s', v] as const);
}

export function scheduledIdBootstrap(
  scenarioId: string,
  scenarioVersion: string,
  key: string,
): string {
  return `sch:${hashHex([
    ['s', 'bootstrap'],
    ['s', scenarioId],
    ['s', scenarioVersion],
    ['s', key],
  ])}`;
}

export function scheduledIdExogenous(streamId: string, ordinal: number): string {
  return `sch:${hashHex([
    ['s', 'exo'],
    ['s', streamId],
    ['i', ordinal],
  ])}`;
}

export function scheduledIdHandler(
  parentEventId: string,
  type: string,
  d: Discriminator,
): string {
  return `sch:${hashHex([
    ['s', 'sched'],
    ['s', parentEventId],
    ['s', type],
    discriminatorComponent(d),
  ])}`;
}

export function eventIdFromCommand(commandId: string, type: string, d: Discriminator): string {
  return `evt:${hashHex([
    ['s', commandId],
    ['s', type],
    discriminatorComponent(d),
  ])}`;
}

export function eventIdChild(parentEventId: string, type: string, d: Discriminator): string {
  return `evt:${hashHex([
    ['s', parentEventId],
    ['s', type],
    discriminatorComponent(d),
  ])}`;
}

export function commitIdForScheduled(scheduledId: string): string {
  return `commit:${scheduledId}`;
}

export function commitIdForIntervention(commandId: string): string {
  return `commit:${commandId}`;
}

export interface AnchorLike {
  readonly virtualTime: number;
  readonly afterCommitId: string | null;
}

export function anchorKey(a: AnchorLike): string {
  return `${a.virtualTime}|${a.afterCommitId ?? ''}`;
}

export function deriveCommandId(
  branchId: string,
  anchor: AnchorLike,
  type: string,
  payload: JsonValue,
  nthAtAnchor: number,
): string {
  return `cmd:${hashHex([
    ['s', branchId],
    ['i', anchor.virtualTime],
    anchor.afterCommitId === null
      ? (['z', null] as const)
      : (['s', anchor.afterCommitId] as const),
    ['s', type],
    ['s', canonicalJson(payload)],
    ['i', nthAtAnchor],
  ])}`;
}

export function deriveBranchId(
  parentBranchId: string,
  forkCursor: AnchorLike,
  forkOrdinalAtCursor: number,
): string {
  return `branch:${hashHex([
    ['s', 'branch'],
    ['s', parentBranchId],
    ['i', forkCursor.virtualTime],
    forkCursor.afterCommitId === null
      ? (['z', null] as const)
      : (['s', forkCursor.afterCommitId] as const),
    ['i', forkOrdinalAtCursor],
  ])}`;
}
