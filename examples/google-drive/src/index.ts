import {
  createUploads,
  jwtUploadToken,
  kvUploadStore,
  type TransferUploadRecord,
  type UploadDestination,
} from "../../../src/index";

interface Env {
  UPLOAD_KV: KVNamespace;
  JWT_SIGNING_KEY: string;
  WORKER_BASE_URL: string;
  MAX_UPLOAD_BYTES?: string;
}

interface DriveFile {
  fileId: string;
  name: string;
  mimeType: string;
}

interface DriveAdapter {
  upload(input: {
    filename: string;
    contentType: string;
    contentLength: number;
    body: ReadableStream<Uint8Array>;
  }): Promise<DriveFile>;
  delete?(fileId: string): Promise<void>;
}

type DriveUploadRecord = TransferUploadRecord<DriveFile, { parentFolderId?: string }>;

export function googleDriveDestination(adapter: DriveAdapter): UploadDestination<DriveFile, DriveUploadRecord> {
  return {
    receive({ record, body, contentLength }) {
      return adapter.upload({
        filename: record.name,
        contentType: record.contentType,
        contentLength,
        body,
      });
    },
    async cleanup({ result }) {
      await adapter.delete?.(result.fileId);
    },
    response({ result, actualSize, actualSha256 }) {
      return {
        accepted: true,
        fileId: result.fileId,
        actualSize,
        actualSha256,
      };
    },
  };
}

export function driveUploads(env: Env) {
  return createUploads<DriveFile, { parentFolderId?: string }, DriveUploadRecord>({
    store: kvUploadStore(env.UPLOAD_KV),
    baseUrl: env.WORKER_BASE_URL,
    maxBytes: env.MAX_UPLOAD_BYTES ?? 30 * 1024 * 1024,
    token: jwtUploadToken(env.JWT_SIGNING_KEY),
  });
}

export async function prepareDriveUpload(
  env: Env,
  input: {
    userId: string;
    filename: string;
    size: number;
    contentType: string;
    sha256?: string;
    parentFolderId?: string;
  },
) {
  return driveUploads(env).prepare({
    owner: input.userId,
    name: input.filename,
    size: input.size,
    contentType: input.contentType,
    ...(input.sha256 ? { sha256: input.sha256 } : {}),
    metadata: { ...(input.parentFolderId ? { parentFolderId: input.parentFolderId } : {}) },
  });
}

export async function handleDriveUpload(
  request: Request,
  env: Env,
  adapter: DriveAdapter,
  uploadId: string,
): Promise<Response> {
  return driveUploads(env).receive({
    uploadId,
    request,
    destination: googleDriveDestination(adapter),
  });
}

export async function completeDriveUpload(env: Env, uploadId: string, userId: string) {
  const record = await driveUploads(env).complete({ uploadId, owner: userId });
  return {
    fileId: record.result?.fileId,
    name: record.result?.name ?? record.name,
    mimeType: record.result?.mimeType ?? record.contentType,
    size: record.actualSize ?? record.size,
    sha256: record.actualSha256 ?? record.sha256 ?? "",
  };
}
