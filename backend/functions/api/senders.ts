import { SESv2Client, ListEmailIdentitiesCommand } from "@aws-sdk/client-sesv2";
import { verifyToken } from "./auth";

const ses = new SESv2Client({ region: "eu-north-1" });

export async function list(event: any) {
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

    // Get all email identities with verification status (SES v2 API)
    const listCommand = new ListEmailIdentitiesCommand({});
    const { EmailIdentities = [] } = await ses.send(listCommand);

    if (EmailIdentities.length === 0) {
      return {
        statusCode: 200,
        body: JSON.stringify({ senders: [], emails: [], domains: [], all: [] }),
      };
    }

    // Filter only verified identities and separate emails from domains
    const verifiedIdentities = EmailIdentities.filter(
      (identity) => identity.IdentityName && identity.VerificationStatus === "SUCCESS"
    ).map((identity) => identity.IdentityName!);

    const emails = verifiedIdentities.filter((identity) => identity.includes("@"));
    const domains = verifiedIdentities.filter((identity) => !identity.includes("@"));

    return {
      statusCode: 200,
      body: JSON.stringify({
        emails,
        domains,
        all: verifiedIdentities,
      }),
    };
  } catch (error) {
    console.error("Error fetching SES identities:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Failed to fetch senders" }),
    };
  }
}
