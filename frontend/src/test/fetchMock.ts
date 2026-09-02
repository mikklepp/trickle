import { vi } from "vitest";

type Handler = (url: string, init?: RequestInit) => unknown;

/**
 * Routes global fetch by URL substring. Components under test each hit several
 * endpoints on mount, so an unmatched URL fails loudly rather than resolving to
 * something plausible and hiding a wiring mistake.
 */
export function mockFetch(routes: Record<string, Handler | unknown>, status = 200) {
  const calls: string[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) throw new Error(`unmocked fetch: ${url}`);
    const route = routes[key];
    const body = typeof route === "function" ? (route as Handler)(url, init) : route;
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", impl);
  return { calls, impl };
}
