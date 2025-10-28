# TODO - Remaining Issues

## Completed
- ✅ **Input Validation** (2025-10-26)
  - Email format validation (RFC 5322) for sender and recipients
  - SES identity verification for sender
  - Subject and content validation
  - Maximum recipient limit (1000)
- ✅ **SES v2 Migration** (2025-10-26)
  - Migrated all SES operations to v2 API
  - Email worker now uses Simple content type with Attachments (cleaner than raw MIME)
  - /senders endpoint uses ListEmailIdentities (single call vs two in v1)
  - Removed @aws-sdk/client-ses dependency
- ✅ **Error Recovery** (2025-10-27)
  - Added Dead Letter Queue for EmailWorker Lambda
  - Implemented retry logic with exponential backoff (1s, 2s, 4s)
  - Error detection for retryable vs permanent failures
  - Store error details in job record (recipient, error type, message)
  - Display error details in frontend
- ✅ **CORS Configuration** (2025-10-27)
  - Environment-aware CORS (dev: *, production: frontend domain only)
  - Specific allowed methods and headers for production
  - Configured in sst.config.ts

## High Priority

### 1. ~~Input Validation~~ ✅ COMPLETED
- [x] Validate email addresses format in recipient list (backend/functions/api/email.ts:194-203)
- [x] Validate sender email against SES verified identities before creating schedules (backend/functions/api/email.ts:137-146)
- [x] Sanitize/validate subject and content fields (backend/functions/api/email.ts:149-164)
- [x] Add maximum recipient count limit (prevent abuse) (backend/functions/api/email.ts:183-191, MAX_RECIPIENTS=1000)

### 2. ~~Error Recovery for Failed Emails~~ ✅ COMPLETED
- [x] EventBridge Scheduler fires once - no retry on failure
- [x] Retry logic in worker Lambda with exponential backoff
- [x] Dead Letter Queue configured for failed invocations
- [ ] Add ability to manually retry failed emails from UI

### 3. ~~CORS Configuration~~ ✅ COMPLETED
- [x] Add CORS headers to API Gateway (sst.config.ts)
- [x] Configure allowed origins for production deployment
- [x] Environment-aware: dev allows *, production only frontend domain

### 4. ~~JWT Migration (Token Security)~~ ✅ COMPLETED (2025-10-28)
- [x] Migrate from custom JWT format to standard RFC 7519 implementation
- [x] Install `jsonwebtoken` standard library
- [x] Add proper JWT claims (sub, iat, exp, iss)
- [x] Use HS256 algorithm with 24-hour expiration
- [x] Add TypeScript types for JWT payloads
- [x] Maintain backward compatibility with existing authentication

### 5. AUTH_SECRET Environment Variable
- [ ] Currently allows default value "change-me-in-production"
- [ ] Should fail-fast on startup if not properly configured
- [ ] Add validation in sst.config.ts or Lambda initialization

## Medium Priority

### 6. Multi-User Support
- [ ] Replace hardcoded "credentials" credentials
- [ ] Integrate with proper auth provider (AWS Cognito, Auth0, etc.)
- [ ] Currently uses userId from token, but only one user can log in
- [ ] Add user management UI

### 7. ~~Dead Letter Queue for Email Worker~~ ✅ COMPLETED (merged with #2)
- [x] Create SQS DLQ for EmailWorker Lambda failures
- [x] Configure DLQ in sst.config.ts for EmailWorker
- [ ] Add monitoring/alerting for messages in DLQ
- [ ] Add UI to view and retry DLQ messages

### 8. Jobs List Pagination
- [ ] Current limit: 50 jobs (backend/functions/api/email.ts:456)
- [ ] Add cursor-based pagination for users with many jobs
- [ ] Add filters (by status, date range, sender)
- [ ] Add search functionality

### 9. Email Content Storage
- [ ] Large emails (>300KB) rejected due to DynamoDB limit
- [ ] Consider storing content in S3 for large emails
- [ ] Store S3 key in DynamoDB, fetch on-demand
- [ ] Would allow unlimited email size (up to SES 10MB limit)

## Low Priority

### 10. Attachment Validation
- [ ] Currently only checks PDF MIME type on frontend
- [ ] Add backend validation of file types
- [ ] Validate actual file content (magic bytes), not just extension
- [ ] Add virus scanning for production use

### 11. Rate Limiting at API Level
- [ ] No rate limiting on API endpoints
- [ ] Could be abused to spam job creation
- [ ] Consider API Gateway throttling or Lambda rate limiting

### 12. Logging and Monitoring
- [ ] Add structured logging (JSON format)
- [ ] Add CloudWatch metrics for success/failure rates
- [ ] Add alarms for high failure rates
- [ ] Add X-Ray tracing for debugging

### 13. Email Preview
- [ ] Add "Preview Email" button in EmailForm
- [ ] Show how email will look before sending
- [ ] Render HTML content with attachments list

### 14. Schedule Management
- [ ] Add ability to view all scheduled emails for a job
- [ ] Add ability to cancel/pause a job in progress
- [ ] Would require listing EventBridge schedules by prefix
- [ ] Add bulk delete of schedules for job cancellation

## Nice to Have

### 15. Email Templates
- [ ] Save frequently used email templates
- [ ] Variables/placeholders for personalization
- [ ] Template management UI

### 16. Recipient Lists
- [ ] Save/manage recipient groups
- [ ] Import recipients from CSV
- [ ] Deduplicate and validate on upload

### 17. Email Analytics
- [ ] Track open rates (requires tracking pixel)
- [ ] Track click rates (requires link tracking)
- [ ] Dashboard with statistics

### 18. Testing
- [ ] Add unit tests for Lambda functions
- [ ] Add integration tests for API endpoints
- [ ] Add E2E tests for frontend flows
- [ ] Add load testing for rate limiting

## Technical Debt

### 19. TypeScript Strictness
- [ ] Enable strict mode in tsconfig
- [ ] Fix `any` types throughout codebase
- [ ] Add proper error types

### 20. Code Organization
- [ ] Extract validation logic to shared module (email validation added in email.ts but should be shared)
- [ ] Extract auth logic to middleware
- [ ] Extract DynamoDB operations to repository layer
- [ ] Add shared types between frontend/backend

### 21. Documentation
- [ ] Add API documentation (OpenAPI/Swagger)
- [ ] Add inline code comments for complex logic
- [ ] Add deployment guide
- [ ] Add troubleshooting guide
