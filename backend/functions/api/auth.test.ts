import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { SignJWT, jwtVerify } from "jose";

// Pins the token contract itself, independent of the module's secret loading:
// a token this app issues must verify under the same issuer and algorithm, and
// must be rejected when any of that differs. The switch from jsonwebtoken to
// jose had to preserve exactly this, so existing sessions kept working.
const secret = new TextEncoder().encode("x".repeat(48));
const ISSUER = "trickle";

const issue = (claims: Record<string, unknown>, expiresIn = "24h") =>
  new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(secret);

describe("auth token contract", () => {
  test("round-trips the custom claims", async () => {
    const token = await issue({ username: "alice", userId: "u-1" });
    const { payload } = await jwtVerify(token, secret, {
      algorithms: ["HS256"],
      issuer: ISSUER,
    });
    assert.equal(payload.username, "alice");
    assert.equal(payload.userId, "u-1");
  });

  test("rejects a token signed with a different secret", async () => {
    const token = await issue({ username: "alice", userId: "u-1" });
    await assert.rejects(() =>
      jwtVerify(token, new TextEncoder().encode("y".repeat(48)), { issuer: ISSUER })
    );
  });

  test("rejects a token from a different issuer", async () => {
    const token = await new SignJWT({ username: "alice", userId: "u-1" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("somewhere-else")
      .setExpirationTime("24h")
      .sign(secret);
    await assert.rejects(() => jwtVerify(token, secret, { issuer: ISSUER }));
  });

  test("rejects an expired token", async () => {
    const token = await issue({ username: "alice", userId: "u-1" }, "-1s");
    await assert.rejects(() => jwtVerify(token, secret, { issuer: ISSUER }));
  });
});
