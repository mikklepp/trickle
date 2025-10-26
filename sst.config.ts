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
    // Storage
    const attachmentsBucket = new sst.aws.Bucket("AttachmentsBucket", {
      transform: {
        bucket: {
          lifecycleConfiguration: {
            rules: [
              {
                id: "DeleteOldAttachments",
                status: "Enabled",
                expiration: { days: 7 },
              },
            ],
          },
        },
      },
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
    });

    const recipientsTable = new sst.aws.Dynamo("RecipientsTable", {
      fields: {
        jobId: "string",
        email: "string",
      },
      primaryIndex: { hashKey: "jobId", rangeKey: "email" },
    });

    const configTable = new sst.aws.Dynamo("ConfigTable", {
      fields: {
        userId: "string",
      },
      primaryIndex: { hashKey: "userId" },
    });

    // Queue
    const emailQueue = new sst.aws.Queue("EmailQueue", {
      visibilityTimeout: "2 minutes",
    });

    const emailDLQ = new sst.aws.Queue("EmailDLQ");

    // Worker Lambda
    const worker = new sst.aws.Function("EmailWorker", {
      handler: "backend/functions/worker/index.handler",
      timeout: "1 minute",
      link: [
        attachmentsBucket,
        jobsTable,
        recipientsTable,
      ],
      permissions: [
        {
          actions: ["ses:SendRawEmail", "ses:SendEmail"],
          resources: ["*"],
        },
      ],
    });

    emailQueue.subscribe(worker.arn);

    // API
    const api = new sst.aws.ApiGatewayV2("Api", {
      transform: {
        route: {
          handler: {
            link: [
              attachmentsBucket,
              jobsTable,
              recipientsTable,
              configTable,
              emailQueue,
            ],
          },
        },
      },
    });

    api.route("POST /auth/login", "backend/functions/api/auth.login");
    api.route("GET /senders", "backend/functions/api/senders.list");
    api.route("POST /email/send", "backend/functions/api/email.send");
    api.route("GET /email/status/{jobId}", "backend/functions/api/email.status");
    api.route("GET /config", "backend/functions/api/config.get");
    api.route("PUT /config", "backend/functions/api/config.update");

    // Frontend
    const frontend = new sst.aws.StaticSite("Frontend", {
      path: "frontend",
      build: {
        command: "npm run build",
        output: "dist",
      },
      environment: {
        VITE_API_URL: api.url,
      },
    });

    return {
      api: api.url,
      frontend: frontend.url,
    };
  },
});
