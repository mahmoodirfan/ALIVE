import {
  AliveError,
  isAliveError,
  snapshotJson,
  type DispatchResult,
  type JsonValue,
} from '@alive-internal/core';
import type {
  AliveHttpErrorBody,
  AliveHttpResult,
  AliveTransportSimulation,
  MutationRouteDef,
  QueryParams,
  ReadRouteDef,
  RouteDef,
  RouteExecutionInput,
  RouteParams,
} from './types.js';

const EMPTY_PARAMS: RouteParams = Object.freeze({});
const EMPTY_QUERY: QueryParams = Object.freeze({});

function safeJson(value: unknown, label: string): JsonValue {
  return snapshotJson(value, label) as JsonValue;
}

function errorBody(
  code: string,
  message: string,
  hint?: string,
  details?: unknown,
): AliveHttpErrorBody {
  const body: Record<string, unknown> = { code, message };
  if (hint !== undefined) body.hint = hint;
  if (details !== undefined) {
    try {
      body.details = safeJson(details, 'http.error.details');
    } catch {
      body.details = { description: String(details) };
    }
  }
  return Object.freeze(body) as unknown as AliveHttpErrorBody;
}

function result(status: number, body: unknown): AliveHttpResult {
  return Object.freeze({ status, body: safeJson(body, 'http.response') });
}

function mapRejection(dispatch: DispatchResult): AliveHttpResult {
  const rejection = dispatch.rejection;
  if (!rejection) return result(500, errorBody('ALIVE_INTERNAL_ERROR', 'command was rejected without details'));
  switch (rejection.code) {
    case 'ALIVE_UNKNOWN_COMMAND':
      return result(404, errorBody(rejection.code, rejection.message, undefined, rejection.details));
    case 'ALIVE_PRECONDITION_FAILED':
      return result(422, errorBody(rejection.code, rejection.message, undefined, rejection.details));
    case 'ALIVE_INVALID_COMMAND':
      return result(400, errorBody(rejection.code, rejection.message, undefined, rejection.details));
    case 'ALIVE_HISTORICAL_VIEW':
      return result(
        409,
        errorBody(rejection.code, rejection.message, 'Fork from this point before making changes.', rejection.details),
      );
  }
}

function mapThrown(error: unknown): AliveHttpResult {
  if (isAliveError(error, 'ALIVE_HISTORICAL_VIEW')) {
    return result(
      409,
      errorBody(error.code, 'This timeline position is read-only.', 'Fork from this point before making changes.'),
    );
  }
  if (isAliveError(error, 'ALIVE_PRECONDITION_FAILED')) {
    return result(422, errorBody(error.code, error.message, undefined, error.details));
  }
  if (isAliveError(error, 'ALIVE_UNKNOWN_COMMAND')) {
    return result(404, errorBody(error.code, error.message, undefined, error.details));
  }
  if (isAliveError(error, 'ALIVE_INVALID_COMMAND')) {
    return result(400, errorBody(error.code, error.message, undefined, error.details));
  }
  if (isAliveError(error, 'ALIVE_FAULTED')) {
    return result(409, errorBody(error.code, 'This simulation branch is faulted and cannot accept mutations.'));
  }
  if (error instanceof AliveError) {
    return result(500, errorBody(error.code, error.message));
  }
  return result(
    500,
    errorBody('ALIVE_INTERNAL_ERROR', error instanceof Error ? error.message : 'Unexpected transport error'),
  );
}

function executeRead<W>(
  simulation: AliveTransportSimulation<W>,
  route: ReadRouteDef<W>,
  params: RouteParams,
  query: QueryParams,
): AliveHttpResult {
  try {
    const body = route.resolve({ state: simulation.getState(), params, query });
    return result(route.successStatus ?? 200, body);
  } catch (error) {
    return mapThrown(error);
  }
}

function fallbackMutationBody(dispatch: DispatchResult): JsonValue {
  return {
    accepted: true,
    commandId: dispatch.commandId ?? null,
    commitId: dispatch.commitId ?? null,
    emitted: dispatch.emitted ? [...dispatch.emitted] : [],
  };
}

function executeMutation<W>(
  simulation: AliveTransportSimulation<W>,
  route: MutationRouteDef<W>,
  params: RouteParams,
  query: QueryParams,
  body: JsonValue,
): AliveHttpResult {
  try {
    const command = route.command({ params, query, body });
    const dispatch = simulation.dispatch(command);
    if (!dispatch.accepted) return mapRejection(dispatch);
    const response = route.resolve
      ? route.resolve({ state: simulation.getState(), params, query, body, dispatch })
      : fallbackMutationBody(dispatch);
    return result(route.successStatus ?? 200, response);
  } catch (error) {
    return mapThrown(error);
  }
}

export function executeAliveRoute<W>(
  simulation: AliveTransportSimulation<W>,
  route: RouteDef<W>,
  input: RouteExecutionInput = {},
): AliveHttpResult {
  const params = input.params ? Object.freeze({ ...input.params }) : EMPTY_PARAMS;
  const query = input.query ? Object.freeze({ ...input.query }) : EMPTY_QUERY;
  if (route.method === 'GET') return executeRead(simulation, route, params, query);
  let body: JsonValue;
  try {
    body = safeJson(input.body ?? null, 'http.request.body');
  } catch (error) {
    return result(400, errorBody('ALIVE_BAD_REQUEST', error instanceof Error ? error.message : 'Invalid request body'));
  }
  return executeMutation(simulation, route, params, query, body);
}
