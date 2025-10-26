import {
  SESClient,
  ListIdentitiesCommand,
  GetIdentityVerificationAttributesCommand,
} from "@aws-sdk/client-ses";
import { verifyToken } from "./auth";

const ses = new SESClient({});

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

    // Get all identities
    const listCommand = new ListIdentitiesCommand({});
    const { Identities = [] } = await ses.send(listCommand);

    if (Identities.length === 0) {
      return {
        statusCode: 200,
        body: JSON.stringify({ senders: [] }),
      };
    }

    // Get verification status
    const verifyCommand = new GetIdentityVerificationAttributesCommand({
      Identities,
    });
    const { VerificationAttributes = {} } = await ses.send(verifyCommand);

    // Filter only verified identities and separate emails from domains
    const verifiedIdentities = Identities.filter(
      (identity) => VerificationAttributes[identity]?.VerificationStatus === "Success"
    );

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
