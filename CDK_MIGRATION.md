# CDK Migration Guide

This document describes the migration from SST to AWS CDK for the Trickle email service.

## Overview

The infrastructure has been migrated from SST v3 (Pulumi-based) to AWS CDK v2. This provides:

- **Stability**: CDK is AWS's official IaC tool with mature, well-tested constructs
- **Better deployment reliability**: Uses CloudFormation natively, no separate state management
- **Wider community support**: Larger ecosystem, more examples, better documentation
- **Full AWS integration**: Direct access to all CloudFormation features

## Prerequisites

- Node.js 20+
- AWS CLI configured with credentials (`aws configure`)
- AWS account with appropriate permissions
- Domain hosted in Route53 (qed.fi in this case)

**Important**: Ensure your AWS credentials are configured properly:
```bash
aws configure
# or
export AWS_PROFILE=your-profile
```

The CDK requires account and region information from your AWS configuration to synthesize the stack.

## Project Structure

The project is organized as an NPM workspaces monorepo:

```
trickle/
├── package.json           # Root config with workspaces & orchestration scripts
├── package-lock.json      # Single lock file for all workspaces
├── node_modules/          # Hoisted dependencies
├── backend/
│   ├── package.json      # Backend Lambda dependencies
│   ├── tsconfig.json     # Backend TypeScript config
│   └── functions/        # Lambda function code
├── cdk/
│   ├── package.json      # CDK dependencies
│   ├── tsconfig.json     # CDK TypeScript config
│   └── lib/              # Infrastructure code
└── frontend/
    ├── package.json      # Frontend dependencies
    └── src/              # React application
```

**NPM Workspaces Benefits:**
- Single `npm install` at root installs all workspace dependencies
- Shared dependencies are hoisted to root (saves disk space)
- Single `package-lock.json` for consistent versions
- Clean orchestration with `--workspaces` flag

## Initial Setup

### 1. Install all dependencies

```bash
# From project root - installs all workspaces
npm install
```

That's it! NPM workspaces automatically installs dependencies for backend, cdk, and frontend.

### 2. Bootstrap CDK (one-time per account/region)

```bash
# Set your AWS region
export AWS_REGION=us-east-1

# Bootstrap CDK in your account
npx cdk bootstrap aws://ACCOUNT-ID/$AWS_REGION
```

Replace `ACCOUNT-ID` with your AWS account ID (can get from `aws sts get-caller-identity`).

### 3. Build the CDK project

```bash
npm run build
```

## Root-Level Scripts

The root `package.json` uses NPM workspaces for clean orchestration:

| Script | Description |
|--------|-------------|
| `npm install` | Install all workspace dependencies (backend + CDK + frontend) |
| `npm run typecheck` | Run TypeScript checks on all workspaces |
| `npm run build` | Build all workspaces (frontend + CDK in parallel) |
| `npm run deploy` | Build everything, then deploy via CDK |
| `npm run diff` | Show deployment diff |
| `npm run synth` | Synthesize CloudFormation template |
| `npm run destroy` | Destroy CDK stack |
| `npm run format` | Format all code with Prettier |
| `npm run format:check` | Check code formatting |

All scripts use `--workspaces` to run across all workspaces consistently.

## Deployment

### Environment Variables

The stack requires the following environment variables:

| Variable | Description | Required | Default |
|----------|-------------|----------|---------|
| `CDK_STAGE` | Deployment stage/environment | No | Current username |
| `AWS_REGION` | AWS region to deploy to | No | us-east-1 |
| `AUTH_USERNAME` | Admin username for login | Yes | - |
| `AUTH_PASSWORD` | Admin password for login | Yes | - |
| `AUTH_SECRET` | JWT signing secret | No | Auto-generated |

### Deploy a Personal Stage

Each developer can deploy their own isolated stage:

```bash
# Set credentials (from project root)
export AUTH_USERNAME=admin
export AUTH_PASSWORD=your-secure-password
export AWS_REGION=eu-west-1

# Deploy (automatically builds + deploys, uses your username as stage)
npm run deploy

# Or specify a custom stage
CDK_STAGE=mikko npm run deploy

# Preview changes before deploying
npm run diff
```

