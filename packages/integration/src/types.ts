import type {
  AliveEvent,
  CommitNotification,
  DispatchResult,
  JsonValue,
  SerializableCommand,
  TimelineChangeNotification,
  Unsubscribe,
} from '@alive-internal/core';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';
export type MutationMethod = Exclude<HttpMethod, 'GET'>;

export type ResourceKey = readonly string[];
export type RouteParams = Readonly<Record<string, string>>;
export type QueryValue = string | readonly string[];
export type QueryParams = Readonly<Record<string, QueryValue>>;

export interface AliveTransportSimulation<W> {
  getState(): Readonly<W>;
  dispatch(command: SerializableCommand): DispatchResult;
}

export interface AliveNotificationSource {
  on(channel: 'committed', fn: (n: CommitNotification) => void): Unsubscribe;
  on(channel: 'timeline:changed', fn: (n: TimelineChangeNotification) => void): Unsubscribe;
}

export interface ReadRouteContext<W> {
  readonly state: Readonly<W>;
  readonly params: RouteParams;
  readonly query: QueryParams;
}

export interface CommandRouteContext {
  readonly params: RouteParams;
  readonly query: QueryParams;
  readonly body: JsonValue;
}

export interface MutationResolveContext<W> extends ReadRouteContext<W> {
  readonly body: JsonValue;
  readonly dispatch: DispatchResult;
}

export interface ReadRouteDef<W> {
  readonly method: 'GET';
  readonly path: string;
  readonly resolve: (ctx: ReadRouteContext<W>) => JsonValue;
  readonly successStatus?: number;
}

export interface MutationRouteDef<W> {
  readonly method: MutationMethod;
  readonly path: string;
  readonly command: (ctx: CommandRouteContext) => SerializableCommand;
  readonly resolve?: (ctx: MutationResolveContext<W>) => JsonValue;
  readonly successStatus?: number;
}

export type RouteDef<W> = ReadRouteDef<W> | MutationRouteDef<W>;

export interface EffectRule {
  readonly when: string | ((event: AliveEvent) => boolean);
  readonly invalidate: (event: AliveEvent) => readonly ResourceKey[];
}

export interface AliveApiContract<W> {
  readonly routes: readonly RouteDef<W>[];
  readonly effects: readonly EffectRule[];
}

export interface RouteExecutionInput {
  readonly params?: RouteParams;
  readonly query?: QueryParams;
  readonly body?: JsonValue;
}

export interface AliveHttpResult {
  readonly status: number;
  readonly body: JsonValue;
}

export interface AliveHttpErrorBody {
  readonly code: string;
  readonly message: string;
  readonly hint?: string;
  readonly details?: JsonValue;
}

export interface QueryClientLike {
  invalidateQueries(filters?: { readonly queryKey?: readonly unknown[]; readonly exact?: boolean }):
    | Promise<unknown>
    | unknown;
}

export interface QueryBindingOptions {
  /** Prefix matching mirrors TanStack Query's default. Set true for exact matching. */
  readonly exact?: boolean;
  /** Optional prefix used for timeline-wide invalidation. Omit to invalidate the whole QueryClient. */
  readonly timelineQueryKey?: ResourceKey;
  /** Called when cache invalidation throws or rejects. The simulation itself is unaffected. */
  readonly onError?: (error: unknown) => void;
}

export interface QueryBindingHandle {
  /** Unsubscribe from ALIVE and prevent any queued future invalidations. */
  dispose(): void;
  /** Number of resource keys currently waiting for the next microtask flush. */
  pending(): number;
}
