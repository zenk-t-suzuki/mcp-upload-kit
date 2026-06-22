import { sha256 } from "@noble/hashes/sha256";
import { z } from "zod";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type UploadStatus = "pending" | "completed" | "failed";

export interface BaseUploadRecord {
  status: UploadStatus;
  size: number;
  contentType: string;
  sha256?: string;
  expiresAt: string;
  actualSize?: number;
  actualSha256?: string;
  failureReason?: string;
}

export interface UploadPrepareResult {
  uploadId: string;
  uploadUrl: string;
  uploadToken: string;
  expiresAt: string;
}

export interface TransferStore<RecordValue> {
  get(uploadId: string): Promise<RecordValue | null>;
  put(uploadId: string, record: RecordValue, ttlSeconds: number): Promise<void>;
}

export interface UploadKvNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<unknown>;
}

export interface TransferUploadRecord<Result = unknown, Metadata = unknown> extends BaseUploadRecord {
  uploadId: string;
  owner: string;
  name: string;
  token?: string;
  metadata?: Metadata;
  result?: Result;
}

export interface UploadTokenIssueInput {
  uploadId: string;
  owner: string;
  name: string;
  size: number;
  contentType: string;
  sha256?: string;
  issuedAt: number;
  expiresAt: number;
}

export type UploadTokenVerification =
  | { ok: true }
  | { ok: false; status: number; message: string };

export interface UploadTokenStrategy<RecordValue extends TransferUploadRecord = TransferUploadRecord> {
  issue(input: UploadTokenIssueInput): Promise<string>;
  verify(input: {
    token: string;
    uploadId: string;
    record: RecordValue;
  }): Promise<UploadTokenVerification>;
}

export interface UploadDestinationInput<RecordValue extends TransferUploadRecord = TransferUploadRecord> {
  record: RecordValue;
  body: ReadableStream<Uint8Array>;
  contentLength: number;
  request: Request;
}

export interface UploadDestination<
  Result = unknown,
  RecordValue extends TransferUploadRecord<Result> = TransferUploadRecord<Result>,
> {
  receive(input: UploadDestinationInput<RecordValue>): Promise<Result>;
  cleanup?(input: {
    record: RecordValue;
    result: Result;
    reason: string;
  }): Promise<void>;
  response?(input: {
    record: RecordValue;
    result: Result;
    actualSize: number;
    actualSha256: string;
  }): unknown;
}

export interface CreateUploadsOptions<
  RecordValue extends TransferUploadRecord = TransferUploadRecord,
  Dest = UploadDestination<unknown, RecordValue>,
> {
  store: TransferStore<RecordValue>;
  baseUrl: string;
  maxBytes: number | string;
  ttlSeconds?: number;
  token?: UploadTokenStrategy<RecordValue>;
  uploadPath?: string;
  /**
   * Strategy that turns a verified PUT into a stored result. Defaults to
   * `singleShotReceiver()` (one PUT carries the whole body). Swap in
   * `resumableReceiver()` for chunked `Content-Range` uploads, or pass a
   * `singleShotReceiver({ validate, verify })` with only the step(s) you
   * want to override — the rest keep their defaults.
   */
  receiver?: UploadReceiver<any, RecordValue, Dest>;
}

export interface PrepareUploadInput<Metadata = unknown> {
  owner: string;
  name: string;
  size: number;
  contentType: string;
  sha256?: string;
  metadata?: Metadata;
}

export interface ReceiveUploadInput<
  Result,
  RecordValue extends TransferUploadRecord<Result> = TransferUploadRecord<Result>,
  Dest = UploadDestination<Result, RecordValue>,
> {
  uploadId: string;
  request: Request;
  destination: Dest;
}

export interface ReceiveUploadWithInput<
  Result,
  RecordValue extends TransferUploadRecord<Result> = TransferUploadRecord<Result>,
  Dest = UploadDestination<Result, RecordValue>,
> {
  uploadId: string;
  request: Request;
  selectDestination(record: RecordValue): Dest | null | undefined;
}

export interface CompleteUploadInput {
  uploadId: string;
  owner?: string;
}

export interface CompleteUploadWithInput<Output, RecordValue extends TransferUploadRecord = TransferUploadRecord>
  extends CompleteUploadInput {
  toResult(record: RecordValue): Output;
}

export interface CompleteUploadController<RecordValue extends TransferUploadRecord = TransferUploadRecord> {
  completeWith<Output>(input: CompleteUploadWithInput<Output, RecordValue>): Promise<Output>;
}

export interface UploadMcpController<
  Result,
  Metadata,
  RecordValue extends TransferUploadRecord<Result, Metadata>,
> extends CompleteUploadController<RecordValue> {
  prepare(input: PrepareUploadInput<Metadata>): Promise<UploadPrepareResult>;
  receiveWith(input: ReceiveUploadWithInput<Result, RecordValue>): Promise<Response>;
}

export type McpInputSchema = Record<string, z.ZodTypeAny>;
export type StandardUploadInputShape<Extra extends McpInputSchema = Record<string, never>> = {
  name: z.ZodString;
  size: z.ZodNumber;
  contentType: z.ZodTypeAny;
  sha256: z.ZodOptional<z.ZodString>;
} & Extra;

export interface McpToolResult extends Record<string, unknown> {
  structuredContent: Record<string, unknown>;
  content: Array<{ type: "text"; text: string }>;
}

export interface McpToolRegistrar {
  registerTool(
    name: string,
    config: {
      title?: string;
      description?: string;
      inputSchema: McpInputSchema;
      [key: string]: unknown;
    },
    handler: (input: Record<string, unknown>) => Promise<McpToolResult>,
  ): unknown;
}

export interface RegisterCompleteUploadToolOptions<
  RecordValue extends TransferUploadRecord,
  Output extends Record<string, unknown>,
> {
  uploads: CompleteUploadController<RecordValue>;
  getOwner?: () => string;
  toResult(record: RecordValue): Output;
  name?: string;
  title?: string;
  description?: string;
}