This creates:
- Stack: `trickle-mikko`
- Frontend: `https://mikko.trickle.qed.fi`
- API: `https://api.mikko.trickle.qed.fi`
- DynamoDB tables: `trickle-jobs-mikko`, `trickle-config-mikko`
- S3 buckets: `trickle-attachments-mikko-ACCOUNT`, `trickle-frontend-mikko-ACCOUNT`

### Deploy to Production

```bash
export AUTH_USERNAME=admin
export AUTH_PASSWORD=production-secure-password
export AWS_REGION=eu-west-1

CDK_STAGE=production npm run deploy
```

This creates:
- Stack: `trickle-production`
- Frontend: `https://trickle.qed.fi`
- API: `https://api.trickle.qed.fi`

## Frontend Deployment

The CDK stack automatically deploys the frontend. When you run `npm run deploy` from the project root, it:

1. Builds the frontend (`npm run build --prefix frontend`)
2. Builds the CDK (`npm run build --prefix cdk`)
3. Deploys to AWS via CDK

The frontend build is copied to S3 and distributed via CloudFront automatically. No manual steps needed!

## Common Commands

All commands run from project root:

```bash
# Check types across all projects
npm run typecheck

# Build everything (frontend + CDK)
npm run build

# Show deployment diff
npm run diff

# Preview CloudFormation template
npm run synth

# Deploy (auto-builds first)
npm run deploy

# Destroy stack (careful!)
npm run destroy

# Format code
npm run format
```

## Stage Management

### Multiple Parallel Stages

You can have multiple stages running simultaneously:

```bash
# Developer 1
CDK_STAGE=alice AWS_REGION=eu-west-1 npm run deploy

# Developer 2
CDK_STAGE=bob AWS_REGION=us-east-1 npm run deploy

# Staging
CDK_STAGE=staging npm run deploy

# Production
CDK_STAGE=production npm run deploy
```

Each stage is completely isolated with its own:
- Lambda functions
- DynamoDB tables
- S3 buckets
- API Gateway
- CloudFront distribution
- DNS records

### Switching Between Stages

The stack name includes the stage, so CDK knows which one to update:

```bash
# Update alice's stage
CDK_STAGE=alice npm run deploy

# Update bob's stage
CDK_STAGE=bob npm run deploy
```

## Resource Naming

Resources follow these naming conventions:

| Resource Type | Format | Example |
|---------------|--------|---------|
| Stack | `trickle-{stage}` | `trickle-mikko` |
| Lambda | `trickle-{function}-{stage}` | `trickle-email-worker-mikko` |
| DynamoDB | `trickle-{table}-{stage}` | `trickle-jobs-mikko` |
| S3 Bucket | `trickle-{purpose}-{stage}-{account}` | `trickle-attachments-mikko-123456789` |
| Secrets | `trickle-{stage}` | `trickle-mikko` |
| IAM Role | `trickle-{purpose}-{stage}` | `trickle-scheduler-mikko` |

## Differences from SST

### Code Changes

Lambda functions were updated to use environment variables instead of SST's `Resource` pattern:

**Before (SST):**
```typescript
import { Resource } from "sst";

TableName: Resource.JobsTable.name
```

**After (CDK):**
```typescript
TableName: process.env.JOBS_TABLE_NAME!
```

### Deployment Workflow

**SST:**
```bash
AUTH_USERNAME=user AUTH_PASSWORD=pass npm run deploy
```

**CDK:**
```bash
cd cdk
export AUTH_USERNAME=user
export AUTH_PASSWORD=pass
npm run deploy
```

### Live Development

SST's `sst dev` with live Lambda reloading is not available in CDK. For local development:

1. Deploy to your personal stage
2. Make changes
3. Redeploy: `npm run deploy`

Alternatively, use SAM local: `sam local start-api` (requires additional setup).

### Resource References

