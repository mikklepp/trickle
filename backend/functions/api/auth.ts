import jwt, { JwtPayload } from "jsonwebtoken";
import { getSecrets } from "../shared/secrets";

let authSecret: string;
let validUsername: string;
let validPassword: string;
let secretsInitialized = false;

// Custom JWT payload interface
interface TrickleJwtPayload extends JwtPayload {
  username: string;
  userId: string;
}

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

/**
 * Creates a JWT token following RFC 7519 standard
 * Includes standard claims (iat, exp) and custom claims (username, userId)
 */
export function createToken(username: string, userId: string): string {
  const payload: TrickleJwtPayload = {
    username,
    userId,
    sub: userId, // Standard JWT subject claim
  };

  // Sign with HS256 algorithm, 24-hour expiration
  return jwt.sign(payload, authSecret, {
    algorithm: "HS256",
    expiresIn: "24h",
    issuer: "trickle",
  });
}

/**
 * Verifies a JWT token and returns the payload if valid
 * Returns null if token is invalid, expired, or verification fails
 */
export async function verifyToken(
  token: string
): Promise<{ username: string; userId: string } | null> {
  try {
    // Ensure secrets are initialized
    await initializeSecrets();

    // Verify token signature and expiration
    const decoded = jwt.verify(token, authSecret, {
      algorithms: ["HS256"],
      issuer: "trickle",
    }) as TrickleJwtPayload;

    // Extract required claims
    if (!decoded.username || !decoded.userId) {
      return null;
    }

    return { username: decoded.username, userId: decoded.userId };
  } catch (error) {
    // Token verification failed (invalid signature, expired, malformed, etc.)
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
