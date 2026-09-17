import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { App } from './App.js';
import { queryClient, startTransport } from './runtime.js';
import './styles.css';

function renderBootError(error: unknown): void {
  const root = document.getElementById('root');
  if (!root) return;
  const message = error instanceof Error ? error.message : String(error);
  root.innerHTML = `<main style="font-family:ui-sans-serif,system-ui;padding:48px;max-width:760px;margin:auto"><h1>ALIVE demo could not start</h1><p>${message.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</p><p>Run <code>pnpm install --no-frozen-lockfile</code> once on a connected machine so MSW can generate <code>public/mockServiceWorker.js</code>.</p></main>`;
}

async function boot(): Promise<void> {
  if (import.meta.env.PROD && import.meta.env.VITE_ALIVE_ENABLED !== 'true') {
    throw new Error('This production build has ALIVE disabled. Set VITE_ALIVE_ENABLED=true only for an intentional demo/sandbox build.');
  }
  await startTransport();
  const root = document.getElementById('root');
  if (!root) throw new Error('Missing #root');
  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </StrictMode>,
  );
}

void boot().catch(renderBootError);
