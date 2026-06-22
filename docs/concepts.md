# Concepts

This page explains the model behind the kit. For function signatures see the
[API reference](api-reference.md).

## The upload controller

`createUploads(options)` returns a controller with `prepare`, `get`, `receive`,
`receiveWith`, `complete`, and `completeWith`. It ties together four pluggable
pieces:

| Piece | Option | Default | Responsibility |
| --- | --- | --- | --- |
| Store | `store` | — (required) | Persist the upload record. |
| Token | `token` | `opaqueUploadToken()` | Issue and verify the per-upload bearer token. |
| Receiver | `receiver` | `singleShotReceiver()` | Move bytes from the PUT into the destination and decide the HTTP outcome. |
| Destination | per `receive` call | — | Write bytes to your storage backend. |

## The upload record

Every upload is one record (`TransferUploadRecord`) that moves through a small
state machine:

```
prepare() ──► pending ──► completed   (size and SHA-256 verified)
                    └────► failed      (verification or backend error)
```

`prepare` writes a `pending` record; `receive` transitions it to `completed` or
`failed`. Once it leaves `pending`, further PUTs for that `uploadId` are
rejected. The record carries the declared `size`/`contentType`/`sha256`, the
measured `actualSize`/`actualSha256`, your destination's `result`, and
`metadata` you attach at prepare time.

> The built-in KV store is best-effort under concurrent PUTs. If you need strict
> single-use enforcement under parallel requests, supply a custom `TransferStore`
> with an atomic claim step.

## Stores

An `TransferStore<RecordValue>` is a `get`/`put` pair. `kvTransferStore(kv)` adapts a
Workers KV namespace; implement the interface yourself to back records with
Durable Objects, D1, or any other store.

## Token strategies

The `uploadToken` is a bearer credential the client presents on the PUT.

- `opaqueUploadToken()` — a random token stored on the record. Simple; the record
  is the source of truth.
- `jwtUploadToken(secret)` — a signed HS256 token that also carries the owner,
  upload ID, size, content type, and expiry. The record is still authoritative;
  the JWT is verified against it.

See [Guides → Token strategies](guides.md#token-strategies).

## Receivers

A **receiver** owns the transfer half of `receive`. By the time it runs, the
controller has already loaded the record, checked expiry, and verified the
bearer token — so a receiver only moves bytes and decides the HTTP response,
using `ctx.complete()` / `ctx.fail()` for record-store transitions.

Two receivers ship with the kit:

- `singleShotReceiver()` (default) — one PUT carries the whole body. It validates
  the request, streams the body through a SHA-256/size counter into the
  destination, then verifies size and SHA-256.
- `resumableReceiver()` — chunked uploads. It owns the `Content-Range` / `308`
  wire protocol and delegates the stateful work to a `ResumableUploadDestination`.

`singleShotReceiver({ validate, verify })` lets you override an individual step
while keeping the rest of the pipeline. This is the key design point: deviating
on one rule does not force you to reimplement the whole flow. See
[Guides → Overriding a pipeline step](guides.md#overriding-a-pipeline-step).

## Destinations

A **destination** is your backend-specific code.

- `UploadDestination` (for single-shot) exposes `receive` (consume the body
  stream, return a result), plus optional `cleanup` (called when bytes were
  stored but verification failed) and `response` (shape the success JSON).
- `ResumableUploadDestination` (for resumable) exposes `writeChunk` — it owns the
  only stateful parts of a chunked upload (committed offset, accumulated bytes,
  end-to-end SHA-256), typically backed by a Durable Object.

If a single-shot `receive` resolves without fully consuming `body`, the kit marks
the upload failed, because it cannot verify size or SHA-256.

## Downloads

`createDownloads` is the mirror image of `createUploads`. Where an upload tool
hands the client a PUT URL and bytes flow *in*, a download tool hands the client
a short-lived signed GET URL and bytes flow *out* — so large files never travel
through the MCP channel or the model's context.

- `prepare({ owner, name?, contentType?, size?, metadata? })` stores a grant and
  returns `{ downloadId, downloadUrl, downloadToken, expiresAt }`. It never
  returns bytes.
- `serve({ downloadId, request, source })` verifies the bearer token (constant
  time) and expiry, then streams `source.fetch(...)`'s response body to the
  client.

A `DownloadSource` is your backend fetch (the download counterpart of an
`UploadDestination`): given the grant record, return a `Response` whose body is
the file (e.g. Google Drive `alt=media`, a kintone file fetch, an R2 object). The
kit reuses the same `TransferStore` for download grants. See
[Guides → Download URLs](guides.md#download-urls).

## Response codes

`receive` returns JSON responses with these main status codes:

| Code | Meaning |
| --- | --- |
| `200` | Accepted and stored. |
| `308` | (resumable) chunk accepted; more expected — see the `Range` header. |
| `400` | Malformed request, invalid range, or `Content-Length` ≠ prepared size. |
| `401` | Missing or invalid bearer token. |
| `403` | Token owner mismatch. |
| `404` | Upload session not found. |
| `405` | Method is not `PUT`. |
| `409` | Already completed/failed, no destination, or SHA-256 mismatch. |
| `410` | Upload session expired. |
| `411` | Missing `Content-Length`. |
| `413` | Body exceeds the configured or prepared maximum. |
| `502` | Destination threw, or returned before fully consuming the body. |

## Where the kit stops

Your application still owns:

- authenticating users before `prepare`
- choosing the upload `owner` and `metadata`
- routing `PUT /upload/:uploadId` to `receive` / `receiveWith`
- the destination that writes to your storage backend
- what a completed upload exposes through MCP tools
- stronger cleanup/rollback of backend objects when you need it
