# Deployment

## Separation and prerequisites

Use distinct Supabase projects, storage buckets, credentials and application deployments for development, staging and production. The local Docker stack and its generated keys are for an isolated developer machine with synthetic data only. Do not publish local Docker service ports or Mailpit. Service processes and Docker state must restart in a new cloud task; a filesystem snapshot does not prove they are live.

Before production, complete the deployment controls below, validate with synthetic staging data and arrange an independent security review. The source code does not configure the hosting provider's encryption, retention, backups or perimeter by itself.

## Database and Auth

1. Apply SQL files under `supabase/migrations` in order, transactionally, on a fresh application project. Review migrations first; they intentionally restrict public application tables/functions. Do not execute them in an unrelated shared database.
2. Keep API exposed schemas restricted to `public` (and Supabase's own managed defaults); never expose `private`. Verify anon/authenticated grants and storage policies after migration.
3. Configure a confirmed-email SMTP flow and exact callback allowlist for the HTTPS `APP_ORIGIN` plus `/auth/callback`. Do not add broad wildcard redirect URLs.
4. Enable TOTP enrollment/verification, strong password policy, auth limits, leaked-password checks and a documented recovery flow. Manually bootstrap the first confirmed owner. Provision VA memberships only through an audited administrator.
5. Restrict production service-role access to the ingestion worker's secret binding. Do not use it for user requests, browser SDKs, logs or agent state.
6. Configure encrypted persistent disks/object storage, TLS, backup/PITR and a tested restore procedure through the provider. Restrict administrator access with MFA and least privilege. Review location, data-processing agreement and retention for ordinary commercial confidential data.

## Application

Inject the names in `.env.example` through the hosting platform. All API keys except the Supabase public key are secret/server-only. Set `APP_ORIGIN` to the precise HTTPS origin. Rebuild for each environment: Next.js can inline `NEXT_PUBLIC_*` values at build time. Never reuse a build containing another environment's public URL/key.

```bash
npm ci --ignore-scripts
npm run typecheck
npm test
npm run build
npm start
```

Run behind a trusted HTTPS reverse proxy with request/body/concurrency/time limits and verified forwarded host handling. Enforce perimeter limits on auth/AI/uploads/worker routes. Allow enough execution time for PDF plus AI (up to about 60 seconds); restrict outgoing network access to fixed providers. Deploy the PDF parser as a hardened container/worker before accepting arbitrary production uploads. Install a supported ClamAV engine at `/usr/bin/clamscan`, keep freshclam's signed definitions current, and configure the server-only service-role key for the scan worker. The default organization policy blocks verification of unscanned files; absence or stale definitions fails closed. Validate with a clean synthetic PDF and the harmless EICAR antivirus test fixture on staging before enabling document collection.

Headers include nonce CSP, frame denial, nosniff, no-referrer, restricted browser features, private no-store and HSTS in production. Inspect headers through the actual proxy; CDN caching must not override no-store or cache authenticated HTML. Test CSP in supported browsers and ensure assets/auth redirects remain functional over HTTPS.

`/api/health` reports whether local configuration names are present, **not** database/provider readiness. Perform a confirmed-user MFA login, cross-role/cross-contractor tests, a private upload/download, a grounded analysis and a blocked/approved submission in staging before accepting traffic.

## Integrations

Configure the server-only SAM and Supabase credentials and fixed `INGEST_ORGANIZATION_ID`, then run `npm run agent:sam`. Use a scheduler with no overlapping executions; no scheduler is embedded in the application. The existing bearer-protected endpoint invokes the same LangChain/LangGraph agent. `INTEGRATION_TOKEN` is required only for this endpoint, not the CLI. Disable external LangSmith/LangChain tracing; never place secrets in graph inputs, outputs or logs.

SAM uses NAICS 561720, a seven-day window, up to five pages of 100 records, and a 55-second execution deadline. CLI exit 2 / `paginationRequired=true` means the window is incomplete; alert and arrange a bounded backfill before claiming complete coverage. Retries restart at page zero with database deduplication; there is no durable checkpoint or queue yet. Notices without usable deadlines are counted as skipped. Test with staging SAM credentials before enabling a schedule. Maryland imports remain manual. Provider attachment URLs are never fetched.

No automatic external messages, e-signatures or bid submissions are enabled. Future automation must preserve approval gates, idempotency, per-source authentication and audit.

## Operational sign-off

- Complete [acceptance.md](acceptance.md) on staging, including real Supabase Auth/Storage.
- Validate network access to the exact project domain, `api.sam.gov`, and `api.openai.com` only when enabled.
- Configure and test rate limits, scanning/quarantine, isolated PDF workers, monitoring and auth recovery.
- Decide legal retention and legal holds, deletion workflow and backup retention.
- Export audit to immutable restricted storage and alert on failures/deadlines/document expirations.
- Verify a restore and credential/session rotation using synthetic data.
- Obtain security review and opportunity-specific compliance review before production use.
