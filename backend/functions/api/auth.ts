import { createHmac } from "crypto";

// Simple JWT-like token (in production, use proper JWT library)
const SECRET = process.env.AUTH_SECRET || "change-me-in-production";

export async function login(event: any) {
  try {
    const body = JSON.parse(event.body || "{}");
    const { username, password } = body;

    // Simple hardcoded auth (replace with proper auth in production)
    // TODO: Integrate with Cognito or proper auth provider
    if (username === "admin" && password === "admin") {
      const token = createHmac("sha256", SECRET).update(`${username}:${Date.now()}`).digest("hex");

      return {
        statusCode: 200,
        body: JSON.stringify({
          token,
          userId: "default-user",
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
