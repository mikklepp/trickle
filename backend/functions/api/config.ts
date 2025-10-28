import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { SESv2Client, GetAccountCommand } from "@aws-sdk/client-sesv2";
import { Resource } from "sst";
import { verifyToken } from "./auth";

const dynamoClient = new DynamoDBClient({});
const dynamo = DynamoDBDocumentClient.from(dynamoClient);
// AWS SDK automatically detects the region from Lambda execution context
const ses = new SESv2Client({});

export async function get(event: any) {
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

    const userId = auth.userId;

    const result = await dynamo.send(
      new GetCommand({
        TableName: Resource.ConfigTable.name,
        Key: { userId },
      })
    );

    // Return defaults if no config exists
    const config = result.Item || {
      rateLimit: 60, // seconds between emails
      maxAttachmentSize: 10485760, // 10MB in bytes
      headers: {
        "List-ID": '"Monthly Newsletter" <newsletter.sarvastonvenekerho.fi>',
        Precedence: "bulk",
      },
    };

    return {
      statusCode: 200,
      body: JSON.stringify(config),
    };
  } catch (error) {
    console.error("Error fetching config:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Failed to fetch config" }),
    };
  }
}

export async function update(event: any) {
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

    const userId = auth.userId;
    const body = JSON.parse(event.body || "{}");
    const { rateLimit, maxAttachmentSize, headers } = body;

    // Get SES limits to validate rate limit (use max 20% of send rate)
    const sesAccount = await ses.send(new GetAccountCommand({}));
    const maxSendRate = sesAccount.SendQuota?.MaxSendRate || 1;
    const minRateLimit = Math.ceil(1 / (maxSendRate * 0.2)); // 20% of max rate

    // Validate input
    if (rateLimit && (rateLimit < minRateLimit || rateLimit > 3600)) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: `Rate limit must be between ${minRateLimit} and 3600 seconds (SES max send rate: ${maxSendRate}/sec, using 20% = ${1 / minRateLimit}/sec)`,
        }),
      };
    }

    if (maxAttachmentSize && (maxAttachmentSize < 0 || maxAttachmentSize > 26214400)) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Max attachment size must be between 0 and 25MB" }),
      };
    }

    const config = {
      userId,
      rateLimit: rateLimit || 60,
      maxAttachmentSize: maxAttachmentSize || 10485760,
      headers: headers || {},
      updatedAt: new Date().toISOString(),
    };

    await dynamo.send(
      new PutCommand({
        TableName: Resource.ConfigTable.name,
        Item: config,
      })
    );

    return {
      statusCode: 200,
      body: JSON.stringify(config),
    };
  } catch (error) {
    console.error("Error updating config:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Failed to update config" }),
    };
  }
}
