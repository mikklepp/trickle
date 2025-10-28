#!/bin/bash

# This script sets up AWS Secrets Manager secrets for the Trickle application
# Each stage gets its own secret containing AuthUsername, AuthPassword, and AuthSecret

set -e

echo "Setting up Trickle Secrets Manager secrets..."
echo ""

# Get stage (default to dev)
STAGE="${1:-dev}"

# Get AWS region (default to eu-west-1)
AWS_REGION="${AWS_REGION:-eu-west-1}"
REGION_FLAG="--region $AWS_REGION"

# Validate AWS_PROFILE is set for AWS CLI
if [ -z "$AWS_PROFILE" ]; then
  echo "Warning: AWS_PROFILE not set. Using default AWS profile."
  echo "Consider setting: export AWS_PROFILE=qed"
  PROFILE_FLAG=""
else
  PROFILE_FLAG="--profile $AWS_PROFILE"
  echo "Using AWS profile: $AWS_PROFILE"
fi

echo "Using AWS region: $AWS_REGION"
echo "Stage: $STAGE"
echo ""

# Read credentials from .env if it exists
if [ -f .env ]; then
  source .env
  echo "Found .env file"
else
  echo "No .env file found. Please enter credentials:"
  read -p "Enter AUTH_USERNAME: " AUTH_USERNAME
  read -sp "Enter AUTH_PASSWORD: " AUTH_PASSWORD
  echo ""
fi

# Validate inputs
if [ -z "$AUTH_USERNAME" ]; then
  echo "Error: AUTH_USERNAME not provided"
  exit 1
fi

if [ -z "$AUTH_PASSWORD" ]; then
  echo "Error: AUTH_PASSWORD not provided"
  exit 1
fi

# Always generate a new AUTH_SECRET for each stage
echo ""
echo "Generating unique AUTH_SECRET for stage: $STAGE"
AUTH_SECRET=$(openssl rand -hex 32)
echo "Generated: ${AUTH_SECRET:0:16}... (truncated for display)"

# Create the secret JSON
SECRET_JSON=$(cat <<EOF
{
  "AuthUsername": "$AUTH_USERNAME",
  "AuthPassword": "$AUTH_PASSWORD",
  "AuthSecret": "$AUTH_SECRET"
}
EOF
)

# Confirm before setting
echo ""
echo "Will create/update secret in AWS Secrets Manager:"
echo "  Secret Name: trickle/$STAGE/secrets"
echo "  AuthUsername: $AUTH_USERNAME"
echo "  AuthPassword: ********"
echo "  AuthSecret:   ${AUTH_SECRET:0:16}... (auto-generated)"
echo ""
read -p "Continue? (y/N) " -n 1 -r
echo ""

if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "Aborted."
  exit 1
fi

# Create or update the secret in AWS Secrets Manager
echo ""
echo "Creating/updating secret in AWS Secrets Manager..."

SECRET_NAME="trickle/$STAGE/secrets"

# Check if secret exists
if aws secretsmanager describe-secret --secret-id "$SECRET_NAME" $REGION_FLAG $PROFILE_FLAG &>/dev/null; then
  # Update existing secret
  echo "Updating existing secret: $SECRET_NAME"
  aws secretsmanager update-secret \
    --secret-id "$SECRET_NAME" \
    --secret-string "$SECRET_JSON" \
    $REGION_FLAG $PROFILE_FLAG > /dev/null
else
  # Create new secret
  echo "Creating new secret: $SECRET_NAME"
  aws secretsmanager create-secret \
    --name "$SECRET_NAME" \
    --description "Trickle credentials for stage: $STAGE" \
    --secret-string "$SECRET_JSON" \
    $REGION_FLAG $PROFILE_FLAG > /dev/null
fi

echo ""
echo "✅ Secrets configured successfully in AWS Secrets Manager!"
echo ""
echo "Secret details:"
echo "  Name: $SECRET_NAME"
echo "  Region: $AWS_REGION"
echo ""
echo "To set secrets for other stages, run:"
echo "  ./setup-secrets.sh dev"
echo "  ./setup-secrets.sh staging"
echo "  ./setup-secrets.sh production"
echo ""
echo "To use a different region, run:"
echo "  AWS_REGION=us-east-1 ./setup-secrets.sh dev"
echo "  AWS_REGION=eu-central-1 AWS_PROFILE=qed ./setup-secrets.sh production"
echo ""
echo "Security notes:"
echo "  - Each stage has its own unique AUTH_SECRET"
echo "  - Tokens from one stage will NOT work in another stage"
echo "  - Secrets are encrypted at rest in AWS Secrets Manager"
echo "  - Consider enabling secret rotation in production"
echo "  - Region defaults to eu-west-1 if AWS_REGION is not set"
echo ""