export interface UploadMcpPurposeConfig<
  Input extends Record<string, unknown>,
  Result,
  Metadata extends { purpose: string },
  RecordValue extends TransferUploadRecord<Result, Metadata>,
  Output extends Record<string, unknown>,
> {
  toolName?: string;
  title?: string;
  description?: string;
  inputSchema: { [Key in keyof Input]: z.ZodTypeAny };
  destination: UploadDestination<Result, RecordValue>;
  metadata?(input: Input): Omit<Metadata, "purpose">;
  prepare?(input: Input): Omit<PrepareUploadInput<Metadata>, "owner">;
  complete?(record: RecordValue): Output;
}

export interface CreateUploadMcpBuilderOptions<
  Result,
  Metadata extends { purpose: string },
  RecordValue extends TransferUploadRecord<Result, Metadata>,
> {
  uploads: UploadMcpController<Result, Metadata, RecordValue>;
  getOwner?: () => string;
  completeToolName?: string;
  completeTitle?: string;
  completeDescription?: string;
}

export interface UploadMcpBuilder<
  Result,
  Metadata extends { purpose: string },
  RecordValue extends TransferUploadRecord<Result, Metadata>,
  Output extends Record<string, unknown> = Record<string, unknown>,
> {
  addPurpose<Input extends Record<string, unknown>>(
    purpose: Metadata["purpose"] & string,
    config: UploadMcpPurposeConfig<Input, Result, Metadata, RecordValue, Output>,
  ): UploadMcpBuilder<Result, Metadata, RecordValue, Output>;
  registerTools(server: McpToolRegistrar, getOwnerOverride?: () => string): void;
  receive(request: Request, uploadId: string): Promise<Response>;
}

export interface CreateUploadMcpOptions<
  Result,
  Metadata extends { purpose: string },
  RecordValue extends TransferUploadRecord<Result, Metadata>,
> extends CreateUploadsOptions<RecordValue>,
    Omit<CreateUploadMcpBuilderOptions<Result, Metadata, RecordValue>, "uploads"> {}

export interface ContentRange {
  start: number;
  end: number;
  total: number;
}

export interface UploadJwtClaims {
  iss: "upload-mcp";
  aud: "upload-app";
  sub: string;
  uploadId: string;
  filename: string;
  maxSize: number;
  contentType: string;
  sha256?: string;
  iat: number;
  exp: number;
}

export interface ShaCountingStream {
  stream: TransformStream<Uint8Array, Uint8Array>;
  finalize: () => { sha256: string; size: number };
}

export interface ValidateUploadRequestOptions {
  request: Request;
  maxBytes: number;
  expectedSize?: number;
  requireBody?: boolean;
}

export type UploadRequestValidation =
  | { ok: true; contentLength: number; contentRange: ContentRange | null }
  | { ok: false; response: Response };

const DEFAULT_UPLOAD_TTL_SECONDS = 900;
const DEFAULT_UPLOAD_KV_TTL_GRACE_SECONDS = 3600;

export function createTransferId(): string {
  return crypto.randomUUID();
}

export function createTransferToken(byteLength = 32): string {
  if (!Number.isInteger(byteLength) || byteLength <= 0) {
    throw new Error("byteLength must be a positive integer");
  }
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return base64UrlEncode(bytes);
}

export function extractBearerToken(input: Headers | Request | string | null): string | null {
  const value =
    typeof input === "string"
      ? input
      : input instanceof Request
        ? input.headers.get("Authorization")
        : input?.get("Authorization");
  if (!value) return null;
  const match = /^Bearer (.+)$/.exec(value);
  return match?.[1] ?? null;
}

export function transferKey(uploadId: string, prefix = "upload:"): string {
  return prefix + uploadId;
}

export function kvTransferStore<RecordValue>(
  kv: UploadKvNamespace,
  prefix = "upload:",
): TransferStore<RecordValue> {
  return {
    async get(uploadId) {
      const raw = await kv.get(transferKey(uploadId, prefix));
      return raw ? (JSON.parse(raw) as RecordValue) : null;
    },
    async put(uploadId, record, ttlSeconds) {
      await kv.put(transferKey(uploadId, prefix), JSON.stringify(record), {
        expirationTtl: Math.max(60, ttlSeconds),
      });
    },
  };
}

export function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

export function parseContentRange(value: string): ContentRange | null {
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/.exec(value.trim());
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || !Number.isSafeInteger(total)) {
    return null;
  }
  if (start < 0 || end < start || total <= 0 || end >= total) return null;
  return { start, end, total };
}

export function validateUploadRequest({
  request,
  maxBytes,
  expectedSize,
  requireBody = true,
}: ValidateUploadRequestOptions): UploadRequestValidation {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("maxBytes must be a positive safe integer");
  }
  if (expectedSize !== undefined && (!Number.isSafeInteger(expectedSize) || expectedSize <= 0)) {
    throw new Error("expectedSize must be a positive safe integer");
  }
  if (request.method !== "PUT") {
    return { ok: false, response: jsonResponse({ error: "method not allowed" }, 405, { Allow: "PUT" }) };
  }
  if (requireBody && !request.body) {
    return { ok: false, response: jsonResponse({ error: "missing body" }, 400) };
  }
  const contentLength = Number(
    request.headers.get("Content-Length") ?? request.headers.get("X-Upload-Content-Length") ?? "",
  );
  if (!Number.isSafeInteger(contentLength) || contentLength <= 0) {
    return { ok: false, response: jsonResponse({ error: "Content-Length required" }, 411) };
  }
  if (contentLength > maxBytes || (expectedSize !== undefined && contentLength > expectedSize)) {
    return { ok: false, response: jsonResponse({ error: `body exceeds maxSize ${maxBytes}` }, 413) };
  }
  if (expectedSize !== undefined && contentLength !== expectedSize) {
    return {
      ok: false,
      response: jsonResponse({ error: `Content-Length must equal expected size ${expectedSize}` }, 400),
    };
  }
  const rangeHeader = request.headers.get("Content-Range");
  if (!rangeHeader) return { ok: true, contentLength, contentRange: null };
  const contentRange = parseContentRange(rangeHeader);
  if (!contentRange) {
    return {
      ok: false,
      response: jsonResponse({ error: `invalid Content-Range: ${rangeHeader}` }, 400),
    };
  }
  if (contentRange.end - contentRange.start + 1 !== contentLength) {
    return { ok: false, response: jsonResponse({ error: "Content-Range size != Content-Length" }, 400) };
  }
  if (
    expectedSize !== undefined &&
    (contentRange.start !== 0 || contentRange.end !== expectedSize - 1 || contentRange.total !== expectedSize)
  ) {
    return {
      ok: false,
      response: jsonResponse({ error: "Content-Range must cover the full expected size" }, 400),
    };
  }
  return { ok: true, contentLength, contentRange };
}

