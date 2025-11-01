#!/bin/bash

# CloudWatch Logs helper script for Trickle
# Tails multiple Lambda log groups in parallel
# Reads log group names from CDK Outputs

set -e

# Determine the stage (defaults to current username)
STAGE="${CDK_STAGE:-${USER:-dev}}"
AWS_REGION="${AWS_REGION:-us-east-1}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

print_header() {
  echo -e "${GREEN}=== Trickle Logs (Stage: ${STAGE}) ===${NC}"
  echo "Region: $AWS_REGION"
}

# Fetch log groups from CDK Output
get_log_groups() {
  # Try to get from CloudFormation - use --output json to preserve the JSON string properly
  local log_groups_json=$(aws cloudformation describe-stacks \
    --stack-name "trickle-${STAGE}" \
    --query "Stacks[0].Outputs[?OutputKey=='LogGroupNames'].OutputValue" \
    --output text \
    --region "$AWS_REGION" 2>/dev/null || echo "")

  if [ -z "$log_groups_json" ]; then
    echo -e "${RED}Error: Could not fetch log groups from CloudFormation stack trickle-${STAGE}${NC}"
    echo "Is the stack deployed? Use: npm run deploy"
    exit 1
  fi

  # The output is a JSON string, but we need to ensure it's parseable by jq
  # Try to parse it - if it fails, the error will be caught
  echo "$log_groups_json" | jq . > /dev/null 2>&1 || {
    echo -e "${RED}Error: Invalid JSON in CloudFormation output${NC}"
    echo "Output was: $log_groups_json"
    exit 1
  }

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
    echo -e "\n${YELLOW}Debug: Fetching CloudFormation output...${NC}\n"

    echo "Stack name: trickle-${STAGE}"
    echo "Region: $AWS_REGION"
    echo ""

    cf_output=$(aws cloudformation describe-stacks \
      --stack-name "trickle-${STAGE}" \
      --query "Stacks[0].Outputs" \
      --output json \
      --region "$AWS_REGION" 2>&1)

    echo "CloudFormation output:"
    echo "$cf_output" | jq . || echo "$cf_output"
    echo ""

    echo "Attempting to extract LogGroupNames..."
    log_groups_json=$(aws cloudformation describe-stacks \
      --stack-name "trickle-${STAGE}" \
      --query "Stacks[0].Outputs[?OutputKey=='LogGroupNames'].OutputValue" \
      --output text \
      --region "$AWS_REGION" 2>&1)

    echo "Raw output:"
    echo "$log_groups_json"
    echo ""

    if [ -z "$log_groups_json" ]; then
      echo -e "${RED}Output is empty - stack may not be deployed or output not found${NC}"
      exit 1
    fi

    echo "Parsed as JSON:"
    echo "$log_groups_json" | jq . || echo -e "${RED}Failed to parse as JSON${NC}"
    ;;

  all)
    print_header
    echo -e "\n${YELLOW}Fetching log groups from CloudFormation...${NC}\n"

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
    done < <(jq -r '.[] | select(.name != "Email Worker" and .name != "SES Events Processor") | .logGroup' <<< "$LOG_GROUPS")

    echo -e "\n${GREEN}API log tails started. Press Ctrl+C to stop.${NC}"
    wait
    ;;

  worker)
    print_header
    echo -e "\n${YELLOW}Fetching worker log group...${NC}\n"

    LOG_GROUPS=$(get_log_groups)
    LOG_GROUP=$(jq -r '.[] | select(.name == "Email Worker") | .logGroup' <<< "$LOG_GROUPS")
    [ -n "$LOG_GROUP" ] && tail_log_group "$LOG_GROUP" "Email Worker"

    echo -e "\n${GREEN}Worker log tail started. Press Ctrl+C to stop.${NC}"
    wait
    ;;

  processor)
    print_header
    echo -e "\n${YELLOW}Fetching processor log group...${NC}\n"

    LOG_GROUPS=$(get_log_groups)
    LOG_GROUP=$(jq -r '.[] | select(.name == "SES Events Processor") | .logGroup' <<< "$LOG_GROUPS")
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
    done < <(jq -r '.[] | select(.name == "Config Get" or .name == "Config Update") | .logGroup' <<< "$LOG_GROUPS")

    echo -e "\n${GREEN}Config log tails started. Press Ctrl+C to stop.${NC}"
    wait
    ;;

  events)
    print_header
    echo -e "\n${YELLOW}Fetching email events log groups...${NC}\n"

    LOG_GROUPS=$(get_log_groups)

    while IFS= read -r log_group; do
      tail_log_group "$log_group" "Email Events Function"
    done < <(jq -r '.[] | select(.name == "Email Events Summary" or .name == "Email Events Logs") | .logGroup' <<< "$LOG_GROUPS")

    echo -e "\n${GREEN}Email Events log tails started. Press Ctrl+C to stop.${NC}"
    wait
    ;;

  *)
    echo "Usage: ./scripts/logs.sh {all|api|worker|processor|config|events|debug}"
    echo ""
    echo "Options:"
    echo "  all       - Tail all Lambda log groups (reads from CloudFormation)"
    echo "  api       - Tail API-related functions"
    echo "  worker    - Tail email worker function"
    echo "  processor - Tail SES event processor function"
    echo "  config    - Tail config management functions"
    echo "  events    - Tail email events functions"
    echo "  debug     - Debug CloudFormation output (troubleshoot JSON issues)"
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
