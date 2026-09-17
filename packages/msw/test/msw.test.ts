import { describe, expect, it } from 'vitest';
import {
  defineAliveApi,
  type AliveTransportSimulation,
} from '@alive-internal/integration';
import { createAliveHandlers, type AliveMswResolver, type AliveMswRuntime } from '../src/index.js';

interface World {
  value: number;
}

interface FakeHandler {
  method: string;
  path: string;
  resolver: AliveMswResolver;
}

function runtime(): AliveMswRuntime<FakeHandler> {
  const register = (method: string) => (path: string, resolver: AliveMswResolver): FakeHandler => ({ method, path, resolver });
  return {
    http: {
      get: register('GET'),
      post: register('POST'),
      patch: register('PATCH'),
      delete: register('DELETE'),
    },
    HttpResponse: {
      json(body, init) {
        return new Response(JSON.stringify(body), {
          status: init?.status ?? 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    },
  };
}

function params(values: Record<string, string | readonly string[]> = {}) {
  return values;
}

async function json(response: Response): Promise<unknown> {
  return response.json();
}

describe('createAliveHandlers', () => {
  it('omits absent optional MSW path parameters', async () => {
    const contract = defineAliveApi<World>({
      routes: [{ method: 'GET', path: '/api/value', resolve: ({ params }) => ({ ...params }) }],
      effects: [],
    });
    const handlers = createAliveHandlers(runtime(), {
      getState: () => ({ value: 1 }), dispatch: () => ({ accepted: false }),
    }, contract);
    const response = await handlers[0]!.resolver({
      request: new Request('https://example.test/api/value'),
      params: { optional: undefined, id: 'a' },
    });
    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ id: 'a' });
  });

  it('creates one MSW-compatible handler per API route', () => {
    const contract = defineAliveApi<World>({
      routes: [
        { method: 'GET', path: '/api/value', resolve: ({ state }) => state.value },
        { method: 'POST', path: '/api/value', command: ({ body }) => ({ type: 'set', payload: body }) },
      ],
      effects: [],
    });
    const simulation: AliveTransportSimulation<World> = {
      getState: () => ({ value: 1 }),
      dispatch: () => ({ accepted: true, commandId: 'cmd:1', commitId: 'commit:1', emitted: [] }),
    };
    const handlers = createAliveHandlers(runtime(), simulation, contract);
    expect(handlers.map((h) => [h.method, h.path])).toEqual([
      ['GET', '/api/value'],
      ['POST', '/api/value'],
    ]);
  });

  it('parses query parameters and serves GET from the current view state', async () => {
    const contract = defineAliveApi<World>({
      routes: [{
        method: 'GET',
        path: '/api/value/:id',
        resolve: ({ state, params: p, query }) => ({
          value: state.value,
          id: p.id ?? null,
          tags: query.tag === undefined ? null : (typeof query.tag === 'string' ? query.tag : Array.from(query.tag)),
        }),
      }],
      effects: [],
    });
    const handlers = createAliveHandlers(runtime(), {
      getState: () => ({ value: 7 }),
      dispatch: () => ({ accepted: false }),
    }, contract);
    const response = await handlers[0]!.resolver({
      request: new Request('https://example.test/api/value/a?tag=x&tag=y'),
      params: params({ id: 'a' }),
    });
    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ value: 7, id: 'a', tags: ['x', 'y'] });
  });

  it('parses mutation JSON and returns the adapter projection after dispatch', async () => {
    const world: World = { value: 1 };
    const seen: unknown[] = [];
    const contract = defineAliveApi<World>({
      routes: [{
        method: 'POST',
        path: '/api/value',
        command: ({ body }) => ({ type: 'set', payload: body }),
        resolve: ({ state }) => ({ value: state.value }),
      }],
      effects: [],
    });
    const handlers = createAliveHandlers(runtime(), {
      getState: () => world,
      dispatch(command) {
        seen.push(command);
        world.value = Number((command.payload as { value: number }).value);
        return { accepted: true, commandId: 'cmd:1', commitId: 'commit:1', emitted: [] };
      },
    }, contract);
    const response = await handlers[0]!.resolver({
      request: new Request('https://example.test/api/value', {
        method: 'POST',
        body: JSON.stringify({ value: 9 }),
        headers: { 'content-type': 'application/json' },
      }),
      params: params(),
    });
    expect(seen).toEqual([{ type: 'set', payload: { value: 9 } }]);
    expect(await json(response)).toEqual({ value: 9 });
  });

  it('returns 400 for malformed JSON without dispatching', async () => {
    let dispatched = false;
    const contract = defineAliveApi<World>({
      routes: [{ method: 'POST', path: '/api/value', command: ({ body }) => ({ type: 'set', payload: body }) }],
      effects: [],
    });
    const handlers = createAliveHandlers(runtime(), {
      getState: () => ({ value: 1 }),
      dispatch: () => { dispatched = true; return { accepted: true }; },
    }, contract);
    const response = await handlers[0]!.resolver({
      request: new Request('https://example.test/api/value', { method: 'POST', body: '{bad' }),
      params: params(),
    });
    expect(response.status).toBe(400);
    expect(await json(response)).toMatchObject({ code: 'ALIVE_BAD_REQUEST' });
    expect(dispatched).toBe(false);
  });
});
