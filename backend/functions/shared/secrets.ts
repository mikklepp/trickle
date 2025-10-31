import { SSMClient, GetParametersByPathCommand } from "@aws-sdk/client-ssm";

const client = new SSMClient({});

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

  const authParameterPath = process.env.AUTH_PARAMETER_PATH;
  if (!authParameterPath) {
    throw new Error("AUTH_PARAMETER_PATH environment variable is not set");
  }

  try {
    const command = new GetParametersByPathCommand({
      Path: authParameterPath,
    });

    const response = await client.send(command);

    if (!response.Parameters?.length) {
      throw new Error("Parameter path does not contain Parameters");
    }

    cachedSecrets.AuthUsername = response.Parameters.find(
      (p) => p.Name === `${authParameterPath}/username`
    )!.Value;
    cachedSecrets.AuthPassword = response.Parameters.find(
      (p) => p.Name === `${authParameterPath}/password`
    )!.Value;
    cachedSecrets.AuthSecret = response.Parameters.find(
      (p) => p.Name === `${authParameterPath}/secret`
    )!.Value;

    // Cache for 1 hour
    cacheExpiresAt = now + 60 * 60 * 1000;

    return cachedSecrets;
  } catch (error) {
    console.error("Failed to retrieve secrets from Secrets Manager:", error);
    throw new Error("Failed to retrieve credentials from Secrets Manager");
  }
}
