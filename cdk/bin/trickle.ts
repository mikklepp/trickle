#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { TrickleStack } from "../lib/trickle-stack";
import { TrickleFrontendCertificateStack } from "../lib/frontend-certificate-stack";
import * as os from "os";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";

async function main() {
  const app = new cdk.App();

  // Stage: from env var or current username (like SST)
  const stage = process.env.CDK_STAGE || process.env.USER || os.userInfo().username || "dev";

  // Region: from env var or default to us-east-1
  const region =
    process.env.CDK_REGION ||
    process.env.AWS_REGION ||
    process.env.CDK_DEFAULT_REGION ||
    "us-east-1";

  // Account: from env var or get from AWS STS
  let account = process.env.CDK_DEFAULT_ACCOUNT || process.env.AWS_ACCOUNT_ID;
  if (!account) {
    try {
      const sts = new STSClient({ region });
      const identity = await sts.send(new GetCallerIdentityCommand({}));
      account = identity.Account;
    } catch (error) {
      throw new Error(
        "Could not determine AWS account. Set CDK_DEFAULT_ACCOUNT or AWS_ACCOUNT_ID environment variable, " +
          "or ensure AWS credentials are configured."
      );
    }
  }

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

  // Create frontend certificate stack (must be in us-east-1 for CloudFront)
  const certificateStack = new TrickleFrontendCertificateStack(
    app,
    `TrickleFrontendCertificateStack-${stage}`,
    {
      stackName: `trickle-frontend-cert-${stage}`,
      env: {
        region: "us-east-1",
        account,
      },
      crossRegionReferences: true,
      stage,
      hostedZoneName: "qed.fi",
      tags: {
        Stage: stage,
        Project: "Trickle",
      },
    }
  );

  // Create main stack (can be in any region)
  new TrickleStack(app, `TrickleStack-${stage}`, {
    stackName: `trickle-${stage}`,
    env: {
      region,
      account,
    },
    crossRegionReferences: true,
    stage,
    authUsername,
    authPassword,
    authSecret,
    frontendCertificateArn: certificateStack.certificateArn,
    tags: {
      Stage: stage,
      Project: "Trickle",
    },
  });

  app.synth();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
