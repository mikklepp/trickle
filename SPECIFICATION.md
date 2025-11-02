# Cloud-Native Email Distribution Application Specification

## Overview
Web application for sending bulk emails individually through AWS SES with rate limiting and attachment support.

## Architecture
- **Frontend**: Single-page web application (React)
- **Backend**: Serverless API (AWS Lambda + API Gateway v2)
- **Scheduling**: AWS EventBridge Scheduler for rate-limited email delivery
- **Storage**: S3 for temporary attachment storage
- **Database**: DynamoDB for tracking send status and configuration
- **Email Service**: AWS SES v2 API

## Core Features

### 1. Authentication
- Simple user authentication (Cognito or basic JWT)
- User sessions with token-based auth

### 2. Email Composition Form
- **Sender Selection**: Dropdown populated from verified SES identities
- **Recipients**: Textarea accepting semicolon-separated email addresses with validation
- **Subject**: Text input
- **Content**: Rich text editor or HTML/plaintext toggle
- **Attachments**: PDF upload with size validation (e.g., 10MB total limit)

### 3. Email Processing
- Parse and validate recipient list
- Upload attachments to S3 (temp storage)
- Create individual SQS messages per recipient
- Worker Lambda processes queue with configurable delay
- Each email sent to single recipient in TO: field
- Track delivery status in DynamoDB

### 4. Rate Limiting
- Configurable sending rate (default: 1 email/minute)
- SQS visibility timeout and delay configuration
- Respect SES sending limits

### 5. Monitoring
- Dashboard showing:
  - Send progress
  - Success/failure counts
  - Failed recipient list
  - SES quota usage

### 6. Email Event Tracking
- Track email events via SES Configuration Set with CloudWatch integration
- Event types tracked:
  - **Send**: Email submission to SES was successful
  - **Delivery**: Email successfully delivered to recipient's mail server
  - **Bounce**: Recipient's mail server permanently rejected the email
  - **Complaint**: Recipient marked email as spam
  - **Reject**: Email contained virus, delivery not attempted
  - **DeliveryDelay**: Temporary delivery failure (inbox full, server issue, etc.)
  - **Open**: Recipient opened the email (with Open Tracking enabled)
  - **Click**: Recipient clicked a link in the email (with Click Tracking enabled)
  - **RenderingFailure**: Template rendering error (when using templated emails)
  - **Subscription**: Recipient updated subscription via List-Unsubscribe
- Event metrics displayed in Job Status page with clickable event counts
- Email Logs page shows raw event details with filtering by recipient and event type
- Deep-linking from Job Status metrics to Email Logs with pre-selected filters

## Technical Details

### API Endpoints
- `POST /auth/login` - Authentication
- `GET /senders` - List verified SES identities
- `POST /email/send` - Submit email job
- `GET /email/status/:jobId` - Check send progress
- `GET /email/events/summary/:jobId` - Get aggregated email event counts by type
- `GET /email/events/logs/:jobId` - Get raw email events with optional filters (recipient, eventType)
- `GET /config` - Get rate limit settings
- `PUT /config` - Update rate limit settings
- `GET /account/quota` - Get SES sending quota and limits

### Data Model
```
Jobs: jobId, userId, subject, content, totalRecipients, sent, failed, status, createdAt
Recipients: jobId, email, status, sentAt, error
Config: userId, rateLimit, maxAttachmentSize
```

### Email Delivery Scheduling
- Lambda triggered by EventBridge Scheduler (replaces SQS)
- Separate schedule per recipient for rate limiting
- Configurable delay between email sends (default: 1 email/minute)
- Dead Letter Queue (DLQ) for failed sends
- Retry logic with exponential backoff (1s, 2s, 4s)

## Security
- Input validation and sanitization
- Email address validation
- Virus scanning for attachments (optional: ClamAV Lambda)
- IAM roles with least privilege
- Encryption at rest (S3, DynamoDB)
- CORS configuration
- Rate limiting on API endpoints

## Constraints
- PDF attachments only
- Max attachment size: 10MB per email
- SES sending limits compliance
- Temporary attachment cleanup (S3 lifecycle policy)

## Related Documentation

- **[README.md](./README.md)** - Project overview and quick start
- **[CDK_MIGRATION.md](./CDK_MIGRATION.md)** - Deployment and infrastructure guide
- **[.github/CICD_SETUP.md](./.github/CICD_SETUP.md)** - GitHub Actions CI/CD setup
- **[cdk/README.md](./cdk/README.md)** - CDK commands and structure
