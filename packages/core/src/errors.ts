/** Typed engine errors. Every error carries a stable `code` (INV-57 family). */
export type AliveErrorCode =
  | 'ALIVE_HISTORICAL_VIEW'
  | 'ALIVE_UNKNOWN_COMMAND'
  | 'ALIVE_INVALID_COMMAND'
  | 'ALIVE_PRECONDITION_FAILED'
  | 'ALIVE_CASCADE_LIMIT'
  | 'ALIVE_RETROACTIVE_SCHEDULE'
  | 'ALIVE_EVENT_ID_COLLISION'
  | 'ALIVE_SCHEDULED_ID_COLLISION'
  | 'ALIVE_NON_JSON_VALUE'
  | 'ALIVE_INVALID_DURATION'
  | 'ALIVE_INVALID_TIME'
  | 'ALIVE_INVALID_PRIORITY'
  | 'ALIVE_COUNTER_OVERFLOW'
  | 'ALIVE_BACKWARD_RUN'
  | 'ALIVE_FAULTED'
  | 'ALIVE_INVALID_CURSOR'
  | 'ALIVE_INVALID_SCENARIO'
  | 'ALIVE_UNKNOWN_SCHEDULED_ITEM'
  | 'ALIVE_INVALID_TUPLE_COMPONENT'
  | 'ALIVE_UNKNOWN_BRANCH'
  | 'ALIVE_REPLAY_INCOMPATIBLE'
  | 'ALIVE_REPLAY_DIVERGED'
  | 'ALIVE_HORIZON_NOT_REACHED'
  | 'ALIVE_INVALID_HORIZON'
  | 'ALIVE_UNKNOWN_OBSERVABLE'
  | 'ALIVE_OBSERVABLE_CARDINALITY'
  | 'ALIVE_INVALID_OBSERVABLE_VALUE';

export class AliveError extends Error {
  readonly code: AliveErrorCode;
  readonly details: Readonly<Record<string, unknown>>;
  constructor(code: AliveErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(`${code}: ${message}`);
    this.name = 'AliveError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export function isAliveError(e: unknown, code?: AliveErrorCode): e is AliveError {
  return e instanceof AliveError && (code === undefined || e.code === code);
}
