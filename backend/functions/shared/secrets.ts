import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

const client = new SecretsManagerClient({});

interface Credentials {
  AuthUsername: string;
  AuthPassword: string;
  AuthSecret: string;
}

let cachedSecrets: Credentials | null = null;
let cacheExpiresAt: number = 0;

/**
 * Fetch credentials from AWS Secrets Manager with caching
 * Cache is valid for 1 hour to reduce API calls
 */
export async function getSecrets(): Promise<Credentials> {
  const now = Date.now();

  // Return cached secrets if still valid
  if (cachedSecrets && now < cacheExpiresAt) {
    return cachedSecrets;
  }

  const secretId = process.env.SECRETS_MANAGER_SECRET_ID;
  if (!secretId) {
    throw new Error("SECRETS_MANAGER_SECRET_ID environment variable is not set");
  }

  try {
    const command = new GetSecretValueCommand({
      SecretId: secretId,
    });

    const response = await client.send(command);

    if (!response.SecretString) {
      throw new Error("Secret does not contain a SecretString");
    }

    cachedSecrets = JSON.parse(response.SecretString);

    // Cache for 1 hour
    cacheExpiresAt = now + 60 * 60 * 1000;

    return cachedSecrets;
  } catch (error) {
    console.error("Failed to retrieve secrets from Secrets Manager:", error);
    throw new Error("Failed to retrieve credentials from Secrets Manager");
  }
}
