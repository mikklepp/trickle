import { QueryClient } from "@tanstack/react-query";

/**
 * Shared defaults for every query in the app.
 *
 * `staleTime` matters here because two components fetch the same endpoints:
 * EmailLogs and JobStatus both list jobs, and EmailForm and Config both read
 * the config. With a non-zero stale time those collapse into one request
 * instead of refetching per mount.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        // The 401 handler in authFetch already returns the user to the login
        // screen; retrying a dead session just delays that.
        retry: 1,
        refetchOnWindowFocus: false,
      },
    },
  });
}
