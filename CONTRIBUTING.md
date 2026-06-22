# Contributing

Thanks for your interest in improving `mcp-upload-kit`.

## Development setup

```sh
npm install
npm test          # vitest
npm run typecheck # tsc --noEmit (covers src, test, and examples)
npm run build     # emits dist/src only
```

The library targets Web Platform APIs available in Cloudflare Workers
(`Request`, `Response`, `ReadableStream`, `TransformStream`, `crypto.subtle`,
`crypto.randomUUID`, `btoa`, `atob`). Avoid Node-only APIs.

## Pull requests

- Keep the public API backward compatible within a `0.x` minor when you can. New
  behaviour should be additive (a new option or function) with a sensible default
  that preserves existing behaviour.
- Add or update tests in `test/index.test.ts` for any behavioural change.
- Update [`docs/`](docs/), the `README.md` API list, and `CHANGELOG.md` when you
  add or change exported API.
- Run `npm test`, `npm run typecheck`, and `npm run build` before opening a PR.
- The `examples/` directory is typechecked. If you change an exported signature,
  update the examples so they keep compiling.

## Commit / changelog

- Describe user-facing changes under the `## Unreleased` heading in
  `CHANGELOG.md`.
- Releases are published as GitHub Release tarballs; see `CHANGELOG.md` for the
  version history.

## Project layout

| Path | Purpose |
| --- | --- |
| `src/index.ts` | The entire library (single entrypoint). |
| `test/index.test.ts` | Vitest suite. |
| `examples/` | Minimal, runnable MCP-server examples (typechecked, not published). |
| `docs/` | Long-form documentation. |
