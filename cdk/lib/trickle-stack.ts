import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as apigatewayv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as sns from "aws-cdk-lib/aws-sns";
import * as snsSubscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import * as iam from "aws-cdk-lib/aws-iam";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as ses from "aws-cdk-lib/aws-ses";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as route53Targets from "aws-cdk-lib/aws-route53-targets";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as cloudfrontOrigins from "aws-cdk-lib/aws-cloudfront-origins";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cloudwatchActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as lambdaDestinations from "aws-cdk-lib/aws-lambda-destinations";
import * as logs from "aws-cdk-lib/aws-logs";
import * as events from "aws-cdk-lib/aws-events";
import * as eventsTargets from "aws-cdk-lib/aws-events-targets";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import * as tasks from "aws-cdk-lib/aws-stepfunctions-tasks";
import { Construct } from "constructs";
import * as path from "node:path";
import { HANDLERS, type HandlerId } from "../../backend/functions/handlers.ts";

// Every Lambda is bundled from TypeScript source by esbuild at synth time.
// On Node 24 runtimes CDK marks @aws-sdk/* external by default -- the SDK
// ships in the runtime -- so bundles stay small. Deliberately not minified:
// the size saved is negligible next to keeping CloudWatch stack traces
// readable on a production service.
const LAMBDA_BUNDLING: nodejs.BundlingOptions = {
  format: nodejs.OutputFormat.ESM,
  target: "node24",
};

const BACKEND_FUNCTIONS = path.join(import.meta.dirname, "../../backend/functions");

/**
 * Resolves a construct id to its esbuild entry point and handler export,
 * so the wiring lives in exactly one place (backend/functions/handlers.ts)
 * and is covered by handlers.test.ts.
 */
function handlerSource(id: HandlerId) {
  const { module: modulePath, export: exportName } = HANDLERS[id];
  return {
    entry: path.join(BACKEND_FUNCTIONS, modulePath),
    handler: exportName,
    bundling: LAMBDA_BUNDLING,
  };
}

export interface TrickleStackProps extends cdk.StackProps {
  stage: string;
  authUsername: string;
  authPassword: string;
  authSecret: string;
  frontendCertificateArn: string;
  /** Where operational alarms are emailed. Omitted: alarms exist but notify nobody. */
  alertEmail?: string;
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

