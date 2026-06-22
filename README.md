# mcp-upload-kit

Small TypeScript primitives for MCP servers that issue short-lived HTTPS upload URLs.

The kit is intentionally not a full upload framework. Your MCP server still owns auth,
authorization, storage, and backend-specific upload calls. This package handles the
pieces that tend to be copied between implementations: upload IDs, bearer tokens,
HS256 upload JWTs, `Content-Range`, JSON responses, KV keys, request validation,
safe token comparison, SHA-256 helpers, and small MCP tool helpers.

## Install

```sh
npm install mcp-upload-kit zod
```

`zod` is a peer dependency because MCP tool schemas should use the same Zod copy as
the host server. The package targets Web Platform APIs available in Cloudflare
Workers, including `Request`, `Response`, `ReadableStream`, `TransformStream`,
`crypto.subtle`, `crypto.randomUUID`, `btoa`, and `atob`.

## Responsibilities

`mcp-upload-kit` provides upload-session primitives only.

Your application is still responsible for:

- authenticating users before calling `prepare`
- choosing the upload owner and metadata
- routing `PUT /upload/:uploadId` requests to `receive` or `receiveWith`
- implementing the destination adapter that writes to your storage backend
- deciding what completed upload result is exposed through MCP tools
- deleting or rolling back backend objects when your adapter needs stronger cleanup

The default upload flow is single-use at the record level: a pending upload
becomes `completed` or `failed`, and future PUTs are rejected. The built-in KV
store is best-effort for concurrent requests; use a custom `UploadStore` with an
atomic claim step if you need strict single-use enforcement under parallel PUTs.

## Minimal Worker

```ts
import {
  createUploads,
  kvUploadStore,
  opaqueUploadToken,
  streamToUint8Array,
  type UploadDestination,
} from "mcp-upload-kit";

interface Env {
  UPLOAD_KV: KVNamespace;
  MAX_UPLOAD_BYTES?: string;
}

const mockStorage: UploadDestination<{ objectKey: string }> = {
  async receive({ record, body }) {
    const bytes = await streamToUint8Array(body);
    await putObject(record.uploadId, bytes);
    return { objectKey: record.uploadId };
  },
};

const uploads = (env: Env, origin: string) =>
  createUploads({
    store: kvUploadStore(env.UPLOAD_KV),
    baseUrl: origin,
    maxBytes: env.MAX_UPLOAD_BYTES ?? 30 * 1024 * 1024,
    token: opaqueUploadToken(),
  });

export async function prepareUpload(env: Env, origin: string) {
  return uploads(env, origin).prepare({
    owner: "user-123",
    name: "example.txt",
    size: 11,
    contentType: "text/plain",
  });
}

export async function handleUpload(request: Request, env: Env, origin: string, uploadId: string) {
  return uploads(env, origin).receive({ uploadId, request, destination: mockStorage });
}

export async function completeUpload(env: Env, origin: string, uploadId: string) {
  return uploads(env, origin).complete({ uploadId, owner: "user-123" });
}
```

## Upload Flow

1. Call `prepare({ owner, name, size, contentType, sha256?, metadata? })` from an
   authenticated MCP tool or application route.
2. Give the returned `uploadUrl` and `uploadToken` to the client.
3. The client uploads exactly `size` bytes with `PUT`,
   `Authorization: Bearer <uploadToken>`, and `Content-Length`.
4. Route the PUT request to `receive({ uploadId, request, destination })`.
5. Call `complete({ uploadId, owner })` or `completeWith(...)` after the upload
   response succeeds.

`receive` returns JSON responses with these main status codes:

- `200`: upload accepted and stored by the destination
- `400`: malformed request, invalid range, or `Content-Length` that does not
  match the prepared size
- `401`: missing or invalid bearer token
- `403`: JWT owner mismatch
- `404`: upload session not found
- `405`: method is not `PUT`
- `409`: already completed/failed, no destination, or SHA-256 mismatch
- `410`: upload session expired
- `411`: missing `Content-Length`
- `413`: body exceeds the configured or prepared maximum
- `502`: destination adapter threw while receiving the body, or returned before
  fully consuming the body stream

## Token Strategies

Use `opaqueUploadToken()` when the upload token can be stored with the upload
record. This is the default and works well with KV-backed sessions.

