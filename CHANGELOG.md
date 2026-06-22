# Changelog

## Unreleased

## 0.3.0

### Breaking

The kit now covers downloads as well as uploads, so a few shared primitives were
renamed to transfer-neutral names:

- `createUploadId` → `createTransferId`
- `createUploadToken` → `createTransferToken`
- `uploadKey` → `transferKey`
- `UploadStore` → `TransferStore`
- `kvUploadStore` → `kvTransferStore`

Upload-specific API (`createUploads`, `UploadDestination`, `singleShotReceiver`,
`resumableReceiver`, `opaqueUploadToken`, `jwtUploadToken`, `signUploadJwt`, …)
is unchanged.

### Added

- `createDownloads({ store, baseUrl, ttlSeconds?, downloadPath? })` — the mirror
  image of `createUploads`. `prepare()` issues a short-lived signed download URL
  (not the bytes); `serve()` verifies the grant (bearer + expiry) and streams the
  bytes from a `DownloadSource` straight to the client, so large files never pass
  through the MCP channel or the model context.
- `DownloadSource`, `TransferDownloadRecord`, `DownloadGrant`,
  `DownloadPrepareInput`, `CreateDownloadsOptions`, `ServeDownloadInput` types.

## 0.2.0

- Make the `receiveWith` pipeline composable via a pluggable `UploadReceiver`.
  `createUploads({ receiver })` defaults to `singleShotReceiver()` (identical
  behaviour to before) and accepts `singleShotReceiver({ validate, verify })` to
  override only individual steps, or `resumableReceiver()` for chunked
  `Content-Range` uploads.
- Add `resumableReceiver()` plus the `ResumableUploadDestination` contract: the
  kit owns the `Content-Range`/308 wire protocol and record transitions, while
  the destination owns cross-request state (offset, accumulated bytes,
  end-to-end sha256) — typically a Durable Object. Adopting resumable uploads no
  longer requires reimplementing the whole handler.
- Tighten package build output to the library entrypoint.
- Document install, runtime assumptions, upload flow, token strategies, and
  security responsibilities.
- Add project security policy and license text.
