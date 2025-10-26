import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { Resource } from "sst";
import { verifyToken } from "./auth";

const dynamoClient = new DynamoDBClient({});
const dynamo = DynamoDBDocumentClient.from(dynamoClient);

export async function get(event: any) {
  try {
    // Verify authentication
    const token = event.headers?.authorization?.replace("Bearer ", "");
    const auth = verifyToken(token);
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
    const auth = verifyToken(token);
    if (!auth) {
      return {
        statusCode: 401,
        body: JSON.stringify({ error: "Unauthorized" }),
      };
    }

    const userId = auth.userId;
    const body = JSON.parse(event.body || "{}");
    const { rateLimit, maxAttachmentSize } = body;

    // Validate input
    if (rateLimit && (rateLimit < 1 || rateLimit > 3600)) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Rate limit must be between 1 and 3600 seconds" }),
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
