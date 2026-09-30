import { describe, test, expect, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
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

  // The API creates at most one job per Idempotency-Key. A network error can
  // hide whether a submission went through, so retrying it must reuse the key
  // -- or the whole list is mailed twice -- while an edited form is a new
  // submission with a new key.
  test("reuses the Idempotency-Key when a submission is retried, not after an edit", async () => {
    mockFetch(ROUTES);
    const sendKeys: string[] = [];
    const routed = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).includes("/email/send")) return routed(input, init);
      sendKeys.push(new Headers(init?.headers).get("Idempotency-Key") ?? "");
      throw new TypeError("Failed to fetch");
    });

    renderForm();
    await waitFor(() => expect(screen.getByDisplayValue("first@example.com")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Sender Name"), { target: { value: "Sender" } });
    fireEvent.change(screen.getByLabelText(/Recipients/), { target: { value: "a@example.com" } });
    fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Hello" } });
    const form = screen.getByLabelText("Subject").closest("form")!;

    fireEvent.submit(form);
    await waitFor(() => expect(screen.getByText(/Network error/)).toBeInTheDocument());
    fireEvent.submit(form);
    await waitFor(() => expect(sendKeys).toHaveLength(2));

    fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Hello again" } });
    fireEvent.submit(form);
    await waitFor(() => expect(sendKeys).toHaveLength(3));

    expect(sendKeys[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(sendKeys[1]).toBe(sendKeys[0]);
    expect(sendKeys[2]).not.toBe(sendKeys[0]);
  });
});
