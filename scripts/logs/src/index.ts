#!/usr/bin/env node

import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { CloudWatchLogsClient, FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";

// Color codes for terminal output
const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
};

interface LogGroup {
  name: string;
  logGroup: string;
}

interface Options {
  stage: string;
  region: string;
  filter: string;
  debug: boolean;
}

async function getLogGroups(stage: string, region: string): Promise<LogGroup[]> {
  const cfClient = new CloudFormationClient({ region });

  try {
    const response = await cfClient.send(
      new DescribeStacksCommand({
        StackName: `trickle-${stage}`,
      })
    );

    const outputs = response.Stacks?.[0]?.Outputs || [];
    const logGroupsOutput = outputs.find((o) => o.OutputKey === "LogGroupNames");

    if (!logGroupsOutput?.OutputValue) {
      throw new Error(`LogGroupNames output not found in stack trickle-${stage}`);
    }

    return JSON.parse(logGroupsOutput.OutputValue);
  } catch (error) {
    if (error instanceof Error) {
      console.error(`${colors.red}Error fetching log groups: ${error.message}${colors.reset}`);
    }
    process.exit(1);
  }
}

async function filterLogGroups(logGroups: LogGroup[], filter: string): Promise<LogGroup[]> {
  switch (filter) {
    case "all":
      return logGroups;
    case "api":
      return logGroups.filter(
        (lg) => lg.name !== "Email Worker" && lg.name !== "SES Events Processor"
      );
    case "worker":
      return logGroups.filter((lg) => lg.name === "Email Worker");
    case "processor":
      return logGroups.filter((lg) => lg.name === "SES Events Processor");
    case "config":
      return logGroups.filter((lg) => lg.name === "Config Get" || lg.name === "Config Update");
    case "events":
      return logGroups.filter(
        (lg) => lg.name === "Email Events Summary" || lg.name === "Email Events Logs"
      );
    default:
      throw new Error(
        `Unknown filter: ${filter}. Use: all, api, worker, processor, config, or events`
      );
  }
}

async function tailLogGroup(logGroup: LogGroup, region: string): Promise<void> {
  const logsClient = new CloudWatchLogsClient({ region });
  let lastTimestamp = Date.now() - 10 * 60 * 1000; // Start from 10 minutes ago

  console.log(`${colors.green}✓ Tailing ${logGroup.name}${colors.reset}`);

  // Function to poll for new logs
  const pollLogs = async () => {
    try {
      const response = await logsClient.send(
        new FilterLogEventsCommand({
          logGroupName: logGroup.logGroup,
          startTime: lastTimestamp,
          interleaved: true,
        })
      );

      if (response.events && response.events.length > 0) {
        for (const event of response.events) {
          if (event.message && event.timestamp) {
            const date = new Date(event.timestamp).toISOString();
            console.log(`${colors.cyan}[${logGroup.name} ${date}]${colors.reset} ${event.message}`);
            lastTimestamp = event.timestamp;
          }
        }
      }

      // Continue polling
      setTimeout(pollLogs, 1000);
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes("ResourceNotFoundException")) {
          console.log(
            `${colors.yellow}⏳ ${logGroup.name}: Log group not yet created${colors.reset}`
          );
          console.log(
            `${colors.yellow}   (Invoke a Lambda to trigger log creation)${colors.reset}`
          );
          // Retry every 5 seconds for new logs
          setTimeout(pollLogs, 5000);
        } else {
          console.error(
            `${colors.red}Error tailing ${logGroup.name}: ${error.message}${colors.reset}`
          );
        }
      }
    }
  };

  // Start polling
  await pollLogs();
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const filter = args[0] || "all";

  const stage = process.env.CDK_STAGE || process.env.USER || "dev";
  const region = process.env.AWS_REGION || "us-east-1";
  const debug = process.env.DEBUG === "1";

  const options: Options = {
    stage,
    region,
    filter,
    debug,
  };

  if (filter === "debug") {
    await debugMode(stage, region);
    return;
  }

  if (filter === "--help" || filter === "-h") {
    printHelp();
    return;
  }

  console.log(
    `${colors.bright}${colors.green}=== Trickle Logs (Stage: ${stage}) ===${colors.reset}`
  );
  console.log(`Region: ${region}`);
  console.log("");

  try {
    console.log(`${colors.yellow}Fetching log groups from CloudFormation...${colors.reset}\n`);

    const allLogGroups = await getLogGroups(stage, region);
    const filteredLogGroups = await filterLogGroups(allLogGroups, filter);

    if (filteredLogGroups.length === 0) {
      console.log(`${colors.yellow}No log groups found for filter: ${filter}${colors.reset}`);
      return;
    }

    // Tail all log groups in parallel
    const tailPromises = filteredLogGroups.map((lg) => tailLogGroup(lg, region));

    await Promise.all(tailPromises);

    console.log(
      `\n${colors.green}${filteredLogGroups.length} log tail(s) started. Press Ctrl+C to stop.${colors.reset}`
    );
  } catch (error) {
    if (error instanceof Error) {
      console.error(`${colors.red}${error.message}${colors.reset}`);
    }
    process.exit(1);
  }
}

async function debugMode(stage: string, region: string): Promise<void> {
  console.log(`${colors.bright}${colors.cyan}Debug Mode${colors.reset}`);
  console.log(`Stage: ${stage}`);
  console.log(`Region: ${region}\n`);

  try {
    console.log("Fetching CloudFormation stack...");
    const logGroups = await getLogGroups(stage, region);

    console.log(`${colors.green}Found ${logGroups.length} Lambda log groups:${colors.reset}\n`);

    logGroups.forEach((lg, i) => {
      console.log(`${i + 1}. ${colors.cyan}${lg.name}${colors.reset}`);
      console.log(`   → ${lg.logGroup}\n`);
    });
  } catch (error) {
    if (error instanceof Error) {
      console.error(`${colors.red}Error: ${error.message}${colors.reset}`);
    }
    process.exit(1);
  }
}

function printHelp(): void {
  console.log(`${colors.bright}Trickle Logs - CloudWatch Logs Streaming${colors.reset}

${colors.bright}Usage:${colors.reset}
  npm run logs [filter]

${colors.bright}Filters:${colors.reset}
  all        - Tail all Lambda log groups
  api        - Tail API-related functions
  worker     - Tail email worker
  processor  - Tail SES event processor
  config     - Tail config management functions
  events     - Tail email events functions
  debug      - Show all available log groups

${colors.bright}Environment Variables:${colors.reset}
  CDK_STAGE  - Stage name (defaults to $USER)
  AWS_REGION - AWS region (defaults to us-east-1)
  DEBUG      - Set to '1' for debug output

${colors.bright}Examples:${colors.reset}
  npm run logs                    # Tail all logs
  npm run logs api                # Tail API logs
  CDK_STAGE=production npm run logs worker  # Tail worker in production
  npm run logs debug              # Show available log groups
`);
}

main().catch(console.error);
