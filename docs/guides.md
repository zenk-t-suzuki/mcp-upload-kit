# Guides

Task-oriented recipes. See [Concepts](concepts.md) for the model and the
[API reference](api-reference.md) for signatures.

- [Token strategies](#token-strategies)
- [Implementing a storage destination](#implementing-a-storage-destination)
- [Overriding a pipeline step](#overriding-a-pipeline-step)
- [Resumable (chunked) uploads](#resumable-chunked-uploads)
- [Download URLs](#download-urls)
- [Custom upload store](#custom-upload-store)
- [Registering MCP tools](#registering-mcp-tools)

## Token strategies

Pick how the per-upload bearer token is issued and verified.

```ts
import { opaqueUploadToken, jwtUploadToken } from "mcp-upload-kit";

// Random token stored on the record. Default; works well with KV sessions.
createUploads({ store, baseUrl, maxBytes, token: opaqueUploadToken() });

// Signed HS256 token that also carries owner / uploadId / size / expiry.
createUploads({ store, baseUrl, maxBytes, token: jwtUploadToken(env.JWT_SIGNING_KEY) });
```

Use a cryptographically random signing secret of at least 32 bytes, keep it in
your deployment's secret manager, and remember that rotating it invalidates
in-flight upload tokens — coordinate rotation with your upload TTL.

You can also implement `UploadTokenStrategy` directly for a custom scheme.

## Implementing a storage destination

A destination is the only backend-specific code in a single-shot upload.

```ts
import { type UploadDestination } from "mcp-upload-kit";

const destination: UploadDestination<{ objectKey: string }> = {
  // Must consume the full body stream before resolving.
  async receive({ record, body, contentLength }) {
    await putObject(record.uploadId, body, {
      contentLength,
      contentType: record.contentType,
    });
    return { objectKey: record.uploadId };
  },
  // Called when bytes were stored but verification later failed.
  async cleanup({ result }) {
    await deleteObject(result.objectKey);
  },
  // Optional: shape the success JSON the client receives.
  response({ result, actualSize, actualSha256 }) {
    return { accepted: true, ...result, actualSize, actualSha256 };
  },
};
```

Rules:

- Resolving without fully consuming `body` marks the upload failed (size/SHA-256
  cannot be verified).
- Throwing from `receive` marks the upload failed and returns `502`.
- `cleanup` runs when bytes were stored but verification failed (e.g. SHA-256
  mismatch); keep it best-effort.

## Overriding a pipeline step

`singleShotReceiver` is built from individually overridable steps. Override only
the one that differs; `validate`, streaming, cleanup, and the success response
keep their defaults.

```ts
import { createUploads, singleShotReceiver, jsonResponse } from "mcp-upload-kit";

createUploads({
  store,
  baseUrl,
  maxBytes,
  // The backend verifies integrity itself, so we keep the size check but drop
  // the kit's client-supplied SHA-256 comparison.
  receiver: singleShotReceiver({
    verify: ({ ctx, actualSize }) =>
      actualSize === ctx.record.size
        ? { ok: true }
        : {
            ok: false,
            reason: "size mismatch",
            response: jsonResponse({ error: "size mismatch" }, 409),
          },
  }),
});
```

- `validate(ctx)` runs before the transfer (default: exact-size single PUT).
- `verify({ ctx, actualSize, actualSha256 })` runs after (default: size +
  optional SHA-256). Returning `{ ok: false, reason, response }` fails the record
  (running destination `cleanup`) and returns your `response`.

## Resumable (chunked) uploads

Swap in `resumableReceiver()` and provide a `ResumableUploadDestination`. The kit
owns the `Content-Range` / `308` protocol; your destination owns the only
stateful parts (offset, accumulated bytes, end-to-end SHA-256) — on Cloudflare,
usually a Durable Object keyed by `uploadId`.

```ts
import {
  createUploads,
  resumableReceiver,
  sha256Hex,
  type TransferUploadRecord,
  type ResumableUploadDestination,
} from "mcp-upload-kit";

type Rec = TransferUploadRecord<{ objectKey: string }>;

const destination: ResumableUploadDestination<{ objectKey: string }, Rec> = {
  async writeChunk({ record, chunk, range }) {
    const offset = await loadOffset(record.uploadId);
    if (range.start !== offset) {
      return { status: "error", httpStatus: 409, message: `expected offset ${offset}` };
    }
    await appendBytes(record.uploadId, chunk);
    if (range.end + 1 < range.total) {
      return { status: "incomplete", nextOffset: range.end + 1 };
    }
    const all = await readAll(record.uploadId);
    return {
      status: "complete",
      result: { objectKey: record.uploadId },
      actualSize: all.byteLength,
      actualSha256: await sha256Hex(all),
    };
  },
};

const uploads = createUploads<
  { objectKey: string },
  unknown,
  Rec,
  ResumableUploadDestination<{ objectKey: string }, Rec>
>({
  store,
  baseUrl,
  maxBytes,
  receiver: resumableReceiver(),
});
```

The client PUTs each chunk with `Content-Range: bytes <start>-<end>/<total>`. The
receiver replies `308` (with a `Range` header) until the final chunk completes.
See [`examples/mcp-server-resumable`](../examples/mcp-server-resumable) for a
runnable version.

## Download URLs

To let a tool return a file without putting its bytes through the MCP channel,
use `createDownloads`. The tool issues a short-lived signed URL; a `GET` route
verifies it and streams the bytes from your backend.

```ts
import { createDownloads, kvTransferStore, type DownloadSource } from "mcp-upload-kit";

type Meta = { fileId: string };

const downloads = createDownloads<Meta>({
  store: kvTransferStore(env.UPLOAD_KV, "download:"),
  baseUrl: env.WORKER_BASE_URL,
  ttlSeconds: 900,
});

// 1. In a `download_file` MCP tool — return the URL, not the bytes:
const grant = await downloads.prepare({
  owner: userId,
  name: meta.name,
  contentType: meta.mimeType,
  size: meta.size,
  metadata: { fileId },
});
return grant; // { downloadId, downloadUrl, downloadToken, expiresAt }

// 2. Your backend fetch (the download counterpart of UploadDestination):
const source: DownloadSource<Meta> = {
  async fetch({ record }) {
    const accessToken = await getAccessToken(record.owner);
    return fetch(`https://www.googleapis.com/drive/v3/files/${record.metadata!.fileId}?alt=media`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  },
};

// 3. Route `GET /download/:downloadId` here:
export const handleDownload = (request: Request, downloadId: string) =>
  downloads.serve({ downloadId, request, source });
```

The client fetches `GET <downloadUrl>` with `Authorization: Bearer <downloadToken>`.
`serve` returns `401` (bad/missing token), `404` (unknown id), `410` (expired),
`405` (non-GET), or `502` (source failed); on success it streams `200` with
`Content-Type` / `Content-Disposition` / `Content-Length` from the grant.

## Custom upload store

`kvTransferStore(kv)` covers Workers KV. For atomic single-use enforcement or a
different backend, implement `TransferStore`:

```ts
import { type TransferStore, type TransferUploadRecord } from "mcp-upload-kit";

function d1Store<R extends TransferUploadRecord>(db: D1Database): TransferStore<R> {
  return {
    async get(uploadId) {
      const row = await db.prepare("select json from uploads where id = ?").bind(uploadId).first<{ json: string }>();
      return row ? (JSON.parse(row.json) as R) : null;
    },
    async put(uploadId, record, ttlSeconds) {
      await db.prepare("insert or replace into uploads (id, json, expires) values (?, ?, ?)")
        .bind(uploadId, JSON.stringify(record), Date.now() + ttlSeconds * 1000)
        .run();
    },
  };
}
```

## Registering MCP tools

Use `createUploadMcp` to register purpose-specific `prepare_*` tools plus one
shared `complete_upload`:

```ts
import { createUploadMcp, standardUploadInput } from "mcp-upload-kit";
import { z } from "zod";

const builder = createUploadMcp({ store, baseUrl, maxBytes, token })
  .addPurpose("attachment", {
    inputSchema: standardUploadInput({ extra: { recordId: z.string().min(1) } }),
    metadata: (input) => ({ recordId: input.recordId }),
    destination,
  });

builder.registerTools(server, () => currentUserId());
// Route PUT /upload/:id to:
builder.receive(request, uploadId);
```

For a hand-rolled pair of tools (and to use a non-default receiver), register
`prepare_upload` yourself and use `registerCompleteUploadTool` for completion —
see [`examples/mcp-server`](../examples/mcp-server).
