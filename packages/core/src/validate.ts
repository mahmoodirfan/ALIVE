/**
 * Scenario declaration validation. Runs before any work is seeded so malformed time,
 * priority, identity and JSON declarations fail deterministically at construction.
 */
import { AliveError } from './errors.js';
import { assertJsonSafe } from './json.js';
import type { SafetyLimits, Scenario } from './types.js';

function bad(message: string, details: Record<string, unknown> = {}): never {
  throw new AliveError('ALIVE_INVALID_SCENARIO', message, details);
}

export function isSafeMillis(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export function isScheduledPriority(value: number): boolean {
  // Priority 0 is reserved exclusively for user interventions.
  return Number.isSafeInteger(value) && value >= 1;
}

function requireTime(value: number, label: string): void {
  if (!isSafeMillis(value)) {
    bad(`${label} must be a non-negative safe-integer millisecond value`, { label, value });
  }
}

function requirePriority(value: number, label: string): void {
  if (!isScheduledPriority(value)) {
    bad(`${label} must be a safe integer >= 1; priority 0 is reserved for interventions`, {
      label,
      value,
    });
  }
}

export function validateLimits(limits: SafetyLimits): void {
  for (const [k, v] of Object.entries(limits)) {
    if (!Number.isSafeInteger(v) || v < 1) {
      bad(`limit "${k}" must be a positive safe integer`, { limit: k, value: v });
    }
  }
}

export function validateScenario<W>(scenario: Scenario<W>): void {
  if (!scenario.id) bad('scenario requires an id');
  if (!scenario.version) bad('scenario requires a version');
  if (scenario.endTime !== undefined) requireTime(scenario.endTime, 'scenario.endTime');

  const bootstrapKeys = new Set<string>();
  (scenario.bootstrap ?? []).forEach((b, i) => {
    const at = `bootstrap[${i}]`;
    if (!b.key) bad(`${at} requires a stable \`key\``, { index: i, type: b.type });
    if (bootstrapKeys.has(b.key)) bad(`duplicate bootstrap key "${b.key}"`, { key: b.key });
    bootstrapKeys.add(b.key);
    if (!b.type) bad(`${at} requires a \`type\``, { key: b.key });
    requireTime(b.virtualTime, `${at}.virtualTime`);
    if (b.priority !== undefined) requirePriority(b.priority, `${at}.priority`);
    // Work after scenario.endTime is permitted: the clock simply never reaches it.
    assertJsonSafe(b.payload, `${at}.payload`);
  });

  const streamIds = new Set<string>();
  (scenario.exogenous ?? []).forEach((s, i) => {
    const at = `exogenous[${i}]`;
    if (!s.id) bad(`${at} requires an id`, { index: i });
    if (streamIds.has(s.id)) bad(`duplicate exogenous stream id "${s.id}"`, { streamId: s.id });
    streamIds.add(s.id);
    requireTime(s.from, `${at}.from`);
    if (s.until !== undefined) {
      requireTime(s.until, `${at}.until`);
      if (s.until < s.from) {
        bad(`${at}.until is before ${at}.from`, {
          streamId: s.id,
          from: s.from,
          until: s.until,
        });
      }
    }
  });

  const ruleIds = new Set<string>();
  (scenario.rules ?? []).forEach((r, i) => {
    const at = `rules[${i}]`;
    if (!r.id) bad(`${at} requires an id`, { index: i });
    if (ruleIds.has(r.id)) bad(`duplicate rule id "${r.id}"`, { ruleId: r.id });
    ruleIds.add(r.id);
    const when = typeof r.when === 'string' ? [r.when] : r.when;
    if (when.length === 0) bad(`${at}.when must name at least one event type`, { ruleId: r.id });
  });

  const observableKeys = new Set<string>();
  for (const [key, observable] of Object.entries(scenario.stateObservables ?? {})) {
    if (!key) bad('state observable requires a non-empty key');
    if (observableKeys.has(key)) bad(`duplicate observable key "${key}"`, { key });
    observableKeys.add(key);
    if (!observable.label) bad(`state observable "${key}" requires a label`, { key });
    if (typeof observable.select !== 'function') bad(`state observable "${key}" requires a selector`, { key });
    if (observable.kind === 'numeric') {
      const sample = (observable as { sample?: unknown }).sample;
      if (sample !== 'at-horizon' && sample !== 'every-commit') {
        bad(`numeric state observable "${key}" has an invalid sampling policy`, { key, sample });
      }
    } else if (observable.kind === 'text') {
      const sample = (observable as { sample?: unknown }).sample;
      if (sample !== 'at-horizon') {
        bad(`text state observable "${key}" must sample at-horizon`, { key, sample });
      }
    } else {
      bad(`state observable "${key}" has an unknown kind`, { key, kind: (observable as { kind?: unknown }).kind });
    }
  }

  for (const [key, observable] of Object.entries(scenario.eventObservables ?? {})) {
    if (!key) bad('event observable requires a non-empty key');
    if (observableKeys.has(key)) bad(`duplicate observable key "${key}"`, { key });
    observableKeys.add(key);
    if (!observable.label) bad(`event observable "${key}" requires a label`, { key });
    if (typeof observable.match !== 'function') bad(`event observable "${key}" requires a matcher`, { key });
    if (observable.expect !== undefined && observable.expect !== 'at-most-once' && observable.expect !== 'any') {
      bad(`event observable "${key}" has an invalid expectation`, { key, expect: observable.expect });
    }
  }
}