Use `jwtUploadToken(secret)` when you want a signed HS256 token that repeats the
upload owner, upload ID, size, content type, issue time, and expiry. The session
record is still used as the source of truth, and the JWT is checked against it.
Use a randomly generated signing secret of at least 32 bytes and keep it outside
source control. Rotating the secret invalidates upload tokens that are still in
flight, so coordinate rotation with the configured upload TTL.

## Storage Adapters

Implement `UploadDestination` for the storage backend you own:

```ts
const destination: UploadDestination<{ objectKey: string }> = {
  async receive({ record, body, contentLength, request }) {
    // The adapter must consume the full body before resolving.
    await putObject(record.uploadId, body, { contentLength, contentType: record.contentType });
    return { objectKey: record.uploadId };
  },
  async cleanup({ result }) {
    await deleteObject(result.objectKey);
  },
  response({ result, actualSize, actualSha256 }) {
    return { accepted: true, ...result, actualSize, actualSha256 };
  },
};
```

`cleanup` is called when bytes were stored but the final SHA-256 check fails.
Errors thrown by `receive` mark the upload as failed. If `receive` resolves
without fully consuming `body`, the kit also marks the upload as failed because
it cannot verify size or SHA-256.

## Examples

- `examples/minimal-worker`: a complete mock storage Worker with prepare, PUT, and complete.
- `examples/mcp-server`: how to register purpose-specific prepare tools (`prepare_avatar_upload`, `prepare_attachment_upload`) with one shared `complete_upload` using `@modelcontextprotocol/sdk`.
- `examples/google-drive`: a Google Drive-shaped flow where Drive specifics stay in an adapter.
- `examples/kintone`: a kintone file upload adapter using an opaque per-upload bearer token.

## API Surface

- `createUploadId()`
- `createUploadToken()`
- `signUploadJwt()` / `verifyUploadJwt()` / `verifyUploadToken()`
- `extractBearerToken()`
- `parseContentRange()`
- `validateUploadRequest()`
- `sha256Hex()` / `createShaCountingStream()`
- `jsonResponse()`
- `uploadKey()`
- `safeEqual()`
- `resolvePositiveInteger()`
- `createUploads()`
- `createUploadMcp()`
- `kvUploadStore()`
- `opaqueUploadToken()` / `jwtUploadToken()`
- `streamToUint8Array()`
- `standardUploadInput()`
- `registerCompleteUploadTool()`
- `createUploadMcpBuilder()`
- Types: `UploadStatus`, `BaseUploadRecord`, `TransferUploadRecord`, `UploadStore`,
  `UploadDestination`, `UploadMcpBuilder`, `UploadPrepareResult`, `ContentRange`,
  `UploadJwtClaims`

Use `createUploadMcp()` when you want one helper to create the upload controller
and MCP builder together. Use `createUploads()` and `createUploadMcpBuilder()`
separately when you need to share or customize the lower-level upload controller.

The package is currently `0.x`, so APIs may still change before a `1.0.0`
stability release. Prefer importing from the package root only:

```ts
import { createUploads } from "mcp-upload-kit";
```

## Development

```sh
npm test
npm run typecheck
npm run build
```

`npm run build` emits only the library entrypoint under `dist/src`. Examples and
tests are intentionally excluded from the published package.

## Security Notes

- Upload URLs and tokens are bearer credentials. Keep TTLs short and send them
  only to the authenticated client that requested the upload.
- Generate JWT signing secrets with a cryptographically secure random source,
  use at least 32 bytes, and store them in your deployment's secret manager.
- Always pass `owner` to `complete` or `completeWith` when completing uploads for
  an authenticated user.
- Validate allowed MIME types and sizes before calling `prepare`; helpers such as
  `standardUploadInput` can enforce those constraints for MCP tools.
- Use `sha256` when the caller can provide an expected digest and your storage
  flow benefits from end-to-end integrity checks.

## Existing Implementations

This package was extracted from two concrete Workers:

- `upload-mcp-server-public`: Google Drive resumable uploads with signed upload JWTs.
- `kintone-mcp-server`: kintone file uploads with opaque upload tokens stored in KV.

The extraction deliberately keeps Google Drive, kintone, and MCP SDK details in those projects.
