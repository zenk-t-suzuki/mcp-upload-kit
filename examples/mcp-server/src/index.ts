// 最小構成の MCP アップロードサーバ（single-shot: 1回の PUT でファイル全体を送る）。
//
// モデルがたどる流れ:
//   1. prepare_upload  を呼ぶ -> 短期有効な HTTPS PUT URL + token を受け取る
//   2. その URL に生バイトを PUT する（ツール呼び出しではなく通常の HTTPS PUT）
//   3. complete_upload を呼ぶ -> 保存済みファイルの最終結果を受け取る
//
// バックエンド固有なのは `destination` だけ。実ストレージに差し替える。
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  createUploads,
  registerCompleteUploadTool,
  standardUploadInput,
  opaqueUploadToken,
  kvUploadStore,
  streamToUint8Array,
  type TransferUploadRecord,
  type UploadDestination,
} from "../../../src/index";

interface Env {
  UPLOAD_KV: KVNamespace;
  WORKER_BASE_URL: string;
}

// `destination` が返す値。kit が record の `result` として保存する。
interface StoredFile {
  objectKey: string;
}
type FileRecord = TransferUploadRecord<StoredFile>;

// 唯一のバックエンド固有部分。既定の receiver がリクエストを検証済みなので、
// ここでは受信ストリームを保存して識別子を返すだけ。
const destination: UploadDestination<StoredFile, FileRecord> = {
  async receive({ record, body }) {
    await streamToUint8Array(body); // TODO: `body` を実ストレージへ書き込む。
    return { objectKey: record.uploadId };
  },
  response: ({ result }) => ({ objectKey: result.objectKey }),
};

function uploads(env: Env) {
  return createUploads<StoredFile>({
    store: kvUploadStore<FileRecord>(env.UPLOAD_KV),
    baseUrl: env.WORKER_BASE_URL,
    maxBytes: 30 * 1024 * 1024,
    token: opaqueUploadToken(),
    // `receiver` 省略時は singleShotReceiver()（既定）。
  });
}

// 2つのアップロードツールを MCP サーバへ登録する。
// `getOwner` は認証済みユーザ ID を返す（例: リクエストの認証コンテキストから）。
export function registerUploadTools(server: McpServer, env: Env, getOwner: () => string): void {
  const ctrl = uploads(env);

  server.registerTool(
    "prepare_upload",
    {
      title: "Prepare upload",
      description: "Issue a short-lived HTTPS PUT URL for one file.",
      inputSchema: standardUploadInput(), // { name, size, contentType, sha256? }
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

  // 共通の完了ツール: ステータスを確認し、保存結果を返す。
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

// Worker の fetch ハンドラで `PUT /upload/:uploadId` をここへ繋ぐ。
export function handleUpload(request: Request, env: Env, uploadId: string): Promise<Response> {
  return uploads(env).receive({ uploadId, request, destination });
}
