# Trickle CDK Infrastructure

AWS CDK infrastructure for the Trickle email service.

## Quick Start

The project uses NPM workspaces. Deploy from the project root:

```bash
# From project root
export AUTH_USERNAME=admin
export AUTH_PASSWORD=your-password
export AWS_REGION=eu-west-1

# Deploy (automatically builds frontend + CDK)
npm run deploy
```

See the main [DEPLOYMENT.md](../DEPLOYMENT.md) for complete documentation.

## Stage Configuration

The stack automatically uses your username as the stage name. Override with `CDK_STAGE`:

```bash
CDK_STAGE=alice npm run deploy     # alice.trickle.qed.fi
CDK_STAGE=production npm run deploy # trickle.qed.fi
```

## Required Environment Variables

- `AUTH_USERNAME` - Admin username
- `AUTH_PASSWORD` - Admin password
- `AWS_REGION` - AWS region (default: us-east-1)

Optional:
- `CDK_STAGE` - Stage name (default: current username)
- `AUTH_SECRET` - JWT secret (default: auto-generated)

## Project Structure

```
cdk/
├── bin/
│   └── trickle.ts          # CDK app entry point
├── lib/
│   └── trickle-stack.ts    # Main infrastructure stack
├── cdk.json                # CDK configuration
├── tsconfig.json           # TypeScript configuration
└── package.json            # Dependencies and scripts
```

## Stack Resources

- **Lambda Functions**: Email worker + 8 API handlers
- **DynamoDB Tables**: Jobs (with GSI) and Config
- **S3 Buckets**: Attachments and frontend hosting
- **API Gateway v2**: REST API with custom domain
- **CloudFront**: Frontend distribution
- **Route53**: DNS records
- **Secrets Manager**: Auth credentials
- **IAM Roles**: EventBridge Scheduler role

## Useful Commands

- `npm run build` - Compile TypeScript
- `npm run watch` - Watch mode
- `npm run diff` - Compare deployed vs local
- `npm run synth` - Generate CloudFormation template
- `npm run deploy` - Deploy to AWS
- `npm run destroy` - Delete stack

## Documentation

See [DEPLOYMENT.md](../DEPLOYMENT.md) for complete documentation.
