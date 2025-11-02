import { useState, useEffect } from "react";
import { format } from "date-fns";
import { calculateETA } from "../utils/calculateETA";

// Auto-refresh interval in milliseconds (while page is visible)
// Collects SES events that arrive during and after job completion
const AUTO_REFRESH_INTERVAL_MS = 5000; // 5 seconds

/**
 * Formats an ISO date string in local time
 * Example: 2025-10-28 14:12
 */
function formatDate(isoString: string): string {
  const date = new Date(isoString);
  return format(date, "yyyy-MM-dd HH:mm");
}

interface JobStatusProps {
  apiUrl: string;
  token: string;
  jobId: string | null;
  onJobIdChange?: (jobId: string) => void;
  onNavigateToLogs?: (jobId: string, eventType: string | null) => void;
}

interface EventMetrics {
  Send: number;
  Delivery: number;
  Bounce: number;
  Complaint: number;
  Reject: number;
  DeliveryDelay: number;
  Open: number;
  Click: number;
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

interface JobData {
  jobId: string;
  status: string;
  totalRecipients: number;
  sent: number;
  failed: number;
  createdAt: string;
  completedAt?: string;
  sender?: string;
  subject?: string;
  lastError?: {
    email: string;
    errorName: string;
    errorMessage: string;
  };
  lastErrorAt?: string;
  metrics?: JobMetrics;
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

export default function JobStatus({
  apiUrl,
  token,
  jobId,
  onJobIdChange,
  onNavigateToLogs,
}: JobStatusProps) {
  const [searchJobId, setSearchJobId] = useState(jobId || "");
  const [jobData, setJobData] = useState<JobData | null>(null);
  const [eventMetrics, setEventMetrics] = useState<EventMetrics | null>(null);
  const [jobs, setJobs] = useState<JobListItem[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadingJobs, setLoadingJobs] = useState(false);
  const [loadingMetrics, setLoadingMetrics] = useState(false);
  const [isPageVisible, setIsPageVisible] = useState(true);

  // Fetch jobs list on mount
  useEffect(() => {
    fetchJobs();
  }, []);

  // Track page visibility to pause polling when tab is hidden
  useEffect(() => {
    const handleVisibilityChange = () => {
      setIsPageVisible(!document.hidden);
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, []);

  useEffect(() => {
    if (jobId) {
      fetchJobStatus(jobId);
    }
  }, [jobId]);

  // Auto-refresh while page is visible (to collect events even after job completion)
  useEffect(() => {
    if (!jobId || !jobData || !isPageVisible) {
      return;
    }

    const interval = setInterval(() => {
      fetchJobStatus(jobId);
    }, AUTO_REFRESH_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [jobId, jobData, isPageVisible]);

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

  const fetchJobStatus = async (id: string) => {
    if (!id) return;

    setLoading(true);
    setError("");

    try {
      const response = await fetch(`${apiUrl}/email/status/${id}`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      const data = await response.json();

      if (response.ok) {
        setJobData(data);
        // Notify parent of jobId change
        if (onJobIdChange) {
          onJobIdChange(id);
        }
        // Fetch summary metrics for event type counts (for backward compatibility)
        fetchEventMetrics(id);
      } else {
        setError(data.error || "Failed to fetch job status");
      }
    } catch (err) {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const fetchEventMetrics = async (id: string) => {
    if (!id) return;

    setLoadingMetrics(true);
    try {
      const response = await fetch(`${apiUrl}/email/events/summary/${id}`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      const data = await response.json();

      if (response.ok) {
        setEventMetrics(data);
      } else {
        console.error("Failed to fetch event metrics:", data.error);
      }
    } catch (err) {
      console.error("Failed to fetch event metrics:", err);
    } finally {
      setLoadingMetrics(false);
    }
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    fetchJobStatus(searchJobId);
  };

  const handleJobClick = (id: string) => {
    setSearchJobId(id);
    fetchJobStatus(id);
  };

  return (
    <div className="job-status">
      <h2>Job Status</h2>

      <form onSubmit={handleSearch} className="search-form">
        <input
          type="text"
          value={searchJobId}
          onChange={(e) => setSearchJobId(e.target.value)}
          placeholder="Enter Job ID"
        />
        <button type="submit" disabled={loading}>
          {loading ? "Loading..." : "Check Status"}
        </button>
      </form>

      {error && <div className="error">{error}</div>}

      {jobData && (
        <div className="job-details">
          {/* Progress Bar at Top - with time estimates */}
          {jobData.status === "pending" &&
            (() => {
              const eta = calculateETA({
                totalRecipients: jobData.totalRecipients,
                sent: jobData.sent,
                createdAt: jobData.createdAt,
              });
              const progressPercent = (jobData.sent / jobData.totalRecipients) * 100;
              return (
                <div className="progress-section">
                  <div className="progress-header">
                    <span className="progress-label">
                      Progress: {jobData.sent}/{jobData.totalRecipients} sent
                    </span>
                    {eta.remainingSeconds > 0 && (
                      <span className="progress-time">
                        ETA: {eta.completionTimeFormatted} ({eta.remainingDuration} remaining)
                      </span>
                    )}
                  </div>
                  <div className="progress-bar">
                    <div
                      className="progress"
                      style={{
                        width: `${progressPercent}%`,
                      }}
                    />
                  </div>
                  <div className="progress-footer">
                    <span className="elapsed">Elapsed: {eta.elapsedDuration}</span>
                  </div>
                </div>
              );
            })()}

          {/* Completed Job Progress */}
          {jobData.status !== "pending" && (
            <div className="progress-section completed">
              <div className="progress-header">
                <span className="progress-label">
                  {jobData.status === "completed" ? "✅ Completed" : "❌ Failed"}: {jobData.sent}/
                  {jobData.totalRecipients} sent
                </span>
              </div>
              <div className="progress-bar">
                <div
                  className="progress"
                  style={{
                    width: "100%",
                  }}
                />
              </div>
            </div>
          )}

          {/* Action Required Section */}
          {jobData.metrics &&
            (jobData.metrics.hardBounceCount > 0 || jobData.metrics.complaintCount > 0) && (
              <div className="action-required-section">
                <h3>⚠️ Action Required</h3>
                {jobData.metrics.hardBounceCount > 0 && (
                  <div className="action-item critical">
                    <div className="action-header">
                      <span className="action-icon">🔴</span>
                      <span className="action-title">
                        Remove Hard Bounced Addresses ({jobData.metrics.hardBounceCount})
                      </span>
                    </div>
                    <p className="action-description">
                      {jobData.metrics.hardBounceCount} email address(es) permanently failed
                      delivery. These should be removed from your list immediately to protect your
                      sender reputation.
                    </p>
                    {onNavigateToLogs && (
                      <button
                        className="action-button"
                        onClick={() => onNavigateToLogs(jobData.jobId, "Bounce")}
                      >
                        View Hard Bounces
                      </button>
                    )}
                  </div>
                )}
                {jobData.metrics.complaintCount > 0 && (
                  <div className="action-item critical">
                    <div className="action-header">
                      <span className="action-icon">🚨</span>
                      <span className="action-title">
                        Investigate Complaints ({jobData.metrics.complaintCount})
                      </span>
                    </div>
                    <p className="action-description">
                      {jobData.metrics.complaintCount} recipient(s) marked your email as spam.
                      Remove these addresses and review your email content and permission practices.
                    </p>
                    {onNavigateToLogs && (
                      <button
                        className="action-button"
                        onClick={() => onNavigateToLogs(jobData.jobId, "Complaint")}
                      >
                        View Complaints
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}

          {/* Warnings from metrics */}
          {jobData.metrics && jobData.metrics.warnings && jobData.metrics.warnings.length > 0 && (
            <div className="metrics-warnings">
              {jobData.metrics.warnings.map((warning, idx) => (
                <div key={idx} className="warning-banner">
                  {warning}
                </div>
              ))}
            </div>
          )}

          <div className="stats">
            <div className="stat stat-small">
              <label>Job ID</label>
              <span>{jobData.jobId}</span>
            </div>
            {jobData.sender && (
              <div className="stat stat-small">
                <label>Sender</label>
                <span>{jobData.sender}</span>
              </div>
            )}
            {jobData.subject && (
              <div className="stat stat-small">
                <label>Subject</label>
                <span>{jobData.subject}</span>
              </div>
            )}
            <div className="stat stat-large">
              <label>Status</label>
              <span className={`status-badge ${jobData.status}`}>{jobData.status}</span>
            </div>
            <div className="stat stat-large">
              <label>Total Recipients</label>
              <span>{jobData.totalRecipients}</span>
            </div>
            <div className="stat stat-large">
              <label>Sent</label>
              <span className="success">{jobData.sent}</span>
            </div>
            <div className="stat stat-large">
              <label>Failed</label>
              <span className="error">{jobData.failed}</span>
            </div>

            {/* Email Event Metrics from job.metrics */}
            {jobData.metrics && (
              <>
                <div
                  className={`stat stat-large ${jobData.metrics.hardBounceRate > 0.05 ? "critical" : jobData.metrics.hardBounceRate > 0.02 ? "warning" : ""}`}
                >
                  <label>Hard Bounces</label>
                  <span
                    className={
                      jobData.metrics.hardBounceRate > 0.05
                        ? "error"
                        : jobData.metrics.hardBounceRate > 0.02
                          ? "error"
                          : ""
                    }
                  >
                    {jobData.metrics.hardBounceCount} (
                    {(jobData.metrics.hardBounceRate * 100).toFixed(1)}%)
                  </span>
                </div>
                <div className="stat stat-large">
                  <label>Soft Bounces</label>
                  <span>{jobData.metrics.softBounceCount}</span>
                </div>
                <div
                  className={`stat stat-large ${jobData.metrics.complaintRate > 0.003 ? "critical" : jobData.metrics.complaintRate > 0.001 ? "warning" : ""}`}
                >
                  <label>Complaints</label>
                  <span className={jobData.metrics.complaintRate > 0.001 ? "error" : ""}>
                    {jobData.metrics.complaintCount} (
                    {(jobData.metrics.complaintRate * 100).toFixed(2)}%)
                  </span>
                </div>
              </>
            )}

            <div className="stat stat-large">
              <label>Created At</label>
              <span>{formatDate(jobData.createdAt)}</span>
            </div>
            {jobData.completedAt && (
              <div className="stat stat-large">
                <label>Completed At</label>
                <span>{formatDate(jobData.completedAt)}</span>
              </div>
            )}

            {/* Email Event Metrics as Stat Cards */}
            {eventMetrics && !loadingMetrics && (
              <>
                <div
                  className="stat stat-large"
                  onClick={() => onNavigateToLogs?.(jobData.jobId, "Delivery")}
                  style={{ cursor: onNavigateToLogs ? "pointer" : "default" }}
                  title="Click to view delivery events"
                >
                  <label>Delivered</label>
                  <span className="success">{eventMetrics.Delivery}</span>
                </div>
                <div
                  className="stat stat-large"
                  onClick={() => onNavigateToLogs?.(jobData.jobId, "Bounce")}
                  style={{ cursor: onNavigateToLogs ? "pointer" : "default" }}
                  title="Click to view bounce events"
                >
                  <label>Bounces</label>
                  <span className="error">{eventMetrics.Bounce}</span>
                </div>
                <div
                  className="stat stat-large"
                  onClick={() => onNavigateToLogs?.(jobData.jobId, "Complaint")}
                  style={{ cursor: onNavigateToLogs ? "pointer" : "default" }}
                  title="Click to view complaint events"
                >
                  <label>Complaints</label>
                  <span className="error">{eventMetrics.Complaint}</span>
                </div>
                {eventMetrics.Open > 0 && (
                  <div
                    className="stat stat-large"
                    onClick={() => onNavigateToLogs?.(jobData.jobId, "Open")}
                    style={{ cursor: onNavigateToLogs ? "pointer" : "default" }}
                    title="Click to view open events"
                  >
                    <label>Opened</label>
                    <span className="success">{eventMetrics.Open}</span>
                  </div>
                )}
                {eventMetrics.Click > 0 && (
                  <div
                    className="stat stat-large"
                    onClick={() => onNavigateToLogs?.(jobData.jobId, "Click")}
                    style={{ cursor: onNavigateToLogs ? "pointer" : "default" }}
                    title="Click to view click events"
                  >
                    <label>Clicked</label>
                    <span className="success">{eventMetrics.Click}</span>
                  </div>
                )}
              </>
            )}
          </div>

          {jobData.lastError && (
            <div className="error-details">
              <h3>Last Error</h3>
              <div className="error-info">
                <p>
                  <strong>Recipient:</strong> {jobData.lastError.email}
                </p>
                <p>
                  <strong>Error Type:</strong> {jobData.lastError.errorName}
                </p>
                <p>
                  <strong>Message:</strong> {jobData.lastError.errorMessage}
                </p>
                {jobData.lastErrorAt && (
                  <p>
                    <strong>Time:</strong> {formatDate(jobData.lastErrorAt)}
                  </p>
                )}
              </div>
            </div>
          )}

          {onNavigateToLogs && (
            <form className="search-form" style={{ marginTop: "20px" }}>
              <button type="button" onClick={() => onNavigateToLogs(jobData.jobId, null)}>
                View All Email Logs
              </button>
            </form>
          )}
        </div>
      )}

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
                  className={jobData?.jobId === job.jobId ? "active" : ""}
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
