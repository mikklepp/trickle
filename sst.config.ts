/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    return {
      name: "trickle",
      removal: input?.stage === "production" ? "retain" : "remove",
      home: "aws",
    };
  },
  async run() {
    const aws = await import("@pulumi/aws");
    const pulumi = await import("@pulumi/pulumi");

    // Get credentials from environment variables
    // Usage: AUTH_USERNAME=user AUTH_PASSWORD=pass npm run deploy
    const authUsername = process.env.AUTH_USERNAME;
    const authPassword = process.env.AUTH_PASSWORD;
    const authSecret = process.env.AUTH_SECRET || require("crypto").randomBytes(32).toString("hex");

    if (!authUsername || !authPassword) {
      throw new Error(
        "AUTH_USERNAME and AUTH_PASSWORD environment variables are required. " +
          "Set them before deploying: AUTH_USERNAME=user AUTH_PASSWORD=pass npm run deploy"
      );
    }

    // Create AWS Secrets Manager secret with credentials
    const secretsManagerSecret = new aws.secretsmanager.Secret("TrickleSecrets", {
      name: `trickle/${$app.stage}/secrets`,
      description: `Trickle credentials for stage: ${$app.stage}`,
    });

    // Store the actual secret values
    new aws.secretsmanager.SecretVersion("TrickleSecretsVersion", {
      secretId: secretsManagerSecret.id,
      secretString: pulumi
        .output({
          AuthUsername: authUsername,
          AuthPassword: authPassword,
          AuthSecret: authSecret,
        })
        .apply(JSON.stringify),
    });

    const isDev = $app.stage !== "production";

    // Dead Letter Queue for failed email processing
    const emailDLQ = new sst.aws.Queue("EmailDLQ");

    // Storage
    const attachmentsBucket = new sst.aws.Bucket("AttachmentsBucket");

    // Lifecycle policy to delete old attachments after 7 days
    new aws.s3.BucketLifecycleConfigurationV2("AttachmentsBucketLifecycle", {
      bucket: attachmentsBucket.name,
      rules: [
        {
          id: "delete-old-attachments",
          status: "Enabled",
          expiration: {
            days: 7,
          },
        },
      ],
    });

    // Database
    const jobsTable = new sst.aws.Dynamo("JobsTable", {
      fields: {
        jobId: "string",
        userId: "string",
        createdAt: "string",
      },
      primaryIndex: { hashKey: "jobId" },
      globalIndexes: {
        userIndex: { hashKey: "userId", rangeKey: "createdAt" },
      },
      ttl: "expiresAt",
    });

    const configTable = new sst.aws.Dynamo("ConfigTable", {
      fields: {
        userId: "string",
      },
      primaryIndex: { hashKey: "userId" },
    });

    // Worker Lambda (invoked by EventBridge Scheduler)
    const worker = new sst.aws.Function("EmailWorker", {
      handler: "backend/functions/worker/index.handler",
      timeout: "2 minutes",
      link: [attachmentsBucket, jobsTable, emailDLQ],
      permissions: [
        {
          actions: ["ses:SendEmail", "sesv2:SendEmail"],
          resources: ["*"],
        },
        {
          actions: ["scheduler:DeleteSchedule"],
          resources: ["*"],
        },
      ],
      transform: {
        function: (args) => {
          args.deadLetterConfig = {
            targetArn: emailDLQ.arn,
          };
        },
      },
    });

    // IAM Role for EventBridge Scheduler to invoke the worker Lambda
    const schedulerRole = new aws.iam.Role("SchedulerRole", {
      assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: {
              Service: "scheduler.amazonaws.com",
            },
            Action: "sts:AssumeRole",
          },
        ],
      }),
    });

    new aws.iam.RolePolicy("SchedulerRolePolicy", {
      role: schedulerRole.id,
      policy: worker.arn.apply((arn) =>
        JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Action: "lambda:InvokeFunction",
              Resource: arn,
            },
          ],
        })
      ),
    });

    // Frontend with custom domain
    const frontendDomain =
      $app.stage === "production" ? "trickle.qed.fi" : `${$app.stage}.trickle.qed.fi`;

    const apiDomain =
      $app.stage === "production" ? "api.trickle.qed.fi" : `api.${$app.stage}.trickle.qed.fi`;

    const frontend = new sst.aws.StaticSite("Frontend", {
      path: "frontend",
      build: {
        command: "npm run build",
        output: "dist",
      },
      domain: {
        name: frontendDomain,
        dns: sst.aws.dns(),
      },
      environment: {
        VITE_API_URL: `https://${apiDomain}`,
      },
    });

    // API with environment-aware CORS and custom domain
    const api = new sst.aws.ApiGatewayV2("Api", {
      domain: {
        name: apiDomain,
        dns: sst.aws.dns(),
      },
      cors: {
        allowOrigins: [`https://${frontendDomain}`],
        allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allowHeaders: ["Content-Type", "Authorization"],
        allowCredentials: false,
      },
      transform: {
        route: {
          handler: {
            link: [attachmentsBucket, jobsTable, configTable, worker],
            environment: {
              SCHEDULER_ROLE_ARN: schedulerRole.arn,
              SECRETS_MANAGER_SECRET_ID: secretsManagerSecret.id,
            },
            permissions: [
              {
                actions: [
                  "ses:ListIdentities",
                  "ses:GetIdentityVerificationAttributes",
                  "ses:ListEmailIdentities",
                  "ses:GetAccount",
                ],
                resources: ["*"],
              },
              {
                actions: ["scheduler:CreateSchedule", "scheduler:GetSchedule"],
                resources: ["*"],
              },
              {
                actions: ["iam:PassRole"],
                resources: ["*"],
              },
              {
                actions: ["secretsmanager:GetSecretValue"],
                resources: [secretsManagerSecret.arn],
              },
            ],
          },
        },
      },
    });

    api.route("POST /auth/login", "backend/functions/api/auth.login");
    api.route("GET /senders", "backend/functions/api/senders.list");
    api.route("POST /email/send", "backend/functions/api/email.send");
    api.route("GET /email/jobs", "backend/functions/api/email.list");
    api.route("GET /email/status/{jobId}", "backend/functions/api/email.status");
    api.route("GET /config", "backend/functions/api/config.get");
    api.route("PUT /config", "backend/functions/api/config.update");
    api.route("GET /account/quota", "backend/functions/api/account.quota");
  },
});
