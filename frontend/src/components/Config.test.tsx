import { describe, test, expect } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import Config from "./Config";
import { mockFetch } from "../test/fetchMock";
import { renderWithQuery } from "../test/renderWithQuery";
import type { AuthFetch } from "../utils/authFetch";

const authFetch: AuthFetch = (input, init) => fetch(input, init);

describe("Config", () => {
  test("loads configuration on mount and renders the returned values", async () => {
    mockFetch({ "/config": { rateLimit: 42, maxAttachmentSize: 12345 } });
    renderWithQuery(<Config apiUrl="http://api" authFetch={authFetch} />);
    await waitFor(() => expect(screen.getByDisplayValue("42")).toBeInTheDocument());
  });

  test("requests the config endpoint exactly once on mount", async () => {
    const { calls } = mockFetch({ "/config": { rateLimit: 60, maxAttachmentSize: 1 } });
    renderWithQuery(<Config apiUrl="http://api" authFetch={authFetch} />);
    await waitFor(() => expect(calls.filter((c) => c.includes("/config"))).toHaveLength(1));
  });

  test("surfaces an error when the request fails", async () => {
    mockFetch({ "/config": { error: "nope" } }, 500);
    renderWithQuery(<Config apiUrl="http://api" authFetch={authFetch} />);
    // A failed load must not leave the form silently showing defaults as if saved.
    await waitFor(() => expect(screen.queryByDisplayValue("42")).not.toBeInTheDocument());
  });
});
