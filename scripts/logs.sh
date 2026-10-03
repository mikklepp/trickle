#!/bin/bash

# CloudWatch Logs helper script for Trickle
# Tails multiple Lambda log groups in parallel
# Finds the stage's Lambda log groups by name prefix

set -e

# Determine the stage (defaults to current username)
STAGE="${CDK_STAGE:-${USER:-dev}}"
AWS_REGION="${AWS_REGION:-eu-north-1}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

print_header() {
  echo -e "${GREEN}=== Trickle Logs (Stage: ${STAGE}) ===${NC}"
  echo "Region: $AWS_REGION"
}

# Discover the stage's Lambda log groups by name: every function is named
# trickle-<stage>-<suffix>, and the suffix says what it is (send-*, config-*,
# email-events-*, ses-events-processor, ...). This used to read a JSON stack
# output, but CloudFormation caps output values at 1024 characters, which the
# list outgrew. Output: [{"name": "<suffix>", "logGroup": "<full name>"}].
get_log_groups() {
  local prefix="/aws/lambda/trickle-${STAGE}-"
  local log_groups_json
  log_groups_json=$(aws logs describe-log-groups \
    --log-group-name-prefix "$prefix" \
    --query 'logGroups[].logGroupName' \
    --output json \
    --region "$AWS_REGION" 2>/dev/null || echo "[]")

  # CDK's own custom-resource functions share the prefix but are CamelCase.
  log_groups_json=$(jq --arg p "$prefix" \
    '[.[] | {name: ltrimstr($p), logGroup: .} | select(.name | test("^[a-z0-9-]+$"))]' \
    <<< "$log_groups_json")

  if [ "$(jq length <<< "$log_groups_json")" -eq 0 ]; then
    echo -e "${RED}Error: No log groups under ${prefix} in ${AWS_REGION}${NC}" >&2
    echo "Is the stack deployed in this region? Set AWS_REGION (production: eu-north-1)." >&2
    exit 1
  fi

  echo "$log_groups_json"
}

# Function to tail a log group
tail_log_group() {
  local log_group=$1
  local display_name=$2

  echo -e "${GREEN}✓ Tailing $display_name${NC}"
  aws logs tail "$log_group" --follow --region "$AWS_REGION" 2>&1 &
}


case "${1:-all}" in
  debug)
    print_header
    echo -e "\n${YELLOW}Debug: log groups discovered under /aws/lambda/trickle-${STAGE}-${NC}\n"
    get_log_groups | jq .
    ;;

  all)
    print_header
    echo -e "\n${YELLOW}Fetching log groups...${NC}\n"

    LOG_GROUPS=$(get_log_groups)

    # Extract all log groups and tail them (avoid subshell with while)
    while IFS= read -r log_group; do
      tail_log_group "$log_group" "Lambda Function"
    done < <(jq -r '.[] | .logGroup' <<< "$LOG_GROUPS")

    echo -e "\n${GREEN}All log tails started. Press Ctrl+C to stop.${NC}"
    wait
    ;;

  api)
    print_header
    echo -e "\n${YELLOW}Fetching API log groups...${NC}\n"

    LOG_GROUPS=$(get_log_groups)

    while IFS= read -r log_group; do
      tail_log_group "$log_group" "API Function"
    done < <(jq -r '.[] | select((.name | startswith("send-") | not) and .name != "ses-events-processor") | .logGroup' <<< "$LOG_GROUPS")

    echo -e "\n${GREEN}API log tails started. Press Ctrl+C to stop.${NC}"
    wait
    ;;

  worker)
    print_header
    echo -e "\n${YELLOW}Fetching worker log group...${NC}\n"

    LOG_GROUPS=$(get_log_groups)
    while IFS=$'\t' read -r NAME LOG_GROUP; do
      tail_log_group "$LOG_GROUP" "$NAME"
    done < <(jq -r '.[] | select(.name | startswith("send-")) | [.name, .logGroup] | @tsv' <<< "$LOG_GROUPS")

    echo -e "\n${GREEN}Worker log tail started. Press Ctrl+C to stop.${NC}"
    wait
    ;;

  processor)
    print_header
    echo -e "\n${YELLOW}Fetching processor log group...${NC}\n"

    LOG_GROUPS=$(get_log_groups)
    LOG_GROUP=$(jq -r '.[] | select(.name == "ses-events-processor") | .logGroup' <<< "$LOG_GROUPS")
    [ -n "$LOG_GROUP" ] && tail_log_group "$LOG_GROUP" "SES Events Processor"

    echo -e "\n${GREEN}Processor log tail started. Press Ctrl+C to stop.${NC}"
    wait
    ;;

  config)
    print_header
    echo -e "\n${YELLOW}Fetching config log groups...${NC}\n"

    LOG_GROUPS=$(get_log_groups)

    while IFS= read -r log_group; do
      tail_log_group "$log_group" "Config Function"
    done < <(jq -r '.[] | select(.name | startswith("config-")) | .logGroup' <<< "$LOG_GROUPS")

    echo -e "\n${GREEN}Config log tails started. Press Ctrl+C to stop.${NC}"
    wait
    ;;

  events)
    print_header
    echo -e "\n${YELLOW}Fetching email events log groups...${NC}\n"

    LOG_GROUPS=$(get_log_groups)

    while IFS= read -r log_group; do
      tail_log_group "$log_group" "Email Events Function"
    done < <(jq -r '.[] | select(.name | startswith("email-events-")) | .logGroup' <<< "$LOG_GROUPS")

    echo -e "\n${GREEN}Email Events log tails started. Press Ctrl+C to stop.${NC}"
    wait
    ;;

  *)
    echo "Usage: ./scripts/logs.sh {all|api|worker|processor|config|events|debug}"
    echo ""
    echo "Options:"
    echo "  all       - Tail all of the stage's Lambda log groups"
    echo "  api       - Tail API-related functions"
    echo "  worker    - Tail the send pipeline (Step Functions task) functions"
    echo "  processor - Tail SES event processor function"
    echo "  config    - Tail config management functions"
    echo "  events    - Tail email events functions"
    echo "  debug     - List the log groups found for the stage"
    echo ""
    echo "Stage: ${STAGE} (set CDK_STAGE to override)"
    echo "Region: ${AWS_REGION} (set AWS_REGION to override)"
    echo ""
    echo "Requirements: aws-cli, jq"
    echo ""
    echo "Troubleshooting:"
    echo "  1. Run: ./scripts/logs.sh debug"
    echo "  2. Verify stack exists: aws cloudformation describe-stacks --stack-name trickle-${STAGE}"
    echo "  3. Ensure backend is deployed: npm run deploy"
    exit 1
    ;;
esac
