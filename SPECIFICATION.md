# Cloud-Native Email Distribution Application Specification

## Overview
Web application for sending bulk emails individually through AWS SES with rate limiting and attachment support.

## Architecture
- **Frontend**: Single-page web application (React/Vue)
- **Backend**: Serverless API (AWS Lambda + API Gateway)
- **Queue**: AWS SQS for email job processing
- **Storage**: S3 for temporary attachment storage
- **Database**: DynamoDB for tracking send status and configuration
- **Email Service**: AWS SES

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

## Technical Details

### API Endpoints
- `POST /auth/login` - Authentication
- `GET /senders` - List verified SES identities
- `POST /email/send` - Submit email job
- `GET /email/status/:jobId` - Check send progress
- `GET /config` - Get rate limit settings
- `PUT /config` - Update rate limit settings

### Data Model
```
Jobs: jobId, userId, subject, content, totalRecipients, sent, failed, status, createdAt
Recipients: jobId, email, status, sentAt, error
Config: userId, rateLimit, maxAttachmentSize
```

### Queue Processing
- Lambda triggered by SQS
- Batch size: 1
- Configurable delay between messages
- DLQ for failed sends
- Retry logic with exponential backoff

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
