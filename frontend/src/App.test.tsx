import { describe, test, expect, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import { mockFetch } from "./test/fetchMock";

// Everything the child views fetch on mount; the assertions here are about
// App's own routing, not about what the children render.
const CHILD_ENDPOINTS = {
  "/senders": { emails: ["a@example.com"], domains: [] },
  "/config": { rateLimit: 60, maxAttachmentSize: 10485760 },
  "/account/quota": { max24HourSend: 100, sentLast24Hours: 1, maxSendRate: 1 },
  "/email/jobs": { jobs: [] },
  "/email/status/": {
    jobId: "job-42",
    status: "completed",
    totalRecipients: 2,
    sent: 2,
    failed: 0,
    createdAt: "2026-08-28T10:00:00.000Z",
    completedAt: "2026-08-28T10:01:00.000Z",
  },
  "/email/events/summary/": {},
  "/email/events/logs/": { events: [] },
};

describe("App deep linking", () => {
  beforeEach(() => {
    mockFetch(CHILD_ENDPOINTS);
  });

  test("starts on the email view when there is no jobId in the URL", async () => {
    localStorage.setItem("token", "t");
    render(<App />);
    expect(await screen.findByRole("button", { name: /send email/i })).toHaveClass("active");
  });

  // This is the path that used to run in a mount effect keyed on `token`.
  test("opens the status view for an authenticated load carrying ?jobId", async () => {
    localStorage.setItem("token", "t");
    window.history.replaceState({}, "", "/?jobId=job-42");
    render(<App />);
    expect(await screen.findByRole("button", { name: /job status/i })).toHaveClass("active");
  });

  test("ignores ?jobId when there is no session and shows the login screen", async () => {
    window.history.replaceState({}, "", "/?jobId=job-42");
    render(<App />);
    expect(await screen.findByRole("heading", { name: /trickle login/i })).toBeInTheDocument();
  });

  // The half that moved into the login handler: the deep link has to survive
  // logging in, not just an already-authenticated load.
  test("applies a ?jobId deep link after logging in", async () => {
    window.history.replaceState({}, "", "/?jobId=job-42");
    mockFetch({ ...CHILD_ENDPOINTS, "/auth/login": { token: "fresh-token" } });
    render(<App />);

    await userEvent.type(await screen.findByLabelText(/username/i), "u");
    await userEvent.type(screen.getByLabelText(/password/i), "p");
    await userEvent.click(screen.getByRole("button", { name: /login/i }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /job status/i })).toHaveClass("active")
    );
  });

  test("persists the token to localStorage on login", async () => {
    mockFetch({ ...CHILD_ENDPOINTS, "/auth/login": { token: "fresh-token" } });
    render(<App />);
    await userEvent.type(await screen.findByLabelText(/username/i), "u");
    await userEvent.type(screen.getByLabelText(/password/i), "p");
    await userEvent.click(screen.getByRole("button", { name: /login/i }));
    await waitFor(() => expect(localStorage.getItem("token")).toBe("fresh-token"));
  });
});
