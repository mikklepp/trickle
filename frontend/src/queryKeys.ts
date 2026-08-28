/**
 * Every query key in one place, so the endpoints two components share -- the
 * job list and the config -- provably use the same key and therefore the same
 * cache entry rather than each fetching their own copy.
 */
export const queryKeys = {
  config: ["config"] as const,
  senders: ["senders"] as const,
  quota: ["quota"] as const,
  jobs: ["jobs"] as const,
  jobStatus: (jobId: string) => ["jobStatus", jobId] as const,
  eventsSummary: (jobId: string) => ["eventsSummary", jobId] as const,
  eventLogs: (
    jobId: string,
    eventType: string | null,
    recipient: string,
    bounceCategory: string | null
  ) => ["eventLogs", jobId, eventType, recipient, bounceCategory] as const,
};

/** Unwraps a JSON response, surfacing the API's own error message when present. */
export async function jsonOrThrow(response: Response): Promise<unknown> {
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      data && typeof data === "object" && "error" in data
        ? String((data as { error: unknown }).error)
        : `Request failed (${response.status})`;
    throw new Error(message);
  }
  return data;
}
