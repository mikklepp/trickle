/**
 * Builds a `fetch` wrapper bound to the current auth token.
 *
 * It injects the `Authorization: Bearer <token>` header on every request and,
 * if the backend responds 401 (token expired, secret rotated, otherwise
 * invalid), invokes `onUnauthorized` so the app can clear the dead session and
 * return to the login screen. Without this, a stale token in localStorage
 * renders the app but fails every API call until the user manually logs out.
 */
export type AuthFetch = (input: string, init?: RequestInit) => Promise<Response>;

export function makeAuthFetch(token: string, onUnauthorized: () => void): AuthFetch {
  return async (input, init = {}) => {
    const response = await fetch(input, {
      ...init,
      headers: {
        ...init.headers,
        Authorization: `Bearer ${token}`,
      },
    });

    if (response.status === 401) {
      onUnauthorized();
    }

    return response;
  };
}
