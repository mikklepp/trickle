import { createHmac } from "crypto";
import { getSecrets } from "../shared/secrets";

let authSecret: string;
let validUsername: string;
let validPassword: string;
let secretsInitialized = false;

// Initialize secrets on first use
async function initializeSecrets() {
  if (secretsInitialized) return;

  const secrets = await getSecrets();
  authSecret = secrets.AuthSecret;
  validUsername = secrets.AuthUsername;
  validPassword = secrets.AuthPassword;
  secretsInitialized = true;

  // Validate secrets
  if (!authSecret || authSecret.length < 32) {
    throw new Error("AUTH_SECRET is not properly configured");
  }
  if (!validUsername) {
    throw new Error("AUTH_USERNAME is not properly configured");
  }
  if (!validPassword) {
    throw new Error("AUTH_PASSWORD is not properly configured");
  }
}

export function createToken(username: string, userId: string): string {
  const expiresAt = Date.now() + 24 * 60 * 60 * 1000; // 24 hours
  const payload = `${username}:${userId}:${expiresAt}`;
  const signature = createHmac("sha256", authSecret).update(payload).digest("hex");
  return `${Buffer.from(payload).toString("base64")}.${signature}`;
}

export async function verifyToken(
  token: string
): Promise<{ username: string; userId: string } | null> {
  try {
    // Ensure secrets are initialized
    await initializeSecrets();

    const [payloadB64, signature] = token.split(".");
    if (!payloadB64 || !signature) return null;

    const payload = Buffer.from(payloadB64, "base64").toString("utf8");
    const expectedSignature = createHmac("sha256", authSecret).update(payload).digest("hex");

    if (signature !== expectedSignature) return null;

    const [username, userId, expiresAtStr] = payload.split(":");
    const expiresAt = parseInt(expiresAtStr);

    if (Date.now() > expiresAt) return null;

    return { username, userId };
  } catch {
    return null;
  }
}

export async function login(event: any) {
  try {
    // Initialize secrets on first request
    await initializeSecrets();

    const body = JSON.parse(event.body || "{}");
    const { username, password } = body;

    const VALID_USERNAME = validUsername;
    const VALID_PASSWORD = validPassword;

    // Simple auth (replace with proper auth in production)
    // TODO: Integrate with Cognito or proper auth provider
    if (username === VALID_USERNAME && password === VALID_PASSWORD) {
      const userId = "default-user";
      const token = createToken(username, userId);

      return {
        statusCode: 200,
        body: JSON.stringify({
          token,
          userId,
          username,
        }),
      };
    }

    return {
      statusCode: 401,
      body: JSON.stringify({ error: "Invalid credentials" }),
    };
  } catch (error) {
    console.error("Error during login:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Login failed" }),
    };
  }
}
