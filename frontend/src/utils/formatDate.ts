import { format } from "date-fns";

/**
 * The one date format used across the UI. Accepts an ISO string or an epoch
 * number, since job records carry the former and events the latter.
 */
export function formatDate(value: string | number): string {
  return format(new Date(value), "yyyy-MM-dd HH:mm");
}
