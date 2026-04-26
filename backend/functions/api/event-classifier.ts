/**
 * Event Classification and Recommendation Engine
 * Classifies email events by severity and provides actionable recommendations
 */

export type EventSeverity = "critical" | "warning" | "info";
export type BounceCategory = "hard" | "soft" | "unknown";

export interface EventClassification {
  severity: EventSeverity;
  category?: BounceCategory;
  icon: string;
  interpretation: string;
  recommendation: string;
  requiresAction: boolean;
}

export interface EmailEvent {
  timestamp: number;
  recipient: string;
  eventType: string;
  messageId: string;
  jobId: string;
  details?: Record<string, unknown>;
}

// Transient subtypes that won't resolve themselves on retry — sender must act.
const EFFECTIVELY_PERMANENT_TRANSIENT_SUBTYPES = new Set([
  "MessageTooLarge",
  "AttachmentRejected",
  "ContentRejected",
  "MailFromDomainNotVerified",
]);

function appendDiagnostic(text: string, diagnosticCode?: string): string {
  if (!diagnosticCode) return text;
  const trimmed = diagnosticCode.trim();
  if (!trimmed) return text;
  const truncated = trimmed.length > 240 ? `${trimmed.slice(0, 240)}…` : trimmed;
  return `${text} (${truncated})`;
}

/**
 * Classify a bounce event by type, subtype, and SMTP enhanced status code.
 *
 * SES marks a bounce as "Transient" whenever the receiving server returned
 * something it could plausibly retry, but several signals make a bounce
 * effectively permanent:
 *   - RFC 3463 enhanced status codes starting with "5." are permanent
 *     failures regardless of SES's bounceType label.
 *   - Specific Transient subtypes (MessageTooLarge, AttachmentRejected,
 *     ContentRejected, MailFromDomainNotVerified) won't resolve without
 *     sender intervention.
 */
export function classifyBounce(
  bounceType?: string,
  bounceSubType?: string,
  diagnosticCode?: string,
  bounceStatus?: string
): EventClassification {
  const statusIsPermanent = typeof bounceStatus === "string" && /^5\./.test(bounceStatus.trim());

  // Hard/Permanent bounces - CRITICAL
  if (bounceType === "Permanent") {
    let interpretation: string;
    switch (bounceSubType) {
      case "NoEmail":
        interpretation = "No email address associated with this recipient";
        break;
      case "Suppressed":
        interpretation = "Address is on your SES suppression list";
        break;
      case "OnAccountSuppressionList":
        interpretation = "Address is on your account suppression list";
        break;
      case "General":
      default:
        interpretation = "Permanent bounce - invalid or non-existent address";
        break;
    }

    return {
      severity: "critical",
      category: "hard",
      icon: "🔴",
      interpretation: appendDiagnostic(interpretation, diagnosticCode),
      recommendation:
        "🛑 Remove this address from your mailing list immediately. Sending to invalid addresses damages your sender reputation. " +
        "Best practice: Maintain hard bounce rate below 2%.",
      requiresAction: true,
    };
  }

  // Soft/Transient bounces
  if (bounceType === "Transient") {
    let interpretation: string;
    let recommendation: string;
    let requiresAction = false;

    switch (bounceSubType) {
      case "MailboxFull":
        interpretation = "Recipient's mailbox is full";
        recommendation =
          "Usually transient — mailboxes get cleared. If this address keeps reporting MailboxFull for 10+ sends, treat it as abandoned and remove it.";
        break;
      case "MessageTooLarge":
        interpretation = "Email size exceeds recipient server limits";
        recommendation =
          "Won't fix itself — reduce message or attachment size, or host attachments and link to them. Recipient server hard-limit, retry will fail.";
        requiresAction = true;
        break;
      case "ContentRejected":
        interpretation = "Email content was rejected by recipient server";
        recommendation =
          "Won't fix itself — recipient's content/spam filter blocked this message. Review subject, links, HTML, and authentication (SPF/DKIM/DMARC). Retrying the same content will fail.";
        requiresAction = true;
        break;
      case "AttachmentRejected":
        interpretation = "Attachment type not accepted by recipient server";
        recommendation =
          "Won't fix itself — change or remove the attachment type. Many providers block executables, archives, or macro-enabled documents.";
        requiresAction = true;
        break;
      case "ServiceUnavailable":
        interpretation = "Recipient server temporarily unavailable";
        recommendation =
          "Genuinely transient — receiving server is down or overloaded. SES will not retry; resending later is usually fine.";
        break;
      case "MailFromDomainNotVerified":
        interpretation = "Sending domain not verified with recipient";
        recommendation =
          "Won't fix itself — recipient requires SPF/DKIM/DMARC alignment. Verify your domain's DNS authentication; retrying without changes will fail.";
        requiresAction = true;
        break;
      case "General":
      default:
        interpretation = "Temporary delivery issue";
        recommendation =
          "SES classifies this as transient. Check the diagnostic code; if the SMTP status starts with 5.x.x it is effectively permanent.";
        break;
    }

    // If the SMTP enhanced status code says permanent, override.
    if (statusIsPermanent) {
      interpretation = `Effectively permanent (SMTP ${bounceStatus}): ${interpretation}`;
      recommendation =
        "🛑 Receiving server returned a 5.x.x permanent code despite SES marking this transient — retrying will fail. Remove this address or fix the underlying issue (size/content/auth) before resending.";
      requiresAction = true;
    } else if (
      !requiresAction &&
      bounceSubType &&
      EFFECTIVELY_PERMANENT_TRANSIENT_SUBTYPES.has(bounceSubType)
    ) {
      requiresAction = true;
    }

    return {
      severity: requiresAction ? "warning" : "info",
      category: "soft",
      icon: requiresAction ? "⚠️" : "💤",
      interpretation: appendDiagnostic(interpretation, diagnosticCode),
      recommendation,
      requiresAction,
    };
  }

  // Unknown bounce type
  return {
    severity: "info",
    category: "unknown",
    icon: "ℹ️",
    interpretation: appendDiagnostic(
      "Bounce event (type: " + (bounceType || "unknown") + ")",
      diagnosticCode
    ),
    recommendation: "Review the bounce details for more information.",
    requiresAction: false,
  };
}

