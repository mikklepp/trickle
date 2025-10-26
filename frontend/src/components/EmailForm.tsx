import { useState, useEffect } from "react";

interface EmailFormProps {
  apiUrl: string;
  token: string;
  onJobCreated: (jobId: string) => void;
}

interface VerifiedIdentities {
  emails: string[];
  domains: string[];
}

export default function EmailForm({ apiUrl, token: _token, onJobCreated }: EmailFormProps) {
  const [verifiedEmails, setVerifiedEmails] = useState<string[]>([]);
  const [verifiedDomains, setVerifiedDomains] = useState<string[]>([]);
  const [recentSenders, setRecentSenders] = useState<string[]>([]);
  const [sender, setSender] = useState("");
  const [recipients, setRecipients] = useState("");
  const [subject, setSubject] = useState("");
  const [content, setContent] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetchSenders();
    loadRecentSenders();
  }, []);

  const loadRecentSenders = () => {
    const recent = localStorage.getItem("recentSenders");
    if (recent) {
      const senders = JSON.parse(recent) as string[];
      setRecentSenders(senders);
      if (senders.length > 0 && !sender) {
        setSender(senders[0]);
      }
    }
  };

  const saveRecentSender = (email: string) => {
    const recent = [email, ...recentSenders.filter((s) => s !== email)].slice(0, 5);
    setRecentSenders(recent);
    localStorage.setItem("recentSenders", JSON.stringify(recent));
  };

  const fetchSenders = async () => {
    try {
      const response = await fetch(`${apiUrl}/senders`);
      const data = (await response.json()) as VerifiedIdentities;
      setVerifiedEmails(data.emails || []);
      setVerifiedDomains(data.domains || []);

      // Set first available sender
      if (!sender) {
        if (data.emails && data.emails.length > 0) {
          setSender(data.emails[0]);
        }
      }
    } catch (err) {
      setError("Failed to fetch verified senders");
    }
  };

  const isValidSender = (email: string): boolean => {
    // Check if email exactly matches a verified email
    if (verifiedEmails.includes(email)) {
      return true;
    }

    // Check if email domain matches a verified domain
    const domain = email.split("@")[1];
    if (domain && verifiedDomains.includes(domain)) {
      return true;
    }

    return false;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    // Validate sender
    if (!isValidSender(sender)) {
      setError(
        `Invalid sender email. Must be a verified email or from a verified domain (${verifiedDomains.join(", ")})`
      );
      return;
    }

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
        saveRecentSender(sender);
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

  if (verifiedEmails.length === 0 && verifiedDomains.length === 0) {
    return (
      <div className="email-form">
        <h2>Send Email</h2>
        <p className="error">
          No verified senders found. Please verify an email address or domain in AWS SES first.
        </p>
      </div>
    );
  }

  const allSuggestions = [...recentSenders, ...verifiedEmails].filter(
    (email, index, self) => self.indexOf(email) === index
  );

  return (
    <div className="email-form">
      <h2>Send Email</h2>
      <form onSubmit={handleSubmit}>
        <div className="form-group">
          <label>From</label>
          <input
            type="email"
            value={sender}
            onChange={(e) => setSender(e.target.value)}
            list="sender-suggestions"
            placeholder="your@example.com"
            required
          />
          <datalist id="sender-suggestions">
            {allSuggestions.map((email) => (
              <option key={email} value={email} />
            ))}
          </datalist>
          <small className="hint">
            {verifiedDomains.length > 0 && (
              <>
                ✓ Verified domains: <strong>{verifiedDomains.join(", ")}</strong>
                <br />
              </>
            )}
            {verifiedEmails.length > 0 && (
              <>
                ✓ Verified emails: <strong>{verifiedEmails.join(", ")}</strong>
              </>
            )}
          </small>
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
