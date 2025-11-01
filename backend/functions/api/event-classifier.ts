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

/**
 * Classify a bounce event by type and subtype
 */
export function classifyBounce(
  bounceType?: string,
  bounceSubType?: string,
  diagnosticCode?: string
): EventClassification {
  // Hard/Permanent bounces - CRITICAL
  if (bounceType === "Permanent") {
    let interpretation = "Email address does not exist or domain is invalid (permanent failure)";
    let details = "";

    switch (bounceSubType) {
      case "NoEmail":
        interpretation = "No email address associated with this recipient";
        details = "The recipient address does not exist in the system.";
        break;
      case "Suppressed":
        interpretation = "Address is on your SES suppression list";
        details = "SES has suppressed this address due to previous bounce/complaint.";
        break;
      case "OnAccountSuppressionList":
        interpretation = "Address is on your account suppression list";
        details = "You have previously suppressed this address.";
        break;
      case "General":
      default:
        interpretation = "Permanent bounce - invalid or non-existent address";
        details = "The receiving server rejected the email permanently.";
        if (diagnosticCode) {
          details += ` (${diagnosticCode})`;
        }
        break;
    }

    return {
      severity: "critical",
      category: "hard",
      icon: "🔴",
      interpretation: interpretation,
      recommendation:
        "🛑 Remove this address from your mailing list immediately. Sending to invalid addresses damages your sender reputation. " +
        "Best practice: Maintain hard bounce rate below 2%.",
      requiresAction: true,
    };
  }

  // Soft/Transient bounces - WARNING
  if (bounceType === "Transient") {
    let interpretation = "Temporary delivery issue";
    let details = "";

    switch (bounceSubType) {
      case "MailboxFull":
        interpretation = "Recipient's mailbox is full";
        details = "The email was rejected because the recipient's inbox is full.";
        break;
      case "MessageTooLarge":
        interpretation = "Email size exceeds recipient server limits";
        details = "The message or attachments are too large for the recipient.";
        break;
      case "ContentRejected":
        interpretation = "Email content was rejected";
        details = "The recipient server rejected the message content (possibly spam filter).";
        break;
      case "AttachmentRejected":
        interpretation = "Attachment type not accepted";
        details = "The recipient server does not accept the attachment type.";
        break;
      case "ServiceUnavailable":
        interpretation = "Recipient server temporarily unavailable";
        details = "The receiving server is temporarily down or overloaded.";
        break;
      case "MailFromDomainNotVerified":
        interpretation = "Sending domain not verified with recipient";
        details = "Your domain has not been verified with the receiving server.";
        break;
      case "General":
      default:
        interpretation = "Temporary delivery issue";
        details = "The receiving server temporarily rejected the email.";
        break;
    }

    return {
      severity: "warning",
      category: "soft",
      icon: "⚠️",
      interpretation: interpretation,
      recommendation:
        "This is usually temporary. " +
        "Monitor if this address continues to soft bounce - after 10+ consecutive failures, consider removing it. " +
        "For MailboxFull or ServerDown issues, retry is often successful.",
      requiresAction: false,
    };
  }

  // Unknown bounce type
  return {
    severity: "info",
    category: "unknown",
    icon: "ℹ️",
    interpretation: "Bounce event (type: " + (bounceType || "unknown") + ")",
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
        details.diagnosticCode as string
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
