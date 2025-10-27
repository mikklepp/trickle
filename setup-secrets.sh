#!/bin/bash

# This script sets up SST secrets for the Trickle application
# Each stage gets its own unique AUTH_SECRET for better security isolation

set -e

echo "Setting up SST secrets..."
echo ""

# Get stage (default to current/dev)
STAGE="${1:-}"
if [ -z "$STAGE" ]; then
  echo "Stage not specified, using current stage"
  STAGE_FLAG=""
  STAGE_NAME="current"
else
  STAGE_FLAG="--stage $STAGE"
  STAGE_NAME="$STAGE"
fi

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

# Always generate a new AUTH_SECRET for each stage
echo ""
echo "Generating unique AUTH_SECRET for stage: $STAGE_NAME"
AUTH_SECRET=$(openssl rand -hex 32)
echo "Generated: ${AUTH_SECRET:0:16}... (truncated for display)"

# Confirm before setting
echo ""
echo "Will set secrets for stage: $STAGE_NAME"
echo "  AuthUsername: $AUTH_USERNAME"
echo "  AuthPassword: ********"
echo "  AuthSecret:   ${AUTH_SECRET:0:16}... (auto-generated, unique per stage)"
echo ""
read -p "Continue? (y/N) " -n 1 -r
echo ""

if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "Aborted."
  exit 1
fi

# Set secrets
echo ""
echo "Setting secrets..."
if [ -z "$STAGE" ]; then
  npx sst secret set AuthUsername "$AUTH_USERNAME"
  npx sst secret set AuthPassword "$AUTH_PASSWORD"
  npx sst secret set AuthSecret "$AUTH_SECRET"
else
  npx sst secret set AuthUsername "$AUTH_USERNAME" --stage "$STAGE"
  npx sst secret set AuthPassword "$AUTH_PASSWORD" --stage "$STAGE"
  npx sst secret set AuthSecret "$AUTH_SECRET" --stage "$STAGE"
fi

echo ""
echo "✅ Secrets configured successfully for stage: $STAGE_NAME"
echo ""
echo "To set secrets for other stages, run:"
echo "  ./setup-secrets.sh production"
echo "  ./setup-secrets.sh dev"
echo ""
echo "Security note: Each stage has its own unique AUTH_SECRET."
echo "Tokens from one stage will NOT work in another stage."
