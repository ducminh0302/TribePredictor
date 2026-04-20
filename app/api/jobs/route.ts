import { NextResponse } from "next/server";
import { apiError, requireAuth } from "@/lib/auth";
import type { Json } from "@/types/supabase";
import type { CreateJobRequest, CreateJobResponse, InputType } from "@/types";

const INPUT_TYPES: InputType[] = ["text", "image", "video", "audio", "file"];

function isValidInputType(value: unknown): value is InputType {
  return typeof value === "string" && INPUT_TYPES.includes(value as InputType);
}

function isValidUuid(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }

  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function buildModalUrls(endpoint: string) {
  const normalized = endpoint.replace(/\/+$/, "");
  const hasInferSuffix = /\/infer$/i.test(normalized);
  const base = hasInferSuffix ? normalized.replace(/\/infer$/i, "") : normalized;
  const candidates = hasInferSuffix
    ? [base, normalized]
    : [normalized, `${normalized}/infer`];

  return Array.from(new Set(candidates));
}

async function dispatchModalJob(params: {
  endpoint: string;
  payload: Record<string, unknown>;
}) {
  const { endpoint, payload } = params;
  const urls = buildModalUrls(endpoint);

  let lastStatus: number | null = null;
  let lastBody: string | null = null;

  for (const url of urls) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        cache: "no-store",
      });

      const rawBody = await response.text();
      let parsedBody: Record<string, unknown> | null = null;
      if (rawBody) {
        try {
          const parsed = JSON.parse(rawBody);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            parsedBody = parsed as Record<string, unknown>;
          }
        } catch {
          // Non-JSON body; keep raw text for debugging.
        }
      }

      if (response.ok && !parsedBody?.error) {
        return { ok: true, url, status: response.status };
      }

      lastStatus = response.status;
      lastBody = rawBody;
    } catch {
      // Continue trying fallback URL candidates.
    }
  }

  return {
    ok: false,
    status: lastStatus,
    body: lastBody,
    triedUrls: urls,
  };
}

export async function POST(request: Request) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) {
    return authResult;
  }

  const { supabase, user } = authResult;

  let body: CreateJobRequest;
  try {
    body = (await request.json()) as CreateJobRequest;
  } catch {
    return apiError("Invalid JSON payload", 400, "BAD_JSON");
  }

  const {
    conversation_id,
    user_text,
    input_type,
    input_path,
    client_request_id,
    interpret_mode,
    campaign_context,
  } = body;

  if (
    !conversation_id ||
    !input_path ||
    !client_request_id ||
    !isValidInputType(input_type) ||
    !isValidUuid(client_request_id)
  ) {
    return apiError("Invalid payload", 400, "INVALID_PAYLOAD");
  }

  const expectedPrefix = `${user.id}/${conversation_id}/`;
  if (!input_path.startsWith(expectedPrefix)) {
    return apiError("Invalid input path prefix", 422, "INVALID_INPUT_PATH");
  }

  const { data: conversation, error: conversationError } = await supabase
    .from("conversations")
    .select("id")
    .eq("id", conversation_id)
    .eq("user_id", user.id)
    .maybeSingle();

  if (conversationError) {
    return apiError(conversationError.message, 500, "DB_ERROR");
  }

  if (!conversation) {
    return apiError("Conversation not found", 404, "CONVERSATION_NOT_FOUND");
  }

  const { data: existingJob, error: existingJobError } = await supabase
    .from("jobs")
    .select("id, status, message_id")
    .eq("user_id", user.id)
    .contains("metadata", { client_request_id })
    .maybeSingle();

  if (existingJobError) {
    return apiError(existingJobError.message, 500, "DB_ERROR");
  }

  if (existingJob) {
    const duplicateResponse: CreateJobResponse = {
      job_id: existingJob.id,
      message_id: existingJob.message_id ?? "",
      status: existingJob.status,
      poll_url: `/api/jobs/${existingJob.id}`,
      interpret_url: `/api/jobs/${existingJob.id}/interpret`,
    };

    return NextResponse.json(duplicateResponse, { status: 200 });
  }

  const { data: inputProbe, error: inputProbeError } = await supabase.storage
    .from("input-files")
    .createSignedUrl(input_path, 60);

  if (inputProbeError || !inputProbe) {
    return apiError("Input file missing or inaccessible", 422, "INPUT_UNAVAILABLE");
  }

  const { data: createdMessage, error: messageError } = await supabase
    .from("messages")
    .insert({
      user_id: user.id,
      conversation_id,
      role: "user",
      content: user_text ?? null,
      input_type,
      attachment_path: input_path,
      attachment_url: null,
    })
    .select("id")
    .single();

  if (messageError || !createdMessage) {
    return apiError(messageError?.message ?? "Failed to create message", 500, "MESSAGE_CREATE_FAILED");
  }

  const metadata: Json = {
    client_request_id,
    interpret_mode: interpret_mode ?? "explain_reaction",
    campaign_context: (campaign_context ?? {}) as Json,
    brain_features_ready: false,
    interpretation_ready: false,
  };

  const { data: createdJob, error: jobError } = await supabase
    .from("jobs")
    .insert({
      user_id: user.id,
      conversation_id,
      message_id: createdMessage.id,
      input_type,
      input_path,
      status: "queued",
      metadata,
    })
    .select("id, status")
    .single();

  if (jobError || !createdJob) {
    return apiError(jobError?.message ?? "Failed to create job", 500, "JOB_CREATE_FAILED");
  }

  const modalEndpoint = process.env.MODAL_ENDPOINT_URL;
  const modalSharedSecret = process.env.MODAL_SHARED_SECRET;

  if (!modalEndpoint || !modalSharedSecret) {
    return apiError("Modal endpoint is not configured", 500, "MODAL_CONFIG_MISSING");
  }

  const modalPayload = {
    job_id: createdJob.id,
    user_id: user.id,
    conversation_id,
    message_id: createdMessage.id,
    input_type,
    input_path,
    _secret: modalSharedSecret,
  };

  const dispatchResult = await dispatchModalJob({
    endpoint: modalEndpoint,
    payload: modalPayload,
  });

  if (!dispatchResult.ok) {
    const dispatchMessage = `Modal dispatch failed (status=${dispatchResult.status ?? "unknown"})`;
    const triedUrls = dispatchResult.triedUrls?.join(",") ?? "";

    await supabase
      .from("jobs")
      .update({
        status: "failed",
        error_message: `${dispatchMessage}; tried=${triedUrls}; body=${dispatchResult.body ?? ""}`.slice(0, 2000),
      })
      .eq("id", createdJob.id)
      .eq("user_id", user.id);

    return apiError(dispatchMessage, 502, "MODAL_DISPATCH_FAILED");
  }

  const response: CreateJobResponse = {
    job_id: createdJob.id,
    message_id: createdMessage.id,
    status: createdJob.status,
    poll_url: `/api/jobs/${createdJob.id}`,
    interpret_url: `/api/jobs/${createdJob.id}/interpret`,
  };

  return NextResponse.json(response, { status: 202 });
}
