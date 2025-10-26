import {
  SESClient,
  ListIdentitiesCommand,
  GetIdentityVerificationAttributesCommand,
} from "@aws-sdk/client-ses";

const ses = new SESClient({});

export async function list() {
  try {
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

    // Filter only verified identities
    const verifiedSenders = Identities.filter(
      (identity) => VerificationAttributes[identity]?.VerificationStatus === "Success"
    );

    return {
      statusCode: 200,
      body: JSON.stringify({ senders: verifiedSenders }),
    };
  } catch (error) {
    console.error("Error fetching SES identities:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Failed to fetch senders" }),
    };
  }
}
