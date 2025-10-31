#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { TrickleStack } from "../lib/trickle-stack";
import * as os from "os";

const app = new cdk.App();

// Stage: from env var or current username (like SST)
const stage = process.env.CDK_STAGE || process.env.USER || os.userInfo().username || "dev";

// Region: from env var or default to us-east-1
const region = process.env.AWS_REGION || process.env.CDK_DEFAULT_REGION || "us-east-1";

// Get auth credentials from environment
const authUsername = process.env.AUTH_USERNAME;
const authPassword = process.env.AUTH_PASSWORD;
const authSecret = process.env.AUTH_SECRET || require("crypto").randomBytes(32).toString("hex");

if (!authUsername || !authPassword) {
  throw new Error(
    "AUTH_USERNAME and AUTH_PASSWORD environment variables are required. " +
      "Set them before deploying: AUTH_USERNAME=user AUTH_PASSWORD=pass cdk deploy"
  );
}

new TrickleStack(app, `TrickleStack-${stage}`, {
  stackName: `trickle-${stage}`,
  env: {
    region,
    account: process.env.CDK_DEFAULT_ACCOUNT,
  },
  stage,
  authUsername,
  authPassword,
  authSecret,
  tags: {
    Stage: stage,
    Project: "Trickle",
  },
});

app.synth();
