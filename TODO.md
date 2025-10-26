# TODO - Remaining Issues

## High Priority

### 1. Input Validation
- [ ] Validate email addresses format in recipient list (backend/functions/api/email.ts:62)
- [ ] Validate sender email against SES verified identities before creating schedules
- [ ] Sanitize/validate subject and content fields
- [ ] Add maximum recipient count limit (prevent abuse)

### 2. Error Recovery for Failed Emails
- [ ] EventBridge Scheduler fires once - no retry on failure
- [ ] Consider adding retry logic in worker Lambda
- [ ] Or configure Dead Letter Queue for failed invocations
- [ ] Add ability to manually retry failed emails from UI

### 3. CORS Configuration
- [ ] Add CORS headers to API Gateway (sst.config.ts)
- [ ] Configure allowed origins for production deployment
- [ ] Currently may not work if frontend deployed on different domain

### 4. AUTH_SECRET Environment Variable
- [ ] Currently allows default value "change-me-in-production"
- [ ] Should fail-fast on startup if not properly configured
- [ ] Add validation in sst.config.ts or Lambda initialization

## Medium Priority

### 5. Multi-User Support
- [ ] Replace hardcoded "credentials" credentials
- [ ] Integrate with proper auth provider (AWS Cognito, Auth0, etc.)
- [ ] Currently uses userId from token, but only one user can log in
- [ ] Add user management UI

### 6. Email DLQ Not Used
- [ ] EmailDLQ created in sst.config.ts but never configured
- [ ] Should configure as DLQ for EmailWorker failures
- [ ] Add monitoring/alerting for messages in DLQ
- [ ] Add UI to view and retry DLQ messages

### 7. Jobs List Pagination
- [ ] Current limit: 50 jobs (backend/functions/api/email.ts:233)
- [ ] Add cursor-based pagination for users with many jobs
- [ ] Add filters (by status, date range, sender)
- [ ] Add search functionality

### 8. Email Content Storage
- [ ] Large emails (>300KB) rejected due to DynamoDB limit
- [ ] Consider storing content in S3 for large emails
- [ ] Store S3 key in DynamoDB, fetch on-demand
- [ ] Would allow unlimited email size (up to SES 10MB limit)

## Low Priority

### 9. Attachment Validation
- [ ] Currently only checks PDF MIME type on frontend
- [ ] Add backend validation of file types
- [ ] Validate actual file content (magic bytes), not just extension
- [ ] Add virus scanning for production use

### 10. Rate Limiting at API Level
- [ ] No rate limiting on API endpoints
- [ ] Could be abused to spam job creation
- [ ] Consider API Gateway throttling or Lambda rate limiting

### 11. Logging and Monitoring
- [ ] Add structured logging (JSON format)
- [ ] Add CloudWatch metrics for success/failure rates
- [ ] Add alarms for high failure rates
- [ ] Add X-Ray tracing for debugging

### 12. Email Preview
- [ ] Add "Preview Email" button in EmailForm
- [ ] Show how email will look before sending
- [ ] Render HTML content with attachments list

### 13. Schedule Management
- [ ] Add ability to view all scheduled emails for a job
- [ ] Add ability to cancel/pause a job in progress
- [ ] Would require listing EventBridge schedules by prefix
- [ ] Add bulk delete of schedules for job cancellation

## Nice to Have

### 14. Email Templates
- [ ] Save frequently used email templates
- [ ] Variables/placeholders for personalization
- [ ] Template management UI

### 15. Recipient Lists
- [ ] Save/manage recipient groups
- [ ] Import recipients from CSV
- [ ] Deduplicate and validate on upload

### 16. Email Analytics
- [ ] Track open rates (requires tracking pixel)
- [ ] Track click rates (requires link tracking)
- [ ] Dashboard with statistics

### 17. Testing
- [ ] Add unit tests for Lambda functions
- [ ] Add integration tests for API endpoints
- [ ] Add E2E tests for frontend flows
- [ ] Add load testing for rate limiting

## Technical Debt

### 18. TypeScript Strictness
- [ ] Enable strict mode in tsconfig
- [ ] Fix `any` types throughout codebase
- [ ] Add proper error types

### 19. Code Organization
- [ ] Extract validation logic to shared module
- [ ] Extract auth logic to middleware
- [ ] Extract DynamoDB operations to repository layer
- [ ] Add shared types between frontend/backend

### 20. Documentation
- [ ] Add API documentation (OpenAPI/Swagger)
- [ ] Add inline code comments for complex logic
- [ ] Add deployment guide
- [ ] Add troubleshooting guide
