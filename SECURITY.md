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
