import { format } from "date-fns";

export interface ETAInput {
  totalRecipients: number;
  rateLimit?: number;
  createdAt?: string; // ISO timestamp - if provided, calculates in-progress
  sent?: number; // if provided with createdAt, shows progress
}

export interface ETAResult {
  // Time calculations (in seconds)
  totalSeconds: number;
  elapsedSeconds: number;
  remainingSeconds: number;

  // Timestamps
  estimatedCompletionTime: Date;

  // Formatted strings
  totalDuration: string; // "2h 15m 30s"
  remainingDuration: string; // "45m" or "1h 30m" (shorter format)
  elapsedDuration: string; // "30m 15s"

  // Completion time formatted
  completionTimeFormatted: string; // "14:32:15"
}

/**
 * Format seconds to human-readable duration string
 * @param seconds - number of seconds
 * @param compact - if true, omits 0 values (e.g., "5m" vs "5m 0s")
 */
function formatDuration(seconds: number, compact = false): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  const parts = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (secs > 0 || (!compact && parts.length === 0)) parts.push(`${secs}s`);

  return parts.join(" ") || "0s";
}

/**
 * Calculate ETA for email sending jobs
 *
 * Handles three scenarios:
 * 1. Pre-send estimation: Just totalRecipients + rateLimit
 * 2. In-progress with rateLimit: Uses configured rate for accurate estimate
 * 3. In-progress fallback: Uses elapsed time average if rateLimit not available
 *
 * @param input - ETA calculation input
 * @returns ETA result with various formatted durations and times
 */
export function calculateETA(input: ETAInput): ETAResult {
  const now = Date.now();

  // Calculate elapsed time if job is in progress
  let elapsedSeconds = 0;
  if (input.createdAt) {
    const createdTime = new Date(input.createdAt).getTime();
    elapsedSeconds = Math.floor((now - createdTime) / 1000);
  }

  // Calculate remaining time
  let remainingSeconds: number;
  let totalSeconds: number;

  const remainingEmails = input.totalRecipients - (input.sent || 0);

  if (input.rateLimit) {
    // Preferred: Use rateLimit-based calculation (accurate to scheduled cadence)
    remainingSeconds = remainingEmails * input.rateLimit;
    totalSeconds = input.totalRecipients * input.rateLimit;
  } else if (input.sent && input.sent > 0 && elapsedSeconds > 0) {
    // Fallback: Use elapsed time average (for in-progress jobs without rateLimit)
    const avgPerEmail = elapsedSeconds / input.sent;
    remainingSeconds = Math.ceil(remainingEmails * avgPerEmail);
    totalSeconds = elapsedSeconds + remainingSeconds;
  } else {
    // Can't calculate without rateLimit or progress data
    remainingSeconds = 0;
    totalSeconds = 0;
  }

  const estimatedCompletionTime = new Date(now + remainingSeconds * 1000);

  return {
    totalSeconds,
    elapsedSeconds,
    remainingSeconds,
    estimatedCompletionTime,
    totalDuration: formatDuration(totalSeconds, false),
    remainingDuration: formatDuration(remainingSeconds, true),
    elapsedDuration: formatDuration(elapsedSeconds, false),
    completionTimeFormatted: format(estimatedCompletionTime, "HH:mm:ss"),
  };
}
