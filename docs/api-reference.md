# API reference

Everything is exported from the package root:

```ts
import { createUploads /* ... */ } from "mcp-upload-kit";
```

The package is `0.x`; APIs may still change before `1.0.0`. See
[`CHANGELOG.md`](../CHANGELOG.md).

## Upload controller

### `createUploads(options)`

```ts
createUploads<Result, Metadata, RecordValue, Dest>(options): {
  prepare(input): Promise<UploadPrepareResult>;
  get(uploadId): Promise<RecordValue | null>;
  receive(input): Promise<Response>;
  receiveWith(input): Promise<Response>;
  complete(input): Promise<RecordValue>;
  completeWith({ uploadId, owner?, toResult }): Promise<Output>;
}
```

Options (`CreateUploadsOptions`):

| Field | Default | Description |
| --- | --- | --- |
| `store` | — (required) | `UploadStore` for records. |
| `baseUrl` | — (required) | Origin used to build `uploadUrl`. |
| `maxBytes` | — (required) | Max upload size (number or numeric string). |
| `ttlSeconds` | `900` | Upload token / URL lifetime. |
| `token` | `opaqueUploadToken()` | `UploadTokenStrategy`. |
| `uploadPath` | `/upload` | Path segment used in `uploadUrl`. |
| `receiver` | `singleShotReceiver()` | `UploadReceiver` (transfer strategy). |

- `prepare({ owner, name, size, contentType, sha256?, metadata? })` writes a
  `pending` record and returns `{ uploadId, uploadUrl, uploadToken, expiresAt }`.
- `receive({ uploadId, request, destination })` / `receiveWith({ uploadId,
  request, selectDestination })` handle the PUT and return a `Response`.
- `complete({ uploadId, owner? })` returns the record if `completed`, else throws.

## Receivers

### `singleShotReceiver(steps?)`

```ts
singleShotReceiver<Result, RecordValue>(
  steps?: Partial<SingleShotReceiverSteps<Result, RecordValue>>,
): UploadReceiver
```

Default receiver: one PUT carries the whole body. Overridable steps:

- `validate(ctx): UploadRequestValidation` — pre-transfer check (default:
  exact-size single PUT).
- `verify({ ctx, actualSize, actualSha256 }): UploadVerifyResult` — post-transfer
  policy (default: size + optional SHA-256). `{ ok: false, reason, response }`
  fails the record (running destination `cleanup`) and returns `response`.

### `resumableReceiver()`

```ts
resumableReceiver<Result, RecordValue>(): UploadReceiver
```

Chunked uploads. Owns the `Content-Range` / `308` protocol and delegates state to
the selected `ResumableUploadDestination`.

## Stores

### `kvUploadStore(kv, prefix?)`

```ts
kvUploadStore<RecordValue>(kv: UploadKvNamespace, prefix = "upload:"): UploadStore<RecordValue>
```

Adapts a Workers KV namespace. Implement `UploadStore` for other backends.

## Token strategies

```ts
opaqueUploadToken(byteLength = 32): UploadTokenStrategy
jwtUploadToken(secret: string): UploadTokenStrategy
```

## MCP helpers

```ts
createUploadMcp(options): UploadMcpBuilder
createUploadMcpBuilder({ uploads, getOwner?, ... }): UploadMcpBuilder
registerCompleteUploadTool(server, { uploads, getOwner?, toResult, name?, title?, description? }): void
standardUploadInput({ extra?, contentType?, maxSize? }?): zod input shape
```

- `createUploadMcp` builds the controller and the MCP builder together; use
  `.addPurpose(name, config)` then `.registerTools(server, getOwner)` and
  `.receive(request, uploadId)`.
- `standardUploadInput` returns `{ name, size, contentType, sha256? }` (plus any
  `extra` Zod fields) for a tool's `inputSchema`.

## Primitives

```ts
createUploadId(): string
createUploadToken(byteLength = 32): string
extractBearerToken(input: Headers | Request | string | null): string | null
uploadKey(uploadId: string, prefix = "upload:"): string
parseContentRange(value: string): ContentRange | null
validateUploadRequest({ request, maxBytes, expectedSize?, requireBody? }): UploadRequestValidation
jsonResponse(body: unknown, status = 200, headers = {}): Response
safeEqual(a: string, b: string): boolean
resolvePositiveInteger(value, fallback): number
```

### JWT / hashing

```ts
signUploadJwt(claims: UploadJwtClaims, secret: string): Promise<string>
verifyUploadJwt(token: string, secret: string): Promise<UploadJwtClaims>
verifyUploadToken // alias of verifyUploadJwt
sha256Hex(input: ArrayBuffer | Uint8Array | string): Promise<string>
bytesToHex(bytes: Uint8Array): string
createShaCountingStream(maxBytes: number): ShaCountingStream
streamToUint8Array(stream: ReadableStream<Uint8Array>): Promise<Uint8Array>
```

## Types

Controller / records: `UploadStatus`, `BaseUploadRecord`, `TransferUploadRecord`,
`UploadPrepareResult`, `UploadStore`, `UploadKvNamespace`,
`CreateUploadsOptions`, `PrepareUploadInput`, `ReceiveUploadInput`,
`ReceiveUploadWithInput`, `CompleteUploadInput`, `CompleteUploadWithInput`,
`CompleteUploadController`, `UploadMcpController`.

Tokens: `UploadTokenStrategy`, `UploadTokenIssueInput`, `UploadTokenVerification`,
`UploadJwtClaims`.

Receivers / destinations: `UploadReceiver`, `UploadReceiverContext`,
`UploadVerifyResult`, `SingleShotReceiverSteps`, `UploadDestination`,
`UploadDestinationInput`, `ResumableUploadDestination`, `ResumableChunkInput`,
`ResumableChunkOutcome`.

Requests / streams: `ContentRange`, `ValidateUploadRequestOptions`,
`UploadRequestValidation`, `ShaCountingStream`.

MCP: `McpInputSchema`, `StandardUploadInputShape`, `McpToolResult`,
`McpToolRegistrar`, `RegisterCompleteUploadToolOptions`, `UploadMcpPurposeConfig`,
`CreateUploadMcpBuilderOptions`, `UploadMcpBuilder`, `CreateUploadMcpOptions`.