export function opaqueUploadToken(byteLength = 32): UploadTokenStrategy {
  return {
    async issue() {
      return createTransferToken(byteLength);
    },
    async verify({ token, record }) {
      if (!record.token || !safeEqual(token, record.token)) {
        return { ok: false, status: 401, message: "missing or invalid upload token" };
      }
      return { ok: true };
    },
  };
}

export function jwtUploadToken(secret: string): UploadTokenStrategy {
  return {
    async issue(input) {
      return signUploadJwt(
        {
          iss: "upload-mcp",
          aud: "upload-app",
          sub: input.owner,
          uploadId: input.uploadId,
          filename: input.name,
          maxSize: input.size,
          contentType: input.contentType,
          ...(input.sha256 ? { sha256: input.sha256 } : {}),
          iat: input.issuedAt,
          exp: input.expiresAt,
        },
        secret,
      );
    },
    async verify({ token, uploadId, record }) {
      let claims: UploadJwtClaims;
      try {
        claims = await verifyUploadJwt(token, secret);
      } catch (err) {
        return { ok: false, status: 401, message: `invalid token: ${(err as Error).message}` };
      }
      if (claims.uploadId !== uploadId) {
        return { ok: false, status: 401, message: "uploadId mismatch" };
      }
      if (claims.sub !== record.owner) {
        return { ok: false, status: 403, message: "owner mismatch" };
      }
      if (claims.maxSize !== record.size) {
        return { ok: false, status: 400, message: "size mismatch" };
      }
      if (claims.contentType !== record.contentType) {
        return { ok: false, status: 400, message: "contentType mismatch" };
      }
      return { ok: true };
    },
  };
}

/**
 * Shared services handed to an {@link UploadReceiver}. The orchestrator has
 * already loaded the record, checked expiry and verified the bearer token, so a
 * receiver only has to move bytes and decide the HTTP outcome. `complete` and
 * `fail` own the record-store transitions; a receiver runs its own backend
 * cleanup separately (it owns the destination).
 */
export interface UploadReceiverContext<
  Result,
  RecordValue extends TransferUploadRecord<Result> = TransferUploadRecord<Result>,
> {
  uploadId: string;
  request: Request;
  record: RecordValue;
  /** Configured `maxBytes` for this controller (already resolved to a number). */
  maxBytes: number;
  /** Persist a `completed` record and return the stored value. */
  complete(input: { actualSize: number; actualSha256: string; result: Result }): Promise<RecordValue>;
  /** Persist a `failed` record. Backend cleanup is the receiver's responsibility. */
  fail(reason: string): Promise<void>;
}

/**
 * Pluggable transfer strategy for `receiveWith`. The default is
 * {@link singleShotReceiver}; {@link resumableReceiver} handles chunked uploads.
 * Implement this directly only for a genuinely new transfer protocol.
 */
export interface UploadReceiver<
  Result = unknown,
  RecordValue extends TransferUploadRecord<Result> = TransferUploadRecord<Result>,
  Dest = UploadDestination<Result, RecordValue>,
> {
  handle(input: {
    ctx: UploadReceiverContext<Result, RecordValue>;
    selectDestination(record: RecordValue): Dest | null | undefined;
  }): Promise<Response>;
}

export type UploadVerifyResult =
  | { ok: true }
  | { ok: false; reason: string; response: Response };

/**
 * Individually-overridable steps of {@link singleShotReceiver}. Omit a step to
 * keep its default — overriding `verify` does not force you to reimplement
 * `validate`, streaming, cleanup or the success response.
 */
export interface SingleShotReceiverSteps<
  Result,
  RecordValue extends TransferUploadRecord<Result> = TransferUploadRecord<Result>,
> {
  /** Pre-transfer request check. Default: exact-size single PUT, no partial ranges. */
  validate(ctx: UploadReceiverContext<Result, RecordValue>): UploadRequestValidation;
  /** Post-transfer policy on the measured bytes. Default: size + optional sha256 match. */
  verify(input: {
    ctx: UploadReceiverContext<Result, RecordValue>;
    actualSize: number;
    actualSha256: string;
  }): UploadVerifyResult;
}

export interface ResumableChunkInput<
  Result,
  RecordValue extends TransferUploadRecord<Result> = TransferUploadRecord<Result>,
> {
  record: RecordValue;
  chunk: Uint8Array;
  range: ContentRange;
  request: Request;
}

export type ResumableChunkOutcome<Result> =
  | { status: "incomplete"; nextOffset: number }
  | { status: "complete"; result: Result; actualSize: number; actualSha256: string }
  | { status: "error"; httpStatus: number; message: string };

/**
 * Backend contract for resumable uploads. The kit owns the HTTP `Content-Range`
 * / 308 protocol and the record transitions; the implementation owns the only
 * stateful parts — accumulating bytes across requests, tracking the committed
 * offset, and computing the end-to-end sha256 (typically a Durable Object).
 */
export interface ResumableUploadDestination<
  Result = unknown,
  RecordValue extends TransferUploadRecord<Result> = TransferUploadRecord<Result>,
