# Secrets Configuration

This application uses SST Secrets to securely manage sensitive credentials.

## Required Secrets

- **AuthUsername** - Username for application login
- **AuthPassword** - Password for application login
- **AuthSecret** - Secret key for token signing (64 characters recommended)

## Setup Instructions

### Option 1: Using the setup script (Recommended)

The script automatically generates a unique `AUTH_SECRET` for each stage:

```bash
# For development/current stage
./setup-secrets.sh

# For production stage (generates different AUTH_SECRET)
./setup-secrets.sh production

# For any other stage
./setup-secrets.sh staging
```

**Important:** Each stage gets its own unique `AUTH_SECRET` for security isolation. Tokens from one stage will NOT work in another stage.

### Option 2: Manual setup

Set secrets manually using the SST CLI:

```bash
# For development/current stage
npx sst secret set AuthUsername "your_username"
npx sst secret set AuthPassword "your_password"
npx sst secret set AuthSecret "your_secret_key"

# For production stage
npx sst secret set AuthUsername "your_username" --stage production
npx sst secret set AuthPassword "your_password" --stage production
npx sst secret set AuthSecret "your_secret_key" --stage production
```

### Generating a secure AUTH_SECRET

```bash
openssl rand -hex 32
```

## Listing Secrets

To see which secrets are configured:

```bash
npx sst secret list
npx sst secret list --stage production
```

## Removing Secrets

To remove a secret:

```bash
npx sst secret remove AuthUsername
npx sst secret remove AuthUsername --stage production
```

## How It Works

- Secrets are stored in AWS Systems Manager Parameter Store
- SST automatically injects them into your Lambda functions at runtime
- Access secrets in code via `Resource.SecretName.value`
- Each stage (dev, production, etc.) has its own set of secrets

## Security Best Practices

1. ✅ Never commit secrets to git
2. ✅ **Each stage has its own unique AUTH_SECRET** (handled automatically by setup script)
3. ✅ Use different passwords for production vs development
4. ✅ Rotate secrets regularly
5. ✅ Use strong, randomly generated values for AUTH_SECRET (256 bits / 64 hex chars)
6. ✅ Keep `.env` file local only (already in `.gitignore`)
7. ✅ Tokens from dev stage won't work in production (because AUTH_SECRET differs)

## Deployment

Secrets must be configured **before** deploying to a stage:

```bash
# Set secrets first
./setup-secrets.sh

# Then deploy
npx sst deploy

# For production
npx sst secret set AuthUsername "prod_user" --stage production
npx sst secret set AuthPassword "prod_pass" --stage production
npx sst secret set AuthSecret "$(openssl rand -hex 32)" --stage production
npx sst deploy --stage production
```
