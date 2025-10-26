import { useState, useEffect } from "react";

interface JobStatusProps {
  apiUrl: string;
  token: string;
  jobId: string | null;
}

interface JobData {
  jobId: string;
  status: string;
  totalRecipients: number;
  sent: number;
  failed: number;
  createdAt: string;
  failedRecipients?: Array<{ email: string; error: string }>;
}

export default function JobStatus({ apiUrl, token: _token, jobId }: JobStatusProps) {
  const [searchJobId, setSearchJobId] = useState(jobId || "");
  const [jobData, setJobData] = useState<JobData | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (jobId) {
      fetchJobStatus(jobId);
    }
  }, [jobId]);

  const fetchJobStatus = async (id: string) => {
    if (!id) return;

    setLoading(true);
    setError("");

    try {
      const response = await fetch(`${apiUrl}/email/status/${id}`);
      const data = await response.json();

      if (response.ok) {
        setJobData(data);
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
    </div>
  );
}
