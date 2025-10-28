# Deployment Guide

This guide explains how to deploy Trickle with proper credentials management.

## Environment Setup

### 1. Configure `.env` for AWS Region and Profile

Copy the example file:
```bash
cp .env.example .env
```

Edit `.env`:
```bash
AWS_REGION=eu-west-1        # Where to deploy (Ireland)
AWS_PROFILE=default         # Which AWS credentials to use
```

Load the environment:
```bash
source .env
```

Or use `direnv` for automatic loading (see below).

### 2. Set Credentials Before Deploying

Pulumi needs credentials to create the Secrets Manager secret. Pass them as environment variables:

```bash
# For development
AUTH_USERNAME=myuser AUTH_PASSWORD=mypassword npm run deploy

# For production with specific profile and region
AUTH_USERNAME=prod_user AUTH_PASSWORD=secure_password AWS_PROFILE=qed AWS_REGION=eu-west-1 npm run deploy
```

**Important:**
- `AUTH_USERNAME` and `AUTH_PASSWORD` are required
- `AUTH_SECRET` is auto-generated if not provided (64 character hex string)
- Each stage gets its own unique AUTH_SECRET

## Full Deployment Example

```bash
# Set up environment
source .env

# Deploy development
AUTH_USERNAME=dev_user AUTH_PASSWORD=dev_password npm run dev

# Deploy production
AUTH_USERNAME=prod_user AUTH_PASSWORD=prod_password \
  AWS_PROFILE=qed \
  AWS_REGION=eu-west-1 \
  npm run deploy -- --stage production
```

## Using direnv for Automatic Loading

Install direnv:
```bash
# macOS
brew install direnv

# Add to ~/.zshrc or ~/.bashrc
eval "$(direnv hook zsh)"  # or "bash" for bash
```

Then set up credentials:
```bash
# Copy and edit the environment file
cp .env.example .envrc

# Edit .envrc to add credentials
nano .envrc
```

Add these to `.envrc`:
```bash
export AWS_REGION=eu-west-1
export AWS_PROFILE=default
export AUTH_USERNAME=myuser
export AUTH_PASSWORD=mypassword
# AUTH_SECRET is auto-generated, leave unset
```

Then allow direnv:
```bash
direnv allow
```

Now credentials load automatically when you `cd` into the directory!

## Environment Variables

### Required for Deployment
- `AUTH_USERNAME` - Login username
- `AUTH_PASSWORD` - Login password

### Optional
- `AUTH_SECRET` - Encryption secret (auto-generated if not provided, minimum 32 characters)
- `AWS_REGION` - AWS region (default: eu-west-1)
- `AWS_PROFILE` - AWS credentials profile (default: default)
- `SST_STAGE` - Deployment stage (default: dev)

## Troubleshooting

### "AUTH_USERNAME and AUTH_PASSWORD environment variables are required"

You forgot to set credentials before deploying:
```bash
AUTH_USERNAME=user AUTH_PASSWORD=pass npm run deploy
```

### Secret already exists error

If you get "ResourceExistsException: The operation failed because the secret already exists", you're trying to deploy with the same stage name. Either:
- Use a different stage name: `npm run deploy -- --stage new-stage`
- Or delete the existing secret in AWS and redeploy

### Wrong region

The secret was created in the wrong region. Check your `AWS_REGION` setting:
```bash
echo $AWS_REGION
```

Fix it and redeploy:
```bash
AWS_REGION=eu-west-1 npm run deploy
```

## Stages

Each stage is isolated with its own secrets:

```bash
# Development (default)
npm run dev

# Staging
npm run deploy -- --stage staging

# Production
npm run deploy -- --stage production
```

Each stage creates its own Secrets Manager secret: `trickle/{stage}/secrets`

## Security Notes

- Credentials are encrypted in AWS Secrets Manager
- Each stage has isolated credentials
- Tokens from one stage cannot be used in another
- Auth tokens expire after 24 hours
- Consider enabling secret rotation in AWS for production
