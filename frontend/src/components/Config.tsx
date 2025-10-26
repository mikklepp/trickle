import { useState, useEffect } from "react";

interface ConfigProps {
  apiUrl: string;
  token: string;
}

interface ConfigData {
  rateLimit: number;
  maxAttachmentSize: number;
}

export default function Config({ apiUrl, token }: ConfigProps) {
  const [config, setConfig] = useState<ConfigData>({ rateLimit: 60, maxAttachmentSize: 10485760 });
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetchConfig();
  }, []);

  const fetchConfig = async () => {
    try {
      const response = await fetch(`${apiUrl}/config`);
      const data = await response.json();
      if (response.ok) {
        setConfig(data);
      }
    } catch (err) {
      setError("Failed to fetch config");
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSuccess("");
    setLoading(true);

    try {
      const response = await fetch(`${apiUrl}/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });

      const data = await response.json();

      if (response.ok) {
        setSuccess("Config updated successfully");
        setConfig(data);
      } else {
        setError(data.error || "Failed to update config");
      }
    } catch (err) {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="config">
      <h2>Configuration</h2>
      <form onSubmit={handleSubmit}>
        <div className="form-group">
          <label>Rate Limit (seconds between emails)</label>
          <input
            type="number"
            min="1"
            max="3600"
            value={config.rateLimit}
            onChange={(e) => setConfig({ ...config, rateLimit: parseInt(e.target.value) })}
            required
          />
          <small>Time to wait between sending each email (1-3600 seconds)</small>
        </div>

        <div className="form-group">
          <label>Max Attachment Size (bytes)</label>
          <input
            type="number"
            min="0"
            max="26214400"
            value={config.maxAttachmentSize}
            onChange={(e) =>
              setConfig({ ...config, maxAttachmentSize: parseInt(e.target.value) })
            }
            required
          />
          <small>Maximum attachment size in bytes (max 25MB)</small>
        </div>

        {error && <div className="error">{error}</div>}
        {success && <div className="success">{success}</div>}

        <button type="submit" disabled={loading}>
          {loading ? "Saving..." : "Save Config"}
        </button>
      </form>
    </div>
  );
}
