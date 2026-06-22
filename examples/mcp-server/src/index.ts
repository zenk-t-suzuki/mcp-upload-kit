import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  createUploadMcp,
  kvUploadStore,
  opaqueUploadToken,
  standardUploadInput,
  streamToUint8Array,
  type TransferUploadRecord,
  type UploadDestination,
} from "../../../src/index";

interface Env {
  UPLOAD_KV: KVNamespace;
  MAX_UPLOAD_BYTES?: string;
}

type UploadMetadata =
  | { purpose: "avatar"; profileId: string }
  | { purpose: "attachment"; recordId: string };

type UploadResult =
  | { purpose: "avatar"; imageUrl: string }
  | { purpose: "attachment"; storedText: string };

type UploadRecord = TransferUploadRecord<UploadResult, UploadMetadata>;

const avatarStorage: UploadDestination<UploadResult, UploadRecord> = {
  async receive({ record, body }) {
    if (record.metadata?.purpose !== "avatar") {
      throw new Error("avatar upload expected");
    }
    await streamToUint8Array(body);
    return {
      purpose: "avatar",
      imageUrl: `https://cdn.example.test/profiles/${record.metadata.profileId}/avatar`,
    };
  },
  response({ result, actualSize, actualSha256 }) {
    if (result.purpose !== "avatar") {
      throw new Error("avatar upload result expected");
    }
    return {
      accepted: true,
      purpose: result.purpose,
      imageUrl: result.imageUrl,
      actualSize,
      actualSha256,
    };
  },
};

const attachmentStorage: UploadDestination<UploadResult, UploadRecord> = {
  async receive({ body }) {
    return {
      purpose: "attachment",
      storedText: new TextDecoder().decode(await streamToUint8Array(body)),
    };
  },
  response({ result, actualSize, actualSha256 }) {
    return {
      accepted: true,
      purpose: result.purpose,
      actualSize,
      actualSha256,
    };
  },
};

function createDemoUploadMcp(env: Env, origin: string) {
  return createUploadMcp<UploadResult, UploadMetadata, UploadRecord>({
    store: kvUploadStore<UploadRecord>(env.UPLOAD_KV),
    baseUrl: origin,
    maxBytes: env.MAX_UPLOAD_BYTES ?? 30 * 1024 * 1024,
    token: opaqueUploadToken(),
    completeDescription: "Complete any avatar or attachment upload prepared by this server.",
  })
    .addPurpose("avatar", {
      title: "Prepare avatar upload",
      description: "Create a short-lived upload URL for a profile avatar image.",
      inputSchema: standardUploadInput({
        contentType: z.enum(["image/png", "image/jpeg", "image/webp"]),
        maxSize: 5 * 1024 * 1024,
        extra: {
          profileId: z.string().min(1),
        },
      }),
      destination: avatarStorage,
      metadata(input: { profileId: string }) {
        return { profileId: input.profileId };
      },
    })
    .addPurpose("attachment", {
      title: "Prepare attachment upload",
      description: "Create a short-lived upload URL for a record attachment.",
      inputSchema: standardUploadInput({
        extra: {
          recordId: z.string().min(1),
        },
      }),
      destination: attachmentStorage,
      metadata(input: { recordId: string }) {
        return { recordId: input.recordId };
      },
    });
}

function registerProfileSummaryTool(server: McpServer): void {
  server.registerTool(
    "get_profile_summary",
    {
      title: "Get profile summary",
      description: "Return profile metadata that does not involve file uploads.",
      inputSchema: {
        profileId: z.string().min(1),
      },
    },
    async ({ profileId }) => {
      const result = {
        profileId: String(profileId),
        displayName: `Profile ${profileId}`,
        avatarConfigured: false,
      };
      return {
        structuredContent: result,
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    },
  );
}

export function registerDemoTools(
  server: McpServer,
  env: Env,
  origin: string,
  getOwner: () => string,
): void {
  registerProfileSummaryTool(server);
  createDemoUploadMcp(env, origin).registerTools(server, getOwner);
}

export async function handleUploadRoute(
  request: Request,
  env: Env,
  origin: string,
  uploadId: string,
): Promise<Response> {
  return createDemoUploadMcp(env, origin).receive(request, uploadId);
}