> {
  writeChunk(input: ResumableChunkInput<Result, RecordValue>): Promise<ResumableChunkOutcome<Result>>;
  cleanup?(input: { record: RecordValue; reason: string }): Promise<void>;
  response?(input: {
    record: RecordValue;
    result: Result;
    actualSize: number;
    actualSha256: string;
  }): unknown;
}

export function createUploads<
  Result = unknown,
  Metadata = unknown,
  RecordValue extends TransferUploadRecord<Result, Metadata> = TransferUploadRecord<Result, Metadata>,
  Dest = UploadDestination<Result, RecordValue>,
>({
  store,
  baseUrl,
  maxBytes,
  ttlSeconds = DEFAULT_UPLOAD_TTL_SECONDS,
  token = opaqueUploadToken() as UploadTokenStrategy<RecordValue>,
  uploadPath = "/upload",
  receiver = singleShotReceiver<Result, RecordValue>() as unknown as UploadReceiver<any, RecordValue, Dest>,
}: CreateUploadsOptions<RecordValue, Dest>) {
  const resolvedMaxBytes = resolvePositiveInteger(maxBytes, 30 * 1024 * 1024);
  const origin = baseUrl.replace(/\/$/, "");
  const normalizedUploadPath = uploadPath.startsWith("/") ? uploadPath : `/${uploadPath}`;
  const storeTtl = ttlSeconds + DEFAULT_UPLOAD_KV_TTL_GRACE_SECONDS;

  async function prepare(input: PrepareUploadInput<Metadata>): Promise<UploadPrepareResult> {
    validatePrepareUploadInput(input, resolvedMaxBytes);
    const uploadId = createTransferId();
    const issuedAt = Math.floor(Date.now() / 1000);
    const expiresAtSeconds = issuedAt + ttlSeconds;
    const uploadToken = await token.issue({
      uploadId,
      owner: input.owner,
      name: input.name,
      size: input.size,
      contentType: input.contentType,
      ...(input.sha256 ? { sha256: input.sha256.toLowerCase() } : {}),
      issuedAt,
      expiresAt: expiresAtSeconds,
    });
    const expiresAt = new Date(expiresAtSeconds * 1000).toISOString();
    const record = {
      status: "pending",
      uploadId,
      owner: input.owner,
      name: input.name,
      size: input.size,
      contentType: input.contentType,
      ...(input.sha256 ? { sha256: input.sha256.toLowerCase() } : {}),
      token: uploadToken,
      expiresAt,
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    } as RecordValue;
    await store.put(uploadId, record, storeTtl);
    return {
      uploadId,
      uploadToken,
      uploadUrl: `${origin}${normalizedUploadPath}/${uploadId}`,
      expiresAt,
    };
  }

  async function get(uploadId: string): Promise<RecordValue | null> {
    return store.get(uploadId);
  }

  async function receive({
    uploadId,
    request,
    destination,
  }: ReceiveUploadInput<Result, RecordValue, Dest>): Promise<Response> {
    return receiveWith({
      uploadId,
      request,
      selectDestination: () => destination,
    });
  }

  async function receiveWith({
    uploadId,
    request,
    selectDestination,
  }: ReceiveUploadWithInput<Result, RecordValue, Dest>): Promise<Response> {
    const record = await store.get(uploadId);
    if (!record) return jsonResponse({ error: "upload session not found" }, 404);
    if (record.status !== "pending") {
      return jsonResponse({ error: `upload not pending (status=${record.status})` }, 409);
    }
    if (Date.parse(record.expiresAt) < Date.now()) {
      return jsonResponse({ error: "upload session expired" }, 410);
    }

    const bearer = extractBearerToken(request);
    if (!bearer) return jsonResponse({ error: "missing Authorization: Bearer" }, 401);
    const verified = await token.verify({ token: bearer, uploadId, record });
    if (!verified.ok) return jsonResponse({ error: verified.message }, verified.status);

    const ctx: UploadReceiverContext<Result, RecordValue> = {
      uploadId,
      request,
      record,
      maxBytes: resolvedMaxBytes,
      async complete({ actualSize, actualSha256, result }) {
        const completed = {
          ...record,
          status: "completed",
          actualSize,
          actualSha256,
          result,
        } as RecordValue;
        await store.put(uploadId, completed, storeTtl);
        return completed;
      },
      async fail(reason) {
        await store.put(
          uploadId,
          { ...record, status: "failed", failureReason: reason } as RecordValue,
          storeTtl,
        );
      },
    };

    return receiver.handle({ ctx, selectDestination });
  }

  async function complete({ uploadId, owner }: CompleteUploadInput): Promise<RecordValue> {
    const record = await store.get(uploadId);
    if (!record) throw new Error(`uploadId not found: ${uploadId}`);
    if (owner !== undefined && record.owner !== owner) {
      throw new Error("uploadId belongs to a different owner");
    }
    if (record.status !== "completed") {
      throw new Error(
        record.status === "failed"
          ? `upload failed: ${record.failureReason ?? "unknown"}`
          : `upload not completed (status=${record.status})`,
      );
    }
    return record;
  }

  async function completeWith<Output>({
    uploadId,
    owner,
    toResult,
  }: CompleteUploadWithInput<Output, RecordValue>): Promise<Output> {
    const record = await complete({ uploadId, owner });
    return toResult(record);
  }

  return {
    prepare,
    get,
    receive,
    receiveWith,
    complete,
    completeWith,
  };
}

/**
 * Default {@link UploadReceiver}: one PUT carries the whole body. Reproduces the
 * historical pipeline (exact-size validation, streaming sha256 + size check,
 * backend cleanup on failure). Pass `validate` and/or `verify` to override only
 * those steps; everything else keeps its default.
 */
export function singleShotReceiver<
  Result = unknown,
  RecordValue extends TransferUploadRecord<Result> = TransferUploadRecord<Result>,