    // ========== S3 Bucket for Attachments ==========
    // Bucket names are global across regions, so they carry the region: a
    // stage can then be moved to another region while the old region's
    // retained buckets still exist (as production's did, moving from eu-west-1).
    const attachmentsBucket = new s3.Bucket(this, "AttachmentsBucket", {
      bucketName: `trickle-attachments-${stage}-${this.region}-${this.account}`,
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
          expiration: cdk.Duration.days(30), // Aligned with job and event retention
        },
      ],
    });

    // ========== DynamoDB Tables ==========
    // Jobs table: Stores email job records (status, recipient count, error tracking)
    // TTL: 30 days (aligned with email events retention - parent records must outlive children)
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

    // Sparse index of the send queue: only queued and sending jobs carry the
    // `queue` attribute, so this lists exactly the active jobs, oldest first.
    jobsTable.addGlobalSecondaryIndex({
      indexName: "queueIndex",
      partitionKey: { name: "queue", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "createdAt", type: dynamodb.AttributeType.STRING },
    });

    // One row per recipient per job: the send pipeline's source of truth for
    // who has been sent what (see backend/functions/sender/model.ts).
    const recipientsTable = new dynamodb.Table(this, "RecipientsTable", {
      tableName: `trickle-recipients-${stage}`,
      partitionKey: { name: "jobId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "idx", type: dynamodb.AttributeType.NUMBER },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: isProduction ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      timeToLiveAttribute: "ttl",
    });

    const configTable = new dynamodb.Table(this, "ConfigTable", {
      tableName: `trickle-config-${stage}`,
      partitionKey: { name: "userId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: isProduction ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // Email events table (stores SES events - Send, Delivery, Bounce, Complaint, Open, Click, etc)
    // TTL: 30 days (aligned with jobs table retention to ensure events are accessible within job lifetime)
    // The sort key is derived from the SES event itself (event time, message,
    // type, recipient), so redelivered notifications overwrite instead of
    // duplicating -- see buildEventRows in ses-events-processor.ts.
    const emailEventsTable = new dynamodb.Table(this, "EmailEventsTableV2", {
      tableName: `trickle-email-events-v2-${stage}`,
      partitionKey: { name: "jobId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "eventKey", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: isProduction ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      timeToLiveAttribute: "ttl",
    });

    // Global secondary index for querying by recipient
    emailEventsTable.addGlobalSecondaryIndex({
      indexName: "recipientIndex",
      partitionKey: { name: "recipient", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "timestamp", type: dynamodb.AttributeType.NUMBER },
    });

    // ========== SES Configuration Set ==========
    const configurationSetName = `trickle-${stage}`;

    // Create SNS topic for SES events
    const sesEventsTopic = new sns.Topic(this, "SESEventsTopic", {
      topicName: `trickle-ses-events-${stage}`,
      displayName: "Trickle SES Email Events",
    });

    // Create SES Configuration Set
    // Suppression at the configuration-set level: SES itself refuses to send to
    // an address that has hard-bounced or complained, rather than relying on
    // someone acting on the "remove hard bounces" advice before the next job.
    const configSet = new ses.CfnConfigurationSet(this, "EmailConfigurationSet", {
      name: configurationSetName,
      suppressionOptions: { suppressedReasons: ["BOUNCE", "COMPLAINT"] },
    });

    // Add SNS event destination for email event tracking
    new ses.CfnConfigurationSetEventDestination(this, "SNSEventDestination", {
      configurationSetName: configSet.ref,
      eventDestination: {
        name: `${configurationSetName}-sns`,
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
        snsDestination: {
          topicArn: sesEventsTopic.topicArn,
        },
      },
    });

    // SNS invokes the processor asynchronously; events that still fail after
    // Lambda's retries land here instead of vanishing, and are alarmed below.
    const sesEventsFailures = new sqs.Queue(this, "SESEventsFailures", {
      queueName: `trickle-ses-events-failures-${stage}`,
      retentionPeriod: cdk.Duration.days(14),
    });

    // Create Lambda to process SES events from SNS and write to DynamoDB
    const sesEventsProcessor = new nodejs.NodejsFunction(this, "SESEventsProcessor", {
      functionName: `trickle-${stage}-ses-events-processor`,
      runtime: lambda.Runtime.NODEJS_24_X,
      ...handlerSource("SESEventsProcessor"),
      environment: {
        EMAIL_EVENTS_TABLE: emailEventsTable.tableName,
      },
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      retryAttempts: 2,
      onFailure: new lambdaDestinations.SqsDestination(sesEventsFailures),
    });

    // Subscribe Lambda to SNS topic
    sesEventsTopic.addSubscription(new snsSubscriptions.LambdaSubscription(sesEventsProcessor));

    // Grant Lambda permission to write to email events table
    emailEventsTable.grantWriteData(sesEventsProcessor);

    // ========== Send pipeline ==========
    // One Step Functions execution per job walks its recipient rows, one at a
    // time, rateLimit seconds apart; one job sends at a time. The logic and
    // its guarantees are documented in backend/functions/sender/.
    //
    // The ARN is spelled out rather than taken from the state machine because
    // its own Finalize task needs it (to start the next job), which would
    // otherwise be a circular reference.
    const sendJobStateMachineName = `trickle-${stage}-send-job`;
    const sendJobStateMachineArn = this.formatArn({
      service: "states",
      resource: "stateMachine",
      resourceName: sendJobStateMachineName,
      arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
    });
    const sendJobExecutionsArn = this.formatArn({
      service: "states",
      resource: "execution",
      resourceName: `${sendJobStateMachineName}:*`,
      arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
    });

    const sendPipelineEnvironment = {
      JOBS_TABLE_NAME: jobsTable.tableName,
      RECIPIENTS_TABLE_NAME: recipientsTable.tableName,
      SEND_JOB_STATE_MACHINE_ARN: sendJobStateMachineArn,
      CONFIGURATION_SET_NAME: configurationSetName,
      ATTACHMENTS_BUCKET_NAME: attachmentsBucket.bucketName,
    };

    /** Everything that can start, inspect or stop a job's execution. */
    const grantExecutionControl = (fn: lambda.Function) => {
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["states:StartExecution"],
          resources: [sendJobStateMachineArn],
        })
      );
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["states:DescribeExecution", "states:StopExecution"],
          resources: [sendJobExecutionsArn],
        })
      );
    };

    const senderFunction = (
      id: HandlerId,
      name: string,
      options: { timeout?: cdk.Duration; memorySize?: number } = {}
    ) => {
      const fn = new nodejs.NodejsFunction(this, id, {
        functionName: `trickle-${stage}-${name}`,
        runtime: lambda.Runtime.NODEJS_24_X,
        ...handlerSource(id),
        timeout: options.timeout ?? cdk.Duration.seconds(30),
        memorySize: options.memorySize ?? 256,
        environment: sendPipelineEnvironment,
        logGroup: new logs.LogGroup(this, `${id}Logs`, {
          logGroupName: `/aws/lambda/trickle-${stage}-${name}`,
          retention: logs.RetentionDays.THREE_MONTHS,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      });
      jobsTable.grantReadWriteData(fn);
      recipientsTable.grantReadWriteData(fn);
      grantExecutionControl(fn);
      return fn;
    };

    const beginFunction = senderFunction("SendJobBegin", "send-job-begin");
    // Long enough for S3 attachment reads plus one SES call. If it still times
    // out mid-send, the retry finds the row claimed and reports it unconfirmed.
    const sendOneFunction = senderFunction("SendJobSendOne", "send-job-send-one", {
      timeout: cdk.Duration.seconds(60),
      memorySize: 512,
    });
    const recordOutcomeFunction = senderFunction("SendJobRecordOutcome", "send-job-record-outcome");
    const finalizeFunction = senderFunction("SendJobFinalize", "send-job-finalize");
    const reconcilerFunction = senderFunction("SendQueueReconciler", "send-queue-reconciler");

    attachmentsBucket.grantRead(sendOneFunction);
    sendOneFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ses:SendEmail"],
        resources: ["*"],
      })
    );

    new events.Rule(this, "SendQueueReconcilerSchedule", {
      ruleName: `trickle-${stage}-send-queue-reconciler`,
      schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
      targets: [new eventsTargets.LambdaFunction(reconcilerFunction)],
    });

    // Lambda invocation failures that say nothing about whether the function
    // ran. Retrying is safe for every task: SendOne's claim turns a re-run of a
    // half-finished send into "unconfirmed", never into a second send.
    const LAMBDA_INVOKE_ERRORS = [
      "Lambda.ServiceException",
      "Lambda.AWSLambdaException",
      "Lambda.SdkClientException",
      "Lambda.TooManyRequestsException",
      "Lambda.Unknown",
      "Sandbox.Timedout",
      sfn.Errors.TIMEOUT,
    ];
    const task = (id: string, fn: lambda.IFunction, payload?: sfn.TaskInput) => {
      const invoke = new tasks.LambdaInvoke(this, id, {
        lambdaFunction: fn,
        payloadResponseOnly: true,
        retryOnServiceExceptions: false,
        ...(payload ? { payload } : {}),
      });
      invoke.addRetry({
        errors: LAMBDA_INVOKE_ERRORS,
        interval: cdk.Duration.seconds(2),
        backoffRate: 2,
        maxAttempts: 6,
      });
      return invoke;
    };

    const jobIdOnly = sfn.TaskInput.fromObject({ jobId: sfn.JsonPath.stringAt("$.jobId") });
    const settleRetry = {
      errors: [sfn.Errors.ALL],
      interval: cdk.Duration.seconds(5),
      backoffRate: 2,
      maxAttempts: 8,
    };

    const finalizeOk = task("Finalize", finalizeFunction, jobIdOnly).addRetry(settleRetry);
    const finalizeFailed = task(
      "FinalizeFailed",
      finalizeFunction,
      sfn.TaskInput.fromObject({
        jobId: sfn.JsonPath.stringAt("$.jobId"),
        caught: sfn.JsonPath.objectAt("$.caught"),
      })
    ).addRetry(settleRetry);
    finalizeOk.next(new sfn.Succeed(this, "JobSettled"));
    finalizeFailed.next(new sfn.Fail(this, "JobFailed", { error: "SendJobFailed" }));

    const catchToFailed = { errors: [sfn.Errors.ALL], resultPath: "$.caught" };

    const begin = task(
      "Begin",
      beginFunction,
      sfn.TaskInput.fromObject({
        jobId: sfn.JsonPath.stringAt("$.jobId"),
        executionArn: sfn.JsonPath.executionId,
      })
    ).addCatch(finalizeFailed, catchToFailed);

    const sendOne = task("SendOne", sendOneFunction)
      // Throttled: SES did not take it. Back off for up to ~15 minutes.
      .addRetry({
        errors: ["RetryableSendError"],
        interval: cdk.Duration.seconds(30),
        backoffRate: 2,
        maxAttempts: 5,
      });

    const recordOutcome = task("RecordOutcome", recordOutcomeFunction)
      .addRetry(settleRetry)
      .addCatch(finalizeFailed, catchToFailed);

    sendOne
      .addCatch(recordOutcome, {
        errors: ["RetryableSendError", "RecordFailedError"],
        resultPath: "$.caught",
      })
      .addCatch(finalizeFailed, catchToFailed);

    const waitRate = new sfn.Wait(this, "WaitRateLimit", {
      time: sfn.WaitTime.secondsPath("$.rateLimit"),
    });
    const nextRecipient = new sfn.Choice(this, "NextRecipient")
      .when(sfn.Condition.booleanEquals("$.done", true), finalizeOk)
      .when(sfn.Condition.booleanEquals("$.pace", true), waitRate.next(sendOne))
      .otherwise(sendOne);
    sendOne.next(nextRecipient);
    recordOutcome.next(nextRecipient);

    const definition = begin.next(
      new sfn.Choice(this, "AnythingToSend")
        .when(sfn.Condition.booleanEquals("$.done", true), finalizeOk)
        .otherwise(sendOne)
    );

    // Step Functions checks at creation time that its role can deliver logs.
    // CDK would attach those permissions as a separate policy created a second
    // before the state machine, which IAM had not propagated yet: the first
    // deploy failed with "The state machine IAM Role is not authorized to
    // access the Log Destination". Inline on the role, they exist from the
    // moment the role does, well before the state machine is created.
    const sendJobRole = new iam.Role(this, "SendJobStateMachineRole", {
      assumedBy: new iam.ServicePrincipal("states.amazonaws.com"),
      inlinePolicies: {
        LogDelivery: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: [
                "logs:CreateLogDelivery",
                "logs:GetLogDelivery",
                "logs:UpdateLogDelivery",
                "logs:DeleteLogDelivery",
                "logs:ListLogDeliveries",
                "logs:PutResourcePolicy",
                "logs:DescribeResourcePolicies",
                "logs:DescribeLogGroups",
              ],
              resources: ["*"],
            }),
          ],
        }),
      },
    });

    const sendJobStateMachine = new sfn.StateMachine(this, "SendJobStateMachine", {
      stateMachineName: sendJobStateMachineName,
      role: sendJobRole,
      stateMachineType: sfn.StateMachineType.STANDARD,
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      logs: {
        destination: new logs.LogGroup(this, "SendJobStateMachineLogs", {
          logGroupName: `/aws/vendedlogs/states/${sendJobStateMachineName}`,
          retention: logs.RetentionDays.THREE_MONTHS,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
        level: sfn.LogLevel.ERROR,
        // Execution data carries recipient addresses; keep it out of logs.
        includeExecutionData: false,
      },
    });

    // Common environment for API functions
    const apiEnvironment = {
      JOBS_TABLE_NAME: jobsTable.tableName,
      CONFIG_TABLE_NAME: configTable.tableName,
      EMAIL_EVENTS_TABLE_NAME: emailEventsTable.tableName,
      ATTACHMENTS_BUCKET_NAME: attachmentsBucket.bucketName,
      RECIPIENTS_TABLE_NAME: recipientsTable.tableName,
      SEND_JOB_STATE_MACHINE_ARN: sendJobStateMachineArn,
      AUTH_PARAMETER_PATH: authParameterPath,
    };

    // API Lambda functions
    const authLoginFunction = new nodejs.NodejsFunction(this, "AuthLogin", {
      functionName: `trickle-${stage}-auth-login`,
      runtime: lambda.Runtime.NODEJS_24_X,
      ...handlerSource("AuthLogin"),
      timeout: cdk.Duration.seconds(30),
      environment: apiEnvironment,
    });

    const sendersListFunction = new nodejs.NodejsFunction(this, "SendersList", {
      functionName: `trickle-${stage}-senders-list`,
      runtime: lambda.Runtime.NODEJS_24_X,
      ...handlerSource("SendersList"),
      timeout: cdk.Duration.seconds(30),
      environment: apiEnvironment,
    });

    const emailSendFunction = new nodejs.NodejsFunction(this, "EmailSend", {
      functionName: `trickle-${stage}-email-send`,
      runtime: lambda.Runtime.NODEJS_24_X,
      ...handlerSource("EmailSend"),
      timeout: cdk.Duration.seconds(30),
      environment: apiEnvironment,
    });

    const emailListFunction = new nodejs.NodejsFunction(this, "EmailList", {
      functionName: `trickle-${stage}-email-list`,
      runtime: lambda.Runtime.NODEJS_24_X,
      ...handlerSource("EmailList"),
      timeout: cdk.Duration.seconds(30),
      environment: apiEnvironment,
    });

    const emailCancelFunction = new nodejs.NodejsFunction(this, "EmailCancel", {
      functionName: `trickle-${stage}-email-cancel`,
      runtime: lambda.Runtime.NODEJS_24_X,
      ...handlerSource("EmailCancel"),
      timeout: cdk.Duration.seconds(30),
      environment: apiEnvironment,
    });

    const emailRecipientsFunction = new nodejs.NodejsFunction(this, "EmailRecipients", {
      functionName: `trickle-${stage}-email-recipients`,
      runtime: lambda.Runtime.NODEJS_24_X,
      ...handlerSource("EmailRecipients"),
      timeout: cdk.Duration.seconds(30),
      environment: apiEnvironment,
    });

    const emailStatusFunction = new nodejs.NodejsFunction(this, "EmailStatus", {
      functionName: `trickle-${stage}-email-status`,
      runtime: lambda.Runtime.NODEJS_24_X,
      ...handlerSource("EmailStatus"),
      timeout: cdk.Duration.seconds(30),
      environment: apiEnvironment,
    });

    const configGetFunction = new nodejs.NodejsFunction(this, "ConfigGet", {
      functionName: `trickle-${stage}-config-get`,
      runtime: lambda.Runtime.NODEJS_24_X,
      ...handlerSource("ConfigGet"),
      timeout: cdk.Duration.seconds(30),
      environment: apiEnvironment,
    });

    const configUpdateFunction = new nodejs.NodejsFunction(this, "ConfigUpdate", {
      functionName: `trickle-${stage}-config-update`,
      runtime: lambda.Runtime.NODEJS_24_X,
      ...handlerSource("ConfigUpdate"),
      timeout: cdk.Duration.seconds(30),
      environment: apiEnvironment,
    });

    const accountQuotaFunction = new nodejs.NodejsFunction(this, "AccountQuota", {
      functionName: `trickle-${stage}-account-quota`,
      runtime: lambda.Runtime.NODEJS_24_X,
      ...handlerSource("AccountQuota"),
      timeout: cdk.Duration.seconds(30),
      environment: apiEnvironment,
    });

    const emailEventsSummaryFunction = new nodejs.NodejsFunction(this, "EmailEventsSummary", {
      functionName: `trickle-${stage}-email-events-summary`,
      runtime: lambda.Runtime.NODEJS_24_X,
      ...handlerSource("EmailEventsSummary"),
      timeout: cdk.Duration.seconds(60),
      environment: apiEnvironment,
    });

    const emailEventsLogsFunction = new nodejs.NodejsFunction(this, "EmailEventsLogs", {
      functionName: `trickle-${stage}-email-events-logs`,
      runtime: lambda.Runtime.NODEJS_24_X,
      ...handlerSource("EmailEventsLogs"),
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

    // emailEventsSummaryFunction - needs Parameter Store + DynamoDB read
    grantAuthParameterAccess(emailEventsSummaryFunction);
    emailEventsTable.grantReadData(emailEventsSummaryFunction);

    // emailEventsLogsFunction - needs Parameter Store + DynamoDB read
    grantAuthParameterAccess(emailEventsLogsFunction);
    emailEventsTable.grantReadData(emailEventsLogsFunction);

    // emailListFunction - needs Parameter Store + jobs table read-only
    grantAuthParameterAccess(emailListFunction);
    jobsTable.grantReadData(emailListFunction);

    // emailStatusFunction - needs Parameter Store + jobs table read-only + email events for metrics
    grantAuthParameterAccess(emailStatusFunction);
    jobsTable.grantReadData(emailStatusFunction);
    emailEventsTable.grantReadData(emailStatusFunction);

    // configGetFunction - needs Parameter Store + config table read-only
    grantAuthParameterAccess(configGetFunction);
    configTable.grantReadData(configGetFunction);

    // configUpdateFunction - needs Parameter Store + config table read/write +
    // SES read-only (it calls ses:GetAccount to derive the rate-limit floor
    // from the account's max send rate). Without this grant every config save
    // throws AccessDenied and returns 500 "Failed to update config".
    grantAuthParameterAccess(configUpdateFunction);
    configTable.grantReadWriteData(configUpdateFunction);
    configUpdateFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ses:GetAccount"],
        resources: ["*"],
      })
    );

    // emailSendFunction - Parameter Store, jobs + recipients, config, S3, SES read, starting executions
    grantAuthParameterAccess(emailSendFunction);
    jobsTable.grantReadWriteData(emailSendFunction);
    recipientsTable.grantWriteData(emailSendFunction);
    grantExecutionControl(emailSendFunction);
    configTable.grantReadData(emailSendFunction);
    attachmentsBucket.grantReadWrite(emailSendFunction);
    emailSendFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ses:ListEmailIdentities", "ses:GetAccount"],
        resources: ["*"],
      })
    );

    // emailCancelFunction - Parameter Store, jobs, stopping and starting executions
    grantAuthParameterAccess(emailCancelFunction);
    jobsTable.grantReadWriteData(emailCancelFunction);
    grantExecutionControl(emailCancelFunction);

    // emailRecipientsFunction - Parameter Store, jobs + recipients read-only
    grantAuthParameterAccess(emailRecipientsFunction);
    jobsTable.grantReadData(emailRecipientsFunction);
    recipientsTable.grantReadData(emailRecipientsFunction);

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
        allowHeaders: ["Content-Type", "Authorization", "Idempotency-Key"],
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
      path: "/email/jobs/{jobId}/cancel",
      methods: [apigatewayv2.HttpMethod.POST],
      integration: new integrations.HttpLambdaIntegration(
        "EmailCancelIntegration",
        emailCancelFunction
      ),
    });

    httpApi.addRoutes({
      path: "/email/jobs/{jobId}/recipients",
      methods: [apigatewayv2.HttpMethod.GET],
      integration: new integrations.HttpLambdaIntegration(
        "EmailRecipientsIntegration",
        emailRecipientsFunction
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
      bucketName: `trickle-frontend-${stage}-${this.region}-${this.account}`,
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

    // ========== Alarms ==========
    // Every alarm notifies one topic. Only stages given an alert address
    // (production, via ALERT_EMAIL in the deploy workflow) subscribe anyone;
    // other stages still create the alarms, so their wiring gets exercised.
    const alertsTopic = new sns.Topic(this, "AlertsTopic", {
      topicName: `trickle-alerts-${stage}`,
      displayName: `Trickle ${stage} alerts`,
    });
    if (props.alertEmail) {
      alertsTopic.addSubscription(new snsSubscriptions.EmailSubscription(props.alertEmail));
    }
    const notify = new cloudwatchActions.SnsAction(alertsTopic);

    const alarm = (id: string, description: string, props: cloudwatch.AlarmProps) => {
      const created = new cloudwatch.Alarm(this, id, {
        alarmName: `trickle-${stage}-${id}`,
        alarmDescription: description,
        ...props,
      });
      created.addAlarmAction(notify);
      return created;
    };

    // Anything sitting in a failure queue is work that was given up on.
    const queueNotEmpty = (id: string, queue: sqs.Queue, description: string) =>
      alarm(id, description, {
        metric: queue.metricApproximateNumberOfMessagesVisible({
          period: cdk.Duration.minutes(5),
          statistic: "Maximum",
        }),
        threshold: 0,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });

    queueNotEmpty(
      "ses-events-failures-not-empty",
      sesEventsFailures,
      "SES events could not be stored. Bounces or complaints may be missing from job metrics."
    );

    // A job whose execution failed has stopped part-way; its remaining
    // recipients are still pending.
    alarm(
      "send-job-failed",
      "A send job's workflow failed. Its remaining recipients were not sent.",
      {
        metric: new cloudwatch.MathExpression({
          expression: "failed + timedOut",
          usingMetrics: {
            failed: sendJobStateMachine.metricFailed({
              period: cdk.Duration.minutes(5),
              statistic: "Sum",
            }),
            timedOut: sendJobStateMachine.metricTimedOut({
              period: cdk.Duration.minutes(5),
              statistic: "Sum",
            }),
          },
          period: cdk.Duration.minutes(5),
        }),
        threshold: 0,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }
    );

    // SendOne logs a structured line for every recipient it cannot confirm
    // (see reportUnconfirmed in sender/steps.ts). Each needs a human to check
    // SES whether it went out, because the pipeline will not resend it.
    const unconfirmed = new logs.MetricFilter(this, "UnconfirmedRecipientsFilter", {
      logGroup: sendOneFunction.logGroup,
      metricNamespace: "Trickle",
      metricName: `UnconfirmedRecipients-${stage}`,
      filterPattern: logs.FilterPattern.stringValue("$.event", "=", "UnconfirmedRecipient"),
      metricValue: "1",
      defaultValue: 0,
    });
    alarm(
      "unconfirmed-recipients",
      "A recipient could not be confirmed as sent or not sent. Check SES before resending by hand.",
      {
        metric: unconfirmed.metric({ period: cdk.Duration.minutes(5), statistic: "Sum" }),
        threshold: 0,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }
    );

    alarm(
      "send-queue-reconciler-errors",
      "The send queue reconciler is failing; queued jobs may not start.",
      {
        metric: reconcilerFunction.metricErrors({
          period: cdk.Duration.minutes(15),
          statistic: "Sum",
        }),
        threshold: 2,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }
    );

    // Account-wide reputation, published by SES. AWS reviews an account at
    // 5% bounces / 0.1% complaints and can pause sending at 10% / 0.5%, so
    // these fire at the review thresholds, well before sending is at risk.
    const sesReputation = (metricName: string) =>
      new cloudwatch.Metric({
        namespace: "AWS/SES",
        metricName,
        period: cdk.Duration.hours(1),
        statistic: "Maximum",
      });
    alarm("ses-bounce-rate", "SES account bounce rate reached the 5% review threshold.", {
      metric: sesReputation("Reputation.BounceRate"),
      threshold: 0.05,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    alarm("ses-complaint-rate", "SES account complaint rate reached the 0.1% review threshold.", {
      metric: sesReputation("Reputation.ComplaintRate"),
      threshold: 0.001,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
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
  }
}
