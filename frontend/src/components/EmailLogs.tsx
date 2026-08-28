import React, { useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { jsonOrThrow, queryKeys } from "../queryKeys";
import JobsTable, { type JobListItem } from "./JobsTable";
import EventDetailCard from "./EventDetailCard";
import type { AuthFetch } from "../utils/authFetch";

/**
 * Formats a timestamp (ISO string or milliseconds) in local time
 * Example: 2025-10-28 14:12
 */
interface EmailEvent {
  timestamp: number;
  recipient: string;
  eventType: string;
  messageId: string;
  jobId: string;
  severity?: string;
  icon?: string;
  interpretation?: string;
  recommendation?: string;
  requiresAction?: boolean;
  category?: string;
  details?: Record<string, unknown>;
}

interface JobMetrics {
  hardBounceCount: number;
  softBounceCount: number;
  softBouncePermanentCount?: number;
  complaintCount: number;
  rejectCount: number;
  totalEventCount: number;
  hardBounceRate: number;
  softBounceRate?: number;
  complaintRate: number;
  bounceSubtypeCounts?: Record<string, number>;
  warnings: string[];
}

interface EmailLogsResponse {
  events?: EmailEvent[];
  count?: number;
  nextToken?: string | null;
  filters?: {
    eventType: string | null;
    recipient: string | null;
    bounceCategory?: "hard" | "soft" | null;
  };
  jobMetrics?: JobMetrics;
  error?: string;
}

interface EmailLogsProps {
  apiUrl: string;
  authFetch: AuthFetch;
  jobId: string | null;
  initialEventType?: string | null;
  initialBounceCategory?: "hard" | "soft" | null;
  onJobIdChange?: (jobId: string) => void;
}

export default function EmailLogs({
  apiUrl,
  authFetch,
  jobId,
  initialEventType,
  initialBounceCategory,
  onJobIdChange,
}: EmailLogsProps) {
  const [searchJobId, setSearchJobId] = useState(jobId || "");

  // Filters
  const [selectedEventType, setSelectedEventType] = useState<string | null>(
    initialEventType || null
  );
  const [bounceCategory, setBounceCategory] = useState<"hard" | "soft" | null>(
    initialBounceCategory || null
  );
  const [recipientFilter, setRecipientFilter] = useState("");

  const eventTypes = [
    "Send",
    "Delivery",
    "Bounce",
    "Complaint",
    "Reject",
    "DeliveryDelay",
    "Open",
    "Click",
  ];

  const jobsQuery = useQuery({
    queryKey: queryKeys.jobs,
    queryFn: async () =>
      ((await jsonOrThrow(await authFetch(`${apiUrl}/email/jobs`))) as { jobs: JobListItem[] })
        .jobs,
  });

  // useInfiniteQuery owns the cursor, so there is no nextToken state to keep in
  // step and no manual append -- which is what allowed a slow page to be
  // concatenated onto a list it no longer belonged to.
  const logsQuery = useInfiniteQuery({
    queryKey: queryKeys.eventLogs(jobId ?? "", selectedEventType, recipientFilter, bounceCategory),
    enabled: !!jobId,
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage: EmailLogsResponse) => lastPage.nextToken ?? undefined,
    queryFn: async ({ pageParam }) => {
      const params = new URLSearchParams();
      if (selectedEventType) params.append("eventType", selectedEventType);
      if (recipientFilter) params.append("recipient", recipientFilter);
      if (bounceCategory) params.append("bounceCategory", bounceCategory);
      if (pageParam) params.append("nextToken", pageParam);
      params.append("limit", "100");
      return (await jsonOrThrow(
        await authFetch(`${apiUrl}/email/events/logs/${jobId}?${params.toString()}`)
      )) as EmailLogsResponse;
    },
  });

  const jobs = jobsQuery.data ?? [];
  const loadingJobs = jobsQuery.isPending;
  const events = logsQuery.data?.pages.flatMap((page) => page.events ?? []) ?? [];
  // Metrics describe the whole filtered set, so they come from the first page.
  const jobMetrics = logsQuery.data?.pages[0]?.jobMetrics ?? null;
  const loading = logsQuery.isFetching;
  const error = (logsQuery.error as Error | null)?.message ?? "";

  const handleLoadMore = () => {
    if (logsQuery.hasNextPage && !logsQuery.isFetchingNextPage) {
      logsQuery.fetchNextPage();
    }
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchJobId) {
      setSearchJobId(searchJobId);
      if (onJobIdChange) {
        onJobIdChange(searchJobId);
      }
    }
  };

  const handleJobClick = (id: string) => {
    setSearchJobId(id);
    if (onJobIdChange) {
      onJobIdChange(id);
    }
  };

  return (
    <div className="email-logs">
      <h2>Email Logs</h2>

      <form onSubmit={handleSearch} className="search-form">
        <input
          type="text"
          value={searchJobId}
          onChange={(e) => setSearchJobId(e.target.value)}
          placeholder="Enter Job ID"
        />
        <button type="submit" disabled={loading}>
          {loading ? "Loading..." : "Search"}
        </button>
      </form>

      {error && <div className="error">{error}</div>}

      {/* Filters Section */}
      {jobId && (
        <div className="email-logs-filters">
          <div className="form-group">
            <label htmlFor="filter-event-type">Event Type</label>
            <select
              id="filter-event-type"
              value={selectedEventType || ""}
              onChange={(e) => {
                const next = e.target.value || null;
                setSelectedEventType(next);
                // The bounce sub-filter only means anything for Bounce events;
                // clear it here, at the point the choice is made, rather than
                // reacting to the change in an effect afterwards.
                if (next !== "Bounce") setBounceCategory(null);
              }}
            >
              <option value="">All Events</option>
              {eventTypes.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </div>

          {selectedEventType === "Bounce" && (
            <div className="form-group">
              <label htmlFor="filter-bounce-category">Bounce Category</label>
              <select
                id="filter-bounce-category"
                value={bounceCategory || ""}
                onChange={(e) =>
                  setBounceCategory((e.target.value || null) as "hard" | "soft" | null)
                }
              >
                <option value="">All Bounces</option>
                <option value="hard">Hard (Permanent)</option>
                <option value="soft">Soft (Transient)</option>
              </select>
            </div>
          )}

          <div className="form-group">
            <label htmlFor="filter-recipient">Recipient Email</label>
            <input
              id="filter-recipient"
              type="email"
              value={recipientFilter}
              onChange={(e) => setRecipientFilter(e.target.value)}
              placeholder="filter@example.com"
            />
          </div>
        </div>
      )}

      {/* Events Table */}
      {jobId && (
        <div className="events-list">
          <h3>Email Events ({events.length})</h3>

          {/* Job Metrics Warnings */}
          {jobMetrics && jobMetrics.warnings.length > 0 && (
            <div className="metrics-warnings">
              {jobMetrics.warnings.map((warning, idx) => (
                <div key={idx} className="warning-banner">
                  {warning}
                </div>
              ))}
            </div>
          )}

          {/* Job Metrics Summary */}
          {jobMetrics && (
            <div className="metrics-summary">
              <div className="metric-item">
                <span className="metric-label">Hard Bounces:</span>
                <span
                  className={`metric-value ${jobMetrics.hardBounceRate > 0.05 ? "critical" : jobMetrics.hardBounceRate > 0.02 ? "warning" : ""}`}
                >
                  {jobMetrics.hardBounceCount} ({(jobMetrics.hardBounceRate * 100).toFixed(1)}%)
                </span>
              </div>
              <div className="metric-item">
                <span className="metric-label">Soft Bounces:</span>
                <span
                  className={`metric-value ${jobMetrics.softBouncePermanentCount && jobMetrics.softBouncePermanentCount > 0 ? "warning" : ""}`}
                >
                  {jobMetrics.softBounceCount}
                  {jobMetrics.softBouncePermanentCount && jobMetrics.softBouncePermanentCount > 0
                    ? ` (${jobMetrics.softBouncePermanentCount} effectively permanent)`
                    : ""}
                </span>
              </div>
              <div className="metric-item">
                <span className="metric-label">Complaints:</span>
                <span
                  className={`metric-value ${jobMetrics.complaintRate > 0.003 ? "critical" : jobMetrics.complaintRate > 0.001 ? "warning" : ""}`}
                >
                  {jobMetrics.complaintCount} ({(jobMetrics.complaintRate * 100).toFixed(2)}%)
                </span>
              </div>
              <div className="metric-item">
                <span className="metric-label">Total Events:</span>
                <span className="metric-value">{jobMetrics.totalEventCount}</span>
              </div>
            </div>
          )}

          {jobMetrics &&
            jobMetrics.bounceSubtypeCounts &&
            Object.keys(jobMetrics.bounceSubtypeCounts).length > 0 && (
              <div className="metrics-summary" style={{ marginTop: "0.5rem" }}>
                <div className="metric-item" style={{ flexBasis: "100%" }}>
                  <span className="metric-label">Bounce subtypes:</span>
                  <span
                    className="metric-value"
                    style={{ fontFamily: "monospace", fontSize: "0.85rem" }}
                  >
                    {Object.entries(jobMetrics.bounceSubtypeCounts)
                      .sort((a, b) => b[1] - a[1])
                      .map(([k, v]) => `${k} (${v})`)
                      .join(", ")}
                  </span>
                </div>
              </div>
            )}

          {loading ? (
            <p>Loading events...</p>
          ) : events.length === 0 ? (
            <p>No events found for this job.</p>
          ) : (
            <>
              <div className="events-cards">
                {events.map((event, index) => (
                  <EventDetailCard
                    key={`${index}-${event.timestamp}`}
                    // EmailEvent (above) and ClassifiedEvent (EventDetailCard) are two
                    // declarations of the same API payload; this one makes the
                    // classification fields optional, the other requires them. Sharing a
                    // single type is the real fix, but it has to settle whether those
                    // fields are actually guaranteed before tightening them.
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    event={event as any}
                  />
                ))}
              </div>
              {events.length > 0 && logsQuery.hasNextPage && (
                <div style={{ marginTop: "1rem", textAlign: "center" }}>
                  <button
                    onClick={handleLoadMore}
                    disabled={loading}
                    style={{
                      background: "#3498db",
                      color: "white",
                      border: "none",
                      padding: "0.75rem 1.5rem",
                      borderRadius: "4px",
                      cursor: loading ? "not-allowed" : "pointer",
                      fontSize: "1rem",
                      opacity: loading ? 0.6 : 1,
                    }}
                  >
                    {loading ? "Loading..." : "Load More"}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Recent Jobs List */}
      <div className="jobs-list">
        <h3>Recent Jobs</h3>
        <JobsTable
          jobs={jobs}
          loading={loadingJobs}
          selectedJobId={jobId}
          onSelect={handleJobClick}
        />
      </div>
    </div>
  );
}