>(
  steps: Partial<SingleShotReceiverSteps<Result, RecordValue>> = {},
): UploadReceiver<Result, RecordValue, UploadDestination<Result, RecordValue>> {
  const validate = steps.validate ?? defaultSingleShotValidate;
  const verify = steps.verify ?? defaultSingleShotVerify;

  return {
    async handle({ ctx, selectDestination }) {
      const destination = selectDestination(ctx.record);
      if (!destination) {
        return jsonResponse({ error: "no upload destination for this upload" }, 409);
      }

      const checked = validate(ctx);
      if (!checked.ok) return checked.response;

      const counter = createShaCountingStream(ctx.record.size);
      let result: Result | undefined;
      let hasResult = false;
      let actualSha256: string;
      let actualSize: number;
      try {
        result = await destination.receive({
          record: ctx.record,
          request: ctx.request,
          contentLength: checked.contentLength,
          body: ctx.request.body!.pipeThrough(counter.stream),
        });
        hasResult = true;
        const finalized = counter.finalize();
        actualSha256 = finalized.sha256;
        actualSize = finalized.size;
      } catch (err) {
        const reason = err instanceof Error ? err.message : "upload failed";
        await ctx.fail(reason);
        if (hasResult) await runCleanup(destination, ctx.record, result as Result, reason);
        return jsonResponse({ error: "upload failed", reason }, 502);
      }

      const verdict = verify({ ctx, actualSize, actualSha256 });
      if (!verdict.ok) {
        await ctx.fail(verdict.reason);
        await runCleanup(destination, ctx.record, result as Result, verdict.reason);
        return verdict.response;
      }

      const completed = await ctx.complete({ actualSize, actualSha256, result: result as Result });
      const body =
        destination.response?.({ record: completed, result: result as Result, actualSize, actualSha256 }) ?? {
          accepted: true,
          actualSize,
          actualSha256,
          result,
        };
      return jsonResponse(body);
    },
  };
}

/**
 * {@link UploadReceiver} for chunked, resumable uploads. The kit handles the
 * `Content-Range` / 308 wire protocol and record transitions; the selected
 * {@link ResumableUploadDestination} owns the cross-request state (offset,
 * accumulated bytes, end-to-end sha256) — usually a Durable Object.
 */
export function resumableReceiver<
  Result = unknown,
  RecordValue extends TransferUploadRecord<Result> = TransferUploadRecord<Result>,
>(): UploadReceiver<Result, RecordValue, ResumableUploadDestination<Result, RecordValue>> {
  return {
    async handle({ ctx, selectDestination }) {
      const destination = selectDestination(ctx.record);
      if (!destination) {
        return jsonResponse({ error: "no upload destination for this upload" }, 409);
      }
      if (!ctx.request.body) return jsonResponse({ error: "missing body" }, 400);

      const rangeHeader = ctx.request.headers.get("Content-Range");
      if (!rangeHeader) {
        return jsonResponse({ error: "Content-Range required for resumable upload" }, 400);
      }
      const range = parseContentRange(rangeHeader);
      if (!range) return jsonResponse({ error: `invalid Content-Range: ${rangeHeader}` }, 400);
      if (range.total !== ctx.record.size) {
        return jsonResponse(
          { error: `Content-Range total ${range.total} != size ${ctx.record.size}` },
          400,
        );
      }
      const contentLength = Number(
        ctx.request.headers.get("Content-Length") ?? ctx.request.headers.get("X-Upload-Content-Length") ?? "",
      );
      if (!Number.isSafeInteger(contentLength) || contentLength <= 0) {
        return jsonResponse({ error: "Content-Length required" }, 411);
      }
      if (range.end - range.start + 1 !== contentLength) {
        return jsonResponse({ error: "Content-Range size != Content-Length" }, 400);
      }

      const chunk = new Uint8Array(await ctx.request.arrayBuffer());

      let outcome: ResumableChunkOutcome<Result>;
      try {
        outcome = await destination.writeChunk({ record: ctx.record, chunk, range, request: ctx.request });
      } catch (err) {
        const reason = err instanceof Error ? err.message : "chunk write failed";
        await ctx.fail(reason);
        await runResumableCleanup(destination, ctx.record, reason);
        return jsonResponse({ error: "upload failed", reason }, 502);
      }

      if (outcome.status === "incomplete") {
        return jsonResponse({ status: "incomplete", nextOffset: outcome.nextOffset }, 308, {
          Range: `bytes=0-${outcome.nextOffset - 1}`,
        });
      }

      if (outcome.status === "error") {
        await ctx.fail(outcome.message);
        await runResumableCleanup(destination, ctx.record, outcome.message);
        return jsonResponse({ error: outcome.message }, outcome.httpStatus);
      }

      if (
        ctx.record.sha256 &&
        outcome.actualSha256 &&
        ctx.record.sha256.toLowerCase() !== outcome.actualSha256.toLowerCase()
      ) {
        const reason = "sha256 mismatch";
        await ctx.fail(reason);
        await runResumableCleanup(destination, ctx.record, reason);
        return jsonResponse(
          { error: reason, expected: ctx.record.sha256, actual: outcome.actualSha256 },
          409,
        );
      }

      const completed = await ctx.complete({
        actualSize: outcome.actualSize,
        actualSha256: outcome.actualSha256,
        result: outcome.result,
      });
      const body =
        destination.response?.({
          record: completed,
          result: outcome.result,
          actualSize: outcome.actualSize,
          actualSha256: outcome.actualSha256,
        }) ?? {
          accepted: true,
          actualSize: outcome.actualSize,
          actualSha256: outcome.actualSha256,
          result: outcome.result,
        };
      return jsonResponse(body);
    },
  };
}

function defaultSingleShotValidate<
  Result,
  RecordValue extends TransferUploadRecord<Result>,
>(ctx: UploadReceiverContext<Result, RecordValue>): UploadRequestValidation {
  return validateUploadRequest({
    request: ctx.request,
    maxBytes: Math.min(ctx.maxBytes, ctx.record.size),
    expectedSize: ctx.record.size,
  });
}

function defaultSingleShotVerify<
  Result,
  RecordValue extends TransferUploadRecord<Result>,
