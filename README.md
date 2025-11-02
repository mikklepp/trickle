# Trickle - Email Distribution Application

Cloud-native web application for sending bulk emails individually through AWS SES with rate limiting, attachment support, and email event tracking.

## Quick Start

Deploy your own instance in 3 steps:

```bash
# 1. Install dependencies
npm install

# 2. Set credentials
export AUTH_USERNAME=admin
export AUTH_PASSWORD=your-secure-password

# 3. Deploy
npm run deploy
```

Your app will be available at `https://{username}.trickle.qed.fi`

See [CDK_MIGRATION.md](./CDK_MIGRATION.md) for detailed deployment instructions.

## Project Structure

This is an **NPM workspaces monorepo** with three main workspaces:

```
trickle/
├── package.json                # Root workspace config & orchestration scripts
├── package-lock.json           # Single lock file for all workspaces
├── backend/                    # Lambda function code
│   ├── functions/
│   │   ├── api/               # 8 API Lambda handlers
│   │   └── worker/            # Email worker Lambda
│   └── package.json           # Backend dependencies
├── cdk/                        # AWS CDK infrastructure
│   ├── bin/                   # CDK app entry point
│   ├── lib/                   # Infrastructure code
│   └── package.json           # CDK dependencies
├── frontend/                   # React web application
│   ├── src/                   # TypeScript/React components
│   └── package.json           # Frontend dependencies
└── scripts/                    # Utility scripts
    └── logs.sh                # CloudWatch logs streaming
```

## Prerequisites

- **Node.js 20+** and npm
- **AWS CLI** configured with credentials
- **AWS Account** with:
  - SES access (at least sandbox or verified domain)
  - Ability to create Lambda, DynamoDB, API Gateway, CloudFront, etc.
  - Route53 hosted zone for custom domain (optional, required for DNS)

## Core Features

- ✅ **Bulk Email Distribution** - Send to multiple recipients with rate limiting
- ✅ **Rich Email Content** - HTML support with attachments
- ✅ **Rate Limiting** - Configurable emails/minute to respect SES limits
- ✅ **Event Tracking** - Track bounces, complaints, opens, clicks from SES
- ✅ **Job Management** - Monitor send progress, view failures, retry logic
- ✅ **Web Dashboard** - Real-time status, email logs, configuration
- ✅ **Authentication** - Simple JWT-based auth with username/password

## Documentation

| Document | Purpose |
|----------|---------|
| [CDK_MIGRATION.md](./CDK_MIGRATION.md) | **→ START HERE** - Comprehensive deployment & infrastructure guide |
| [SPECIFICATION.md](./SPECIFICATION.md) | Architecture, features, API endpoints, data models |
| [.github/CICD_SETUP.md](./.github/CICD_SETUP.md) | GitHub Actions CI/CD setup with AWS OIDC |
| [cdk/README.md](./cdk/README.md) | CDK-specific commands and structure |

## Common Commands

All commands run from the project root:

```bash
# Development
npm run dev                  # Watch mode for backend + frontend + CDK

# Building & Validation
npm run typecheck           # TypeScript validation
npm run build               # Build all workspaces
npm run format              # Auto-format code

# Deployment
npm run deploy              # Build + deploy to AWS
npm run diff                # Show CloudFormation diff
npm run destroy             # Delete AWS stack (careful!)

# Monitoring
npm run logs                # Stream CloudWatch logs from all Lambdas
npm run logs:api            # Stream API Lambda logs only
```

## Architecture Overview

**Frontend** (React)
- Single-page app for composing and monitoring emails
- Real-time job status tracking
- Email event logs with filtering

**Backend** (Node.js Lambda)
- Email API: `/auth`, `/senders`, `/email/send`, `/email/status`, `/email/events`, `/config`
- Email Worker: Processes jobs from EventBridge Scheduler
- SES integration: Sends emails via AWS SES v2 API

**Database** (DynamoDB)
- `Jobs` table: Send jobs and status tracking
- `Config` table: Per-user rate limit configuration
- Global Secondary Index for querying by timestamp

**Infrastructure** (AWS CDK)
- API Gateway v2 (HTTP API) with custom domain
- CloudFront + S3 for frontend hosting
- EventBridge Scheduler for rate-limited email delivery
- Route53 for DNS management
- ACM certificates for HTTPS

## Deployment Stages

Each developer can deploy isolated stages:

```bash
# Personal development
npm run deploy              # Uses your username as stage

# Specific stage
CDK_STAGE=alice npm run deploy
CDK_STAGE=staging npm run deploy
CDK_STAGE=production npm run deploy
```

Each stage has:
- Separate Lambda functions
- Separate DynamoDB tables
- Separate S3 buckets
- Separate custom domain (e.g., `staging.trickle.qed.fi`)

## Next Steps

1. **First time?** Read [CDK_MIGRATION.md](./CDK_MIGRATION.md)
2. **Want to deploy?** Set `AUTH_USERNAME` and `AUTH_PASSWORD` env vars, then run `npm run deploy`
3. **Want to contribute?** Run `npm run dev` for watch mode
4. **Need CI/CD?** Follow [.github/CICD_SETUP.md](./.github/CICD_SETUP.md)

## Support & Issues

- **Infrastructure questions?** Check [CDK_MIGRATION.md](./CDK_MIGRATION.md) troubleshooting section
- **Feature questions?** See [SPECIFICATION.md](./SPECIFICATION.md)
- **CI/CD issues?** See [.github/CICD_SETUP.md](./.github/CICD_SETUP.md)

## License

See LICENSE file (if applicable)
