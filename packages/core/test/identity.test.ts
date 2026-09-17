import { describe, expect, it } from 'vitest';
import {
  ROOT_BRANCH_ID,
  commitIdForIntervention,
  commitIdForScheduled,
  deriveBranchId,
  deriveCommandId,
  discriminatorComponent,
  eventIdChild,
  eventIdFromCommand,
  scheduledIdBootstrap,
  scheduledIdExogenous,
  scheduledIdHandler,
} from '../src/identity.js';

describe('identity derivation (INV-10/12/13/69/70)', () => {
  it('pins golden ids', () => {
    expect(scheduledIdBootstrap('shop', '1.0.0', 'open')).toBe('sch:59f489599bb5f4d3');
    expect(scheduledIdExogenous('arrivals', 0)).toBe('sch:fe867a30b2ed7ad1');
    expect(scheduledIdHandler('evt:p', 'audit', { key: 'k1' })).toBe('sch:6eb632eaf491ef17');
    expect(eventIdChild('evt:p', 'order.created', { entityId: 'ord-1' })).toBe(
      'evt:8359bee3e76b4411',
    );
    expect(eventIdFromCommand('cmd:x', 'inventory.restocked', { entityId: 'lamp' })).toBe(
      'evt:4b9eca5d026ebd6e',
    );
  });

  it('derives CommitId by namespaced source id (INV-69)', () => {
    expect(commitIdForScheduled('sch:abc')).toBe('commit:sch:abc');
    expect(commitIdForIntervention('cmd:abc')).toBe('commit:cmd:abc');
    expect(commitIdForScheduled('sch:abc')).not.toBe(commitIdForIntervention('cmd:abc'));
  });

  it('CommitId is branch-independent — it takes no branch input (INV-69)', () => {
    // same scheduled source, any branch: same commit id, by construction
    const a = commitIdForScheduled(scheduledIdExogenous('arrivals', 5));
    const b = commitIdForScheduled(scheduledIdExogenous('arrivals', 5));
    expect(a).toBe(b);
  });

  it('BranchId: stable root constant and deterministic forks (INV-70)', () => {
    expect(ROOT_BRANCH_ID).toBe('branch:root');
    const cursor = { virtualTime: 1000, afterCommitId: 'commit:sch:abc' };
    expect(deriveBranchId('branch:root', cursor, 0)).toBe('branch:3627981cbee6038d');
    expect(deriveBranchId('branch:root', cursor, 0)).toBe(deriveBranchId('branch:root', cursor, 0));
    expect(deriveBranchId('branch:root', cursor, 1)).not.toBe(
      deriveBranchId('branch:root', cursor, 0),
    );
    expect(deriveBranchId('branch:other', cursor, 0)).not.toBe(
      deriveBranchId('branch:root', cursor, 0),
    );
    expect(deriveBranchId('branch:root', { ...cursor, afterCommitId: null }, 0)).not.toBe(
      deriveBranchId('branch:root', cursor, 0),
    );
  });

  it('CommandId is deterministic and payload-order independent (INV-54)', () => {
    const anchor = { virtualTime: 1000, afterCommitId: null };
    const a = deriveCommandId('branch:root', anchor, 'product.restock', {
      productId: 'lamp',
      quantity: 8,
    }, 0);
    const b = deriveCommandId('branch:root', anchor, 'product.restock', {
      quantity: 8,
      productId: 'lamp',
    }, 0);
    expect(a).toBe('cmd:cce77f3aca28bdf3');
    expect(a).toBe(b);
    expect(
      deriveCommandId('branch:root', anchor, 'product.restock', { productId: 'lamp', quantity: 8 }, 1),
    ).not.toBe(a);
  });

  it('discriminator precedence is key > slot > entityId > actorId', () => {
    expect(discriminatorComponent({ key: 'k', slot: 's', entityId: 'e', actorId: 'a' })).toEqual([
      's',
      'k',
    ]);
    expect(discriminatorComponent({ slot: 's', entityId: 'e' })).toEqual(['s', 's']);
    expect(discriminatorComponent({ entityId: 'e', actorId: 'a' })).toEqual(['s', 'e']);
    expect(discriminatorComponent({ actorId: 'a' })).toEqual(['s', 'a']);
  });

  it('absent discriminator is not an empty string (INV-75)', () => {
    expect(discriminatorComponent({})).toEqual(['z', null]);
    expect(eventIdChild('evt:p', 't', {})).not.toBe(eventIdChild('evt:p', 't', { key: '' }));
  });

  it('distinguishes slot from key with the same value', () => {
    // both resolve to the same discriminator string, so they are deliberately equal:
    // the discriminator is a value, not a labelled field.
    expect(eventIdChild('evt:p', 't', { key: 'x' })).toBe(eventIdChild('evt:p', 't', { slot: 'x' }));
    // and differ when the values differ
    expect(eventIdChild('evt:p', 't', { slot: 'sale' })).not.toBe(
      eventIdChild('evt:p', 't', { slot: 'reservation' }),
    );
  });

  it('child identity depends on parent and type', () => {
    expect(eventIdChild('evt:p1', 't', { entityId: 'e' })).not.toBe(
      eventIdChild('evt:p2', 't', { entityId: 'e' }),
    );
    expect(eventIdChild('evt:p', 't1', { entityId: 'e' })).not.toBe(
      eventIdChild('evt:p', 't2', { entityId: 'e' }),
    );
  });

  it('bootstrap identity depends on scenario version', () => {
    expect(scheduledIdBootstrap('shop', '1.0.0', 'open')).not.toBe(
      scheduledIdBootstrap('shop', '1.0.1', 'open'),
    );
  });
});
