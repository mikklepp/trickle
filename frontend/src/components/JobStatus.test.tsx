import { describe, test, expect, vi, afterEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import JobStatus from "./JobStatus";
import { mockFetch } from "../test/fetchMock";
import type { AuthFetch } from "../utils/authFetch";

const authFetch: AuthFetch = (input, init) => fetch(input, init);

const JOB = {
  jobId: "job-1",
  status: "sending",
  totalRecipients: 10,
  sent: 3,
  failed: 0,
  createdAt: "2026-08-28T10:00:00.000Z",
};
const ROUTES = {
  "/email/jobs": { jobs: [] },
  "/email/status/": JOB,
  "/email/events/summary/": {},
};

afterEach(() => vi.useRealTimers());

const statusCalls = (calls: string[]) => calls.filter((c) => c.includes("/email/status/")).length;

describe("JobStatus polling", () => {
  test("fetches the job on mount", async () => {
    const { calls } = mockFetch(ROUTES);
    render(<JobStatus apiUrl="http://api" authFetch={authFetch} jobId="job-1" />);
    await waitFor(() => expect(statusCalls(calls)).toBe(1));
  });

  // The hand-rolled setInterval + visibilitychange pause is exactly what
  // TanStack Query's refetchInterval/refetchIntervalInBackground would replace,
  // so its behaviour is pinned before any migration touches it.
  test("keeps polling while the tab is visible", async () => {
    const { calls } = mockFetch(ROUTES);
    render(<JobStatus apiUrl="http://api" authFetch={authFetch} jobId="job-1" />);
    await waitFor(() => expect(statusCalls(calls)).toBe(1));

    const before = statusCalls(calls);
    await vi.waitFor(() => expect(statusCalls(calls)).toBeGreaterThan(before), {
      timeout: 8_000,
      interval: 250,
    });
  }, 15_000);

  test("stops polling once the tab is hidden", async () => {
    const { calls } = mockFetch(ROUTES);
    render(<JobStatus apiUrl="http://api" authFetch={authFetch} jobId="job-1" />);
    await waitFor(() => expect(statusCalls(calls)).toBe(1));

    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));

    const atHide = statusCalls(calls);
    await new Promise((r) => setTimeout(r, 6_500));
    expect(statusCalls(calls)).toBe(atHide);
  }, 15_000);
});
