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

interface JobStatusProps {
  apiUrl: string;
  token: string;
  jobId: string | null;
  onJobIdChange?: (jobId: string) => void;
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
}: JobStatusProps) {
  const [searchJobId, setSearchJobId] = useState(jobId || "");
  const [jobData, setJobData] = useState<JobData | null>(null);
  const [jobs, setJobs] = useState<JobListItem[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadingJobs, setLoadingJobs] = useState(false);

  // Fetch jobs list on mount
  useEffect(() => {
    fetchJobs();
  }, []);

  useEffect(() => {
    if (jobId) {
      fetchJobStatus(jobId);
    }
  }, [jobId]);

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
      } else {
        setError(data.error || "Failed to fetch job status");
      }
    } catch (err) {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
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
          <div className="stats">
            <div className="stat">
              <label>Job ID</label>
              <span>{jobData.jobId}</span>
            </div>
            {jobData.sender && (
              <div className="stat">
                <label>Sender</label>
                <span>{jobData.sender}</span>
              </div>
            )}
            {jobData.subject && (
              <div className="stat">
                <label>Subject</label>
                <span>{jobData.subject}</span>
              </div>
            )}
            <div className="stat">
              <label>Status</label>
              <span>{jobData.status}</span>
            </div>
            <div className="stat">
              <label>Total Recipients</label>
              <span>{jobData.totalRecipients}</span>
            </div>
            <div className="stat">
              <label>Sent</label>
              <span className="success">{jobData.sent}</span>
            </div>
            <div className="stat">
              <label>Failed</label>
              <span className="error">{jobData.failed}</span>
            </div>
            <div className="stat">
              <label>Created At</label>
              <span>{formatDate(jobData.createdAt)}</span>
            </div>
            {jobData.completedAt && (
              <div className="stat">
                <label>Completed At</label>
                <span>{formatDate(jobData.completedAt)}</span>
              </div>
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

          <div className="progress-bar">
            <div
              className="progress"
              style={{
                width: `${(jobData.sent / jobData.totalRecipients) * 100}%`,
              }}
            />
          </div>
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
