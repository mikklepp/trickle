import { useState } from "react";

interface EventDetails {
  bounceType?: string;
  bounceSubType?: string;
  diagnosticCode?: string;
  complainedRecipientCount?: number;
  processingTimeMillis?: number;
  smtpResponse?: string;
  remoteMtaIp?: string;
  userAgent?: string;
  link?: string;
  reason?: string;
  reasonCode?: string;
  delayType?: string;
  [key: string]: unknown;
}

interface ClassifiedEvent {
  timestamp: number;
  recipient: string;
  eventType: string;
  messageId: string;
  jobId: string;
  details?: EventDetails;
  severity: "critical" | "warning" | "info";
  icon: string;
  interpretation: string;
  recommendation: string;
  requiresAction: boolean;
  category?: "hard" | "soft" | "unknown";
}

interface EventDetailCardProps {
  event: ClassifiedEvent;
}

export default function EventDetailCard({ event }: EventDetailCardProps) {
  const [showRaw, setShowRaw] = useState(false);

  const getSeverityColor = () => {
    switch (event.severity) {
      case "critical":
        return "#ffe6e6"; // Light red
      case "warning":
        return "#fff4e6"; // Light orange
      case "info":
      default:
        return "#f0f8ff"; // Light blue
    }
  };

  const getSeverityBorder = () => {
    switch (event.severity) {
      case "critical":
        return "#e74c3c"; // Red
      case "warning":
        return "#f39c12"; // Orange
      case "info":
      default:
        return "#3498db"; // Blue
    }
  };

  const formatTimestamp = (ms: number) => {
    const date = new Date(ms);
    return date.toLocaleString();
  };

  const renderEventDetails = () => {
    if (!event.details) return null;

    const details: any[] = [];

    // Bounce-specific details
    if (event.eventType === "Bounce") {
      if (event.details.bounceType) {
        details.push(
          <div key="bounceType" className="detail-row">
            <span className="detail-label">Bounce Type:</span>
            <span className="detail-value">{event.details.bounceType}</span>
          </div>
        );
      }
      if (event.details.bounceSubType) {
        details.push(
          <div key="bounceSubType" className="detail-row">
            <span className="detail-label">Bounce Subtype:</span>
            <span className="detail-value">{event.details.bounceSubType}</span>
          </div>
        );
      }
      if (event.details.diagnosticCode) {
        details.push(
          <div key="diagnosticCode" className="detail-row">
            <span className="detail-label">Diagnostic Code:</span>
            <span className="detail-value" style={{ fontFamily: "monospace" }}>
              {event.details.diagnosticCode}
            </span>
          </div>
        );
      }
    }

    // Complaint-specific details
    if (event.eventType === "Complaint" && event.details.complainedRecipientCount) {
      details.push(
        <div key="complaintCount" className="detail-row">
          <span className="detail-label">Complained Recipients:</span>
          <span className="detail-value">{event.details.complainedRecipientCount}</span>
        </div>
      );
    }

    // Delivery-specific details
    if (event.eventType === "Delivery") {
      if (event.details.processingTimeMillis) {
        details.push(
          <div key="processingTime" className="detail-row">
            <span className="detail-label">Delivery Time:</span>
            <span className="detail-value">{event.details.processingTimeMillis}ms</span>
          </div>
        );
      }
      if (event.details.smtpResponse) {
        details.push(
          <div key="smtpResponse" className="detail-row">
            <span className="detail-label">SMTP Response:</span>
            <span className="detail-value" style={{ fontFamily: "monospace" }}>
              {event.details.smtpResponse}
            </span>
          </div>
        );
      }
      if (event.details.remoteMtaIp) {
        details.push(
          <div key="remoteMtaIp" className="detail-row">
            <span className="detail-label">Receiving Server IP:</span>
            <span className="detail-value">{event.details.remoteMtaIp}</span>
          </div>
        );
      }
    }

    // Open/Click-specific details
    if ((event.eventType === "Open" || event.eventType === "Click") && event.details.userAgent) {
      details.push(
        <div key="userAgent" className="detail-row">
          <span className="detail-label">User Agent:</span>
          <span className="detail-value" style={{ fontSize: "0.9em" }}>
            {event.details.userAgent}
          </span>
        </div>
      );
    }

    if (event.eventType === "Click" && event.details.link) {
      details.push(
        <div key="link" className="detail-row">
          <span className="detail-label">Link Clicked:</span>
          <span className="detail-value" style={{ wordBreak: "break-all", fontSize: "0.9em" }}>
            {event.details.link}
          </span>
        </div>
      );
    }

    // Reject-specific details
    if (event.eventType === "Reject") {
      if (event.details.reason) {
        details.push(
          <div key="reason" className="detail-row">
            <span className="detail-label">Rejection Reason:</span>
            <span className="detail-value">{event.details.reason}</span>
          </div>
        );
      }
      if (event.details.reasonCode) {
        details.push(
          <div key="reasonCode" className="detail-row">
            <span className="detail-label">Reason Code:</span>
            <span className="detail-value">{event.details.reasonCode}</span>
          </div>
        );
      }
    }

    // Delivery Delay-specific details
    if (event.eventType === "DeliveryDelay") {
      if (event.details.delayType) {
        details.push(
          <div key="delayType" className="detail-row">
            <span className="detail-label">Delay Type:</span>
            <span className="detail-value">{event.details.delayType}</span>
          </div>
        );
      }
      if (event.details.processingTimeMillis) {
        details.push(
          <div key="delayTime" className="detail-row">
            <span className="detail-label">Delay Time:</span>
            <span className="detail-value">{event.details.processingTimeMillis}ms</span>
          </div>
        );
      }
    }

    return details.length > 0 ? details : null;
  };

  return (
    <div
      className="event-detail-card"
      style={{
        backgroundColor: getSeverityColor(),
        borderLeft: `4px solid ${getSeverityBorder()}`,
        padding: "1rem",
        margin: "0.5rem 0",
        borderRadius: "4px",
      }}
    >
      {/* Header with icon and interpretation */}
      <div style={{ marginBottom: "0.75rem" }}>
        <div style={{ fontSize: "1.1rem", fontWeight: "600", marginBottom: "0.25rem" }}>
          {event.icon} {event.interpretation}
        </div>
        <div style={{ fontSize: "0.9rem", color: "#666", marginBottom: "0.5rem" }}>
          {event.recipient} • {formatTimestamp(event.timestamp)}
        </div>
      </div>

      {/* Event details */}
      {renderEventDetails() && (
        <div style={{ marginBottom: "0.75rem", padding: "0.5rem 0" }}>
          <div style={{ fontSize: "0.9rem", marginBottom: "0.5rem", fontWeight: "500" }}>
            📋 Event Details:
          </div>
          <div style={{ marginLeft: "1rem" }}>{renderEventDetails()}</div>
        </div>
      )}

      {/* Recommendation */}
      {event.requiresAction && (
        <div
          style={{
            marginBottom: "0.75rem",
            padding: "0.5rem",
            backgroundColor: "rgba(0,0,0,0.05)",
            borderRadius: "4px",
          }}
        >
          <div style={{ fontSize: "0.9rem", marginBottom: "0.25rem", fontWeight: "500" }}>
            ✅ Recommended Action:
          </div>
          <div style={{ fontSize: "0.9rem", lineHeight: "1.5" }}>{event.recommendation}</div>
        </div>
      )}

      {/* Toggle raw data */}
      <button
        onClick={() => setShowRaw(!showRaw)}
        style={{
          background: "none",
          border: "none",
          color: "#3498db",
          cursor: "pointer",
          padding: "0",
          fontSize: "0.85rem",
          textDecoration: "underline",
          marginTop: "0.5rem",
        }}
      >
        {showRaw ? "Hide raw data ▲" : "Show raw data ▼"}
      </button>

      {/* Raw data */}
      {showRaw && (
        <pre
          style={{
            margin: "0.75rem 0 0 0",
            padding: "0.75rem",
            backgroundColor: "#f5f5f5",
            fontSize: "11px",
            overflow: "auto",
            maxHeight: "300px",
            borderRadius: "4px",
          }}
        >
          {JSON.stringify(event, null, 2)}
        </pre>
      )}
    </div>
  );
}
