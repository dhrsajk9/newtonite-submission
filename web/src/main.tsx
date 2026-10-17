import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError } from './api';
import { App } from './App';
import { ToastProvider } from './components/Toast';
import './styles.css';

// Server data lives in TanStack Query's cache, not in hand-written global state.
// Filters live in the URL; form drafts live in component state.
const queryClient: QueryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      refetchOnWindowFocus: true, // coming back to the tab shows fresh data
      // Retry network blips, never "you're not allowed" or "not found".
      retry: (count, error) => !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 2,
    },
  },
  // A 401 anywhere means the session ended: drop back to the login screen.
  queryCache: new QueryCache({ onError: (e) => expireSession(e) }),
  mutationCache: new MutationCache({ onError: (e) => expireSession(e) }),
});

function expireSession(error: unknown) {
  if (error instanceof ApiError && error.status === 401) queryClient.setQueryData(['me'], null);
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <ToastProvider>
          <App />
        </ToastProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
