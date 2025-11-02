# GitHub Configuration

This directory contains GitHub-specific configurations for the Trickle project.

## Contents

### Workflows (`.github/workflows/`)

#### `pr-validate.yml`
- **Trigger**: Pull requests to `main` or `cdk` branches
- **Purpose**: Validate code quality on every PR
- **Checks**:
  - TypeScript type checking (`npm run typecheck`)
  - Build compilation (`npm run build`)
  - Code formatting (`npm run format:check`)
  - CDK synthesis validation (`npm run synth`)
  - CDK diff preview (informational)
- **Duration**: ~2-3 minutes
- **Secrets Required**: None

#### `deploy.yml`
- **Trigger**: Pushes to `main` branch
- **Purpose**: Automatically deploy to production AWS
- **Steps**:
  1. Run all PR validation checks
  2. Assume AWS IAM role via OIDC
  3. Build all workspaces
  4. Deploy with CDK
- **Duration**: ~5-10 minutes
- **Secrets Required**:
  - `AWS_ROLE_TO_ASSUME` (AWS IAM role ARN)
  - `AWS_REGION`
  - `AUTH_USERNAME`
  - `AUTH_PASSWORD`
  - `AUTH_SECRET`

### Configuration Files

#### `dependabot.yml`
- **Purpose**: Automated dependency updates
- **Frequency**: Weekly (Monday)
- **Scopes**:
  - npm dependencies
  - GitHub Actions versions
- **Auto-merge**: Disabled (requires review)

#### `CICD_SETUP.md`
- **Purpose**: Step-by-step setup guide for CI/CD
- **Includes**:
  - AWS IAM role creation (OIDC and Access Key options)
  - GitHub Secrets configuration
  - Testing the pipeline
  - Troubleshooting guide

## Quick Start

1. **For Development**: No setup needed! PR validation runs automatically.

2. **For Production Deployment**: Follow [`CICD_SETUP.md`](./CICD_SETUP.md)

3. **Testing Changes**:
   - Create a feature branch
   - Push and open a PR
   - Watch the validation workflow run
   - Merge when all checks pass

## Workflow Status

You can view workflow status and logs at:
- GitHub: Repository → Actions
- Individual workflows are linked in PR checks

## Adding New Workflows

To add new workflows:

1. Create a new `.yml` file in `.github/workflows/`
2. Define trigger (on: push/pull_request/schedule)
3. Add jobs with steps
4. Use `CICD_SETUP.md` format for new secrets

### Example Template

```yaml
name: New Workflow

on:
  push:
    branches: [main]

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20.x
          cache: npm
      - run: npm ci
      - run: npm run your-script
```

## Security Best Practices

- ✅ Use OIDC for AWS credentials (no long-lived keys)
- ✅ Use GitHub environment protection rules for production
- ✅ Require PR reviews before merge to main
- ✅ Keep Actions and dependencies updated via Dependabot
- ✅ Rotate credentials every 90 days
- ✅ Use separate AWS roles per environment
- ✅ Enable branch protection rules on main

## Troubleshooting

### Workflows not running
- Check if branch is protected
- Verify workflow syntax (`.yml` format)
- Check repository settings → Actions → General

### Build failures
- Check workflow logs (click on failed check)
- Common issues:
  - Missing dependencies
  - Environment variable not set
  - AWS credentials expired
  - Node version mismatch

### Deployment failures
- Check CloudFormation stack events in AWS Console
- Verify IAM permissions
- Check AWS resource limits
- Review GitHub Actions logs for specific error

## Monitoring

Monitor CI/CD health at:
- **GitHub**: Actions tab
- **AWS**: CloudFormation stacks
- **Slack**: Set up GitHub notifications (optional)

## References

- [GitHub Actions Documentation](https://docs.github.com/en/actions)
- [AWS IAM OIDC Provider](https://docs.github.com/en/actions/deployment/security-hardening-your-deployments/about-security-hardening-with-openid-connect)
- [AWS CDK Documentation](https://docs.aws.amazon.com/cdk/)
