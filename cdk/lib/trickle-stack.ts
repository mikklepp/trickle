import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as apigatewayv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as ses from "aws-cdk-lib/aws-ses";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as route53Targets from "aws-cdk-lib/aws-route53-targets";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as cloudfrontOrigins from "aws-cdk-lib/aws-cloudfront-origins";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import { Construct } from "constructs";

export interface TrickleStackProps extends cdk.StackProps {
  stage: string;
  authUsername: string;
  authPassword: string;
  authSecret: string;
  frontendCertificateArn: string;
}

export class TrickleStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: TrickleStackProps) {
    super(scope, id, props);

    const { stage, authUsername, authPassword, authSecret } = props;
    const isProduction = stage === "production";

    // Domain names
    const frontendDomain = isProduction ? "trickle.qed.fi" : `${stage}.trickle.qed.fi`;
    const apiDomain = isProduction ? "api.trickle.qed.fi" : `api.${stage}.trickle.qed.fi`;
    const authParameterPath = `/app/trickle/${stage}/auth`;

    // ========== Parameter Store ==========
    new ssm.StringParameter(this, "AuthUsernameParameter", {
      parameterName: `${authParameterPath}/username`,
      stringValue: authUsername,
    });

    new ssm.StringParameter(this, "AuthPasswordParameter", {
      parameterName: `${authParameterPath}/password`,
      stringValue: authPassword,
    });

    new ssm.StringParameter(this, "AuthSecretParameter", {
      parameterName: `${authParameterPath}/secret`,
      stringValue: authSecret,
    });

    // ========== SES Configuration Set ==========
    // Configuration set for tracking email events via CloudWatch
    const configurationSetName = `trickle-${stage}`;

    // Create SES Configuration Set
    const configSet = new ses.CfnConfigurationSet(this, "EmailConfigurationSet", {
      name: configurationSetName,
    });

    // Add CloudWatch event destination for email event tracking
    new ses.CfnConfigurationSetEventDestination(this, "CloudWatchEventDestination", {
      configurationSetName: configSet.ref,
      eventDestination: {
        name: `${configurationSetName}-cloudwatch`,
        enabled: true,
        matchingEventTypes: [
          "send",
          "delivery",
          "bounce",
          "complaint",
          "reject",
          "deliveryDelay",
          "open",
          "click",
        ],
        cloudWatchDestination: {
          dimensionConfigurations: [
            {
              defaultDimensionValue: configurationSetName,
              dimensionName: "ses:configuration-set",
              dimensionValueSource: "messageTag",
            },
          ],
        },
      },
    });

