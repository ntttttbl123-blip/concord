# ADR-0003: Concord sends no email

- **Status:** Accepted
- **Deciders:** Maintainers
- **Date:** 2026-10-18
- **Consulted:** Architecture, API, Security

## Context

Concord is designed as an auditable, single-process reconciliation engine run by institutions—transfer agents, fund managers, and custodians—either on dedicated servers, virtual machines, or container platforms. Its operational model prioritizes self-containment: a single Node binary running against SQLite files on local disk (`CONCORD_DATA_DIR`).

Integrating email delivery into a self-hosted or regulated application imposes significant operational complexity on operators:
1. **Infrastructure dependencies:** Operators would need to configure and maintain outbound SMTP relays or third-party transactional mail services (such as AWS SES, SendGrid, or Postmark), managing API keys and network egress rules.
2. **Deliverability maintenance:** Institutional domains require configuring DNS records (SPF, DKIM, DMARC, MX, and reverse DNS pointers). Failure or misconfiguration leads to dropped or junked notification emails, causing confusion during onboarding and incident response.
3. **Sensitive data exposure:** Notification emails traverse external mail transfer agents in transit, risking disclosure of organization names, user identifiers, and operational notifications.
4. **Out-of-band enterprise practices:** Regulated organizations and financial institutions routinely provision user access and communicate credentials through managed enterprise communication channels (e.g., corporate Slack, Microsoft Teams, encrypted chat, or internal password vaults) rather than public email.

## Decision

Concord does not integrate email transport libraries, background mail queues, or external delivery API integrations. It sends no email whatsoever (`docs/ARCHITECTURE.md`, `README.md`).

All identity lifecycle actions rely on out-of-band link distribution and operator CLI execution:

### 1. Link-based workspace invitations
- When a workspace owner invites a colleague via the dashboard or API (`POST /api/org/invites`, `services/api/src/api.ts`), the backend invokes `Auth.createInvite` (`services/api/src/auth.ts`).
- A 32-byte cryptographically secure random token (`newToken(32)`, `services/api/src/security.ts`) is generated. Only its SHA-256 hash (`token_hash`) is stored in the `invites` table with a 7-day expiration (`INVITE_LIFE_MS = 7 * DAY`).
- The API response returns the direct invite link:
  ```json
  {
    "id": "e8f1...",
    "email": "analyst@example.com",
    "role": "member",
    "link": "https://concord.example.com/#/invite/<token>"
  }
  ```
- The workspace owner copies this link and shares it directly with the invitee through their organization's secure communication channel.
- Upon opening the link, the invitee verifies their account details and completes onboarding (`POST /api/auth/invites/accept`, `services/api/src/auth-api.ts`).

### 2. Operator-issued password resets
- Concord exposes no public "Forgot Password" form on the sign-in screen, preventing unauthenticated enumeration or reset-token flooding.
- To reset a password, an operator with shell access to the host runs the CLI command:
  ```sh
  pnpm concord reset-link user@example.com
  ```
  (`services/api/src/cli.ts`).
- This generates a single-use token valid for 24 hours (`RESET_LIFE_MS = DAY`) stored in `one_time_tokens` (`services/api/src/auth.ts`).
- The operator transmits the resulting URL (`https://concord.example.com/#/reset/<token>`) to the verified user through a trusted channel.

### 3. Third-party verified identity via Google OAuth
- Where automated identity verification without outbound email is desired, operators can configure Google OAuth via `CONCORD_GOOGLE_CLIENT_ID` and `CONCORD_GOOGLE_CLIENT_SECRET` (`services/api/src/config.ts`).
- OpenID Connect profile exchange (`services/api/src/auth-api.ts`) imports the verified email address directly from Google's OpenID claims (`email_verified = true`).

## Risks and Mitigations

### Unverified email addresses
- **Risk:** Because Concord does not send confirmation emails upon sign-up or invitation acceptance, email addresses entered during registration are not verified by email round-trip. `services/api/src/auth.ts` sets `email_verified = 0` for non-OAuth users. A user could mistype their email or enter an address belonging to another domain.
- **Mitigation:**
  - Workspace boundaries are strictly guarded: an account created via open sign-up cannot see or access any existing organization's data. Each organization is an isolated SQLite database (`data/orgs/<id>.db`, `services/api/src/tenants.ts`).
  - Operators can restrict new workspace creation by setting `CONCORD_SIGNUP=code` (`services/api/src/config.ts`), requiring an operator-generated signup token (`pnpm concord signup-code`).
  - Adding a user to an existing workspace requires an explicit invitation token created by an organization owner (`services/api/src/auth.ts`). Knowing an email address does not grant access to any organization without possessing the out-of-band invitation secret.
  - Password resets require authenticated host access, eliminating risk from spoofed unverified email address claims.

## Conditions for Revisit

This architectural decision should be re-evaluated if:
1. **Multi-tenant public SaaS deployment:** Concord is packaged and operated as a hosted multi-tenant software-as-a-service platform where operators cannot interact out-of-band with end users.
2. **High-scale user provisioning:** Customer deployments reach team sizes where manual invitation link sharing and operator reset link generation create unacceptable administrative friction (e.g., hundreds of active operators per organization).
3. **Mandatory regulatory delivery receipts:** Compliance frameworks require cryptographically signed audit logs proving automated email delivery of corporate action and reconciliation sign-off notifications.
4. **Multi-factor authentication (MFA):** If secondary authentication factors are required, though standards-based WebAuthn/FIDO2 or TOTP (RFC 6238) would be preferred over email-based one-time passwords to maintain the zero-email posture.
