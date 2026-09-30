import { describe, test, expect, vi, afterEach } from "vitest";
import { waitFor } from "@testing-library/react";
import JobStatus from "./JobStatus";
import { mockFetch } from "../test/fetchMock";
import { renderWithQuery } from "../test/renderWithQuery";
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
  // isFetching is true on every background poll, so using it for UI state made
  // the metrics panel disappear and the search button flip to "Loading..."
  // every few seconds. Only the first load should show loading state -- so
  // the assertion runs while a background poll is actually in flight.
  test("does not flash loading state on background polls", async () => {
    const { calls } = mockFetch(ROUTES);
    const routed = globalThis.fetch;
    let releasePoll: () => void = () => {};
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/email/status/") && statusCalls(calls) >= 1) {
        calls.push(String(input));
        await new Promise<void>((resolve) => (releasePoll = resolve));
        return new Response(JSON.stringify(JOB), { status: 200 });
      }
      return routed(input, init);
    });

    const { getByRole } = renderWithQuery(
      <JobStatus apiUrl="http://api" authFetch={authFetch} jobId="job-1" />
    );
    await waitFor(() => expect(statusCalls(calls)).toBe(1));
    await vi.waitFor(() => expect(statusCalls(calls)).toBe(2), { timeout: 9_000, interval: 100 });

    expect(getByRole("button", { name: /check status/i })).toBeEnabled();
    releasePoll();
  }, 15_000);

  // A disabled query (no job selected) is pending forever; reading isPending
  // for the button's state locked it on "Loading..." on first visit.
  test("the search button is usable before any job is selected", async () => {
    const { calls } = mockFetch(ROUTES);
    const { getByRole } = renderWithQuery(
      <JobStatus apiUrl="http://api" authFetch={authFetch} jobId={null} />
    );
    await waitFor(() => expect(calls.some((c) => c.includes("/email/jobs"))).toBe(true));
    expect(getByRole("button", { name: /check status/i })).toBeEnabled();
  });

  test("backs off polling once the job has settled", async () => {
    const { calls } = mockFetch({ ...ROUTES, "/email/status/": { ...JOB, status: "completed" } });
    renderWithQuery(<JobStatus apiUrl="http://api" authFetch={authFetch} jobId="job-1" />);
    await waitFor(() => expect(statusCalls(calls)).toBe(1));

    // At the active 5s cadence this window would produce several more calls.
    await new Promise((r) => setTimeout(r, 12_000));
    expect(statusCalls(calls)).toBe(1);
  }, 20_000);

  test("fetches the job on mount", async () => {
    const { calls } = mockFetch(ROUTES);
    renderWithQuery(<JobStatus apiUrl="http://api" authFetch={authFetch} jobId="job-1" />);
    await waitFor(() => expect(statusCalls(calls)).toBe(1));
  });

  // The hand-rolled setInterval + visibilitychange pause is exactly what
  // TanStack Query's refetchInterval/refetchIntervalInBackground would replace,
  // so its behaviour is pinned before any migration touches it.
  test("keeps polling while the tab is visible", async () => {
    const { calls } = mockFetch(ROUTES);
    renderWithQuery(<JobStatus apiUrl="http://api" authFetch={authFetch} jobId="job-1" />);
    await waitFor(() => expect(statusCalls(calls)).toBe(1));

    const before = statusCalls(calls);
    await vi.waitFor(() => expect(statusCalls(calls)).toBeGreaterThan(before), {
      timeout: 8_000,
      interval: 250,
    });
  }, 15_000);

  test("stops polling once the tab is hidden", async () => {
    const { calls } = mockFetch(ROUTES);
    renderWithQuery(<JobStatus apiUrl="http://api" authFetch={authFetch} jobId="job-1" />);
    await waitFor(() => expect(statusCalls(calls)).toBe(1));

    // A real browser sets both; the old code read `hidden`, TanStack Query's
    // focus manager reads `visibilityState`.
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    Object.defineProperty(document, "visibilityState", {
      value: "hidden",
      configurable: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));

    const atHide = statusCalls(calls);
    await new Promise((r) => setTimeout(r, 6_500));
    expect(statusCalls(calls)).toBe(atHide);
  }, 15_000);
});

describe("JobStatus actions", () => {
  test("cancels a sending job", async () => {
    const posts: string[] = [];
    mockFetch({
      "/cancel": (url: string, init?: RequestInit) => {
        if (init?.method === "POST") posts.push(url);
        return { jobId: "job-1", status: "cancelled" };
      },
      ...ROUTES,
    });
    const { findByRole } = renderWithQuery(
      <JobStatus apiUrl="http://api" authFetch={authFetch} jobId="job-1" />
    );

    (await findByRole("button", { name: /cancel job/i })).click();
    await waitFor(() => expect(posts).toEqual(["http://api/email/jobs/job-1/cancel"]));
  });

  test("offers no cancel for a settled job", async () => {
    mockFetch({ ...ROUTES, "/email/status/": { ...JOB, status: "completed" } });
    const { findByText, queryByRole } = renderWithQuery(
      <JobStatus apiUrl="http://api" authFetch={authFetch} jobId="job-1" />
    );
    await findByText(/Completed:/);
    expect(queryByRole("button", { name: /cancel job/i })).toBeNull();
  });

  test("lists failed and unconfirmed recipients", async () => {
    mockFetch({
      "/recipients": {
        recipients: [
          { idx: 0, email: "ok@example.com", state: "sent" },
          { idx: 1, email: "bad@example.com", state: "failed", error: "MessageRejected" },
          { idx: 2, email: "maybe@example.com", state: "unconfirmed" },
        ],
      },
      ...ROUTES,
      "/email/status/": { ...JOB, status: "completed_with_errors", failed: 1, unconfirmed: 1 },
    });
    const { findByText, queryByText } = renderWithQuery(
      <JobStatus apiUrl="http://api" authFetch={authFetch} jobId="job-1" />
    );

    expect(await findByText("bad@example.com")).toBeInTheDocument();
    expect(await findByText("maybe@example.com")).toBeInTheDocument();
    expect(queryByText("ok@example.com")).toBeNull();
  });
});