**SST:** Automatic resource linking with `Resource.X.name`

**CDK:** Explicit environment variables passed to Lambda functions in the stack definition

### State Management

**SST:** Uses Pulumi state (stored in AWS)

**CDK:** Uses CloudFormation stacks (native AWS)

## Architecture

### Infrastructure Stack (`cdk/lib/trickle-stack.ts`)

The single `TrickleStack` contains all resources:

1. **Secrets Manager** - Authentication credentials
2. **S3 Buckets** - Attachments (with 7-day lifecycle) and frontend hosting
3. **DynamoDB Tables** - Jobs and Config with GSI
4. **SQS Queue** - Dead letter queue for failed emails
5. **Lambda Functions**:
   - Email Worker (invoked by EventBridge Scheduler)
   - 8 API handlers (auth, senders, email CRUD, config, quota)
6. **IAM Roles** - EventBridge Scheduler role
7. **API Gateway v2** - HTTP API with custom domain
8. **CloudFront** - Frontend distribution with custom domain
9. **Route53** - A records for custom domains
10. **ACM Certificates** - SSL for API and frontend

### Environment-Specific Configuration

The stack adapts based on stage:

**Production (`stage === 'production'`)**:
- Domains: `trickle.qed.fi`, `api.trickle.qed.fi`
- Removal policy: RETAIN (data persists after stack deletion)
- Auto-delete objects: false

**Non-Production**:
- Domains: `{stage}.trickle.qed.fi`, `api.{stage}.trickle.qed.fi`
- Removal policy: DESTROY (clean deletion)
- Auto-delete objects: true

## Troubleshooting

### Certificate Validation Timeout

If deployment hangs on certificate creation:

1. Check Route53 has the hosted zone for `qed.fi`
2. Ensure DNS is properly configured
3. Wait up to 30 minutes for DNS propagation

### Stack Already Exists

If you get a "stack already exists" error:

```bash
# List existing stacks
aws cloudformation list-stacks --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE

# If needed, delete old stack
CDK_STAGE=your-stage npm run destroy
```

### Lambda Deployment Fails

Ensure all Lambda dependencies are installed:

```bash
cd backend/functions/api
npm install

cd ../worker
npm install
```

### Frontend Not Updating

CloudFront caches aggressively. After deployment:

1. Wait 5-10 minutes
2. Hard refresh browser (Cmd+Shift+R / Ctrl+F5)
3. Or invalidate CloudFront cache:

```bash
aws cloudfront create-invalidation \
  --distribution-id YOUR_DIST_ID \
  --paths "/*"
```

## Migration from SST

If you're migrating from an existing SST deployment:

### 1. Note your SST resource names

```bash
# Get SST outputs
npx sst deploy --dry-run
```

### 2. Export data if needed

If you have important data in SST DynamoDB tables, export it:

```bash
# Example: Export jobs table
aws dynamodb scan \
  --table-name trickle-jobs-yourstage \
  --output json > jobs-backup.json
```

### 3. Destroy SST stack

```bash
npx sst remove
```

### 4. Deploy CDK stack

```bash
cd cdk
npm run deploy
```

### 5. Import data if needed

Use AWS CLI or DynamoDB console to import backed-up data.

## Cost Considerations

CDK vs SST costs are nearly identical since they deploy the same AWS resources:

- **Lambda**: Pay per invocation + duration
- **DynamoDB**: Pay-per-request billing
- **S3**: Storage + requests
- **CloudFront**: Data transfer + requests
- **API Gateway**: Per request

**CDK-specific costs:**
- None (CDK is just a deployment tool)

**SST-specific costs:**
- None for infrastructure, but state storage uses AWS resources

## Next Steps

1. Set up CI/CD pipeline for automated deployments
2. Configure CloudWatch alarms for monitoring
3. Implement automated backups for production data
4. Add integration tests
5. Set up staging environment

## Support

For issues with:
- **CDK**: https://github.com/aws/aws-cdk/issues
- **Trickle app**: [Your issue tracker]
- **AWS resources**: AWS Support Console