>({
  ctx,
  actualSize,
  actualSha256,
}: {
  ctx: UploadReceiverContext<Result, RecordValue>;
  actualSize: number;
  actualSha256: string;
}): UploadVerifyResult {
  if (actualSize !== ctx.record.size) {
    return {
      ok: false,
      reason: `size mismatch: expected ${ctx.record.size}, actual ${actualSize}`,
      response: jsonResponse({ error: "size mismatch", expected: ctx.record.size, actual: actualSize }, 409),
    };
  }
  if (ctx.record.sha256 && ctx.record.sha256.toLowerCase() !== actualSha256.toLowerCase()) {
    return {
      ok: false,
      reason: "sha256 mismatch",
      response: jsonResponse({ error: "sha256 mismatch", expected: ctx.record.sha256, actual: actualSha256 }, 409),
    };
  }
  return { ok: true };
}

async function runCleanup<Result, RecordValue extends TransferUploadRecord<Result>>(
  destination: UploadDestination<Result, RecordValue>,
  record: RecordValue,
  result: Result,
  reason: string,
): Promise<void> {
  try {
    await destination.cleanup?.({ record, result, reason });
  } catch {
    // The upload state must remain failed even if backend cleanup fails.
  }
}

async function runResumableCleanup<Result, RecordValue extends TransferUploadRecord<Result>>(
  destination: ResumableUploadDestination<Result, RecordValue>,
  record: RecordValue,
  reason: string,
): Promise<void> {
  try {
    await destination.cleanup?.({ record, reason });
  } catch {
    // The upload state must remain failed even if backend cleanup fails.
  }
}

// --- Downloads -------------------------------------------------------------
//
// The mirror image of uploads: instead of bytes flowing in over a direct PUT,
// `download_file`-style tools hand the client a short-lived signed GET URL and
// the bytes flow out over a direct GET — so large files never travel through
// the MCP channel or the model's context. The kit owns issuing/verifying the
// grant and wiring the stream; the app supplies a `DownloadSource` that fetches
// the bytes from its backend (Drive, kintone, R2, ...).

export interface TransferDownloadRecord<Metadata = unknown> {
  downloadId: string;
  owner: string;
  token: string;
  expiresAt: string;
  name?: string;
  contentType?: string;
  size?: number;
  metadata?: Metadata;
}

export interface DownloadPrepareInput<Metadata = unknown> {
  owner: string;
  name?: string;
  contentType?: string;
  size?: number;
  metadata?: Metadata;
}

export interface DownloadGrant {
  downloadId: string;
  downloadUrl: string;
  downloadToken: string;
  expiresAt: string;
}

/** Fetches the bytes for a verified download grant from the app's backend. */
export interface DownloadSource<
  Metadata = unknown,
  RecordValue extends TransferDownloadRecord<Metadata> = TransferDownloadRecord<Metadata>,
> {
  /** Return a Response whose body streams to the client (e.g. Drive `alt=media`). */
  fetch(input: { record: RecordValue; request: Request }): Promise<Response>;
}

export interface CreateDownloadsOptions<
  RecordValue extends TransferDownloadRecord = TransferDownloadRecord,
> {
  store: TransferStore<RecordValue>;
  baseUrl: string;
  ttlSeconds?: number;
  downloadPath?: string;
}

export interface ServeDownloadInput<
  Metadata,
  RecordValue extends TransferDownloadRecord<Metadata> = TransferDownloadRecord<Metadata>,
> {
  downloadId: string;
  request: Request;
  source: DownloadSource<Metadata, RecordValue>;
}

export function createDownloads<
  Metadata = unknown,
  RecordValue extends TransferDownloadRecord<Metadata> = TransferDownloadRecord<Metadata>,
>({
  store,
  baseUrl,
  ttlSeconds = DEFAULT_UPLOAD_TTL_SECONDS,
  downloadPath = "/download",
}: CreateDownloadsOptions<RecordValue>) {
  const origin = baseUrl.replace(/\/$/, "");
  const normalizedPath = downloadPath.startsWith("/") ? downloadPath : `/${downloadPath}`;
  const storeTtl = ttlSeconds + DEFAULT_UPLOAD_KV_TTL_GRACE_SECONDS;

  /** Issue a short-lived grant and persist it. Returns the URL, NOT the bytes. */
  async function prepare(input: DownloadPrepareInput<Metadata>): Promise<DownloadGrant> {
    const downloadId = createTransferId();
    const token = createTransferToken();
    const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
    const expiresAt = new Date(exp * 1000).toISOString();
    const record = {
      downloadId,
      owner: input.owner,
      token,
      expiresAt,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.contentType !== undefined ? { contentType: input.contentType } : {}),
      ...(input.size !== undefined ? { size: input.size } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    } as RecordValue;
    await store.put(downloadId, record, storeTtl);
    return {
      downloadId,
      downloadUrl: `${origin}${normalizedPath}/${downloadId}`,
      downloadToken: token,
      expiresAt,
    };
  }

  async function get(downloadId: string): Promise<RecordValue | null> {
    return store.get(downloadId);
  }

  /** Verify the grant (bearer + expiry) and stream the source's bytes. */
  async function serve({ downloadId, request, source }: ServeDownloadInput<Metadata, RecordValue>): Promise<Response> {
    if (request.method !== "GET") {
      return jsonResponse({ error: "method not allowed" }, 405, { Allow: "GET" });
    }
    const record = await store.get(downloadId);
    if (!record) return jsonResponse({ error: "download not found" }, 404);

    const bearer = extractBearerToken(request);
    if (!bearer || !safeEqual(bearer, record.token)) {
      return jsonResponse({ error: "invalid download token" }, 401);
    }
    if (Date.parse(record.expiresAt) < Date.now()) {
      return jsonResponse({ error: "download link expired" }, 410);
    }

    let res: Response;
    try {
      res = await source.fetch({ record, request });
    } catch (err) {
      const reason = err instanceof Error ? err.message : "download failed";
      return jsonResponse({ error: "download failed", reason }, 502);
    }
    if (!res.ok || !res.body) {
      return jsonResponse({ error: `download source failed: ${res.status}` }, 502);
    }

    // Prefer values declared on the grant; otherwise fall back to whatever the
    // source response advertised (e.g. a backend that only knows the MIME type
    // once it has fetched the bytes).
    const headers = new Headers();
    headers.set(
      "Content-Type",
      record.contentType ?? res.headers.get("Content-Type") ?? "application/octet-stream",
    );
    if (record.name) {
      headers.set("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(record.name)}`);
    } else {
      const sourceDisposition = res.headers.get("Content-Disposition");
      if (sourceDisposition) headers.set("Content-Disposition", sourceDisposition);
    }
    const contentLength =
      record.size !== undefined ? String(record.size) : res.headers.get("Content-Length");
    if (contentLength) headers.set("Content-Length", contentLength);

    return new Response(res.body, { status: 200, headers });
  }

  return { prepare, get, serve };
}

export async function streamToUint8Array(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export async function signUploadJwt(claims: UploadJwtClaims, secret: string): Promise<string> {
  const header = { alg: "HS256", typ: "JWT" };
  const headerPart = base64UrlEncode(encoder.encode(JSON.stringify(header)));
  const payloadPart = base64UrlEncode(encoder.encode(JSON.stringify(claims)));
  const data = `${headerPart}.${payloadPart}`;
  const key = await importHmacKey(secret);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(data)));
  return `${data}.${base64UrlEncode(sig)}`;
}

