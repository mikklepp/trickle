import { test, expect, vi } from "vitest";
import { waitFor, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
  createdAt: "2026-09-02T10:00:00.000Z",
};

// Reproduces the *production* client config, where staleTime is 30s, to prove
// it does not suppress the 5s refetchInterval.
test("polls on its interval despite a 30s staleTime", async () => {
  const { calls } = mockFetch({
    "/email/jobs": { jobs: [] },
    "/email/status/": JOB,
    "/email/events/summary/": {},
  });
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <JobStatus apiUrl="http://api" authFetch={authFetch} jobId="job-1" />
    </QueryClientProvider>
  );
  const n = () => calls.filter((c) => c.includes("/email/status/")).length;
  await waitFor(() => expect(n()).toBe(1));
  await vi.waitFor(() => expect(n()).toBeGreaterThan(1), { timeout: 9_000, interval: 250 });
}, 15_000);
