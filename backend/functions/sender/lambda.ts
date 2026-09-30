/**
 * Lambda entrypoints for the send pipeline: the SendJob workflow's tasks and
 * the queue reconciler. Only wiring lives here; the logic is in steps.ts and
 * queue.ts, where it is tested.
 */
import {
  SFNClient,
  DescribeExecutionCommand,
  StartExecutionCommand,
  StopExecutionCommand,
} from "@aws-sdk/client-sfn";
import { dynamoStore } from "./store.ts";
import { sesMailer } from "./mailer.ts";
import { advanceQueue, type ExecutionStatus, type Executions } from "./queue.ts";
import * as steps from "./steps.ts";
import type { StepState } from "./model.ts";

const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};

export function sfnExecutions(stateMachineArn: string, sfn = new SFNClient({})): Executions {
  return {
    arnFor: (jobId) => `${stateMachineArn.replace(":stateMachine:", ":execution:")}:${jobId}`,

    async describe(executionArn) {
      try {
        const { status } = await sfn.send(new DescribeExecutionCommand({ executionArn }));
        return (status ?? "MISSING") as ExecutionStatus;
      } catch (error: any) {
        if (error?.name === "ExecutionDoesNotExist") return "MISSING";
        throw error;
      }
    },

    async start(jobId) {
      try {
        await sfn.send(
          new StartExecutionCommand({
            stateMachineArn,
            // Named by jobId: a job can only ever have one execution.
            name: jobId,
            input: JSON.stringify({ jobId }),
          })
        );
      } catch (error: any) {
        if (error?.name !== "ExecutionAlreadyExists") throw error;
      }
    },

    async stop(executionArn, cause) {
      try {
        await sfn.send(new StopExecutionCommand({ executionArn, cause }));
      } catch (error: any) {
        if (error?.name !== "ExecutionDoesNotExist") throw error;
      }
    },
  };
}

// Built lazily so importing this module (tests, the bundle check) needs no env.
let deps: steps.StepDeps | undefined;
function stepDeps(): steps.StepDeps {
  deps ??= {
    store: dynamoStore(env("JOBS_TABLE_NAME"), env("RECIPIENTS_TABLE_NAME")),
    mailer: sesMailer({
      configurationSetName: env("CONFIGURATION_SET_NAME"),
      attachmentsBucket: env("ATTACHMENTS_BUCKET_NAME"),
    }),
    executions: sfnExecutions(env("SEND_JOB_STATE_MACHINE_ARN")),
  };
  return deps;
}

export const begin = (input: { jobId: string; executionArn: string }) =>
  steps.begin(stepDeps(), input);

export const sendOne = (state: StepState) => steps.sendOne(stepDeps(), state);

export const recordOutcome = (input: StepState & { caught: steps.Caught }) =>
  steps.recordOutcome(stepDeps(), input);

export const finalize = (input: { jobId: string; caught?: steps.Caught }) =>
  steps.finalize(stepDeps(), input);

/** Every minute: the guarantee that the queue moves even if a fast path failed. */
export async function reconcile() {
  const result = await advanceQueue(stepDeps());
  if (result.action !== "busy") console.log(JSON.stringify(result));
  return result;
}
