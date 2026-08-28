import { describe, test, expect } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import EmailForm from "./EmailForm";
import { mockFetch } from "../test/fetchMock";
import { renderWithQuery } from "../test/renderWithQuery";
import type { AuthFetch } from "../utils/authFetch";

const authFetch: AuthFetch = (input, init) => fetch(input, init);

const ROUTES = {
  "/senders": { emails: ["first@example.com", "second@example.com"], domains: [] },
  "/config": { rateLimit: 60, maxAttachmentSize: 10485760 },
  "/account/quota": { max24HourSend: 100, sentLast24Hours: 1, maxSendRate: 1 },
};

const renderForm = () =>
  renderWithQuery(<EmailForm apiUrl="http://api" authFetch={authFetch} onJobCreated={() => {}} />);

describe("EmailForm", () => {
  test("loads senders, config and quota on mount", async () => {
    const { calls } = mockFetch(ROUTES);
    renderForm();
    await waitFor(() => {
      for (const path of ["/senders", "/config", "/account/quota"]) {
        expect(calls.some((c) => c.includes(path))).toBe(true);
      }
    });
  });

  test("defaults the sender to the first verified address", async () => {
    mockFetch(ROUTES);
    renderForm();
    await waitFor(() => expect(screen.getByDisplayValue("first@example.com")).toBeInTheDocument());
  });

  // Restoring recent senders became a lazy state initialiser rather than a
  // mount effect, and must still win over the verified-address default.
  test("restores the most recent sender from localStorage instead of the default", async () => {
    localStorage.setItem(
      "recentSenders",
      JSON.stringify([{ email: "second@example.com", name: "Second" }])
    );
    mockFetch(ROUTES);
    renderForm();
    await waitFor(() => expect(screen.getByDisplayValue("second@example.com")).toBeInTheDocument());
    expect(screen.getByDisplayValue("Second")).toBeInTheDocument();
  });

  test("accepts the legacy plain-string form of recentSenders", async () => {
    localStorage.setItem("recentSenders", JSON.stringify(["second@example.com"]));
    mockFetch(ROUTES);
    renderForm();
    await waitFor(() => expect(screen.getByDisplayValue("second@example.com")).toBeInTheDocument());
  });

  test("survives corrupt recentSenders without crashing", async () => {
    localStorage.setItem("recentSenders", "{not json");
    mockFetch(ROUTES);
    renderForm();
    await waitFor(() => expect(screen.getByDisplayValue("first@example.com")).toBeInTheDocument());
  });
});
