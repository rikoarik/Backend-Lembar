# Authentication, Accounts, and Tenancy

## Domain distinction

- **Account:** human login identity.
- **Workspace:** ownership/billing/data boundary: `personal` or `school`.
- **Membership:** account role inside a workspace.
- **Platform role:** `superadmin`, separate from workspace membership.
- **Plan/entitlement:** commercial capability, not role.

An individual subscriber is a `teacher` in a personal workspace. One account can have one
personal workspace and memberships in multiple schools.

## Roles

### Teacher

- create/review/finalize own/workspace assessment according to policy;
- use private sources/bank/templates;
- view own/effective usage;
- cannot administer school membership or platform.

### School admin

- invite/activate/suspend members and assign allowed workspace role;
- view seat and aggregate usage;
- manage school profile/plan operations allowed by contract;
- does not automatically read private teacher assessment/source content.

### Superadmin

- platform operations only through explicit audited tools;
- support/content/billing actions are separate permissions;
- no permanent “see everything” UI;
- sensitive content access requires justified step-up flow and audit where ever allowed.

## Personal registration

Baseline outcome:

1. User supplies approved identifier and credentials/auth method.
2. Verify identifier when required.
3. Create account + personal workspace + teacher membership atomically.
4. Start session with rotated ID and secure cookie.
5. Record consent/version metadata required by policy.

Do not create duplicate account/workspace on retry. Enumeration-safe responses apply.

## School-created credentials

School admin may initiate access but must never know or retrieve a teacher's permanent password.

Supported conceptual flows:

### Email invite

Admin creates invitation → single-use token sent → teacher signs in/creates account → accepts
membership → invitation consumed.

### One-time activation code

For environments where teacher email is unavailable, admin creates a pending identity/member
record and receives a one-time activation handoff. Teacher opens activation page, supplies code,
sets own credential/recovery method, and code is invalidated.

Requirements:

- short expiry and attempt rate limit;
- token/code stored hashed;
- rotate/revoke rather than reveal;
- no reusable default password;
- admin sees status, not credential;
- account recovery path does not depend permanently on school admin.

Exact supported identifier (email, username, phone) is decided in D-002 after security and
support review.

## Session policy

- HttpOnly, Secure production cookie; `__Host-` prefix where deployment permits.
- SameSite selected with actual domain/auth flow; do not copy blindly.
- Idle and absolute expiry.
- Rotate on login, privilege change, recovery, and suspicious event.
- Server-side revocation/version check for logout-all and membership/account suspension.
- CSRF protection on browser mutations and strict allowed origins.
- No session/token in localStorage, URL, analytics, or logs.
- Future mobile authentication is included in D-002 design, not retrofitted through cookie hacks.

## Active workspace

- Request states a workspace ID; backend verifies active membership every time.
- Session may remember last active workspace but it is never an authorization cache forever.
- Workspace switch endpoint verifies membership and returns new effective context.
- Every tenant row/repository query is scoped by verified workspace.
- Background jobs persist workspace ID and reauthorize ownership/state at execution boundaries.

## Authorization model

Use explicit permissions behind roles, for example:

```text
assessment.create
assessment.read
assessment.review
assessment.finalize
source.manage
library.manage
workspace.member.manage
workspace.usage.read
catalog.publish
platform.support.act
```

Application service checks resource state + tenant + permission. Route guards alone are not
sufficient. IDs are identifiers, not capabilities.

## Tenant isolation tests

For every tenant resource:

- account A cannot read/update/delete workspace B object by ID;
- switching header without membership fails;
- list/search/count/cache do not leak B;
- signed upload/download cannot be reused across workspace;
- job and artifact lookup scoped;
- bank/template/analytics scoped;
- school admin cannot access teacher content without explicit permission;
- superadmin route unavailable to workspace admin;
- soft-deleted/archived object remains inaccessible.

These adversarial tests are mandatory CI integration tests.

## Invitations and memberships

Invitation states: `pending`, `accepted`, `expired`, `revoked`. Membership states: `active`,
`suspended`, `revoked`.

- One invite acceptance is idempotent.
- Accepted token cannot be replayed.
- Removing final school admin requires transfer/owner-controlled recovery.
- Role change and suspension revoke/refresh effective sessions promptly.
- Account deletion and workspace membership removal are distinct.

## Recovery and sensitive changes

- Recovery request response is generic.
- Tokens hashed, single-use, short-lived, purpose-bound.
- Password/passkey policy delegated to proven library/provider; no custom crypto.
- Changing identifier, password, recovery, or role may require recent authentication.
- Notify user of security-sensitive action when email/notification provider exists.
- Rate limit by multiple safe dimensions without permanent lockout abuse.

## Superadmin support access

Support workflow records:

- actor, permission, reason/ticket;
- target and action category;
- step-up result;
- timestamp/request ID;
- before/after safe metadata;
- outcome.

Impersonation is deferred unless explicitly designed. Prefer scoped support actions over full
session impersonation.

## Auth decision acceptance

D-002 is accepted only when PoC covers:

- registration/login/logout/recovery;
- session rotation/revocation;
- CSRF/origin behavior across actual FE/API domains;
- email invite and/or one-time school activation;
- multi-workspace switch;
- mobile future path;
- local/test operation without production secret;
- audit and enumeration/rate-limit tests.

