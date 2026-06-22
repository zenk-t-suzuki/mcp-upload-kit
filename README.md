# mcp-upload-kit

Small TypeScript primitives for MCP servers that issue short-lived HTTPS upload
URLs, so large file bytes travel over a plain `PUT` instead of the MCP JSON-RPC
channel.

It is intentionally **not** a full upload framework. Your MCP server still owns
auth, authorization, storage, and backend-specific upload calls. The kit handles
the parts that get copied between implementations: upload IDs, bearer tokens,
HS256 upload JWTs, `Content-Range`, request validation, SHA-256 streaming, JSON
responses, KV keys, and small MCP tool helpers.

- **Composable** — one `createUploads` controller wires a store, token strategy,
  receiver, and destination. Swap any piece; override a single pipeline step
  without reimplementing the rest.
- **Single-shot or resumable** — `singleShotReceiver()` (default) or
  `resumableReceiver()` for chunked `Content-Range` uploads.
- **Workers-native** — targets Web Platform APIs (Cloudflare Workers et al.).

## Install

```sh
npm install https://github.com/zenk-t-suzuki/mcp-upload-kit/releases/download/v0.2.0/mcp-upload-kit-0.2.0.tgz zod
```

Distributed via GitHub Releases (not yet on the npm registry). `zod` is a peer
dependency so MCP tool schemas share the host server's Zod copy. Import from the
package root only:

```ts
import { createUploads } from "mcp-upload-kit";
```

## Quick start

```ts
import { createUploads, kvUploadStore, opaqueUploadToken, streamToUint8Array } from "mcp-upload-kit";

const uploads = createUploads({
  store: kvUploadStore(env.UPLOAD_KV),
  baseUrl: origin,
  maxBytes: 30 * 1024 * 1024,
  token: opaqueUploadToken(),
});

// 1. prepare (from an authenticated MCP tool)
const { uploadId, uploadUrl, uploadToken } = await uploads.prepare({
  owner: "user-123", name: "example.txt", size: 11, contentType: "text/plain",
});

// 2. route PUT /upload/:uploadId here
await uploads.receive({
  uploadId,
  request,
  destination: {
    async receive({ record, body }) {
      await putObject(record.uploadId, await streamToUint8Array(body));
      return { objectKey: record.uploadId };
    },
  },
});

// 3. complete
const record = await uploads.complete({ uploadId, owner: "user-123" });
```

## Documentation

- [Getting started](docs/getting-started.md) — install, requirements, the
  three-step flow, a minimal example.
- [Concepts](docs/concepts.md) — records, stores, tokens, receivers,
  destinations, the state machine, and response codes.
- [Guides](docs/guides.md) — token strategies, storage destinations, overriding a
  pipeline step, resumable uploads, custom stores, MCP tool registration.
- [API reference](docs/api-reference.md) — every export.
- [Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md) ·
  [Security](SECURITY.md)

## Examples

Minimal, runnable MCP servers (`prepare_upload` + `complete_upload` tools plus a
PUT route) that differ only by receiver and destination:

- [`examples/mcp-server`](examples/mcp-server) — single-shot.
- [`examples/mcp-server-resumable`](examples/mcp-server-resumable) — chunked
  `Content-Range` uploads with a `ResumableUploadDestination`.

## Development

```sh
npm test          # vitest
npm run typecheck # tsc --noEmit (covers src, test, examples)
npm run build     # emits dist/src only
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
