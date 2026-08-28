import { describe, test, expect } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import EmailLogs from "./EmailLogs";
import { mockFetch } from "../test/fetchMock";
import type { AuthFetch } from "../utils/authFetch";

const authFetch: AuthFetch = (input, init) => fetch(input, init);

const JOBS = {
  jobs: [{ jobId: "job-1", subject: "Newsletter", createdAt: "2026-08-28T10:00:00Z" }],
};
const event = (over: Record<string, unknown> = {}) => ({
  timestamp: 1756377600000,
  recipient: "a@example.com",
  eventType: "Bounce",
  messageId: "m-1",
  jobId: "job-1",
  ...over,
});

function renderLogs(logs: unknown = { events: [event()] }) {
  const mock = mockFetch({ "/email/jobs": JOBS, "/email/events/logs/": logs });
  render(<EmailLogs apiUrl="http://api" authFetch={authFetch} jobId="job-1" />);
  return mock;
}

describe("EmailLogs", () => {
  test("loads the job list and the selected job's events on mount", async () => {
    const { calls } = renderLogs();
    await waitFor(() => {
      expect(calls.some((c) => c.includes("/email/jobs"))).toBe(true);
      expect(calls.some((c) => c.includes("/email/events/logs/job-1"))).toBe(true);
    });
  });

  // The sub-filter reset moved out of an effect and into the select's own
  // change handler; this pins the behaviour that move had to preserve.
  test("clears the bounce sub-filter when the event type stops being Bounce", async () => {
    const { calls } = renderLogs();
    await screen.findByLabelText(/event type/i);

    await userEvent.selectOptions(screen.getByLabelText(/event type/i), "Bounce");
    await userEvent.selectOptions(await screen.findByLabelText(/bounce category/i), "hard");
    await waitFor(() => expect(calls.some((c) => c.includes("bounceCategory=hard"))).toBe(true));

    await userEvent.selectOptions(screen.getByLabelText(/event type/i), "Delivery");

    // The sub-filter must not survive as a hidden constraint on the new query.
    await waitFor(() => {
      const last = calls.filter((c) => c.includes("/email/events/logs/")).at(-1)!;
      expect(last).toContain("eventType=Delivery");
      expect(last).not.toContain("bounceCategory");
    });
  });

  test("hides the bounce sub-filter unless Bounce is selected", async () => {
    renderLogs();
    await screen.findByLabelText(/event type/i);
    expect(screen.queryByLabelText(/bounce category/i)).not.toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText(/event type/i), "Bounce");
    expect(await screen.findByLabelText(/bounce category/i)).toBeInTheDocument();
  });
});
