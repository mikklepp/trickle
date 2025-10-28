import { useState, useEffect, useMemo } from "react";
import ReactQuill from "react-quill-new";
import imageCompression from "browser-image-compression";
import "react-quill-new/dist/quill.snow.css";

interface EmailFormProps {
  apiUrl: string;
  token: string;
  onJobCreated: (jobId: string) => void;
}

interface VerifiedIdentities {
  emails: string[];
  domains: string[];
}

interface Attachment {
  filename: string;
  content: string; // base64
  contentType: string;
  size: number;
}

interface Config {
  rateLimit: number;
  maxAttachmentSize: number;
  headers?: Record<string, string>;
}

interface Quota {
  max24HourSend: number;
  sentLast24Hours: number;
  remaining: number;
  usableQuota: number;
  available: number;
  maxSendRate: number;
  minRateLimit: number;
  productionAccessEnabled: boolean;
}

const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_FILE_TYPES = {
  "application/pdf": ".pdf",
  "image/jpeg": ".jpg,.jpeg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

interface RecentSender {
  email: string;
  name?: string;
}

export default function EmailForm({ apiUrl, token, onJobCreated }: EmailFormProps) {
  const [verifiedEmails, setVerifiedEmails] = useState<string[]>([]);
  const [verifiedDomains, setVerifiedDomains] = useState<string[]>([]);
  const [recentSenders, setRecentSenders] = useState<RecentSender[]>([]);
  const [sender, setSender] = useState("");
  const [senderName, setSenderName] = useState("");
  const [recipients, setRecipients] = useState("");
  const [subject, setSubject] = useState("");
  const [content, setContent] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [config, setConfig] = useState<Config>({ rateLimit: 60, maxAttachmentSize: 10485760 });
  const [quota, setQuota] = useState<Quota | null>(null);

  useEffect(() => {
    fetchSenders();
    fetchConfig();
    fetchQuota();
    loadRecentSenders();
  }, []);

  const loadRecentSenders = () => {
    const recent = localStorage.getItem("recentSenders");
    if (recent) {
      try {
        const parsed = JSON.parse(recent);
        // Handle backward compatibility: convert old string[] format to new RecentSender[] format
        const senders: RecentSender[] = Array.isArray(parsed)
          ? parsed.map((item) =>
              typeof item === "string" ? { email: item } : item
            )
          : [];
        setRecentSenders(senders);
        if (senders.length > 0 && !sender) {
          setSender(senders[0].email);
          if (senders[0].name) {
            setSenderName(senders[0].name);
          }
        }
      } catch (err) {
        console.error("Failed to parse recent senders:", err);
      }
    }
  };

  const saveRecentSender = (email: string, name: string = "") => {
    const newSender: RecentSender = { email, name: name || undefined };
    const recent = [
      newSender,
      ...recentSenders.filter((s) => s.email !== email),
    ].slice(0, 5);
    setRecentSenders(recent);
    localStorage.setItem("recentSenders", JSON.stringify(recent));
    console.log("Saved recent senders:", recent);
  };

  const fetchSenders = async () => {
    try {
      const response = await fetch(`${apiUrl}/senders`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
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

  const fetchConfig = async () => {
    try {
      const response = await fetch(`${apiUrl}/config`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      const data = (await response.json()) as Config;
      setConfig(data);
    } catch (err) {
      // Use defaults on error
      console.error("Failed to fetch config:", err);
    }
  };

  const fetchQuota = async () => {
    try {
      const response = await fetch(`${apiUrl}/account/quota`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      const data = (await response.json()) as Quota;
      setQuota(data);
    } catch (err) {
      console.error("Failed to fetch quota:", err);
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

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;

    const newAttachments: Attachment[] = [];

    for (let file of Array.from(files)) {
      // Validate file type
      if (!Object.keys(ALLOWED_FILE_TYPES).includes(file.type)) {
        setError(
          `${file.name} has unsupported file type. Allowed: PDF, JPEG, PNG, GIF, WebP`
        );
        continue;
      }

      // Optimize images (compress if too large)
      const isImage = file.type.startsWith("image/");
      if (isImage && file.size > 1024 * 1024) {
        // Compress images larger than 1MB
        try {
          console.log(`Compressing ${file.name} (${(file.size / 1024 / 1024).toFixed(2)}MB)...`);
          file = await imageCompression(file, {
            maxSizeMB: 1,
            maxWidthOrHeight: 1920,
            useWebWorker: true,
          });
          console.log(`Compressed to ${(file.size / 1024 / 1024).toFixed(2)}MB`);
        } catch (err) {
          console.warn("Image compression failed, using original:", err);
        }
      }

      // Validate size after compression
      if (file.size > MAX_ATTACHMENT_SIZE) {
        setError(`${file.name} is too large (max 10MB)`);
        continue;
      }

      // Read file as base64
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = reader.result as string;
          // Remove data URL prefix
          const base64Data = result.split(",")[1];
          resolve(base64Data);
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });

      newAttachments.push({
        filename: file.name,
        content: base64,
        contentType: file.type,
        size: file.size,
      });
    }

    setAttachments([...attachments, ...newAttachments]);
    setError("");
  };

  const removeAttachment = (index: number) => {
    setAttachments(attachments.filter((_, i) => i !== index));
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const recipientCount = useMemo(() => {
    if (!recipients.trim()) return 0;
    return recipients
      .split(";")
      .map((r) => r.trim())
      .filter((r) => r.length > 0).length;
  }, [recipients]);

  const estimatedTime = useMemo(() => {
    if (recipientCount === 0) return null;

    const totalSeconds = recipientCount * config.rateLimit;
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    const parts = [];
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);

    const duration = parts.join(" ");
    const completionTime = new Date(Date.now() + totalSeconds * 1000);
    const timeStr = completionTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    return { duration, completionTime: timeStr };
  }, [recipientCount, config.rateLimit]);

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
      // Format sender as RFC 5322: "Name" <email@example.com> or just email@example.com
      const formattedSender = senderName.trim()
        ? `"${senderName}" <${sender}>`
        : sender;

      const response = await fetch(`${apiUrl}/email/send`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          sender: formattedSender,
          recipients,
          subject,
          content,
          headers: config.headers || {},
          attachments: attachments.map((a) => ({
            filename: a.filename,
            content: a.content,
            contentType: a.contentType,
          })),
        }),
      });

      const data = await response.json();

      if (response.ok) {
        saveRecentSender(sender, senderName);
        onJobCreated(data.jobId);
        // Reset form (but keep sender and senderName for convenience)
        setRecipients("");
        setSubject("");
        setContent("");
        setAttachments([]);
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

  const allSuggestions = [
    ...recentSenders.map((s) => s.email),
    ...verifiedEmails,
  ].filter((email, index, self) => self.indexOf(email) === index);

  return (
    <div className="email-form">
      <h2>Send Email</h2>

      {quota && (
        <div className="quota-info">
          Sent today: <strong>{quota.sentLast24Hours}</strong> • Remaining:{" "}
          <strong>{quota.remaining}</strong>
          {!quota.productionAccessEnabled && (
            <>
              {" "}
              •{" "}
              <span style={{ color: "orange" }}>
                ⚠️ Sandbox mode
              </span>
            </>
          )}
        </div>
      )}

      <form onSubmit={handleSubmit}>
        <div className="form-group">
          <label htmlFor="email">From</label>
          <input
            id="email"
            type="email"
            value={sender}
            onChange={(e) => setSender(e.target.value)}
            list="sender-suggestions"
            placeholder="Type or click a recent sender below"
            required
            autoComplete="email"
            autoCapitalize="off"
            autoCorrect="off"
          />
          <datalist id="sender-suggestions" key={allSuggestions.join(",")}>
            {allSuggestions.map((email) => (
              <option key={email} value={email} />
            ))}
          </datalist>
          {recentSenders.length > 0 && (
            <div className="recent-senders">
              {recentSenders.map((recentSender) => (
                <button
                  key={recentSender.email}
                  type="button"
                  className="sender-chip"
                  onClick={() => {
                    setSender(recentSender.email);
                    setSenderName(recentSender.name || "");
                  }}
                >
                  {recentSender.name ? `${recentSender.name} <${recentSender.email}>` : recentSender.email}
                </button>
              ))}
            </div>
          )}
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
          <label htmlFor="senderName">Sender Name (optional)</label>
          <input
            id="senderName"
            type="text"
            value={senderName}
            onChange={(e) => setSenderName(e.target.value)}
            placeholder="e.g., John Doe or Support Team"
            autoCapitalize="off"
            autoCorrect="off"
          />
          <small>
            How the sender name will appear in recipients' inboxes
          </small>
        </div>

        <div className="form-group">
          <label htmlFor="recipients">Recipients (semicolon-separated)</label>
          <textarea
            id="recipients"
            value={recipients}
            onChange={(e) => setRecipients(e.target.value)}
            placeholder="email1@example.com; email2@example.com; email3@example.com"
            rows={3}
            required
            autoCapitalize="off"
            autoCorrect="off"
          />
          <small>
            Separate multiple email addresses with semicolons
            {recipientCount > 0 && (
              <>
                <br />
                <strong>
                  {recipientCount} recipient{recipientCount !== 1 ? "s" : ""}
                </strong>
                {estimatedTime && recipientCount > 1 && (
                  <>
                    {" • "}
                    Expected duration: <strong>{estimatedTime.duration}</strong>
                    {" • "}
                    Estimated completion: <strong>{estimatedTime.completionTime}</strong>
                  </>
                )}
              </>
            )}
          </small>
        </div>

        <div className="form-group">
          <label htmlFor="subject">Subject</label>
          <input
            id="subject"
            type="text"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            required
          />
        </div>

        <div className="form-group">
          <label>Content</label>
          <ReactQuill
            theme="snow"
            value={content}
            onChange={setContent}
            placeholder="Write your email content here..."
            modules={{
              toolbar: [
                [{ header: [1, 2, 3, false] }],
                ["bold", "italic", "underline", "strike"],
                [{ list: "ordered" }, { list: "bullet" }],
                ["link"],
                ["clean"],
              ],
            }}
          />
        </div>

        <div className="form-group">
          <label htmlFor="attachments">
            Attachments (PDF, JPEG, PNG, GIF, WebP - max 10MB each)
            <br />
            <small>Images &gt;1MB will be automatically compressed</small>
          </label>
          <input
            id="attachments"
            type="file"
            accept=".pdf,.jpg,.jpeg,.png,.gif,.webp,application/pdf,image/jpeg,image/png,image/gif,image/webp"
            multiple
            onChange={handleFileUpload}
            disabled={loading}
          />
          {attachments.length > 0 && (
            <div className="attachments-list">
              {attachments.map((attachment, index) => (
                <div key={index} className="attachment-item">
                  <span className="attachment-name">
                    📎 {attachment.filename} ({formatFileSize(attachment.size)})
                  </span>
                  <button
                    type="button"
                    className="remove-attachment"
                    onClick={() => removeAttachment(index)}
                    disabled={loading}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {error && <div className="error">{error}</div>}

        <button type="submit" disabled={loading}>
          {loading ? "Sending..." : "Send Emails"}
        </button>
      </form>
    </div>
  );
}
