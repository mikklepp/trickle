import { useState, useEffect } from "react";

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
  sender?: string;
  subject?: string;
  failedRecipients?: Array<{ email: string; error: string }>;
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
              <span>{new Date(jobData.createdAt).toLocaleString()}</span>
            </div>
          </div>

          {jobData.failedRecipients && jobData.failedRecipients.length > 0 && (
            <div className="failed-recipients">
              <h3>Failed Recipients</h3>
              <ul>
                {jobData.failedRecipients.map((recipient, i) => (
                  <li key={i}>
                    <strong>{recipient.email}</strong>: {recipient.error}
                  </li>
                ))}
              </ul>
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
                  <td>{new Date(job.createdAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
