import { useState, useEffect } from "react";

interface EmailFormProps {
  apiUrl: string;
  token: string;
  onJobCreated: (jobId: string) => void;
}

export default function EmailForm({ apiUrl, token, onJobCreated }: EmailFormProps) {
  const [senders, setSenders] = useState<string[]>([]);
  const [sender, setSender] = useState("");
  const [recipients, setRecipients] = useState("");
  const [subject, setSubject] = useState("");
  const [content, setContent] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetchSenders();
  }, []);

  const fetchSenders = async () => {
    try {
      const response = await fetch(`${apiUrl}/senders`);
      const data = await response.json();
      setSenders(data.senders || []);
      if (data.senders && data.senders.length > 0) {
        setSender(data.senders[0]);
      }
    } catch (err) {
      setError("Failed to fetch verified senders");
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const response = await fetch(`${apiUrl}/email/send`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sender,
          recipients,
          subject,
          content,
          attachments: [],
        }),
      });

      const data = await response.json();

      if (response.ok) {
        onJobCreated(data.jobId);
        // Reset form
        setRecipients("");
        setSubject("");
        setContent("");
      } else {
        setError(data.error || "Failed to send email");
      }
    } catch (err) {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  if (senders.length === 0) {
    return (
      <div className="email-form">
        <h2>Send Email</h2>
        <p className="error">
          No verified senders found. Please verify an email address in AWS SES first.
        </p>
      </div>
    );
  }

  return (
    <div className="email-form">
      <h2>Send Email</h2>
      <form onSubmit={handleSubmit}>
        <div className="form-group">
          <label>From</label>
          <select value={sender} onChange={(e) => setSender(e.target.value)} required>
            {senders.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>

        <div className="form-group">
          <label>Recipients (semicolon-separated)</label>
          <textarea
            value={recipients}
            onChange={(e) => setRecipients(e.target.value)}
            placeholder="email1@example.com; email2@example.com; email3@example.com"
            rows={3}
            required
          />
          <small>Separate multiple email addresses with semicolons</small>
        </div>

        <div className="form-group">
          <label>Subject</label>
          <input
            type="text"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            required
          />
        </div>

        <div className="form-group">
          <label>Content</label>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={10}
            required
          />
        </div>

        {error && <div className="error">{error}</div>}

        <button type="submit" disabled={loading}>
          {loading ? "Sending..." : "Send Emails"}
        </button>
      </form>
    </div>
  );
}
