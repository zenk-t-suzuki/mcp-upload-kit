import {
  createUploads,
  kvUploadStore,
  opaqueUploadToken,
  streamToUint8Array,
  type TransferUploadRecord,
  type UploadDestination,
} from "../../../src/index";

interface Env {
  SESSIONS: KVNamespace;
  MAX_UPLOAD_BYTES?: string;
}

interface KintoneFile {
  fileKey: string;
}

interface KintoneAdapter {
  uploadFile(input: {
    name: string;
    bytes: Uint8Array;
    contentType: string;
  }): Promise<KintoneFile>;
}

type KintoneUploadRecord = TransferUploadRecord<
  KintoneFile,
  { email: string; credentialId: number }
>;

export function kintoneDestination(adapter: KintoneAdapter): UploadDestination<KintoneFile, KintoneUploadRecord> {
  return {
    async receive({ record, body }) {
      return adapter.uploadFile({
        name: record.name,
        bytes: await streamToUint8Array(body),
        contentType: record.contentType,
      });
    },
    response({ result, actualSize, actualSha256 }) {
      return {
        accepted: true,
        fileKey: result.fileKey,
        size: actualSize,
        sha256: actualSha256,
      };
    },
  };
}

export function kintoneUploads(env: Env, origin: string) {
  return createUploads<KintoneFile, { email: string; credentialId: number }, KintoneUploadRecord>({
    store: kvUploadStore(env.SESSIONS),
    baseUrl: origin,
    maxBytes: env.MAX_UPLOAD_BYTES ?? 30 * 1024 * 1024,
    token: opaqueUploadToken(),
  });
}

export async function prepareKintoneUpload(
  env: Env,
  origin: string,
  input: {
    email: string;
    credentialId: number;
    name: string;
    size: number;
    contentType: string;
    sha256?: string;
  },
) {
  return kintoneUploads(env, origin).prepare({
    owner: input.email,
    name: input.name,
    size: input.size,
    contentType: input.contentType,
    ...(input.sha256 ? { sha256: input.sha256 } : {}),
    metadata: { email: input.email, credentialId: input.credentialId },
  });
}

export async function handleKintoneUpload(
  request: Request,
  env: Env,
  origin: string,
  adapter: KintoneAdapter,
  uploadId: string,
): Promise<Response> {
  return kintoneUploads(env, origin).receive({
    uploadId,
    request,
    destination: kintoneDestination(adapter),
  });
}

export async function completeKintoneUpload(env: Env, origin: string, uploadId: string, email: string) {
  const record = await kintoneUploads(env, origin).complete({ uploadId, owner: email });
  return {
    fileKey: record.result?.fileKey,
    name: record.name,
    size: record.actualSize ?? record.size,
    sha256: record.actualSha256 ?? record.sha256 ?? "",
  };
}
