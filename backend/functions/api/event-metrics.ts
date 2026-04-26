/**
 * Event Metrics Computation Utility
 * Shared logic for computing bounce/complaint metrics from email events
 */

import { DynamoDBClient, QueryCommand } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";

const dynamodb = new DynamoDBClient({});
const tableName = process.env.EMAIL_EVENTS_TABLE_NAME || "trickle-email-events";

export interface JobMetrics {
  hardBounceCount: number;
  softBounceCount: number;
  /** Soft bounces whose SMTP enhanced status is 5.x.x — effectively permanent. */
  softBouncePermanentCount: number;
  complaintCount: number;
  rejectCount: number;
  totalEventCount: number;
  hardBounceRate: number;
  softBounceRate: number;
  complaintRate: number;
  /** Counts of bounce subtypes (e.g. MailboxFull, ContentRejected) for visibility. */
  bounceSubtypeCounts: Record<string, number>;
  warnings: string[];
}

/**
 * Compute job metrics from all events for a job
 */
export async function computeJobMetrics(
  jobId: string,
  totalRecipients: number = 0
): Promise<JobMetrics> {
  try {
    // Query all events for this job (no pagination, to compute metrics)
    const allEventsResult = await dynamodb.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "jobId = :jobId",
        ExpressionAttributeValues: {
          ":jobId": { S: jobId },
        },
        Select: "ALL_ATTRIBUTES",
      })
    );

    let hardBounceCount = 0;
    let softBounceCount = 0;
    let softBouncePermanentCount = 0;
    let complaintCount = 0;
    let rejectCount = 0;
    let totalEventCount = 0;
    const bounceSubtypeCounts: Record<string, number> = {};

    if (allEventsResult.Items) {
      totalEventCount = allEventsResult.Items.length;

      for (const item of allEventsResult.Items) {
        const unmarshalled = unmarshall(item) as any;
        const eventType = unmarshalled.eventType;

        if (eventType === "Bounce") {
          const bounceType = unmarshalled.details?.bounceType;
          const subType = unmarshalled.details?.bounceSubType || "Unknown";
          const status = unmarshalled.details?.bounceStatus;
          if (bounceType === "Permanent") {
            hardBounceCount++;
            bounceSubtypeCounts[`Permanent:${subType}`] =
              (bounceSubtypeCounts[`Permanent:${subType}`] || 0) + 1;
          } else if (bounceType === "Transient") {
            softBounceCount++;
            bounceSubtypeCounts[`Transient:${subType}`] =
              (bounceSubtypeCounts[`Transient:${subType}`] || 0) + 1;
            if (typeof status === "string" && /^5\./.test(status.trim())) {
              softBouncePermanentCount++;
            }
          }
        } else if (eventType === "Complaint") {
          complaintCount++;
        } else if (eventType === "Reject") {
          rejectCount++;
        }
      }
    }

    const hardBounceRate = totalRecipients > 0 ? hardBounceCount / totalRecipients : 0;
    const softBounceRate = totalRecipients > 0 ? softBounceCount / totalRecipients : 0;
    const complaintRate = totalRecipients > 0 ? complaintCount / totalRecipients : 0;

    const warnings: string[] = [];
    if (hardBounceRate > 0.05) {
      warnings.push(
        `⚠️ High hard bounce rate (${(hardBounceRate * 100).toFixed(1)}%) - review your email list quality`
      );
    } else if (hardBounceRate > 0.02) {
      warnings.push(
        `Warning: Hard bounce rate is ${(hardBounceRate * 100).toFixed(1)}% (target <2%)`
      );
    }

    if (softBouncePermanentCount > 0) {
      warnings.push(
        `⚠️ ${softBouncePermanentCount} soft bounce${softBouncePermanentCount === 1 ? "" : "s"} returned a 5.x.x SMTP code — effectively permanent. Review the soft bounce list.`
      );
    }

    if (softBounceRate > 0.05) {
      warnings.push(
        `⚠️ Soft bounce rate is ${(softBounceRate * 100).toFixed(1)}% — investigate recurring transient failures.`
      );
    }

    if (complaintRate > 0.003) {
      warnings.push(
        `🚨 Critical: Spam complaint rate is ${(complaintRate * 100).toFixed(2)}% - investigate email content and permissions`
      );
    } else if (complaintRate > 0.001) {
      warnings.push(`⚠️ Complaint rate is ${(complaintRate * 100).toFixed(2)}% (target <0.1%)`);
    }

    return {
      hardBounceCount,
      softBounceCount,
      softBouncePermanentCount,
      complaintCount,
      rejectCount,
      totalEventCount,
      hardBounceRate,
      softBounceRate,
      complaintRate,
      bounceSubtypeCounts,
      warnings,
    };
  } catch (error) {
    console.error("Error computing job metrics:", error);
    return {
      hardBounceCount: 0,
      softBounceCount: 0,
      softBouncePermanentCount: 0,
      complaintCount: 0,
      rejectCount: 0,
      totalEventCount: 0,
      hardBounceRate: 0,
      softBounceRate: 0,
      complaintRate: 0,
      bounceSubtypeCounts: {},
      warnings: [],
    };
  }
}
