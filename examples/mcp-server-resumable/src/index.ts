// resumable（分割）アップロード対応の MCP アップロードサーバ。
//
// examples/mcp-server と同じ骨格。違いは [RESUMABLE] の箇所だけ:
//   - コントローラが既定でなく `resumableReceiver()` を使う
//   - PUT ルートが `ResumableUploadDestination` を使う
//
// クライアントは各チャンクを `Content-Range: bytes <start>-<end>/<total>` 付きで
// PUT し、kit は最終チャンクまで 308（`Range` ヘッダ付き）を返す。
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  createUploads,
  resumableReceiver, // [RESUMABLE]
  registerCompleteUploadTool,
  standardUploadInput,
  opaqueUploadToken,
  kvTransferStore,
  sha256Hex,
  type TransferUploadRecord,
  type ResumableUploadDestination, // [RESUMABLE]
} from "../../../src/index";

interface Env {
  UPLOAD_KV: KVNamespace;
  WORKER_BASE_URL: string;
}

interface StoredFile {
  objectKey: string;
}
type FileRecord = TransferUploadRecord<StoredFile>;

// [RESUMABLE] リクエストをまたぐ状態（オフセット・蓄積バイト・全体ハッシュ）を
// PUT 間で保持する必要がある。本番では uploadId ごとの Durable Object を使う。
// ここでは例を自己完結させるため in-memory の Map を使う。
const offsets = new Map<string, number>();
const parts = new Map<string, Uint8Array[]>();

const destination: ResumableUploadDestination<StoredFile, FileRecord> = {
  async writeChunk({ record, chunk, range }) {
    const id = record.uploadId;
    const at = offsets.get(id) ?? 0;
    // 順序がずれたチャンクは拒否する。
    if (range.start !== at) {
      return { status: "error", httpStatus: 409, message: `expected offset ${at}, got ${range.start}` };
    }
    const buffered = parts.get(id) ?? [];
    buffered.push(chunk);
    parts.set(id, buffered);
    offsets.set(id, range.end + 1);

    // まだ最終チャンクでない -> 次のオフセットをクライアントへ返す。
    if (range.end + 1 < range.total) {
      return { status: "incomplete", nextOffset: range.end + 1 };
    }
    // 最終チャンク: 結合してハッシュし、完了を報告する。
    const all = concat(buffered);
    offsets.delete(id);
    parts.delete(id);
    return { status: "complete", result: { objectKey: id }, actualSize: all.byteLength, actualSha256: await sha256Hex(all) };
  },
  response: ({ result }) => ({ objectKey: result.objectKey }),
};

function uploads(env: Env) {
  return createUploads<StoredFile, unknown, FileRecord, ResumableUploadDestination<StoredFile, FileRecord>>({
    store: kvTransferStore<FileRecord>(env.UPLOAD_KV),
    baseUrl: env.WORKER_BASE_URL,
    maxBytes: 100 * 1024 * 1024,
    token: opaqueUploadToken(),
    receiver: resumableReceiver<StoredFile, FileRecord>(), // [RESUMABLE]
  });
}

// prepare_upload + complete_upload は single-shot 版と同一。resumable 化で
// 変わるのはバイトの届き方だけで、ツールの形は変わらない。
export function registerUploadTools(server: McpServer, env: Env, getOwner: () => string): void {
  const ctrl = uploads(env);

  server.registerTool(
    "prepare_upload",
    {
      title: "Prepare upload",
      description: "Issue a short-lived HTTPS PUT URL for one (possibly large) file.",
      inputSchema: standardUploadInput(),
    },
    async (input) => {
      const { name, size, contentType, sha256 } = input as {
        name: string;
        size: number;
        contentType: string;
        sha256?: string;
      };
      const prepared = await ctrl.prepare({
        owner: getOwner(),
        name,
        size,
        contentType,
        ...(sha256 ? { sha256 } : {}),
      });
      return { structuredContent: { ...prepared }, content: [{ type: "text", text: JSON.stringify(prepared) }] };
    },
  );

  registerCompleteUploadTool(server, {
    uploads: ctrl,
    getOwner,
    toResult: (record) => ({
      objectKey: record.result?.objectKey ?? "",
      size: record.actualSize ?? record.size,
      sha256: record.actualSha256 ?? "",
    }),
  });
}

// `PUT /upload/:uploadId` をここへ繋ぐ。1回の呼び出しで1チャンクを処理する。
export function handleUpload(request: Request, env: Env, uploadId: string): Promise<Response> {
  return uploads(env).receive({ uploadId, request, destination });
}

// 蓄積したチャンクを1つに結合する。
function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}
