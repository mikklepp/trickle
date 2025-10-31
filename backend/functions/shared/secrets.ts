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
 * Fetch credentials from AWS Systems Manager Parameter Store with caching
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

    const usernameParam = response.Parameters.find(
      (p) => p.Name === `${authParameterPath}/username`
    );
    const passwordParam = response.Parameters.find(
      (p) => p.Name === `${authParameterPath}/password`
    );
    const secretParam = response.Parameters.find((p) => p.Name === `${authParameterPath}/secret`);

    if (!usernameParam?.Value || !passwordParam?.Value || !secretParam?.Value) {
      throw new Error("Missing required auth parameters in Parameter Store");
    }

    cachedSecrets = {
      AuthUsername: usernameParam.Value,
      AuthPassword: passwordParam.Value,
      AuthSecret: secretParam.Value,
    };

    // Cache for 1 hour
    cacheExpiresAt = now + 60 * 60 * 1000;

    return cachedSecrets;
  } catch (error) {
    console.error("Failed to retrieve secrets from Parameter Store:", error);
    throw new Error("Failed to retrieve credentials from Parameter Store");
  }
}
