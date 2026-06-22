import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  createUploadMcpBuilder,
  createUploadMcp,
  createUploads,
  createDownloads,
  singleShotReceiver,
  resumableReceiver,
  createShaCountingStream,
  createTransferToken,
  extractBearerToken,
  jsonResponse,
  kvTransferStore,
  opaqueUploadToken,
  parseContentRange,
  safeEqual,
  sha256Hex,
  signUploadJwt,
  standardUploadInput,
  transferKey,
  validateUploadRequest,
  verifyUploadJwt,
  streamToUint8Array,
  type UploadJwtClaims,
  type TransferUploadRecord,
  type UploadKvNamespace,
  type McpToolResult,
  type TransferDownloadRecord,
  type DownloadSource,
  type ResumableUploadDestination,
  type ResumableChunkOutcome,
} from "../src/index";

const SECRET = "test-secret-key-of-sufficient-length";

function claims(overrides: Partial<UploadJwtClaims> = {}): UploadJwtClaims {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: "upload-mcp",
    aud: "upload-app",
    sub: "user-1",
    uploadId: "upload-1",
    filename: "file.bin",
    maxSize: 1024,
    contentType: "application/octet-stream",
    iat: now,
    exp: now + 60,
    ...overrides,
  };
}

describe("tokens", () => {
  test("creates opaque URL-safe tokens", () => {
    expect(createTransferToken()).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(createTransferToken()).not.toBe(createTransferToken());
  });

  test("extracts bearer tokens", () => {
    expect(extractBearerToken("Bearer abc.def")).toBe("abc.def");
    expect(extractBearerToken("Basic abc")).toBeNull();
  });

  test("safeEqual compares equal strings", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});

describe("jwt", () => {
  test("signs and verifies upload claims", async () => {
    const signed = await signUploadJwt(claims({ sha256: "a".repeat(64) }), SECRET);
    await expect(verifyUploadJwt(signed, SECRET)).resolves.toMatchObject({ uploadId: "upload-1" });
  });

  test("rejects expired claims", async () => {
    const signed = await signUploadJwt(claims({ exp: Math.floor(Date.now() / 1000) - 1 }), SECRET);
    await expect(verifyUploadJwt(signed, SECRET)).rejects.toThrow(/expired/);
  });

  test("rejects malformed and incorrectly signed tokens", async () => {
    await expect(verifyUploadJwt("not-a-jwt", SECRET)).rejects.toThrow(/malformed/);
    const signed = await signUploadJwt(claims(), SECRET);
    await expect(verifyUploadJwt(signed, "a-different-test-secret-of-32-bytes"))
      .rejects.toThrow(/invalid signature/);
  });

  test.each([
    { override: { iss: "other-issuer" as UploadJwtClaims["iss"] }, message: /invalid iss\/aud/ },
    { override: { aud: "other-audience" as UploadJwtClaims["aud"] }, message: /invalid iss\/aud/ },
  ])("rejects invalid registered claims", async ({ override, message }) => {
    const signed = await signUploadJwt(claims(override), SECRET);
    await expect(verifyUploadJwt(signed, SECRET)).rejects.toThrow(message);
  });
});

describe("content range and request validation", () => {
  test("parses valid byte ranges", () => {
    expect(parseContentRange("bytes 0-99/100")).toEqual({ start: 0, end: 99, total: 100 });
  });

  test("rejects invalid byte ranges", () => {
    expect(parseContentRange("bytes 99-0/100")).toBeNull();
    expect(parseContentRange("bytes 0-100/100")).toBeNull();
    expect(parseContentRange("items 0-1/2")).toBeNull();
  });

  test("validates PUT length and range", () => {
    const request = new Request("https://example.test/upload/u", {
      method: "PUT",
      headers: { "Content-Length": "5", "Content-Range": "bytes 0-4/5" },
      body: new Uint8Array([1, 2, 3, 4, 5]) as unknown as BodyInit,
    });
    expect(validateUploadRequest({ request, maxBytes: 5 })).toMatchObject({
      ok: true,
      contentLength: 5,
      contentRange: { start: 0, end: 4, total: 5 },
    });
  });

  test("returns 411 for missing Content-Length", () => {
    const request = new Request("https://example.test/upload/u", {
      method: "PUT",
      body: new Uint8Array([1]) as unknown as BodyInit,
    });
    const result = validateUploadRequest({ request, maxBytes: 5 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(411);
  });

  test("rejects length that does not match expected size", () => {
    const request = new Request("https://example.test/upload/u", {
      method: "PUT",
      headers: { "Content-Length": "3" },
      body: new Uint8Array([1, 2, 3]) as unknown as BodyInit,
    });
    const result = validateUploadRequest({ request, maxBytes: 5, expectedSize: 5 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(400);
  });

  test("rejects partial Content-Range when expected size is known", () => {
    const request = new Request("https://example.test/upload/u", {
      method: "PUT",
      headers: { "Content-Length": "5", "Content-Range": "bytes 5-9/10" },
      body: new Uint8Array([1, 2, 3, 4, 5]) as unknown as BodyInit,
    });
    const result = validateUploadRequest({ request, maxBytes: 10, expectedSize: 5 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(400);
  });

  test.each([NaN, Infinity, 0, -1])("rejects invalid maxBytes configuration: %s", (maxBytes) => {
    const request = new Request("https://example.test/upload/u", {
      method: "PUT",
      headers: { "Content-Length": "1" },
      body: new Uint8Array([1]) as unknown as BodyInit,
    });
    expect(() => validateUploadRequest({ request, maxBytes })).toThrow(
      "maxBytes must be a positive safe integer",
    );
  });

  test.each([NaN, Infinity, 0, -1])("rejects invalid expectedSize configuration: %s", (expectedSize) => {
    const request = new Request("https://example.test/upload/u", {
      method: "PUT",
      headers: { "Content-Length": "1" },
      body: new Uint8Array([1]) as unknown as BodyInit,
    });
    expect(() => validateUploadRequest({ request, maxBytes: 1, expectedSize })).toThrow(
      "expectedSize must be a positive safe integer",
    );
  });
});

describe("sha and responses", () => {
  test("hashes bytes", async () => {
    expect(await sha256Hex("hello world")).toBe(
      "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
    );
  });

  test("counts stream bytes and hashes", async () => {
    const counter = createShaCountingStream(20);
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("hello "));
        controller.enqueue(new TextEncoder().encode("world"));
        controller.close();
      },
    });
    const reader = readable.pipeThrough(counter.stream).getReader();
    while (!(await reader.read()).done) {
      // drain
    }
    expect(counter.finalize()).toEqual({
      size: 11,
      sha256: "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
    });
  });

  test("builds JSON responses and upload keys", async () => {
    const response = jsonResponse({ ok: true }, 201);
    expect(response.status).toBe(201);
    expect(response.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(await response.json()).toEqual({ ok: true });
    expect(transferKey("abc")).toBe("upload:abc");
  });
});

describe("createUploads", () => {
  test("prepare -> receive -> complete stores the destination result", async () => {
    const kv = memoryKv();
    const uploads = createUploads<{ objectKey: string }>({
      store: kvTransferStore<TransferUploadRecord<{ objectKey: string }>>(kv),
      baseUrl: "https://files.example.test",
      maxBytes: 1024,
      token: opaqueUploadToken(),
    });

    const prepared = await uploads.prepare({
      owner: "user-1",
      name: "hello.txt",
      size: 11,
      contentType: "text/plain",
    });
    const body = new TextEncoder().encode("hello world");
    const received: Uint8Array[] = [];
    const response = await uploads.receive({
      uploadId: prepared.uploadId,
      request: uploadRequest(prepared.uploadUrl, prepared.uploadToken, body),
      destination: {
        async receive({ record, body: stream }) {
          const bytes = await streamToUint8Array(stream);
          received.push(bytes);
          return { objectKey: record.uploadId };
        },
      },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      accepted: true,
      actualSize: 11,
      result: { objectKey: prepared.uploadId },
    });
    expect(new TextDecoder().decode(received[0])).toBe("hello world");

    const completed = await uploads.complete({ uploadId: prepared.uploadId, owner: "user-1" });
    expect(completed.status).toBe("completed");
    expect(completed.result).toEqual({ objectKey: prepared.uploadId });
    expect(completed.actualSha256).toBe(
      "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
    );
  });

  test("rejects missing bearer token", async () => {
    const uploads = createUploads({
      store: kvTransferStore<TransferUploadRecord>(memoryKv()),
      baseUrl: "https://files.example.test",
      maxBytes: 1024,
    });
    const prepared = await uploads.prepare({
      owner: "user-1",
      name: "a.txt",
      size: 1,
      contentType: "text/plain",
    });
    const response = await uploads.receive({
      uploadId: prepared.uploadId,
      request: new Request(prepared.uploadUrl, {
        method: "PUT",
        headers: { "Content-Length": "1" },
        body: new Uint8Array([1]) as unknown as BodyInit,
      }),
      destination: { async receive() { return {}; } },
    });
    expect(response.status).toBe(401);
  });

  test("supports destructured controller methods", async () => {
    const { prepare, receive, completeWith } = createUploads<{ objectKey: string }>({
      store: kvTransferStore<TransferUploadRecord<{ objectKey: string }>>(memoryKv()),
      baseUrl: "https://files.example.test",
      maxBytes: 1024,
    });
    const prepared = await prepare({
      owner: "user-1",
      name: "hello.txt",
      size: 5,
      contentType: "text/plain",
    });
    const response = await receive({
      uploadId: prepared.uploadId,
      request: uploadRequest(prepared.uploadUrl, prepared.uploadToken, new TextEncoder().encode("hello")),
      destination: {
        async receive({ record, body }) {
          await streamToUint8Array(body);
          return { objectKey: record.uploadId };
        },
      },
    });

    expect(response.status).toBe(200);
    await expect(
      completeWith({
        uploadId: prepared.uploadId,
        toResult: (record) => record.result,
      }),
    ).resolves.toEqual({ objectKey: prepared.uploadId });
  });

  test("rejects direct prepare inputs with invalid required fields", async () => {
    const uploads = createUploads({
      store: kvTransferStore<TransferUploadRecord>(memoryKv()),
      baseUrl: "https://files.example.test",
      maxBytes: 1024,
    });

    await expect(
      uploads.prepare({
        owner: "user-1",
        name: "bad.txt",
        size: 0,
        contentType: "text/plain",
      }),
    ).rejects.toThrow(/size must be a positive integer/);
    await expect(
      uploads.prepare({
        owner: "",
        name: "bad.txt",
        size: 1,
        contentType: "text/plain",
      }),
    ).rejects.toThrow(/owner must be a non-empty string/);
  });

  test("rejects request bodies shorter than the prepared size", async () => {
    const uploads = createUploads({
      store: kvTransferStore<TransferUploadRecord>(memoryKv()),
      baseUrl: "https://files.example.test",
      maxBytes: 1024,
    });
    const prepared = await uploads.prepare({
      owner: "user-1",
      name: "short.txt",
      size: 5,
      contentType: "text/plain",
    });

    const response = await uploads.receive({
      uploadId: prepared.uploadId,
      request: uploadRequest(prepared.uploadUrl, prepared.uploadToken, new TextEncoder().encode("hey")),
      destination: {
        async receive() {
          return {};
        },
      },
    });

    expect(response.status).toBe(400);
  });

  test("marks failed when declared length matches but actual body is shorter", async () => {
    const uploads = createUploads<{ objectKey: string }>({
      store: kvTransferStore<TransferUploadRecord<{ objectKey: string }>>(memoryKv()),
      baseUrl: "https://files.example.test",
      maxBytes: 1024,
    });
    const prepared = await uploads.prepare({
      owner: "user-1",
      name: "truncated.txt",
      size: 5,
      contentType: "text/plain",
    });
    let cleaned = false;

    const response = await uploads.receive({
      uploadId: prepared.uploadId,
      request: new Request(prepared.uploadUrl, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${prepared.uploadToken}`,
          "Content-Length": "5",
        },
        body: new TextEncoder().encode("hey") as unknown as BodyInit,
      }),
      destination: {
        async receive({ body }) {
          await streamToUint8Array(body);
          return { objectKey: "truncated-object" };
        },
        async cleanup() {
          cleaned = true;
        },
      },
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "size mismatch", expected: 5, actual: 3 });
    expect(cleaned).toBe(true);
    await expect(uploads.complete({ uploadId: prepared.uploadId })).rejects.toThrow(/size mismatch/);
  });

  test("marks failed when destination does not consume the body stream", async () => {
    const uploads = createUploads<{ objectKey: string }>({
      store: kvTransferStore<TransferUploadRecord<{ objectKey: string }>>(memoryKv()),
      baseUrl: "https://files.example.test",
      maxBytes: 1024,
    });
    const prepared = await uploads.prepare({
      owner: "user-1",
      name: "undrained.txt",
      size: 5,
      contentType: "text/plain",
    });
    let cleaned = false;

    const response = await uploads.receive({
      uploadId: prepared.uploadId,
      request: uploadRequest(prepared.uploadUrl, prepared.uploadToken, new TextEncoder().encode("hello")),
      destination: {
        async receive() {
          return { objectKey: "partial-object" };
        },
        async cleanup() {
          cleaned = true;
        },
      },
    });

    expect(response.status).toBe(502);
    expect(cleaned).toBe(true);
    await expect(uploads.complete({ uploadId: prepared.uploadId })).rejects.toThrow(/stream did not complete/);
  });

  test("keeps failed state when cleanup throws", async () => {
    const uploads = createUploads<{ objectKey: string }>({
      store: kvTransferStore<TransferUploadRecord<{ objectKey: string }>>(memoryKv()),
      baseUrl: "https://files.example.test",
      maxBytes: 1024,
    });
    const prepared = await uploads.prepare({
      owner: "user-1",
      name: "cleanup-fails.txt",
      size: 5,
      contentType: "text/plain",
      sha256: "f".repeat(64),
    });

    const response = await uploads.receive({
      uploadId: prepared.uploadId,
      request: uploadRequest(prepared.uploadUrl, prepared.uploadToken, new TextEncoder().encode("hello")),
      destination: {
        async receive({ body }) {
          await streamToUint8Array(body);
          return { objectKey: "cleanup-fails-object" };
        },
        async cleanup() {
          throw new Error("cleanup failed");
        },
      },
    });

    expect(response.status).toBe(409);
    await expect(uploads.complete({ uploadId: prepared.uploadId })).rejects.toThrow(/sha256 mismatch/);
  });

  test("calls cleanup after a failed verification even when destination result is undefined", async () => {
    const uploads = createUploads<undefined>({
      store: kvTransferStore<TransferUploadRecord<undefined>>(memoryKv()),
      baseUrl: "https://files.example.test",
      maxBytes: 1024,
    });
    const prepared = await uploads.prepare({
      owner: "user-1",
      name: "undefined-result.txt",
      size: 5,
      contentType: "text/plain",
      sha256: "f".repeat(64),
    });
    let cleaned = false;

    const response = await uploads.receive({
      uploadId: prepared.uploadId,
      request: uploadRequest(prepared.uploadUrl, prepared.uploadToken, new TextEncoder().encode("hello")),
      destination: {
        async receive({ body }) {
          await streamToUint8Array(body);
          return undefined;
        },
        async cleanup() {
          cleaned = true;
        },
      },
    });

    expect(response.status).toBe(409);
    expect(cleaned).toBe(true);
  });

  test("marks failed and calls cleanup on sha mismatch", async () => {
    const uploads = createUploads<{ objectKey: string }>({
      store: kvTransferStore<TransferUploadRecord<{ objectKey: string }>>(memoryKv()),
      baseUrl: "https://files.example.test",
      maxBytes: 1024,
    });
    const prepared = await uploads.prepare({
      owner: "user-1",
      name: "bad.txt",
      size: 5,
      contentType: "text/plain",
      sha256: "f".repeat(64),
    });
    let cleaned = false;
    const response = await uploads.receive({
      uploadId: prepared.uploadId,
      request: uploadRequest(prepared.uploadUrl, prepared.uploadToken, new TextEncoder().encode("hello")),
      destination: {
        async receive({ body }) {
          await streamToUint8Array(body);
          return { objectKey: "uploaded-before-sha-check" };
        },
        async cleanup() {
          cleaned = true;
        },
      },
    });

    expect(response.status).toBe(409);
    expect(cleaned).toBe(true);
    await expect(uploads.complete({ uploadId: prepared.uploadId })).rejects.toThrow(/sha256 mismatch/);
  });

  test("rejects expired sessions before reading the body", async () => {
    const uploads = createUploads({
      store: kvTransferStore<TransferUploadRecord>(memoryKv()),
      baseUrl: "https://files.example.test",
      maxBytes: 1024,
      ttlSeconds: -1,
    });
    const prepared = await uploads.prepare({
      owner: "user-1",
      name: "old.txt",
      size: 1,
      contentType: "text/plain",
    });
    const response = await uploads.receive({
      uploadId: prepared.uploadId,
      request: uploadRequest(prepared.uploadUrl, prepared.uploadToken, new Uint8Array([1])),
      destination: { async receive() { return {}; } },
    });
    expect(response.status).toBe(410);
  });

  test("receiveWith selects a destination from record metadata", async () => {
    type Purpose = { purpose: "avatar" } | { purpose: "attachment" };
    type Result = { selected: "avatar" } | { selected: "attachment" };
    type RecordValue = TransferUploadRecord<Result, Purpose>;
    const uploads = createUploads<Result, Purpose, RecordValue>({
      store: kvTransferStore<RecordValue>(memoryKv()),
      baseUrl: "https://files.example.test",
      maxBytes: 1024,
    });
    const prepared = await uploads.prepare({
      owner: "user-1",
      name: "avatar.png",
      size: 3,
      contentType: "image/png",
      metadata: { purpose: "avatar" },
    });
    const response = await uploads.receiveWith({
      uploadId: prepared.uploadId,
      request: uploadRequest(prepared.uploadUrl, prepared.uploadToken, new Uint8Array([1, 2, 3])),
      selectDestination(record) {
        if (record.metadata?.purpose === "avatar") {
          return {
            async receive({ body }) {
              await streamToUint8Array(body);
              return { selected: "avatar" };
            },
          };
        }
        return {
          async receive({ body }) {
            await streamToUint8Array(body);
            return { selected: "attachment" };
          },
        };
      },
    });

    expect(response.status).toBe(200);
    const completed = await uploads.complete({ uploadId: prepared.uploadId });
    expect(completed.result).toEqual({ selected: "avatar" });
    await expect(
      uploads.completeWith({
        uploadId: prepared.uploadId,
        toResult: (record) => ({
          selected: record.result?.selected,
          purpose: record.metadata?.purpose,
        }),
      }),
    ).resolves.toEqual({ selected: "avatar", purpose: "avatar" });
  });

  test("receiveWith rejects when no destination matches", async () => {
    const uploads = createUploads({
      store: kvTransferStore<TransferUploadRecord>(memoryKv()),
      baseUrl: "https://files.example.test",
      maxBytes: 1024,
    });
    const prepared = await uploads.prepare({
      owner: "user-1",
      name: "unknown.bin",
      size: 1,
      contentType: "application/octet-stream",
    });
    const response = await uploads.receiveWith({
      uploadId: prepared.uploadId,
      request: uploadRequest(prepared.uploadUrl, prepared.uploadToken, new Uint8Array([1])),
      selectDestination: () => null,
    });
    expect(response.status).toBe(409);
  });
});

describe("createUploadMcpBuilder", () => {
  test("registers purpose prepare tools and shared complete with default prepare/complete", async () => {
    type Metadata = { purpose: "file"; folderId: string };
    type Result = { objectKey: string };
    type RecordValue = TransferUploadRecord<Result, Metadata>;
    const uploads = createUploads<Result, Metadata, RecordValue>({
      store: kvTransferStore<RecordValue>(memoryKv()),
      baseUrl: "https://files.example.test",
      maxBytes: 1024,
    });
    const server = fakeMcpServer();
    const builder = createUploadMcpBuilder<Result, Metadata, RecordValue>({
      uploads,
      getOwner: () => "user-1",
    }).addPurpose("file", {
      inputSchema: standardUploadInput({
        extra: { folderId: z.string().min(1) },
      }),
      metadata(input: { folderId: string }) {
        return { folderId: input.folderId };
      },
      destination: {
        async receive({ record, body }) {
          await streamToUint8Array(body);
          return { objectKey: `folder/${record.metadata?.folderId}/${record.name}` };
        },
      },
    });

    builder.registerTools(server);
    const preparedResult = await server.call("prepare_file_upload", {
      folderId: "docs",
      name: "hello.txt",
      size: 11,
      contentType: "text/plain",
    });
    const prepared = preparedResult.structuredContent as { uploadId: string; uploadUrl: string; uploadToken: string };

    const putResponse = await builder.receive(
      uploadRequest(prepared.uploadUrl, prepared.uploadToken, new TextEncoder().encode("hello world")),
      prepared.uploadId,
    );
    expect(putResponse.status).toBe(200);

    const completed = await server.call("complete_upload", { uploadId: prepared.uploadId });
    expect(completed.structuredContent).toMatchObject({
      uploadId: prepared.uploadId,
      purpose: "file",
      name: "hello.txt",
      size: 11,
      objectKey: "folder/docs/hello.txt",
    });
  });

  test("createUploadMcp combines upload controller setup with MCP builder setup", async () => {
    type Metadata = { purpose: "file"; folderId: string };
    type Result = { objectKey: string };
    type RecordValue = TransferUploadRecord<Result, Metadata>;
    const server = fakeMcpServer();
    const builder = createUploadMcp<Result, Metadata, RecordValue>({
      store: kvTransferStore<RecordValue>(memoryKv()),
      baseUrl: "https://files.example.test",
      maxBytes: 1024,
    }).addPurpose("file", {
      inputSchema: standardUploadInput({
        extra: { folderId: z.string().min(1) },
      }),
      metadata(input: { folderId: string }) {
        return { folderId: input.folderId };
      },
      destination: {
        async receive({ record, body }) {
          await streamToUint8Array(body);
          return { objectKey: `folder/${record.metadata?.folderId}/${record.name}` };
        },
      },
    });

    builder.registerTools(server, () => "user-1");
    const preparedResult = await server.call("prepare_file_upload", {
      folderId: "docs",
      name: "hello.txt",
      size: 5,
      contentType: "text/plain",
    });
    const prepared = preparedResult.structuredContent as { uploadId: string; uploadUrl: string; uploadToken: string };
    const putResponse = await builder.receive(
      uploadRequest(prepared.uploadUrl, prepared.uploadToken, new TextEncoder().encode("hello")),
      prepared.uploadId,
    );

    expect(putResponse.status).toBe(200);
    const completed = await server.call("complete_upload", { uploadId: prepared.uploadId });
    expect(completed.structuredContent).toMatchObject({
      uploadId: prepared.uploadId,
      purpose: "file",
      objectKey: "folder/docs/hello.txt",
    });
  });

  test("registered purpose wins over purpose returned from metadata callback", async () => {
    type Metadata = { purpose: "avatar"; profileId: string } | { purpose: "attachment"; recordId: string };
    type Result = { selected: "avatar" } | { selected: "attachment" };
    type RecordValue = TransferUploadRecord<Result, Metadata>;
    const server = fakeMcpServer();
    const builder = createUploadMcp<Result, Metadata, RecordValue>({
      store: kvTransferStore<RecordValue>(memoryKv()),
      baseUrl: "https://files.example.test",
      maxBytes: 1024,
    })
      .addPurpose("avatar", {
        inputSchema: standardUploadInput({
          extra: { profileId: z.string().min(1) },
        }),
        metadata(input: { profileId: string }) {
          return { purpose: "attachment", profileId: input.profileId } as unknown as Omit<Metadata, "purpose">;
        },
        destination: {
          async receive({ body }) {
            await streamToUint8Array(body);
            return { selected: "avatar" };
          },
        },
      })
      .addPurpose("attachment", {
        inputSchema: standardUploadInput({
          extra: { recordId: z.string().min(1) },
        }),
        metadata(input: { recordId: string }) {
          return { recordId: input.recordId };
        },
        destination: {
          async receive({ body }) {
            await streamToUint8Array(body);
            return { selected: "attachment" };
          },
        },
      });

    builder.registerTools(server, () => "user-1");
    const preparedResult = await server.call("prepare_avatar_upload", {
      profileId: "profile-1",
      name: "avatar.png",
      size: 3,
      contentType: "image/png",
    });
    const prepared = preparedResult.structuredContent as { uploadId: string; uploadUrl: string; uploadToken: string };
    const response = await builder.receive(
      uploadRequest(prepared.uploadUrl, prepared.uploadToken, new Uint8Array([1, 2, 3])),
      prepared.uploadId,
    );

    expect(response.status).toBe(200);
    const completed = await server.call("complete_upload", { uploadId: prepared.uploadId });
    expect(completed.structuredContent).toMatchObject({
      purpose: "avatar",
      selected: "avatar",
    });
  });
});

describe("singleShotReceiver step overrides", () => {
  test("overriding verify keeps validate, streaming and the success path intact", async () => {
    const uploads = createUploads<{ objectKey: string }>({
      store: kvTransferStore<TransferUploadRecord<{ objectKey: string }>>(memoryKv()),
      baseUrl: "https://files.example.test",
      maxBytes: 1024,
      // Accept whatever bytes arrive — e.g. a backend that hashes server-side.
      receiver: singleShotReceiver<{ objectKey: string }>({
        verify: () => ({ ok: true }),
      }),
    });
    const prepared = await uploads.prepare({
      owner: "user-1",
      name: "relaxed.txt",
      size: 5,
      contentType: "text/plain",
      sha256: "f".repeat(64), // intentionally wrong — default verify would 409
    });

    const response = await uploads.receive({
      uploadId: prepared.uploadId,
      request: uploadRequest(prepared.uploadUrl, prepared.uploadToken, new TextEncoder().encode("hello")),
      destination: {
        async receive({ record, body }) {
          await streamToUint8Array(body);
          return { objectKey: record.uploadId };
        },
      },
    });

    expect(response.status).toBe(200);
    const completed = await uploads.complete({ uploadId: prepared.uploadId });
    expect(completed.status).toBe("completed");
    expect(completed.result).toEqual({ objectKey: prepared.uploadId });
  });

  test("a custom verify can reject and still triggers cleanup", async () => {
    let cleaned = false;
    const uploads = createUploads<{ objectKey: string }>({
      store: kvTransferStore<TransferUploadRecord<{ objectKey: string }>>(memoryKv()),
      baseUrl: "https://files.example.test",
      maxBytes: 1024,
      receiver: singleShotReceiver<{ objectKey: string }>({
        verify: () => ({
          ok: false,
          reason: "policy: rejected",
          response: jsonResponse({ error: "policy: rejected" }, 422),
        }),
      }),
    });
    const prepared = await uploads.prepare({
      owner: "user-1",
      name: "policy.txt",
      size: 5,
      contentType: "text/plain",
    });

    const response = await uploads.receive({
      uploadId: prepared.uploadId,
      request: uploadRequest(prepared.uploadUrl, prepared.uploadToken, new TextEncoder().encode("hello")),
      destination: {
        async receive({ body }) {
          await streamToUint8Array(body);
          return { objectKey: "obj" };
        },
        async cleanup() {
          cleaned = true;
        },
      },
    });

    expect(response.status).toBe(422);
    expect(cleaned).toBe(true);
    await expect(uploads.complete({ uploadId: prepared.uploadId })).rejects.toThrow(/policy: rejected/);
  });

  test("default validate is still enforced when only verify is overridden", async () => {
    const uploads = createUploads({
      store: kvTransferStore<TransferUploadRecord>(memoryKv()),
      baseUrl: "https://files.example.test",
      maxBytes: 1024,
      receiver: singleShotReceiver({ verify: () => ({ ok: true }) }),
    });
    const prepared = await uploads.prepare({
      owner: "user-1",
      name: "len.txt",
      size: 5,
      contentType: "text/plain",
    });
    // Content-Length (3) does not match the prepared size (5): default validate rejects.
    const response = await uploads.receive({
      uploadId: prepared.uploadId,
      request: new Request(prepared.uploadUrl, {
        method: "PUT",
        headers: { Authorization: `Bearer ${prepared.uploadToken}`, "Content-Length": "3" },
        body: new TextEncoder().encode("hey") as unknown as BodyInit,
      }),
      destination: { async receive() { return {}; } },
    });
    expect(response.status).toBe(400);
  });
});

describe("resumableReceiver", () => {
  type Result = { objectKey: string };
  type RecordValue = TransferUploadRecord<Result>;

  function memoryResumable(onCleanup?: () => void): ResumableUploadDestination<Result, RecordValue> {
    const chunks: Uint8Array[] = [];
    let offset = 0;
    return {
      async writeChunk({ record, chunk, range }): Promise<ResumableChunkOutcome<Result>> {
        if (range.start !== offset) {
          return { status: "error", httpStatus: 409, message: `offset mismatch: expected ${offset}` };
        }
        chunks.push(chunk);
        offset = range.end + 1;
        if (offset < range.total) return { status: "incomplete", nextOffset: offset };
        const all = concat(chunks);
        return {
          status: "complete",
          result: { objectKey: record.uploadId },
          actualSize: all.byteLength,
          actualSha256: await sha256Hex(all),
        };
      },
      async cleanup() {
        onCleanup?.();
      },
    };
  }

  test("accepts chunks, returns 308 then 200 and stores the result", async () => {
    const dest = memoryResumable();
    const uploads = createUploads<Result, unknown, RecordValue, ResumableUploadDestination<Result, RecordValue>>({
      store: kvTransferStore<RecordValue>(memoryKv()),
      baseUrl: "https://files.example.test",
      maxBytes: 1024,
      receiver: resumableReceiver<Result, RecordValue>(),
    });
    const prepared = await uploads.prepare({
      owner: "user-1",
      name: "big.txt",
      size: 11,
      contentType: "text/plain",
    });

    const first = await uploads.receiveWith({
      uploadId: prepared.uploadId,
      request: chunkRequest(prepared.uploadUrl, prepared.uploadToken, new TextEncoder().encode("hello "), 0, 5, 11),
      selectDestination: () => dest,
    });
    expect(first.status).toBe(308);
    expect(first.headers.get("Range")).toBe("bytes=0-5");
    expect(await first.json()).toMatchObject({ status: "incomplete", nextOffset: 6 });

    const second = await uploads.receiveWith({
      uploadId: prepared.uploadId,
      request: chunkRequest(prepared.uploadUrl, prepared.uploadToken, new TextEncoder().encode("world"), 6, 10, 11),
      selectDestination: () => dest,
    });
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({
      accepted: true,
      actualSize: 11,
      result: { objectKey: prepared.uploadId },
    });

    const completed = await uploads.complete({ uploadId: prepared.uploadId });
    expect(completed.status).toBe("completed");
    expect(completed.actualSha256).toBe(
      "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
    );
  });

  test("rejects sha256 mismatch on the final chunk and runs cleanup", async () => {
    let cleaned = false;
    const dest = memoryResumable(() => {
      cleaned = true;
    });
    const uploads = createUploads<Result, unknown, RecordValue, ResumableUploadDestination<Result, RecordValue>>({
      store: kvTransferStore<RecordValue>(memoryKv()),
      baseUrl: "https://files.example.test",
      maxBytes: 1024,
      receiver: resumableReceiver<Result, RecordValue>(),
    });
    const prepared = await uploads.prepare({
      owner: "user-1",
      name: "mismatch.txt",
      size: 11,
      contentType: "text/plain",
      sha256: "a".repeat(64),
    });

    const response = await uploads.receiveWith({
      uploadId: prepared.uploadId,
      request: chunkRequest(prepared.uploadUrl, prepared.uploadToken, new TextEncoder().encode("hello world"), 0, 10, 11),
      selectDestination: () => dest,
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "sha256 mismatch" });
    expect(cleaned).toBe(true);
    await expect(uploads.complete({ uploadId: prepared.uploadId })).rejects.toThrow(/sha256 mismatch/);
  });

  test("propagates a destination error outcome as its http status", async () => {
    const dest = memoryResumable();
    const uploads = createUploads<Result, unknown, RecordValue, ResumableUploadDestination<Result, RecordValue>>({
      store: kvTransferStore<RecordValue>(memoryKv()),
      baseUrl: "https://files.example.test",
      maxBytes: 1024,
      receiver: resumableReceiver<Result, RecordValue>(),
    });
    const prepared = await uploads.prepare({
      owner: "user-1",
      name: "gap.txt",
      size: 11,
      contentType: "text/plain",
    });
    // Start at offset 6 while the destination expects 0 -> offset mismatch (409).
    const response = await uploads.receiveWith({
      uploadId: prepared.uploadId,
      request: chunkRequest(prepared.uploadUrl, prepared.uploadToken, new TextEncoder().encode("world"), 6, 10, 11),
      selectDestination: () => dest,
    });
    expect(response.status).toBe(409);
    const errorBody = (await response.json()) as { error: string };
    expect(errorBody.error).toMatch(/offset mismatch/);
  });

  test("requires a Content-Range header", async () => {
    const dest = memoryResumable();
    const uploads = createUploads<Result, unknown, RecordValue, ResumableUploadDestination<Result, RecordValue>>({
      store: kvTransferStore<RecordValue>(memoryKv()),
      baseUrl: "https://files.example.test",
      maxBytes: 1024,
      receiver: resumableReceiver<Result, RecordValue>(),
    });
    const prepared = await uploads.prepare({
      owner: "user-1",
      name: "norange.txt",
      size: 5,
      contentType: "text/plain",
    });
    const response = await uploads.receiveWith({
      uploadId: prepared.uploadId,
      request: uploadRequest(prepared.uploadUrl, prepared.uploadToken, new TextEncoder().encode("hello")),
      selectDestination: () => dest,
    });
    expect(response.status).toBe(400);
  });
});

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

function chunkRequest(
  url: string,
  token: string,
  body: Uint8Array,
  start: number,
  end: number,
  total: number,
): Request {
  return new Request(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Length": String(body.byteLength),
      "Content-Range": `bytes ${start}-${end}/${total}`,
    },
    body: body as unknown as BodyInit,
  });
}

describe("createDownloads", () => {
  type Meta = { fileId: string };
  type Rec = TransferDownloadRecord<Meta>;

  function newDownloads(kv = memoryKv()) {
    const downloads = createDownloads<Meta, Rec>({
      store: kvTransferStore<Rec>(kv, "download:"),
      baseUrl: "https://files.example.test",
      ttlSeconds: 900,
    });
    return { downloads, kv };
  }

  const FILE_BYTES = new TextEncoder().encode("hello drive");
  const source: DownloadSource<Meta, Rec> = {
    async fetch({ record }) {
      expect(record.metadata?.fileId).toBe("f1");
      return new Response(FILE_BYTES, { status: 200 });
    },
  };

  function getReq(token: string | null, method = "GET"): Request {
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    return new Request("https://files.example.test/download/x", { method, headers });
  }

  test("prepare issues a URL grant and stores a record without bytes", async () => {
    const { downloads, kv } = newDownloads();
    const grant = await downloads.prepare({
      owner: "user-1",
      name: "hello.txt",
      contentType: "text/plain",
      size: FILE_BYTES.byteLength,
      metadata: { fileId: "f1" },
    });
    expect(grant.downloadUrl).toBe(`https://files.example.test/download/${grant.downloadId}`);
    expect(grant.downloadToken).toBeTruthy();
    const stored = JSON.parse((await kv.get(`download:${grant.downloadId}`))!) as Rec;
    expect(stored).toMatchObject({ owner: "user-1", token: grant.downloadToken, metadata: { fileId: "f1" } });
  });

  test("serve streams the source bytes for a valid grant", async () => {
    const { downloads } = newDownloads();
    const grant = await downloads.prepare({
      owner: "user-1",
      name: "hello.txt",
      contentType: "text/plain",
      size: FILE_BYTES.byteLength,
      metadata: { fileId: "f1" },
    });
    const res = await downloads.serve({ downloadId: grant.downloadId, request: getReq(grant.downloadToken), source });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/plain");
    expect(res.headers.get("Content-Disposition")).toContain("hello.txt");
    expect(new TextDecoder().decode(new Uint8Array(await res.arrayBuffer()))).toBe("hello drive");
  });

  test("serve rejects bad token / missing / expired / unknown / non-GET", async () => {
    const { downloads } = newDownloads();
    const grant = await downloads.prepare({ owner: "u", metadata: { fileId: "f1" } });

    expect((await downloads.serve({ downloadId: grant.downloadId, request: getReq("nope"), source })).status).toBe(401);
    expect((await downloads.serve({ downloadId: grant.downloadId, request: getReq(null), source })).status).toBe(401);
    expect((await downloads.serve({ downloadId: "missing", request: getReq(grant.downloadToken), source })).status).toBe(404);
    expect(
      (await downloads.serve({ downloadId: grant.downloadId, request: getReq(grant.downloadToken, "POST"), source })).status,
    ).toBe(405);
  });

  test("serve returns 410 once the grant has expired", async () => {
    const kv = memoryKv();
    const downloads = createDownloads<Meta, Rec>({
      store: kvTransferStore<Rec>(kv, "download:"),
      baseUrl: "https://files.example.test",
      ttlSeconds: -1, // already expired
    });
    const grant = await downloads.prepare({ owner: "u", metadata: { fileId: "f1" } });
    const res = await downloads.serve({ downloadId: grant.downloadId, request: getReq(grant.downloadToken), source });
    expect(res.status).toBe(410);
  });

  test("serve returns 502 when the source response is not ok", async () => {
    const { downloads } = newDownloads();
    const grant = await downloads.prepare({ owner: "u", metadata: { fileId: "f1" } });
    const failing: DownloadSource<Meta, Rec> = { async fetch() { return new Response("err", { status: 403 }); } };
    const res = await downloads.serve({ downloadId: grant.downloadId, request: getReq(grant.downloadToken), source: failing });
    expect(res.status).toBe(502);
  });
});

function uploadRequest(url: string, token: string, body: Uint8Array): Request {
  return new Request(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Length": String(body.byteLength),
    },
    body: body as unknown as BodyInit,
  });
}

function memoryKv(): UploadKvNamespace {
  const values = new Map<string, string>();
  return {
    async get(key: string) {
      return values.get(key) ?? null;
    },
    async put(key: string, value: string) {
      values.set(key, value);
    },
  };
}

function fakeMcpServer() {
  const handlers = new Map<string, (input: Record<string, unknown>) => Promise<McpToolResult>>();
  return {
    registerTool(
      name: string,
      _config: { inputSchema: Record<string, unknown> },
      handler: (input: Record<string, unknown>) => Promise<McpToolResult>,
    ) {
      handlers.set(name, handler);
    },
    async call(name: string, input: Record<string, unknown>) {
      const handler = handlers.get(name);
      if (!handler) throw new Error(`tool not registered: ${name}`);
      return handler(input);
    },
  };
}
