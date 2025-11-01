import {
  CloudWatchLogsClient,
  StartQueryCommand,
  GetQueryResultsCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import { verifyToken } from "./auth.js";

const logsClient = new CloudWatchLogsClient({});

// CloudWatch log group where SES publishes events
const LOG_GROUP_NAME = "/aws/ses/email-events";

interface EmailEvent {
  timestamp: string;
  recipient: string;
  eventType: string;
  messageId: string;
  jobId: string;
  details?: Record<string, unknown>;
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

    // Query CloudWatch Logs for email events with this jobId
    const queryString = `
      fields @timestamp, eventType, recipient, messageId
      | filter eventMetadata.jobId = "${jobId}"
      | stats count() as count by eventType
    `;

    const queryResult = await queryLogs(queryString);

    // Transform results into summary format
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

    // Parse query results and populate summary
    if (queryResult && Array.isArray(queryResult)) {
      queryResult.forEach((row: any) => {
        const eventType = row.find((f: any) => f.field === "eventType")?.value;
        const count = parseInt(row.find((f: any) => f.field === "count")?.value || "0");
        if (eventType && summary.hasOwnProperty(eventType)) {
          summary[eventType] = count;
        }
      });
    }

    return {
      statusCode: 200,
      body: JSON.stringify(summary),
    };
  } catch (error) {
    console.error("Error fetching email event summary:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Failed to fetch email event summary" }),
    };
  }
}

/**
 * Get raw email events for a job with optional filtering
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

    // Optional filters from query parameters
    const recipient = event.queryStringParameters?.recipient;
    const eventType = event.queryStringParameters?.eventType;

    // Build CloudWatch Logs Insights query
    let queryString = `
      fields @timestamp, eventType, recipient, messageId, @message
      | filter eventMetadata.jobId = "${jobId}"
    `;

    if (eventType) {
      queryString += `| filter eventType = "${eventType}"`;
    }

    if (recipient) {
      queryString += `| filter recipient = "${recipient}"`;
    }

    queryString += `| stats count() as count by @timestamp, eventType, recipient, messageId`;

    const queryResult = await queryLogs(queryString);

    // Transform results into event format
    const events: EmailEvent[] = [];

    if (queryResult && Array.isArray(queryResult)) {
      queryResult.forEach((row: any) => {
        events.push({
          timestamp: row.find((f: any) => f.field === "@timestamp")?.value || "",
          recipient: row.find((f: any) => f.field === "recipient")?.value || "",
          eventType: row.find((f: any) => f.field === "eventType")?.value || "",
          messageId: row.find((f: any) => f.field === "messageId")?.value || "",
          jobId,
        });
      });
    }

    // Sort by timestamp descending
    events.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    return {
      statusCode: 200,
      body: JSON.stringify({
        events,
        count: events.length,
        filters: {
          eventType: eventType || null,
          recipient: recipient || null,
        },
      }),
    };
  } catch (error) {
    console.error("Error fetching email events:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Failed to fetch email events" }),
    };
  }
}

/**
 * Helper function to query CloudWatch Logs
 */
async function queryLogs(queryString: string): Promise<any[]> {
  try {
    // Start the query
    const startQueryResponse = await logsClient.send(
      new StartQueryCommand({
        logGroupName: LOG_GROUP_NAME,
        startTime: Math.floor(Date.now() / 1000) - 86400 * 7, // Last 7 days
        endTime: Math.floor(Date.now() / 1000),
        queryString,
      })
    );

    if (!startQueryResponse.queryId) {
      throw new Error("Failed to start CloudWatch Logs query");
    }

    // Wait for query to complete
    let queryStatus = "Running";
    let queryResults: any[] = [];

    while (queryStatus === "Running" || queryStatus === "Scheduled") {
      await new Promise((resolve) => setTimeout(resolve, 1000)); // Wait 1 second

      const getResultsResponse = await logsClient.send(
        new GetQueryResultsCommand({
          queryId: startQueryResponse.queryId,
        })
      );

      queryStatus = getResultsResponse.status || "";
      queryResults = getResultsResponse.results || [];
    }

    return queryResults;
  } catch (error) {
    console.error("CloudWatch Logs query error:", error);
    return [];
  }
}
