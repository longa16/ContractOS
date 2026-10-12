# Security design and residual risks

This document describes implemented controls and operator responsibilities. It is not a guarantee of zero vulnerabilities or a certification.

## Implemented controls

| Threat                              | Control                                                                                                                                                                        |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Internal MFA bypass                 | Database `aal2`, live session, confirmed/non-banned account and verified factor, verified Supabase session/claims, TOTP setup and challenge                                    |
| Role escalation through signup      | Memberships are administrative only; no role from user-editable metadata                                                                                                       |
| Cross-tenant/contractor access      | RLS, composite organization foreign keys, ownership checks in RPCs and private object policies                                                                                 |
| Direct API write bypass             | No client INSERT/UPDATE/DELETE grants; each material write is an authorized RPC                                                                                                |
| CSRF                                | Next.js server-action checks plus exact `APP_ORIGIN` validation; mutations never exposed as GET routes                                                                         |
| XSS / malicious files               | React text escaping, nonce CSP, no raw HTML, no inline remote document preview, attachment downloads, nosniff, permitted MIME/signature/size                                   |
| Malicious PDF resource usage        | Separate parser process, stripped credential environment, 192 MiB V8 heap, 15-second deadline, 10 MiB input, 100 pages, 80k text limit, output cap                             |
| SSRF / prompt instructions          | Fixed HTTPS provider URLs, no redirects or source-URL downloads, no AI tools, source text treated as untrusted data                                                            |
| Unsupported AI facts                | Strict schemas, verbatim grounding, MISSING status, human verification; deterministic proposal provenance                                                                      |
| Stale approvals/evidence            | Revision invalidation, current-time expiry checks, amendment re-review, explicit document/approval revocation                                                                  |
| Proposal replacement after approval | Append-only storage, newest final PDF must be verified, approval bound to immutable document ID and revision                                                                   |
| Credential/log leakage              | Server-only clients, HttpOnly auth/setup cookies, no raw provider/database errors or document content in logs, no credentials in agent state/output; external tracing disabled |
| Audit tampering by users            | No mutation grants on audit/approval tables, audit inserted transactionally with business operations                                                                           |

Internal users who also own a contractor record still require MFA. Contractors can update availability/capacity and upload their own documents but cannot self-verify, view internal prices/proposals/audit, or inspect another contractor.

## Important limits

- MFA is TOTP, not phishing-resistant WebAuthn. Configure a controlled recovery procedure through Supabase administration, require identity verification and log recovery. Do not bypass MFA by giving internal users an `aal1` exception.
- Auth rate limits, leaked-password protection, SMTP, email confirmation, anti-bot/CAPTCHA and session lifetimes must be configured in hosted Supabase. A perimeter rate limit is also required for login, MFA, uploads, AI and worker requests. App memory is not a reliable distributed rate limiter.
- File signature checks are not antivirus. Organizations require malware scanning by default. A trusted local ClamAV worker must report CLEAN before owner verification; users cannot forge that result. The worker requires a recent definition date, bounds input/time/scan recursion, flags encrypted/oversized content, and records a SHA-256 of the immutable stored bytes. An unavailable/stale scanner leaves the document pending, never clean. REJECTED objects cannot be downloaded. Only the uploader may download its own pending upload; other internal readers wait for the scan. Install a supported ClamAV engine at `/usr/bin/clamscan`, keep signed definitions updated with freshclam, and configure the server-only service-role binding. The scanner binary/definitions have not been exercised by the unit tests; those validate the database enforcement boundary. Download attachments only in managed, patched readers. The PDF subprocess strips credentials, disables eval/font execution, and uses Node filesystem permissions to prevent access to application secret files. It remains a resource/permission boundary, not a full OS sandbox: use an isolated worker/container without network and minimal filesystem permissions for hostile production uploads.

For synthetic development fixtures only, a trusted administrator may set `organizations.require_malware_scan=false`; application users have no write grant on that setting and the Command Center displays a warning. Do not use this exception for production or real sensitive documents. Enabling the policy also invalidates eligibility of earlier unscanned evidence through current-time compliance checks.

- Audit is append-only for application users, not privileged database administrators. Export to a restricted immutable/WORM sink; monitor gaps and admin changes.
- Credentials sent to a model, prompt injection and false semantic interpretations remain risks. Do not upload CUI, government-restricted documents, SSNs/W-9s, payroll, identity documents or contractor insurance into AI. Explicit consent does not change contractual provider data-handling obligations. Establish an approved provider/account, retention terms and processing agreement before activation.
- Matching currently supports exact trade and comma-separated geographic areas, basic capacity and fixed required documents. It does not establish eligibility, license applicability, bonding, workers' compensation, past performance or set-aside compliance. The owner must verify these for the specific opportunity and record relevant mandatory requirements.
- Contract value, financial structures, legal retention and licenses differ by solicitation. The MVP conservatively requires W-9, insurance and license; a documented exemption requires a controlled policy change, not a fabricated document.
- This is a private B2B MVP. The views are bounded, and the SAM connector is windowed. Bounded pagination exists; add durable backfill, monitoring, distributed limits and production load testing before scaling.

## Retention and deletion

Document rows have `retained_until`, with a conservative **development default** of seven years. Establish the lawful business/contract-specific retention schedule before production; this default is not legal advice. There is deliberately no contractor or VA delete permission and no arbitrary retention override from the browser.

Use a separate privileged deletion job with approved requests, tenant/object checks, legal-hold checks, expiry review, and an audit export. Remove the object through the Storage API before removing its metadata, preserve necessary approval references, and apply the policy to backups. A revoked document remains readable for historical review but is ineligible as evidence. User erasure cannot silently destroy required contract records.

## Security reporting

Report issues privately to the repository owner. Include affected behavior, prerequisites and reproduction using synthetic data. Never include production credentials or actual confidential documents in a public issue. Rotate compromised bindings, invalidate sessions and audit privileged actions before restoring service.
