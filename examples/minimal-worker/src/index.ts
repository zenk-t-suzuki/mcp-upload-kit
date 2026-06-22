import {
  createUploads,
  kvUploadStore,
  opaqueUploadToken,
  streamToUint8Array,
  type TransferUploadRecord,
  type UploadDestination,
} from "../../../src/index";

interface Env {
  UPLOAD_KV: KVNamespace;
  MAX_UPLOAD_BYTES?: string;
}

interface MockFile {
  storedText: string;
}

type MockUploadRecord = TransferUploadRecord<MockFile>;

const mockStorage: UploadDestination<MockFile, MockUploadRecord> = {
  async receive({ body }) {
    return { storedText: new TextDecoder().decode(await streamToUint8Array(body)) };
  },
  response({ result, actualSize, actualSha256 }) {
    return {
      accepted: true,
      actualSize,
      actualSha256,
      storedText: result.storedText,
    };
  },
};

function uploads(env: Env, origin: string) {
  return createUploads<MockFile>({
    store: kvUploadStore<MockUploadRecord>(env.UPLOAD_KV),
    baseUrl: origin,
    maxBytes: env.MAX_UPLOAD_BYTES ?? 30 * 1024 * 1024,
    token: opaqueUploadToken(),
  });
}

export async function prepareUpload(env: Env, origin: string) {
  return uploads(env, origin).prepare({
    owner: "demo-user",
    name: "hello.txt",
    size: 11,
    contentType: "text/plain",
  });
}

export async function handleUpload(
  request: Request,
  env: Env,
  origin: string,
  uploadId: string,
): Promise<Response> {
  return uploads(env, origin).receive({
    uploadId,
    request,
    destination: mockStorage,
  });
}

export async function completeUpload(env: Env, origin: string, uploadId: string) {
  const record = await uploads(env, origin).complete({ uploadId, owner: "demo-user" });
  return {
    filename: record.name,
    size: record.actualSize,
    sha256: record.actualSha256,
    storedText: record.result?.storedText,
  };
}
