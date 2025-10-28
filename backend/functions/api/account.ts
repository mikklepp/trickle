import { SESv2Client, GetAccountCommand } from "@aws-sdk/client-sesv2";
import { verifyToken } from "./auth";

// AWS SDK automatically detects the region from Lambda execution context
const ses = new SESv2Client({});

export async function quota(event: any) {
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

    const account = await ses.send(new GetAccountCommand({}));

    if (!account.SendQuota) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: "Failed to retrieve SES quota" }),
      };
    }

    const max24HourSend = account.SendQuota.Max24HourSend || 0;
    const sentLast24Hours = account.SendQuota.SentLast24Hours || 0;
    const maxSendRate = account.SendQuota.MaxSendRate || 0;
    const remaining = max24HourSend - sentLast24Hours;
    const usableQuota = Math.floor(max24HourSend * 0.5); // 50% of quota
    const available = Math.max(0, usableQuota - sentLast24Hours);
    const minRateLimit = Math.ceil(1 / (maxSendRate * 0.2)); // 20% of max rate

    return {
      statusCode: 200,
      body: JSON.stringify({
        max24HourSend,
        sentLast24Hours,
        remaining,
        usableQuota,
        available,
        maxSendRate,
        minRateLimit,
        productionAccessEnabled: account.ProductionAccessEnabled || false,
      }),
    };
  } catch (error) {
    console.error("Error fetching SES quota:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Failed to fetch quota" }),
    };
  }
}
