# ADR 001: Marketing CMS Authoring Implementation

## Status
Accepted

## Context
The product requires superadmin-only marketing CMS ops to manage marketing pages with revision control, draft publishing, and audit trails.

## Decision
Implemented the following:
- Revision locking using HTTP If-Match headers to prevent concurrent modifications
- 100KB draft size limit enforced on save-draft endpoint
- Content sanitization to remove XSS vectors (script tags) from draft content
- Immutable versioning for published drafts via database transactions
- Full audit trail logging all operations with user, timestamp, and content hash
- Superadmin-only authorization via role-based middleware

## Consequences
- Enhanced security through content sanitization and access control
- Reliable revision management with atomic operations
- Clear audit trail for compliance and debugging
- Maintained existing project structure and conventions