import { formatDate } from "../utils/formatDate";

export interface JobListItem {
  jobId: string;
  status: string;
  sender: string;
  subject: string;
  totalRecipients: number;
  sent: number;
  failed: number;
  createdAt: string;
}

interface JobsTableProps {
  jobs: JobListItem[];
  loading: boolean;
  selectedJobId: string | null;
  onSelect: (jobId: string) => void;
}

/**
 * The Recent Jobs list, shared by JobStatus and EmailLogs. Both rendered their
 * own byte-identical copy before; both now read the same cache entry too, since
 * they use the same query key.
 */
export default function JobsTable({ jobs, loading, selectedJobId, onSelect }: JobsTableProps) {
  if (loading) return <p>Loading jobs...</p>;
  if (jobs.length === 0) return <p>No jobs found.</p>;

  return (
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
            onClick={() => onSelect(job.jobId)}
            className={selectedJobId === job.jobId ? "active" : ""}
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
  );
}