    // ========== S3 Bucket for Attachments ==========
    const attachmentsBucket = new s3.Bucket(this, "AttachmentsBucket", {
      bucketName: `trickle-attachments-${stage}-${this.account}`,
      removalPolicy: isProduction ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: !isProduction,
      cors: [
        {
          allowedOrigins: [`https://${frontendDomain}`],
          allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT, s3.HttpMethods.POST],
          allowedHeaders: ["*"],
          maxAge: 3600,
        },
      ],
      lifecycleRules: [
        {
          id: "delete-old-attachments",
          enabled: true,
          expiration: cdk.Duration.days(7),
        },
      ],
    });

    // ========== DynamoDB Tables ==========
    const jobsTable = new dynamodb.Table(this, "JobsTable", {
      tableName: `trickle-jobs-${stage}`,
      partitionKey: { name: "jobId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: isProduction ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      timeToLiveAttribute: "expiresAt",
    });

    // Global secondary index for user queries
    jobsTable.addGlobalSecondaryIndex({
      indexName: "userIndex",
      partitionKey: { name: "userId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "createdAt", type: dynamodb.AttributeType.STRING },
    });

    const configTable = new dynamodb.Table(this, "ConfigTable", {
      tableName: `trickle-config-${stage}`,
      partitionKey: { name: "userId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: isProduction ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // ========== SQS Dead Letter Queue ==========
    const emailDLQ = new sqs.Queue(this, "EmailDLQ", {
      queueName: `trickle-email-dlq-${stage}`,
      retentionPeriod: cdk.Duration.days(14),
    });

    // ========== Lambda Functions ==========

    // Worker Lambda (invoked by EventBridge Scheduler)
    const workerFunction = new lambda.Function(this, "EmailWorker", {
      functionName: `trickle-email-worker-${stage}`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "worker/index.handler",
      code: lambda.Code.fromAsset("../backend/dist"),
      timeout: cdk.Duration.minutes(2),
      deadLetterQueue: emailDLQ,
      environment: {
        JOBS_TABLE_NAME: jobsTable.tableName,
        ATTACHMENTS_BUCKET_NAME: attachmentsBucket.bucketName,
        EMAIL_DLQ_URL: emailDLQ.queueUrl,
        CONFIGURATION_SET_NAME: configurationSetName,
      },
    });

    // Grant permissions to worker
    jobsTable.grantReadWriteData(workerFunction);
    attachmentsBucket.grantRead(workerFunction);

    workerFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ses:SendEmail"],
        resources: ["*"],
      })
    );

    workerFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["scheduler:DeleteSchedule"],
        resources: ["*"],
      })
    );

    // IAM Role for EventBridge Scheduler to invoke worker
    const schedulerRole = new iam.Role(this, "SchedulerRole", {
      roleName: `trickle-scheduler-${stage}`,
      assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com"),
    });

    schedulerRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["lambda:InvokeFunction"],
        resources: [workerFunction.functionArn],
      })
    );

    // Common environment for API functions
    const apiEnvironment = {
      JOBS_TABLE_NAME: jobsTable.tableName,
      CONFIG_TABLE_NAME: configTable.tableName,
      ATTACHMENTS_BUCKET_NAME: attachmentsBucket.bucketName,
      WORKER_FUNCTION_ARN: workerFunction.functionArn,
      SCHEDULER_ROLE_ARN: schedulerRole.roleArn,
      AUTH_PARAMETER_PATH: authParameterPath,
    };

    // API Lambda functions
    const authLoginFunction = new lambda.Function(this, "AuthLogin", {
      functionName: `trickle-auth-login-${stage}`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "api/auth.login",
      code: lambda.Code.fromAsset("../backend/dist"),
      timeout: cdk.Duration.seconds(30),
      environment: apiEnvironment,
    });

    const sendersListFunction = new lambda.Function(this, "SendersList", {
      functionName: `trickle-senders-list-${stage}`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "api/senders.list",
      code: lambda.Code.fromAsset("../backend/dist"),
      timeout: cdk.Duration.seconds(30),
      environment: apiEnvironment,
    });

    const emailSendFunction = new lambda.Function(this, "EmailSend", {
      functionName: `trickle-email-send-${stage}`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "api/email.send",
      code: lambda.Code.fromAsset("../backend/dist"),
      timeout: cdk.Duration.seconds(30),
      environment: apiEnvironment,
    });

    const emailListFunction = new lambda.Function(this, "EmailList", {
      functionName: `trickle-email-list-${stage}`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "api/email.list",
      code: lambda.Code.fromAsset("../backend/dist"),
      timeout: cdk.Duration.seconds(30),
      environment: apiEnvironment,
    });

    const emailStatusFunction = new lambda.Function(this, "EmailStatus", {
      functionName: `trickle-email-status-${stage}`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "api/email.status",
      code: lambda.Code.fromAsset("../backend/dist"),
      timeout: cdk.Duration.seconds(30),
      environment: apiEnvironment,
    });

    const configGetFunction = new lambda.Function(this, "ConfigGet", {
      functionName: `trickle-config-get-${stage}`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "api/config.get",
      code: lambda.Code.fromAsset("../backend/dist"),
      timeout: cdk.Duration.seconds(30),
      environment: apiEnvironment,
    });

    const configUpdateFunction = new lambda.Function(this, "ConfigUpdate", {
      functionName: `trickle-config-update-${stage}`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "api/config.update",
      code: lambda.Code.fromAsset("../backend/dist"),
      timeout: cdk.Duration.seconds(30),
      environment: apiEnvironment,
    });

    const accountQuotaFunction = new lambda.Function(this, "AccountQuota", {
      functionName: `trickle-account-quota-${stage}`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "api/account.quota",
      code: lambda.Code.fromAsset("../backend/dist"),
      timeout: cdk.Duration.seconds(30),
      environment: apiEnvironment,
    });

    const emailEventsSummaryFunction = new lambda.Function(this, "EmailEventsSummary", {
      functionName: `trickle-email-events-summary-${stage}`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "api/email-events.summary",
      code: lambda.Code.fromAsset("../backend/dist"),
      timeout: cdk.Duration.seconds(60),
      environment: apiEnvironment,
    });

    const emailEventsLogsFunction = new lambda.Function(this, "EmailEventsLogs", {
      functionName: `trickle-email-events-logs-${stage}`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "api/email-events.logs",
      code: lambda.Code.fromAsset("../backend/dist"),
      timeout: cdk.Duration.seconds(60),
      environment: apiEnvironment,
    });

    // Helper to grant auth parameter store access
    const grantAuthParameterAccess = (fn: lambda.Function) => {
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["ssm:GetParametersByPath"],
          resources: [
            `arn:aws:ssm:${this.region}:${this.account}:parameter/app/trickle/${stage}/auth`,
          ],
        })
      );
    };

    // Grant specialized permissions to each API function based on actual needs

    // authLoginFunction - only needs auth secrets
    grantAuthParameterAccess(authLoginFunction);

    // sendersListFunction - needs Parameter Store + SES read-only
    grantAuthParameterAccess(sendersListFunction);
    sendersListFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ses:ListEmailIdentities", "ses:GetAccount"],
        resources: ["*"],
      })
    );

    // accountQuotaFunction - needs Parameter Store + SES read-only
    grantAuthParameterAccess(accountQuotaFunction);
    accountQuotaFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ses:GetAccount"],
        resources: ["*"],
      })
    );

    // emailEventsSummaryFunction - needs Parameter Store + CloudWatch Logs read
    grantAuthParameterAccess(emailEventsSummaryFunction);
    emailEventsSummaryFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["logs:StartQuery", "logs:GetQueryResults"],
        resources: ["arn:aws:logs:*:*:log-group:/aws/ses/email-events:*"],
      })
    );

    // emailEventsLogsFunction - needs Parameter Store + CloudWatch Logs read
    grantAuthParameterAccess(emailEventsLogsFunction);
    emailEventsLogsFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["logs:StartQuery", "logs:GetQueryResults"],
        resources: ["arn:aws:logs:*:*:log-group:/aws/ses/email-events:*"],
      })
    );

    // emailListFunction - needs Parameter Store + jobs table read-only
    grantAuthParameterAccess(emailListFunction);
    jobsTable.grantReadData(emailListFunction);

    // emailStatusFunction - needs Parameter Store + jobs table read-only
    grantAuthParameterAccess(emailStatusFunction);
    jobsTable.grantReadData(emailStatusFunction);

    // configGetFunction - needs Parameter Store + config table read-only
    grantAuthParameterAccess(configGetFunction);
    configTable.grantReadData(configGetFunction);

    // configUpdateFunction - needs Parameter Store + config table read/write
    grantAuthParameterAccess(configUpdateFunction);
    configTable.grantReadWriteData(configUpdateFunction);

    // emailSendFunction - needs full permissions (Parameter Store, jobs, config, S3, SES, Scheduler, IAM)
    grantAuthParameterAccess(emailSendFunction);
    jobsTable.grantReadWriteData(emailSendFunction);
    configTable.grantReadData(emailSendFunction);
    attachmentsBucket.grantReadWrite(emailSendFunction);
    emailSendFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ses:ListEmailIdentities", "ses:GetAccount"],
        resources: ["*"],
      })
    );
    emailSendFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["scheduler:CreateSchedule", "scheduler:GetSchedule"],
        resources: ["*"],
      })
    );
    emailSendFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["iam:PassRole"],
        resources: [schedulerRole.roleArn],
      })
    );

    // ========== Route53 & ACM ==========

    // Look up the existing hosted zone
    const hostedZone = route53.HostedZone.fromLookup(this, "HostedZone", {
      domainName: "qed.fi",
    });

    // SSL Certificate for API (must be in same region as API Gateway)
    const apiCertificate = new acm.Certificate(this, "ApiCertificate", {
      domainName: apiDomain,
      validation: acm.CertificateValidation.fromDns(hostedZone),
    });

    // SSL Certificate for CloudFront (imported from us-east-1 certificate stack)
    const frontendCertificate = acm.Certificate.fromCertificateArn(
      this,
      "FrontendCertificate",
      props.frontendCertificateArn
    );

    // ========== API Gateway v2 ==========

    const httpApi = new apigatewayv2.HttpApi(this, "HttpApi", {
      apiName: `trickle-api-${stage}`,
      corsPreflight: {
        allowOrigins: [`https://${frontendDomain}`],
        allowMethods: [
          apigatewayv2.CorsHttpMethod.GET,
          apigatewayv2.CorsHttpMethod.POST,
          apigatewayv2.CorsHttpMethod.PUT,
          apigatewayv2.CorsHttpMethod.DELETE,
          apigatewayv2.CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: ["Content-Type", "Authorization"],
        allowCredentials: false,
      },
    });

    // Custom domain for API
    const apiDomainName = new apigatewayv2.DomainName(this, "ApiDomainName", {
      domainName: apiDomain,
      certificate: apiCertificate,
    });

    new apigatewayv2.ApiMapping(this, "ApiMapping", {
      api: httpApi,
      domainName: apiDomainName,
    });

    // DNS record for API
    new route53.ARecord(this, "ApiAliasRecord", {
      zone: hostedZone,
      recordName: apiDomain,
      target: route53.RecordTarget.fromAlias(
        new route53Targets.ApiGatewayv2DomainProperties(
          apiDomainName.regionalDomainName,
          apiDomainName.regionalHostedZoneId
        )
      ),
    });

    // Add routes
    httpApi.addRoutes({
      path: "/auth/login",
      methods: [apigatewayv2.HttpMethod.POST],
      integration: new integrations.HttpLambdaIntegration(
        "AuthLoginIntegration",
        authLoginFunction
      ),
    });

    httpApi.addRoutes({
      path: "/senders",
      methods: [apigatewayv2.HttpMethod.GET],
      integration: new integrations.HttpLambdaIntegration(
        "SendersListIntegration",
        sendersListFunction
      ),
    });

    httpApi.addRoutes({
      path: "/email/send",
      methods: [apigatewayv2.HttpMethod.POST],
      integration: new integrations.HttpLambdaIntegration(
        "EmailSendIntegration",
        emailSendFunction
      ),
    });

    httpApi.addRoutes({
      path: "/email/jobs",
      methods: [apigatewayv2.HttpMethod.GET],
      integration: new integrations.HttpLambdaIntegration(
        "EmailListIntegration",
        emailListFunction
      ),
    });

    httpApi.addRoutes({
      path: "/email/status/{jobId}",
      methods: [apigatewayv2.HttpMethod.GET],
      integration: new integrations.HttpLambdaIntegration(
        "EmailStatusIntegration",
        emailStatusFunction
      ),
    });

    httpApi.addRoutes({
      path: "/config",
      methods: [apigatewayv2.HttpMethod.GET],
      integration: new integrations.HttpLambdaIntegration(
        "ConfigGetIntegration",
        configGetFunction
      ),
    });

    httpApi.addRoutes({
      path: "/config",
      methods: [apigatewayv2.HttpMethod.PUT],
      integration: new integrations.HttpLambdaIntegration(
        "ConfigUpdateIntegration",
        configUpdateFunction
      ),
    });

    httpApi.addRoutes({
      path: "/account/quota",
      methods: [apigatewayv2.HttpMethod.GET],
      integration: new integrations.HttpLambdaIntegration(
        "AccountQuotaIntegration",
        accountQuotaFunction
      ),
    });

    httpApi.addRoutes({
      path: "/email/events/summary/{jobId}",
      methods: [apigatewayv2.HttpMethod.GET],
      integration: new integrations.HttpLambdaIntegration(
        "EmailEventsSummaryIntegration",
        emailEventsSummaryFunction
      ),
    });

    httpApi.addRoutes({
      path: "/email/events/logs/{jobId}",
      methods: [apigatewayv2.HttpMethod.GET],
      integration: new integrations.HttpLambdaIntegration(
        "EmailEventsLogsIntegration",
        emailEventsLogsFunction
      ),
    });

    // ========== Frontend Static Site ==========

    // S3 bucket for frontend
    const frontendBucket = new s3.Bucket(this, "FrontendBucket", {
      bucketName: `trickle-frontend-${stage}-${this.account}`,
      removalPolicy: isProduction ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: !isProduction,
      publicReadAccess: false,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    });

    // CloudFront distribution
    const distribution = new cloudfront.Distribution(this, "FrontendDistribution", {
      defaultBehavior: {
        origin: cloudfrontOrigins.S3BucketOrigin.withOriginAccessControl(frontendBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      domainNames: [frontendDomain],
      certificate: frontendCertificate,
      defaultRootObject: "index.html",
      errorResponses: [
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: "/index.html",
        },
      ],
    });

    // DNS record for frontend
    new route53.ARecord(this, "FrontendAliasRecord", {
      zone: hostedZone,
      recordName: frontendDomain,
      target: route53.RecordTarget.fromAlias(new route53Targets.CloudFrontTarget(distribution)),
    });

    // Deploy frontend (note: you'll need to build first)
    new s3deploy.BucketDeployment(this, "DeployFrontend", {
      sources: [s3deploy.Source.asset("../frontend/dist")],
      destinationBucket: frontendBucket,
      distribution,
      distributionPaths: ["/*"],
    });

    // ========== Outputs ==========

    new cdk.CfnOutput(this, "ApiUrl", {
      value: `https://${apiDomain}`,
      description: "API Gateway URL",
    });

    new cdk.CfnOutput(this, "FrontendUrl", {
      value: `https://${frontendDomain}`,
      description: "Frontend URL",
    });

    new cdk.CfnOutput(this, "WorkerFunctionArn", {
      value: workerFunction.functionArn,
      description: "Email Worker Lambda ARN",
    });
  }
}
