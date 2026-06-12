import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import './index.css';
import App from './App.tsx';
import { ThemeProvider } from './theme/ThemeContext';
import { EventStreamProvider } from './events/EventStreamContext';
import { BrandingProvider } from './branding/BrandingContext';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <BrandingProvider>
          <EventStreamProvider>
            <App />
          </EventStreamProvider>
        </BrandingProvider>
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>
);
