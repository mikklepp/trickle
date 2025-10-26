import { createHmac } from "crypto";

const SECRET = process.env.AUTH_SECRET || "change-me-in-production";

if (SECRET === "change-me-in-production") {
  console.warn(
    "WARNING: Using default AUTH_SECRET. Set AUTH_SECRET environment variable in production!"
  );
}

export function createToken(username: string, userId: string): string {
  const expiresAt = Date.now() + 24 * 60 * 60 * 1000; // 24 hours
  const payload = `${username}:${userId}:${expiresAt}`;
  const signature = createHmac("sha256", SECRET).update(payload).digest("hex");
  return `${Buffer.from(payload).toString("base64")}.${signature}`;
}

export function verifyToken(token: string): { username: string; userId: string } | null {
  try {
    const [payloadB64, signature] = token.split(".");
    if (!payloadB64 || !signature) return null;

    const payload = Buffer.from(payloadB64, "base64").toString("utf8");
    const expectedSignature = createHmac("sha256", SECRET).update(payload).digest("hex");

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
    const body = JSON.parse(event.body || "{}");
    const { username, password } = body;

    // Simple hardcoded auth (replace with proper auth in production)
    // TODO: Integrate with Cognito or proper auth provider
    if (username === process.env.AUTH_USERNAME && password === process.env.AUTH_PASSWORD) {
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
