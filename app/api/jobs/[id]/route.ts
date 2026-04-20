import { NextResponse } from "next/server";
import { apiError, requireAuth } from "@/lib/auth";
import type { JobStatusResponse } from "@/types";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) {
    return authResult;
  }

  const { supabase, user } = authResult;
  const { id } = await context.params;

  if (!id) {
    return apiError("Missing job id", 400, "INVALID_JOB_ID");
  }

  const { data: job, error } = await supabase
    .from("jobs")
    .select(
      "id, status, input_type, result_shape, n_segments, output_json_path, output_npy_path, output_preview_path, error_message, metadata, updated_at"
    )
    .eq("id", id)
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) {
    return apiError(error.message, 500, "DB_ERROR");
  }

  if (!job) {
    return apiError("Job not found", 404, "JOB_NOT_FOUND");
  }

  const metadata = typeof job.metadata === "object" && job.metadata ? job.metadata : {};

  const response: JobStatusResponse = {
    id: job.id,
    status: job.status,
    input_type: job.input_type,
    error: job.error_message,
    updated_at: job.updated_at,
    result: {
      shape: job.result_shape ?? [],
      n_segments: job.n_segments ?? 0,
      output_json_path: job.output_json_path,
      output_npy_path: job.output_npy_path,
      output_preview_path: job.output_preview_path,
      brain_features_ready: Boolean((metadata as Record<string, unknown>).brain_features_ready),
      interpretation_ready: Boolean((metadata as Record<string, unknown>).interpretation_ready),
      interpretation_message_id:
        typeof (metadata as Record<string, unknown>).interpretation_message_id === "string"
          ? ((metadata as Record<string, unknown>).interpretation_message_id as string)
          : null,
    },
  };

  return NextResponse.json(response, { status: 200 });
}
