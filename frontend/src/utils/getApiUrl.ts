/**
 * Determine the API URL based on the current frontend domain.
 *
 * For qed.fi domains: prepend "api." to the hostname
 * - trickle.qed.fi -> https://api.trickle.qed.fi
 * - staging.trickle.qed.fi -> https://api.staging.trickle.qed.fi
 *
 * For localhost development -> http://localhost:3000
 * Can be overridden with VITE_API_URL environment variable
 */
export function getApiUrl(): string {
  // Allow explicit override via environment variable (for backwards compatibility)
  if (import.meta.env.VITE_API_URL) {
    return import.meta.env.VITE_API_URL;
  }

  const hostname = window.location.hostname;

  // Development on localhost
  if (hostname === "localhost" || hostname === "127.0.0.1") {
    return "http://localhost:3000";
  }

  // Production/staging on qed.fi domain
  if (hostname.endsWith(".qed.fi")) {
    return `https://api.${hostname}`;
  }

  // Fallback for unknown domains
  return "http://localhost:3000";
}
