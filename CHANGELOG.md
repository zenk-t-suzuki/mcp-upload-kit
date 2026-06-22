# Changelog

## Unreleased

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
