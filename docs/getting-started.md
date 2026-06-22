# Getting started

`mcp-upload-kit` gives an MCP server the building blocks to hand out
short-lived HTTPS upload URLs, so large file bytes travel over a plain `PUT`
instead of the MCP JSON-RPC channel.

It is **not** a full upload framework. Your server still owns authentication,
authorization, storage, and any backend-specific upload calls. The kit handles
the parts that get copied between implementations: upload IDs, bearer tokens,
HS256 upload JWTs, `Content-Range`, request validation, SHA-256 streaming, JSON
responses, KV keys, and small MCP tool helpers.

## Requirements

- A Cloudflare Workers-style runtime (Web Platform APIs: `Request`, `Response`,
  `ReadableStream`, `TransformStream`, `crypto.subtle`, `crypto.randomUUID`,
  `btoa`, `atob`).
- `zod` installed in the host project — it is a peer dependency so MCP tool
  schemas use the same Zod copy as your server.

## Install

```sh
npm install https://github.com/zenk-t-suzuki/mcp-upload-kit/releases/download/v0.3.1/mcp-upload-kit-0.3.1.tgz zod
```

The package is distributed through GitHub Releases and is not yet published to
the npm registry. Always import from the package root:

```ts
import { createUploads } from "mcp-upload-kit";
```

## The three-step flow

1. **prepare** — from an authenticated MCP tool, call `prepare(...)`. You get an
   `uploadId`, a short-lived `uploadUrl`, and an `uploadToken`.
2. **PUT** — the client sends the raw bytes to `uploadUrl` with
   `Authorization: Bearer <uploadToken>` and a `Content-Length`. Your Worker
   routes that request to `receive(...)`, which streams the body to your storage
   and verifies size (and SHA-256, if provided).
3. **complete** — call `complete(...)` to read back the final, verified result
   and expose it through an MCP tool.

## Minimal example

```ts
import {
  createUploads,
  kvTransferStore,
  opaqueUploadToken,
  streamToUint8Array,
  type UploadDestination,
} from "mcp-upload-kit";

interface Env {
  UPLOAD_KV: KVNamespace;
}

// The one backend-specific piece: persist the verified bytes.
const destination: UploadDestination<{ objectKey: string }> = {
  async receive({ record, body }) {
    const bytes = await streamToUint8Array(body);
    await putObject(record.uploadId, bytes); // your storage call
    return { objectKey: record.uploadId };
  },
};

const uploads = (env: Env, origin: string) =>
  createUploads({
    store: kvTransferStore(env.UPLOAD_KV),
    baseUrl: origin,
    maxBytes: 30 * 1024 * 1024,
    token: opaqueUploadToken(),
  });

export const prepareUpload = (env: Env, origin: string) =>
  uploads(env, origin).prepare({
    owner: "user-123",
    name: "example.txt",
    size: 11,
    contentType: "text/plain",
  });

export const handleUpload = (request: Request, env: Env, origin: string, uploadId: string) =>
  uploads(env, origin).receive({ uploadId, request, destination });

export const completeUpload = (env: Env, origin: string, uploadId: string) =>
  uploads(env, origin).complete({ uploadId, owner: "user-123" });
```

For a complete MCP server (with `prepare_upload` / `complete_upload` tools), see
[`examples/mcp-server`](../examples/mcp-server) and, for chunked uploads,
[`examples/mcp-server-resumable`](../examples/mcp-server-resumable).

## Next steps

- [Concepts](concepts.md) — the model behind records, stores, tokens, receivers,
  and destinations.
- [Guides](guides.md) — token strategies, storage backends, overriding a
  pipeline step, resumable uploads, and MCP tool registration.
- [API reference](api-reference.md) — every export.
