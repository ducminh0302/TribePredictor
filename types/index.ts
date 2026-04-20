/**
 * Shared domain types for the TRIBE Chat MVP.
 * Used across API routes, components, and hooks.
 */

import type { Tables, Enums } from "@/types/supabase";

// ─── Row types (DB → App) ──────────────────────────────────────
export type Conversation = Tables<"conversations">;
export type Message = Tables<"messages">;
export type Job = Tables<"jobs">;

// ─── Enum types ────────────────────────────────────────────────
export type InputType = Enums<"input_type">;
export type JobStatus = Enums<"job_status">;
export type MessageRole = Enums<"message_role">;

// ─── API Payloads ──────────────────────────────────────────────

/** POST /api/uploads/init — request */
export interface UploadInitRequest {
  fileName: string;
  fileType: string; // MIME type
  fileSize: number; // bytes
  conversationId: string;
}

/** POST /api/uploads/init — response */
export interface UploadInitResponse {
  uploadUrl: string; // signed Supabase Storage URL
  storagePath: string; // path inside the bucket
}

/** POST /api/jobs — request */
export interface CreateJobRequest {
  conversation_id: string;
  user_text?: string;
  input_type: InputType;
  input_path: string; // storage path in input-files bucket
  client_request_id: string; // idempotency key (UUID from client)
  interpret_mode?: InterpretMode;
  campaign_context?: CampaignContext;
}

/** POST /api/jobs — response (202 Accepted) */
export interface CreateJobResponse {
  job_id: string;
  message_id: string;
  status: JobStatus;
  poll_url: string;
  interpret_url: string;
}

/** GET /api/jobs/[id] — response */
export interface JobStatusResponse {
  id: string;
  status: JobStatus;
  input_type: InputType;
  result?: JobResult;
  error: string | null;
  updated_at: string;
}

export interface JobResult {
  shape: number[];
  n_segments: number;
  output_json_path: string | null;
  output_npy_path: string | null;
  output_preview_path: string | null;
  output_mesh_path?: string | null;
  brain_features_ready: boolean;
  interpretation_ready: boolean;
  interpretation_message_id: string | null;
}

/** POST /api/jobs/[id]/interpret — request */
export interface InterpretJobRequest {
  mode: InterpretMode;
  user_instruction?: string;
  model?: string;
  temperature?: number;
  max_tokens?: number;
}

/** POST /api/jobs/[id]/interpret — response */
export interface InterpretJobResponse {
  job_id: string;
  mode: InterpretMode;
  message_id: string;
  interpretation: Interpretation;
}

// ─── Domain-specific types ────────────────────────────────────

export type InterpretMode =
  | "explain_reaction"
  | "recommend_improvements"
  | "compare_variants";

export interface CampaignContext {
  goal?: string;
  target_audience?: string;
  channel?: string;
}

export interface Interpretation {
  executive_summary: string;
  key_findings: string[];
  recommendations: string[];
  confidence: "high" | "medium" | "low";
  limitations: string;
}

/** Brain feature summary produced by Modal worker */
export interface BrainFeatures {
  global_mean: number;
  global_max: number;
  global_variance: number;
  peak_timestep: number;
  low_timestep: number;
  sustained_zones: number[];
  n_segments: number;
  result_shape: number[];
}

// ─── Supported MIME types ─────────────────────────────────────
export const SUPPORTED_MIME_TYPES: Record<InputType, string[]> = {
  text: ["text/plain"],
  image: ["image/jpeg", "image/png", "image/webp", "image/gif"],
  video: ["video/mp4", "video/quicktime", "video/webm"],
  audio: ["audio/mpeg", "audio/wav", "audio/ogg", "audio/webm"],
  file: ["application/pdf"],
};

export const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB
