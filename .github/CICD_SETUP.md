# CI/CD Setup Guide

This project uses GitHub Actions for automated validation and deployment.

## Workflows

### 1. PR Validation (`pr-validate.yml`)
Runs on every pull request to ensure code quality:
- ✅ TypeScript type checking
- ✅ Build compilation
- ✅ Code formatting checks
- ✅ CDK synthesis validation
- 📋 CDK diff preview (informational)

**No secrets required** - runs on all PRs automatically.

### 2. Deploy (`deploy.yml`)
Runs on `main` branch to deploy to AWS:
- ✅ All PR validation checks
- 🚀 AWS deployment via CDK
- 📝 Updates environment variables from secrets

**Requires AWS credentials** - see setup below.

## Setup Instructions

### Step 1: Create AWS IAM Role for GitHub

GitHub Actions needs an IAM role to deploy to AWS. You have two options:

#### Option A: Using GitHub OIDC (Recommended - No Long-lived Credentials)

1. In AWS IAM, create an identity provider:
   ```bash
   aws iam create-open-id-connect-provider \
     --url https://token.actions.githubusercontent.com \
     --client-id-list sts.amazonaws.com \
     --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1
   ```

2. Create an IAM role that trusts GitHub:
   ```bash
   # Create trust policy JSON
   cat > trust-policy.json << 'EOF'
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Principal": {
           "Federated": "arn:aws:iam::ACCOUNT_ID:oidc-provider/token.actions.githubusercontent.com"
         },
         "Action": "sts:AssumeRoleWithWebIdentity",
         "Condition": {
           "StringEquals": {
             "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
           },
           "StringLike": {
             "token.actions.githubusercontent.com:sub": "repo:YOUR_ORG/trickle:*"
           }
         }
       }
     ]
   }
   EOF

   # Create the role
   aws iam create-role \
     --role-name github-trickle-deploy \
     --assume-role-policy-document file://trust-policy.json
   ```

3. Attach deployment policies to the role (see Step 2 below)

#### Option B: Using AWS Access Keys (Easier to Set Up, Less Secure)

1. Create an IAM user for GitHub Actions:
   ```bash
   aws iam create-user --user-name github-trickle-deploy
   ```

2. Create access key:
   ```bash
   aws iam create-access-key --user-name github-trickle-deploy
   ```

   Save the `AccessKeyId` and `SecretAccessKey`.

### Step 2: Create IAM Policy

Create a policy that allows CloudFormation and related services:

```bash
cat > trickle-deploy-policy.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "cloudformation:*",
        "iam:*",
        "s3:*",
        "lambda:*",
        "apigateway:*",
        "dynamodb:*",
        "sns:*",
        "sqs:*",
        "logs:*",
        "cloudwatch:*",
        "ec2:*",
        "route53:*",
        "acm:*",
        "cloudfront:*",
        "ssm:*",
        "scheduler:*",
        "ses:*"
      ],
      "Resource": "*"
    }
  ]
}
EOF

# Attach to role
aws iam put-role-policy \
  --role-name github-trickle-deploy \
  --policy-name trickle-deploy \
  --policy-document file://trickle-deploy-policy.json
```

### Step 3: Add GitHub Secrets

Go to your GitHub repository → Settings → Secrets and variables → Actions

Add the following secrets:

#### For OIDC (Option A):
```
AWS_ROLE_TO_ASSUME = arn:aws:iam::YOUR_ACCOUNT_ID:role/github-trickle-deploy
AWS_REGION = eu-west-1
AUTH_USERNAME = (your auth username)
AUTH_PASSWORD = (your auth password)
AUTH_SECRET = (your JWT secret, can be generated with: openssl rand -hex 32)
```

#### For Access Keys (Option B):
```
AWS_ACCESS_KEY_ID = (from step 2)
AWS_SECRET_ACCESS_KEY = (from step 2)
AWS_REGION = eu-west-1
AUTH_USERNAME = (your auth username)
AUTH_PASSWORD = (your auth password)
AUTH_SECRET = (your JWT secret, can be generated with: openssl rand -hex 32)
```

### Step 4: Test the Pipeline

1. Create a test PR:
   ```bash
   git checkout -b test/ci-setup
   echo "# CI/CD Test" >> README.md
   git add README.md
   git commit -m "Test CI/CD pipeline"
   git push origin test/ci-setup
   ```

2. Go to GitHub → Pull Requests → Your PR
   - Watch the PR validation workflow run
   - Verify all checks pass

3. Merge to main to trigger deployment

## Troubleshooting

### Build fails in CI but works locally
- Ensure `npm ci` is used instead of `npm install`
- Check that all environment variables are set in GitHub Secrets
- Verify Node.js version matches (.node-version or 20.x)

### Deployment fails
- Check AWS credentials in secrets
- Verify IAM policy includes all required services
- Check CloudFormation events in AWS Console for specific errors
- Look at GitHub Actions logs for details

### "No identity-based policy allows" errors
- You likely need to add more permissions to the IAM policy
- Check the exact service and action in the error message
- Add to the policy and redeploy

## Monitoring Deployments

After setup, monitor deployments at:
- GitHub: Repository → Actions → Deploy to AWS workflow
- AWS: CloudFormation → Stacks → trickle-production

## Security Notes

- 🔒 OIDC (Option A) is more secure - uses temporary credentials
- 🔓 Access Keys (Option B) should be rotated regularly
- Never commit secrets to the repository
- Use GitHub environment protection rules for production deployments
- Consider requiring approvals before deploying to production
