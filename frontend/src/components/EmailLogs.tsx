import { useState, useEffect } from "react";
import { format } from "date-fns";

/**
 * Formats an ISO date string in local time
 * Example: 2025-10-28 14:12
 */
function formatDate(isoString: string): string {
  const date = new Date(isoString);
  return format(date, "yyyy-MM-dd HH:mm");
}

interface EmailEvent {
  timestamp: string;
  recipient: string;
  eventType: string;
  messageId: string;
  jobId: string;
}

interface EmailLogsResponse {
  events?: EmailEvent[];
  count?: number;
  filters?: {
    eventType: string | null;
    recipient: string | null;
  };
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
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadingJobs, setLoadingJobs] = useState(false);

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

  // Fetch logs when jobId changes
  useEffect(() => {
    if (jobId) {
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
    recipient: string
  ) => {
    if (!id) return;

    setLoading(true);
    setError("");

    try {
      const params = new URLSearchParams();
      if (eventType) params.append("eventType", eventType);
      if (recipient) params.append("recipient", recipient);

      const response = await fetch(`${apiUrl}/email/events/logs/${id}?${params.toString()}`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      const data: EmailLogsResponse = await response.json();

      if (response.ok) {
        setEvents(data.events || []);
      } else {
        setError(data.error || "Failed to fetch email logs");
      }
    } catch (err) {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
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

  const clearEventTypeFilter = () => {
    setSelectedEventType(null);
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
        <div className="filters-section">
          <div className="filter-group">
            <label>Event Type:</label>
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
            {selectedEventType && (
              <button className="clear-filter" onClick={clearEventTypeFilter}>
                Clear
              </button>
            )}
          </div>

          <div className="filter-group">
            <label>Recipient (filter):</label>
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
        <div className="events-section">
          <h3>Email Events ({events.length})</h3>
          {loading ? (
            <p>Loading events...</p>
          ) : events.length === 0 ? (
            <p>No events found for this job.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Timestamp</th>
                  <th>Recipient</th>
                  <th>Event Type</th>
                  <th>Message ID</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => (
                  <tr key={`${event.messageId}-${event.eventType}`}>
                    <td>{formatDate(event.timestamp)}</td>
                    <td>{event.recipient}</td>
                    <td>
                      <span className={`event-type ${event.eventType.toLowerCase()}`}>
                        {event.eventType}
                      </span>
                    </td>
                    <td className="monospace">{event.messageId}</td>
                  </tr>
                ))}
              </tbody>
            </table>
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