/**
 * Classify a complaint event
 */
export function classifyComplaint(complaintCount?: number): EventClassification {
  return {
    severity: "critical",
    icon: "🚨",
    interpretation: `Recipient marked email as spam${
      complaintCount && complaintCount > 1 ? ` (${complaintCount} recipients)` : ""
    }`,
    recommendation:
      "🛑 CRITICAL: Remove this address immediately and investigate. " +
      "High complaint rates damage sender reputation and can trigger SES account review. " +
      "Verify: 1) Email content quality and relevance, 2) Recipient consent/permission, 3) Unsubscribe process is working. " +
      "Target: Keep complaint rate below 0.1%.",
    requiresAction: true,
  };
}

/**
 * Classify a delivery event
 */
export function classifyDelivery(): EventClassification {
  return {
    severity: "info",
    icon: "✅",
    interpretation: "Email successfully delivered to recipient",
    recommendation: "No action needed. Email reached the recipient's server.",
    requiresAction: false,
  };
}

/**
 * Classify a send event
 */
export function classifySend(): EventClassification {
  return {
    severity: "info",
    icon: "📤",
    interpretation: "Email successfully sent from SES",
    recommendation: "No action needed. Email sent successfully from Amazon SES.",
    requiresAction: false,
  };
}

/**
 * Classify an open event
 */
export function classifyOpen(): EventClassification {
  return {
    severity: "info",
    icon: "👀",
    interpretation: "Recipient opened the email",
    recommendation: "No action needed. Engagement metric - recipient is engaged.",
    requiresAction: false,
  };
}

/**
 * Classify a click event
 */
export function classifyClick(): EventClassification {
  return {
    severity: "info",
    icon: "🔗",
    interpretation: "Recipient clicked a link in the email",
    recommendation: "No action needed. Engagement metric - recipient is highly engaged.",
    requiresAction: false,
  };
}

/**
 * Classify a reject event
 */
export function classifyReject(reason?: string, reasonCode?: string): EventClassification {
  let interpretation = "SES rejected email before sending";
  let recommendation = "Investigate SES account status and configuration";

  if (reason?.toLowerCase().includes("config")) {
    interpretation = "Configuration issue prevents sending";
    recommendation =
      "Check: 1) Verified sender email address, 2) SES sending limits, 3) DKIM/SPF configuration";
  } else if (reason?.toLowerCase().includes("content")) {
    interpretation = "Email content was rejected";
    recommendation =
      "Review email content for spam triggers. Check: HTML formatting, links, attachments, text patterns.";
  } else if (reason?.toLowerCase().includes("reputation")) {
    interpretation = "SES blocked due to account reputation";
    recommendation =
      "Your account reputation is too low for sending. Review previous bounce/complaint rates and contact AWS support.";
  }

  return {
    severity: "warning",
    icon: "⚠️",
    interpretation: interpretation + (reasonCode ? ` (${reasonCode})` : ""),
    recommendation: recommendation,
    requiresAction: true,
  };
}

/**
 * Classify a delivery delay event
 */
export function classifyDeliveryDelay(
  delayType?: string,
  processingTimeMillis?: number
): EventClassification {
  let interpretation = "Email delivery is delayed";
  let recommendation = "Monitor this address. If delay persists, it may eventually bounce.";

  if (delayType === "Temporary") {
    interpretation = "Temporary delivery delay";
    recommendation = "This is usually temporary. The email will be retried by SES.";
  }

  return {
    severity: "info",
    icon: "⏱️",
    interpretation: interpretation,
    recommendation: recommendation,
    requiresAction: false,
  };
}

/**
 * Classify any email event
 */
export function classifyEvent(event: EmailEvent): EventClassification {
  const eventType = event.eventType;
  const details = event.details || {};

  switch (eventType) {
    case "Bounce":
      return classifyBounce(
        details.bounceType as string,
        details.bounceSubType as string,
        details.diagnosticCode as string,
        details.bounceStatus as string
      );
    case "Complaint":
      return classifyComplaint(details.complainedRecipientCount as number);
    case "Delivery":
      return classifyDelivery();
    case "Send":
      return classifySend();
    case "Open":
      return classifyOpen();
    case "Click":
      return classifyClick();
    case "Reject":
      return classifyReject(details.reason as string, details.reasonCode as string);
    case "DeliveryDelay":
      return classifyDeliveryDelay(
        details.delayType as string,
        details.processingTimeMillis as number
      );
    default:
      return {
        severity: "info",
        icon: "ℹ️",
        interpretation: `Email event: ${eventType}`,
        recommendation: "Review event details for more information.",
        requiresAction: false,
      };
  }
}
