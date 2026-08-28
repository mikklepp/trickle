/**
 * Every Lambda entrypoint, as a (module, export) pair.
 *
 * The CDK stack derives each NodejsFunction's `entry` and `handler` from this
 * map rather than repeating the strings, and handlers.test.ts asserts that every
 * pair actually resolves to a function. Nothing else validates them: esbuild
 * resolves the entry *file* but not the *export*, and `tsc` never sees the
 * wiring at all, so renaming a handler would otherwise surface only as a failed
 * invocation in production.
 */
export const HANDLERS = {
  SESEventsProcessor: { module: "api/ses-events-processor.ts", export: "handler" },
  EmailWorker: { module: "worker/index.ts", export: "handler" },
  AuthLogin: { module: "api/auth.ts", export: "login" },
  SendersList: { module: "api/senders.ts", export: "list" },
  EmailSend: { module: "api/email.ts", export: "send" },
  EmailList: { module: "api/email.ts", export: "list" },
  EmailStatus: { module: "api/email.ts", export: "status" },
  ConfigGet: { module: "api/config.ts", export: "get" },
  ConfigUpdate: { module: "api/config.ts", export: "update" },
  AccountQuota: { module: "api/account.ts", export: "quota" },
  EmailEventsSummary: { module: "api/email-events.ts", export: "summary" },
  EmailEventsLogs: { module: "api/email-events.ts", export: "logs" },
} as const;

export type HandlerId = keyof typeof HANDLERS;
