import type { JsonValue } from '@alive-internal/core';
import {
  executeAliveRoute,
  type AliveApiContract,
  type AliveHttpResult,
  type AliveTransportSimulation,
  type QueryParams,
  type RouteDef,
  type RouteParams,
} from '@alive-internal/integration';

export interface AliveMswResolverInfo {
  readonly request: Request;
  readonly params: Readonly<Record<string, string | readonly string[] | undefined>>;
}

export type AliveMswResolver = (info: AliveMswResolverInfo) => Promise<Response>;

export interface AliveMswHttp<H> {
  get(path: string, resolver: AliveMswResolver): H;
  post(path: string, resolver: AliveMswResolver): H;
  patch(path: string, resolver: AliveMswResolver): H;
  delete(path: string, resolver: AliveMswResolver): H;
}

export interface AliveMswHttpResponse {
  json(body: JsonValue, init?: { readonly status?: number }): Response;
}

/**
 * The two MSW v2 primitives used by ALIVE. Consumers pass `{ http, HttpResponse }` from
 * `msw`. Keeping them injected means this private workspace adapter can be verified
 * without making MSW a kernel or integration dependency.
 */
export interface AliveMswRuntime<H> {
  readonly http: AliveMswHttp<H>;
  readonly HttpResponse: AliveMswHttpResponse;
}

function queryFromUrl(url: string): QueryParams {
  const grouped = new Map<string, string[]>();
  for (const [key, value] of new URL(url).searchParams) {
    const values = grouped.get(key);
    if (values) values.push(value);
    else grouped.set(key, [value]);
  }
  const out: Record<string, string | readonly string[]> = {};
  for (const [key, values] of grouped) {
    out[key] = values.length === 1 ? (values[0] as string) : Object.freeze([...values]);
  }
  return Object.freeze(out);
}

function normalizeParams(raw: AliveMswResolverInfo['params']): RouteParams {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    if (typeof value === 'string') {
      out[key] = value;
      continue;
    }
    if (value.length !== 1) {
      throw new TypeError(`path parameter "${key}" resolved to multiple values`);
    }
    out[key] = value[0] as string;
  }
  return Object.freeze(out);
}

async function bodyFromRequest(request: Request): Promise<JsonValue> {
  const text = await request.text();
  if (text.trim() === '') return null;
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    throw new SyntaxError('Request body must contain valid JSON.');
  }
}

function toMswResponse(runtime: AliveMswRuntime<unknown>, result: AliveHttpResult): Response {
  return runtime.HttpResponse.json(result.body, { status: result.status });
}

function badRequest(runtime: AliveMswRuntime<unknown>, error: unknown): Response {
  return runtime.HttpResponse.json(
    {
      code: 'ALIVE_BAD_REQUEST',
      message: error instanceof Error ? error.message : 'Invalid request',
    },
    { status: 400 },
  );
}

function handlerFor<W, H>(
  runtime: AliveMswRuntime<H>,
  simulation: AliveTransportSimulation<W>,
  route: RouteDef<W>,
): H {
  const resolver: AliveMswResolver = async ({ request, params }) => {
    try {
      const normalized = normalizeParams(params);
      const query = queryFromUrl(request.url);
      const body = route.method === 'GET' ? undefined : await bodyFromRequest(request);
      return toMswResponse(
        runtime as unknown as AliveMswRuntime<unknown>,
        executeAliveRoute(simulation, route, { params: normalized, query, body }),
      );
    } catch (error) {
      return badRequest(runtime as unknown as AliveMswRuntime<unknown>, error);
    }
  };

  switch (route.method) {
    case 'GET':
      return runtime.http.get(route.path, resolver);
    case 'POST':
      return runtime.http.post(route.path, resolver);
    case 'PATCH':
      return runtime.http.patch(route.path, resolver);
    case 'DELETE':
      return runtime.http.delete(route.path, resolver);
  }
}

/**
 * Convert an ALIVE API contract into MSW v2-compatible request handlers.
 *
 * Usage:
 * `createAliveHandlers({ http, HttpResponse }, alive, apiContract)`
 *
 * The host application keeps using ordinary fetch/Axios calls. GET handlers project the
 * simulation's current *view* state, so scrub mode naturally serves historical data.
 * Mutation handlers dispatch ALIVE commands and translate historical-view/precondition
 * failures into stable HTTP responses.
 */
export function createAliveHandlers<W, H>(
  runtime: AliveMswRuntime<H>,
  simulation: AliveTransportSimulation<W>,
  contract: AliveApiContract<W>,
): readonly H[] {
  return Object.freeze(contract.routes.map((route) => handlerFor(runtime, simulation, route)));
}
