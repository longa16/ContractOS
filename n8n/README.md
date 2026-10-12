# n8n

Import `sam-opportunities.json`; it is intentionally inactive and has no credential value or user-specific credential ID. Edit the app HTTPS origin and choose a managed HTTP Header Auth credential with header name `Authorization`, value `Bearer <INTEGRATION_TOKEN>`. Store the real token only in n8n's encrypted credential manager. The app's server bindings hold the SAM key and fixed target organization.

Run once in staging and inspect returned counts/limits before activating the schedule. Configure n8n execution/error notifications to the operator and provider quotas. Retries are bounded and notices are deduplicated by organization, source and notice identity. A failed provider/database step returns an error; it must not be treated as success. No emails, SMS, signatures or bid submissions are performed by this workflow.

RFP ingestion, contractor onboarding, matching, pricing, proposals, compliance and human gates currently run through the application and PostgreSQL RPCs. They are not represented as pretend autonomous workflows. Award/operations automation is a later roadmap item.
