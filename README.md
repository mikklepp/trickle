# Trickle - Email Distribution Application

Cloud-native web application for sending bulk emails individually through AWS SES.

## Project Structure

```
trickle/
├── backend/
│   └── functions/
│       ├── api/           # API Lambda handlers
│       └── worker/        # SQS worker Lambda
├── frontend/              # Web application (React/Vue)
├── sst.config.ts          # SST infrastructure definition
└── SPECIFICATION.md       # Full project specification
```

## Prerequisites

- Node.js 18+ and npm
- AWS CLI configured with credentials
- AWS account with SES access

## Getting Started

### Install Dependencies

```bash
npm install
```

### Development

Run SST in development mode with live Lambda updates:

```bash
npm run dev
```

This starts the SST console and deploys your app to AWS with hot-reload enabled.

### Deployment

Deploy to production:

```bash
npm run deploy --stage production
```

### Remove Stack

```bash
npm run remove
```

## SST Features

- **Live Lambda Development**: Edit code and see changes instantly
- **Type Safety**: Full TypeScript support with autocomplete
- **Resource Linking**: Automatic environment variables and permissions
- **Local Console**: Web-based dashboard at `sst console`

## Next Steps

1. Implement Lambda function logic in `backend/functions/`
2. Build frontend in `frontend/`
3. Configure SES verified identities
4. Set up authentication (Cognito or JWT)
5. Add monitoring and logging

See `SPECIFICATION.md` for detailed requirements.
