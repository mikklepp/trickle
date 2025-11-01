import React, { useState, useEffect } from "react";
import { format } from "date-fns";
import EventDetailCard from "./EventDetailCard";

/**
 * Formats a timestamp (ISO string or milliseconds) in local time
 * Example: 2025-10-28 14:12
 */
function formatDate(timestamp: string | number): string {
  const date = new Date(timestamp);
  return format(date, "yyyy-MM-dd HH:mm");
}

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
  complaintCount: number;
  rejectCount: number;
  totalEventCount: number;
  hardBounceRate: number;
  complaintRate: number;
  warnings: string[];
}

interface EmailLogsResponse {
  events?: EmailEvent[];
  count?: number;
  nextToken?: string | null;
  filters?: {
    eventType: string | null;
    recipient: string | null;
  };
  jobMetrics?: JobMetrics;
  error?: string;
}

interface JobListItem {
  jobId: string;
  status: string;
  sender: string;
  subject: string;
  totalRecipients: number;
  sent: number;
  failed: number;
  createdAt: string;
}

interface EmailLogsProps {
  apiUrl: string;
  token: string;
  jobId: string | null;
  initialEventType?: string | null;
  onJobIdChange?: (jobId: string) => void;
}

export default function EmailLogs({
  apiUrl,
  token,
  jobId,
  initialEventType,
  onJobIdChange,
}: EmailLogsProps) {
  const [searchJobId, setSearchJobId] = useState(jobId || "");
  const [events, setEvents] = useState<EmailEvent[]>([]);
  const [jobs, setJobs] = useState<JobListItem[]>([]);
  const [jobMetrics, setJobMetrics] = useState<JobMetrics | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadingJobs, setLoadingJobs] = useState(false);
  const [nextToken, setNextToken] = useState<string | null>(null);

  // Filters
  const [selectedEventType, setSelectedEventType] = useState<string | null>(
    initialEventType || null
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

  // Fetch jobs list on mount
  useEffect(() => {
    fetchJobs();
  }, []);

  // Fetch logs when jobId or filters change (reset to first page)
  useEffect(() => {
    if (jobId) {
      setNextToken(null);
      setEvents([]);
      fetchLogs(jobId, selectedEventType, recipientFilter);
    }
  }, [jobId, selectedEventType, recipientFilter]);

  const fetchJobs = async () => {
    setLoadingJobs(true);
    try {
      const response = await fetch(`${apiUrl}/email/jobs`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      const data = await response.json();

      if (response.ok) {
        setJobs(data.jobs);
      }
    } catch (err) {
      console.error("Failed to fetch jobs:", err);
    } finally {
      setLoadingJobs(false);
    }
  };

  const fetchLogs = async (
    id: string,
    eventType: string | null,
    recipient: string,
    pageToken?: string | null,
    append: boolean = false,
    totalRecipients?: number
  ) => {
    if (!id) return;

    setLoading(true);
    if (!append) setError("");

    try {
      const params = new URLSearchParams();
      if (eventType) params.append("eventType", eventType);
      if (recipient) params.append("recipient", recipient);
      if (pageToken) params.append("nextToken", pageToken);
      if (totalRecipients && totalRecipients > 0) {
        params.append("totalRecipients", totalRecipients.toString());
      }
      params.append("limit", "100");

      const response = await fetch(`${apiUrl}/email/events/logs/${id}?${params.toString()}`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      const data: EmailLogsResponse = await response.json();

      if (response.ok) {
        if (append) {
          // Load more: append to existing events
          setEvents([...events, ...(data.events || [])]);
        } else {
          // Initial load: replace events and metrics
          setEvents(data.events || []);
          setJobMetrics(data.jobMetrics || null);
        }
        setNextToken(data.nextToken || null);
      } else {
        setError(data.error || "Failed to fetch email logs");
      }
    } catch (err) {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleLoadMore = () => {
    if (jobId && !loading && nextToken) {
      fetchLogs(jobId, selectedEventType, recipientFilter, nextToken, true);
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
            <label>Event Type</label>
            <select
              value={selectedEventType || ""}
              onChange={(e) => setSelectedEventType(e.target.value || null)}
            >
              <option value="">All Events</option>
              {eventTypes.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </div>

          <div className="form-group">
            <label>Recipient Email</label>
            <input
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
                <span className={`metric-value ${jobMetrics.hardBounceRate > 0.05 ? "critical" : jobMetrics.hardBounceRate > 0.02 ? "warning" : ""}`}>
                  {jobMetrics.hardBounceCount} ({(jobMetrics.hardBounceRate * 100).toFixed(1)}%)
                </span>
              </div>
              <div className="metric-item">
                <span className="metric-label">Soft Bounces:</span>
                <span className="metric-value">{jobMetrics.softBounceCount}</span>
              </div>
              <div className="metric-item">
                <span className="metric-label">Complaints:</span>
                <span className={`metric-value ${jobMetrics.complaintRate > 0.003 ? "critical" : jobMetrics.complaintRate > 0.001 ? "warning" : ""}`}>
                  {jobMetrics.complaintCount} ({(jobMetrics.complaintRate * 100).toFixed(2)}%)
                </span>
              </div>
              <div className="metric-item">
                <span className="metric-label">Total Events:</span>
                <span className="metric-value">{jobMetrics.totalEventCount}</span>
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
                    event={event as any}
                  />
                ))}
              </div>
              {events.length > 0 && nextToken && (
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
        {loadingJobs ? (
          <p>Loading jobs...</p>
        ) : jobs.length === 0 ? (
          <p>No jobs found.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Subject</th>
                <th>Sender</th>
                <th>Status</th>
                <th>Progress</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <tr
                  key={job.jobId}
                  onClick={() => handleJobClick(job.jobId)}
                  className={jobId === job.jobId ? "active" : ""}
                >
                  <td>{job.subject}</td>
                  <td>{job.sender}</td>
                  <td>
                    <span className={`status-badge ${job.status}`}>{job.status}</span>
                  </td>
                  <td>
                    {job.sent}/{job.totalRecipients}
                    {job.failed > 0 && <span className="error"> ({job.failed} failed)</span>}
                  </td>
                  <td>{formatDate(job.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
