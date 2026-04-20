import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { apiError, requireAuth } from "@/lib/auth";
import {
  MAX_FILE_SIZE_BYTES,
  SUPPORTED_MIME_TYPES,
  type InputType,
  type UploadInitRequest,
  type UploadInitResponse,
} from "@/types";

function sanitizeFilename(fileName: string): string {
  const trimmed = fileName.trim();
  const noPath = trimmed.split(/[\\/]/).pop() ?? "upload.bin";
  return noPath.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function inferInputType(fileType: string): InputType | null {
  const normalized = fileType.toLowerCase();

  for (const [inputType, mimeList] of Object.entries(SUPPORTED_MIME_TYPES)) {
    if (mimeList.includes(normalized)) {
      return inputType as InputType;
    }
  }

  return null;
}

export async function POST(request: Request) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) {
    return authResult;
  }

  const { supabase, user } = authResult;

  let body: UploadInitRequest;
  try {
    body = (await request.json()) as UploadInitRequest;
  } catch {
    return apiError("Invalid JSON payload", 400, "BAD_JSON");
  }

  const { fileName, fileSize, fileType, conversationId } = body;

  if (!fileName || !fileType || !conversationId || typeof fileSize !== "number") {
    return apiError("Missing required fields", 400, "INVALID_PAYLOAD");
  }

  if (fileSize <= 0 || fileSize > MAX_FILE_SIZE_BYTES) {
    return apiError(
      `File size must be between 1 and ${MAX_FILE_SIZE_BYTES} bytes`,
      400,
      "INVALID_FILE_SIZE"
    );
  }

  const inputType = inferInputType(fileType);
  if (!inputType) {
    return apiError("Unsupported file type", 400, "UNSUPPORTED_FILE_TYPE");
  }

  const { data: conversation, error: conversationError } = await supabase
    .from("conversations")
    .select("id")
    .eq("id", conversationId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (conversationError) {
    return apiError(conversationError.message, 500, "DB_ERROR");
  }

  if (!conversation) {
    return apiError("Conversation not found", 404, "CONVERSATION_NOT_FOUND");
  }

  const safeName = sanitizeFilename(fileName);
  const storagePath = `${user.id}/${conversationId}/${Date.now()}-${randomUUID()}-${safeName}`;

  const { data, error } = await supabase.storage
    .from("input-files")
    .createSignedUploadUrl(storagePath, { upsert: false });

  if (error || !data) {
    return apiError(error?.message ?? "Failed to initialize upload", 500, "UPLOAD_INIT_FAILED");
  }

  const response: UploadInitResponse & { inputType: InputType; uploadToken: string } = {
    uploadUrl: data.signedUrl,
    storagePath: data.path,
    inputType,
    uploadToken: data.token,
  };

  return NextResponse.json(response, { status: 200 });
}
