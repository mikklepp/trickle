import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";

/**
 * Node 26 defines its own experimental `localStorage` global, which shadows the
 * one jsdom installs and is inert unless the process was started with
 * --localstorage-file ("localStorage is not available because
 * --localstorage-file was not provided"). Rather than depend on which of the
 * two wins, install a plain in-memory Storage the tests fully control.
 */
function createStorage(): Storage {
  let map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
    clear: () => void (map = new Map()),
  } as Storage;
}

const storage = createStorage();
for (const target of [globalThis, window]) {
  Object.defineProperty(target, "localStorage", {
    value: storage,
    configurable: true,
    writable: true,
  });
}

beforeEach(() => {
  localStorage.clear();
  // Each test starts from a bare URL; deep-link tests set their own.
  window.history.replaceState({}, "", "/");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
