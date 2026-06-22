# Security Policy

## Supported Versions

This package is pre-1.0. Security fixes are expected to land on the latest
published version.

## Reporting a Vulnerability

Please report suspected vulnerabilities privately to the project maintainer or
through the repository's private vulnerability reporting channel when available.

Do not include working exploits in public issues. Include the affected version,
the vulnerable flow, impact, and a minimal reproduction if you can share one
safely.

## Security Scope

This package provides upload-session primitives. Applications remain responsible
for authentication, authorization, storage backend permissions, MIME policy, and
post-upload access controls.

JWT signing secrets must be generated with a cryptographically secure random
source, contain at least 32 bytes, and be stored outside source control. Rotating
the signing secret invalidates outstanding upload tokens; applications should
coordinate rotation with their upload TTL.

## Operational guidance

- Upload URLs and tokens are bearer credentials. Keep TTLs short and send them
  only to the authenticated client that requested the upload.
- Always pass `owner` to `complete` / `completeWith` when completing uploads for
  an authenticated user.
- Validate allowed MIME types and sizes before calling `prepare`;
  `standardUploadInput` can enforce those constraints for MCP tools.
- Provide `sha256` at `prepare` time when the caller can compute an expected
  digest and your flow benefits from end-to-end integrity checks.
