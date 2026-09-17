import { QueryClient } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { setupWorker } from 'msw/browser';
import { bindAliveQueryInvalidation } from '@alive-internal/integration';
import { createAliveHandlers } from '@alive-internal/msw';
import { launchApi } from './scenario/api.js';
import { simulation } from './scenario/runtime.js';
export { simulation } from './scenario/runtime.js';
import { PlaybackController } from './lib/playback.js';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 60_000, retry: false, refetchOnWindowFocus: false },
    mutations: { retry: false },
  },
});

export const playback = new PlaybackController(simulation);
export const worker = setupWorker(...createAliveHandlers({ http, HttpResponse }, simulation, launchApi));

export const queryBinding = bindAliveQueryInvalidation(simulation, queryClient, launchApi, {
  timelineQueryKey: ['alive'],
  onError: (error) => console.error('[ALIVE] query invalidation failed', error),
});

export async function startTransport(): Promise<void> {
  await worker.start({
    onUnhandledRequest: 'bypass',
    serviceWorker: { url: '/mockServiceWorker.js' },
    quiet: true,
  });
}
