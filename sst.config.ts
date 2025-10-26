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
      },
      primaryIndex: { hashKey: "jobId" },
      globalIndexes: {
        userIndex: { hashKey: "userId", rangeKey: "jobId" },
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
      link: [attachmentsBucket, jobsTable],
      permissions: [
        {
          actions: ["ses:SendRawEmail", "ses:SendEmail"],
          resources: ["*"],
        },
        {
          actions: ["scheduler:DeleteSchedule"],
          resources: ["*"],
        },
      ],
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

    // API
    const api = new sst.aws.ApiGatewayV2("Api", {
      transform: {
        route: {
          handler: {
            link: [attachmentsBucket, jobsTable, configTable, worker],
            environment: {
              SCHEDULER_ROLE_ARN: schedulerRole.arn,
            },
            permissions: [
              {
                actions: ["ses:ListIdentities", "ses:GetIdentityVerificationAttributes"],
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

    // Frontend
    new sst.aws.StaticSite("Frontend", {
      path: "frontend",
      build: {
        command: "npm run build",
        output: "dist",
      },
      environment: {
        VITE_API_URL: api.url,
      },
    });
  },
});