export async function verifyUploadJwt(token: string, secret: string): Promise<UploadJwtClaims> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("malformed JWT");
  const [headerPart, payloadPart, sigPart] = parts as [string, string, string];
  const key = await importHmacKey(secret);
  const sig = base64UrlDecode(sigPart);
  const data = encoder.encode(`${headerPart}.${payloadPart}`);
  const ok = await crypto.subtle.verify(
    "HMAC",
    key,
    sig.buffer.slice(sig.byteOffset, sig.byteOffset + sig.byteLength) as ArrayBuffer,
    data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
  );
  if (!ok) throw new Error("invalid signature");

  const headerJson = JSON.parse(decoder.decode(base64UrlDecode(headerPart))) as { alg?: string };
  if (headerJson.alg !== "HS256") throw new Error("unsupported alg");

  const claims = JSON.parse(decoder.decode(base64UrlDecode(payloadPart))) as UploadJwtClaims;
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== "number" || claims.exp <= now) throw new Error("token expired");
  if (claims.iss !== "upload-mcp" || claims.aud !== "upload-app") {
    throw new Error("invalid iss/aud");
  }
  return claims;
}

export const verifyUploadToken = verifyUploadJwt;

export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

export async function sha256Hex(input: ArrayBuffer | Uint8Array | string): Promise<string> {
  const bytes = typeof input === "string" ? encoder.encode(input) : toUint8Array(input);
  return bytesToHex(sha256(bytes));
}

export function createShaCountingStream(maxBytes: number): ShaCountingStream {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    throw new Error("maxBytes must be a positive number");
  }
  const hasher = sha256.create();
  let size = 0;
  let aborted = false;
  let finalDigest: Uint8Array | null = null;

  const stream = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (aborted) return;
      size += chunk.byteLength;
      if (size > maxBytes) {
        aborted = true;
        controller.error(new Error(`upload exceeds maxBytes (${maxBytes})`));
        return;
      }
      hasher.update(chunk);
      controller.enqueue(chunk);
    },
    flush() {
      if (!aborted) finalDigest = hasher.digest();
    },
  });

  return {
    stream,
    finalize() {
      if (!finalDigest) throw new Error("stream did not complete");
      return { sha256: bytesToHex(finalDigest), size };
    },
  };
}

export function resolvePositiveInteger(
  value: string | number | undefined,
  fallback: number,
): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function standardUploadInput<Extra extends McpInputSchema = Record<string, never>>({
  extra,
  contentType = z.string().min(1),
  maxSize,
}: {
  extra?: Extra;
  contentType?: z.ZodTypeAny;
  maxSize?: number;
} = {}): StandardUploadInputShape<Extra> {
  const size = maxSize
    ? z.number().int().positive().max(maxSize)
    : z.number().int().positive();
  return {
    name: z.string().min(1).max(255),
    size,
    contentType,
    sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    ...(extra ?? {}),
  } as StandardUploadInputShape<Extra>;
}

export function registerCompleteUploadTool<
  RecordValue extends TransferUploadRecord,
  Output extends Record<string, unknown>,
