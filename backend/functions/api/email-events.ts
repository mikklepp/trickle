import { DynamoDBClient, QueryCommand, ScanCommand } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { verifyToken } from "./auth.js";
import { classifyEvent, EventClassification } from "./event-classifier.js";
import { computeJobMetrics } from "./event-metrics.js";

const dynamodb = new DynamoDBClient({});
const tableName = process.env.EMAIL_EVENTS_TABLE_NAME || "trickle-email-events";

interface EmailEvent {
  timestamp: number;
  recipient: string;
  eventType: string;
  messageId: string;
  jobId: string;
  details?: Record<string, unknown>;
}

interface ClassifiedEmailEvent extends EmailEvent {
  severity: string;
  category?: string;
  icon: string;
  interpretation: string;
  recommendation: string;
  requiresAction: boolean;
}

interface JobMetrics {
  hardBounceCount: number;
  softBounceCount: number;
  complaintCount: number;
  rejectCount: number;
  totalEventCount: number;
  hardBounceRate: number;
  complaintRate: number;
  warnings: string[];
}

interface EventSummary {
  [eventType: string]: number;
}

/**
 * Get aggregated email event counts by type for a specific job
 */
export async function summary(event: any) {
  try {
    // Verify authentication
    const token = event.headers?.authorization?.replace("Bearer ", "");
    const auth = await verifyToken(token);
    if (!auth) {
      return {
        statusCode: 401,
        body: JSON.stringify({ error: "Unauthorized" }),
      };
    }

    const jobId = event.pathParameters?.jobId;
    if (!jobId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "jobId is required" }),
      };
    }

    // Query DynamoDB for events with this jobId
    const queryResult = await dynamodb.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "jobId = :jobId",
        ExpressionAttributeValues: {
          ":jobId": { S: jobId },
        },
        Select: "ALL_ATTRIBUTES",
      })
    );

    // Initialize summary with all event types
    const summary: EventSummary = {
      Send: 0,
      Delivery: 0,
      Bounce: 0,
      Complaint: 0,
      Reject: 0,
      DeliveryDelay: 0,
      Open: 0,
      Click: 0,
    };

    // Count events by type
    if (queryResult.Items) {
      for (const item of queryResult.Items) {
        const unmarshalled = unmarshall(item);
        const eventType = unmarshalled.eventType as string;
        if (eventType && summary.hasOwnProperty(eventType)) {
          summary[eventType]++;
        }
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify(summary),
    };
  } catch (error) {
    console.error("Error querying email event summary:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Failed to query email events" }),
    };
  }
}

/**
 * Get email events for a specific job with classifications, recommendations, and pagination
 */
export async function logs(event: any) {
  try {
    // Verify authentication
    const token = event.headers?.authorization?.replace("Bearer ", "");
    const auth = await verifyToken(token);
    if (!auth) {
      return {
        statusCode: 401,
        body: JSON.stringify({ error: "Unauthorized" }),
      };
    }

    const jobId = event.pathParameters?.jobId;
    if (!jobId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "jobId is required" }),
      };
    }

    // Get optional filters from query parameters
    const eventType = event.queryStringParameters?.eventType || null;
    const recipientFilter = event.queryStringParameters?.recipient || null;
    const nextTokenParam = event.queryStringParameters?.nextToken || null;

    // Page size
    let limit = parseInt(event.queryStringParameters?.limit || "100", 10);
    if (limit < 1 || limit > 1000) limit = 100;

    // Get totalRecipients if provided (for metric calculations)
    const totalRecipients = event.queryStringParameters?.totalRecipients
      ? parseInt(event.queryStringParameters.totalRecipients, 10)
      : 0;

    // Parse pagination token if provided
    let exclusiveStartKey: any = undefined;
    if (nextTokenParam) {
      try {
        exclusiveStartKey = JSON.parse(nextTokenParam);
      } catch (err) {
        console.error("Invalid pagination token:", err);
        return {
          statusCode: 400,
          body: JSON.stringify({ error: "Invalid pagination token" }),
        };
      }
    }

    // Query DynamoDB for events with this jobId
    const queryResult = await dynamodb.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "jobId = :jobId",
        ExpressionAttributeValues: {
          ":jobId": { S: jobId },
        },
        ScanIndexForward: false, // Sort by timestamp descending (latest first)
        Limit: limit,
        ExclusiveStartKey: exclusiveStartKey,
      })
    );

    let classifiedEvents: ClassifiedEmailEvent[] = [];
    let nextToken: string | null = null;

    // Convert items, apply filters, and classify
    if (queryResult.Items) {
      for (const item of queryResult.Items) {
        const unmarshalled = unmarshall(item) as any;
        const email: EmailEvent = {
          jobId: unmarshalled.jobId,
          timestamp: unmarshalled.timestamp,
          recipient: unmarshalled.recipient,
          eventType: unmarshalled.eventType,
          messageId: unmarshalled.messageId,
          details: unmarshalled.details,
        };

        // Apply event type filter if specified
        if (eventType && email.eventType !== eventType) {
          continue;
        }

        // Apply recipient filter if specified
        if (
          recipientFilter &&
          !email.recipient.toLowerCase().includes(recipientFilter.toLowerCase())
        ) {
          continue;
        }

        // Classify the event
        const classification = classifyEvent(email);

        const classifiedEvent: ClassifiedEmailEvent = {
          ...email,
          ...classification,
        };

        classifiedEvents.push(classifiedEvent);
      }
    }

    // Generate next pagination token if there are more results
    if (queryResult.LastEvaluatedKey) {
      nextToken = JSON.stringify(queryResult.LastEvaluatedKey);
    }

    // Compute job metrics
    const jobMetrics = await computeJobMetrics(jobId, totalRecipients);

    return {
      statusCode: 200,
      body: JSON.stringify({
        events: classifiedEvents,
        count: classifiedEvents.length,
        nextToken,
        filters: {
          eventType: eventType || null,
          recipient: recipientFilter || null,
        },
        jobMetrics,
      }),
    };
  } catch (error) {
    console.error("Error querying email event logs:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Failed to query email events" }),
    };
  }
}