>(
  server: McpToolRegistrar,
  {
    uploads,
    getOwner,
    toResult,
    name = "complete_upload",
    title = "Complete upload",
    description = "Complete any upload prepared by this server and return its result.",
  }: RegisterCompleteUploadToolOptions<RecordValue, Output>,
): void {
  server.registerTool(
    name,
    {
      title,
      description,
      inputSchema: {
        uploadId: z.string().min(1),
      },
    },
    async ({ uploadId }) => {
      const result = await uploads.completeWith({
        uploadId: String(uploadId),
        ...(getOwner ? { owner: getOwner() } : {}),
        toResult,
      });
      return {
        structuredContent: { ...result },
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    },
  );
}

export function createUploadMcpBuilder<
  Result,
  Metadata extends { purpose: string },
  RecordValue extends TransferUploadRecord<Result, Metadata>,
  Output extends Record<string, unknown> = Record<string, unknown>,
>({
  uploads,
  getOwner,
  completeToolName = "complete_upload",
  completeTitle = "Complete upload",
  completeDescription = "Complete any upload prepared by this server and return its result.",
}: CreateUploadMcpBuilderOptions<Result, Metadata, RecordValue>): UploadMcpBuilder<
  Result,
  Metadata,
  RecordValue,
  Output
> {
  const purposes = new Map<
    string,
    UploadMcpPurposeConfig<Record<string, unknown>, Result, Metadata, RecordValue, Output>
  >();

  const builder: UploadMcpBuilder<Result, Metadata, RecordValue, Output> = {
    addPurpose<Input extends Record<string, unknown>>(
      purpose: Metadata["purpose"] & string,
      config: UploadMcpPurposeConfig<Input, Result, Metadata, RecordValue, Output>,
    ) {
      purposes.set(
        purpose,
        config as UploadMcpPurposeConfig<Record<string, unknown>, Result, Metadata, RecordValue, Output>,
      );
      return builder;
    },

    registerTools(server: McpToolRegistrar, getOwnerOverride?: () => string): void {
      const toolOwner = getOwnerOverride ?? getOwner;
      if (!toolOwner) {
        throw new Error("getOwner is required to register upload MCP tools");
      }

      for (const [purpose, config] of purposes.entries()) {
        server.registerTool(
          config.toolName ?? `prepare_${purpose}_upload`,
          {
            title: config.title ?? `Prepare ${purpose} upload`,
            ...(config.description ? { description: config.description } : {}),
            inputSchema: config.inputSchema,
          },
          async (input) => {
            const prepared = config.prepare
              ? config.prepare(input)
              : defaultPrepareForPurpose(purpose, input, config);
            const result = await uploads.prepare({
              owner: toolOwner(),
              ...prepared,
            });
            return mcpJsonResult(result);
          },
        );
      }

      registerCompleteUploadTool(server, {
        uploads,
        getOwner: toolOwner,
        name: completeToolName,
        title: completeTitle,
        description: completeDescription,
        toResult(record) {
          const purpose = record.metadata?.purpose;
          const config = purpose ? purposes.get(purpose) : undefined;
          if (!config) throw new Error("unknown upload purpose");
          return config.complete?.(record) ?? (defaultCompleteResult(record) as Output);
        },
      });
    },

    receive(request: Request, uploadId: string): Promise<Response> {
      return uploads.receiveWith({
        uploadId,
        request,
        selectDestination(record) {
          const purpose = record.metadata?.purpose;
          return purpose ? purposes.get(purpose)?.destination : undefined;
        },
      });
    },
  };

  return builder;
}

export function createUploadMcp<
  Result,
  Metadata extends { purpose: string },
  RecordValue extends TransferUploadRecord<Result, Metadata>,
  Output extends Record<string, unknown> = Record<string, unknown>,
>({
  getOwner,
  completeToolName,
  completeTitle,
  completeDescription,
  ...uploadOptions
}: CreateUploadMcpOptions<Result, Metadata, RecordValue>) {
  return createUploadMcpBuilder<Result, Metadata, RecordValue, Output>({
    uploads: createUploads<Result, Metadata, RecordValue>(uploadOptions),
    ...(getOwner ? { getOwner } : {}),
    ...(completeToolName ? { completeToolName } : {}),
    ...(completeTitle ? { completeTitle } : {}),
    ...(completeDescription ? { completeDescription } : {}),
  });
}

function validatePrepareUploadInput(input: PrepareUploadInput<unknown>, maxBytes: number): void {
  if (typeof input.owner !== "string" || input.owner.length === 0) {
    throw new Error("owner must be a non-empty string");
  }
  if (typeof input.name !== "string" || input.name.length === 0) {
    throw new Error("name must be a non-empty string");
  }
  if (!Number.isSafeInteger(input.size) || input.size <= 0) {
    throw new Error("size must be a positive integer");
  }
  if (input.size > maxBytes) {
    throw new Error(`file size ${input.size} exceeds maxBytes ${maxBytes}`);
  }
  if (typeof input.contentType !== "string" || input.contentType.length === 0) {
    throw new Error("contentType must be a non-empty string");
  }
  if (input.sha256 !== undefined && !/^[a-f0-9]{64}$/i.test(input.sha256)) {
    throw new Error("sha256 must be a 64-character hex string");
  }
}

function defaultPrepareForPurpose<
  Input extends Record<string, unknown>,
  Result,
  Metadata extends { purpose: string },
  RecordValue extends TransferUploadRecord<Result, Metadata>,
  Output extends Record<string, unknown>,
>(
  purpose: string,
  input: Input,
  config: UploadMcpPurposeConfig<Input, Result, Metadata, RecordValue, Output>,
): Omit<PrepareUploadInput<Metadata>, "owner"> {
  const name = input.name;
  const size = input.size;
  const contentType = input.contentType;
  if (typeof name !== "string") throw new Error("standard upload input requires string name");
  if (typeof size !== "number") throw new Error("standard upload input requires number size");
  if (typeof contentType !== "string") {
    throw new Error("standard upload input requires string contentType");
  }
  const sha256 = input.sha256;
  if (sha256 !== undefined && typeof sha256 !== "string") {
    throw new Error("standard upload input sha256 must be a string");
  }
  const extraMetadata = config.metadata?.(input) ?? {};
  return {
    name,
    size,
    contentType,
    ...(sha256 ? { sha256 } : {}),
    metadata: { ...extraMetadata, purpose } as Metadata,
  };
}

function defaultCompleteResult(record: TransferUploadRecord): Record<string, unknown> {
  const result = isRecord(record.result) ? record.result : { result: record.result };
  return {
    uploadId: record.uploadId,
    purpose: isRecord(record.metadata) ? record.metadata.purpose : undefined,
    name: record.name,
    size: record.actualSize ?? record.size,
    sha256: record.actualSha256 ?? record.sha256 ?? "",
    ...result,
  };
}

function mcpJsonResult(body: object): McpToolResult {
  return {
    structuredContent: { ...body },
    content: [{ type: "text", text: JSON.stringify(body) }],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function base64UrlDecode(input: string): Uint8Array {
  const remainder = input.length % 4;
  if (remainder === 1) throw new Error("invalid base64url");
  const pad = remainder === 2 ? "==" : remainder === 3 ? "=" : "";
  const binary = atob(input.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function toUint8Array(input: ArrayBuffer | Uint8Array): Uint8Array {
  return input instanceof Uint8Array ? input : new Uint8Array(input);
}
