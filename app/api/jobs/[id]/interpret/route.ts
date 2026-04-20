import { NextResponse } from "next/server";
import { apiError, requireAuth } from "@/lib/auth";
import type { Json } from "@/types/supabase";
import type {
  InterpretJobRequest,
  InterpretJobResponse,
  InterpretMode,
  Interpretation,
} from "@/types";

const INTERPRET_MODES: InterpretMode[] = [
  "explain_reaction",
  "recommend_improvements",
  "compare_variants",
];

const MEDICAL_TERMS_REGEX =
  /\b(diagnos(?:is|e|ed|ing)|clinical|disease|disorder|patient|therapy|treatment|depression|anxiety|adhd|autism|ptsd)\b/gi;

function isInterpretMode(value: unknown): value is InterpretMode {
  return typeof value === "string" && INTERPRET_MODES.includes(value as InterpretMode);
}

function stripCodeFences(raw: string): string {
  return raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function extractFirstJsonObject(raw: string): string | null {
  const start = raw.indexOf("{");
  if (start === -1) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return raw.slice(start, i + 1);
      }
    }
  }

  return null;
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  const cleaned = stripCodeFences(raw);

  try {
    const parsed = JSON.parse(cleaned);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    const extracted = extractFirstJsonObject(cleaned);
    if (!extracted) {
      return null;
    }

    try {
      const parsed = JSON.parse(extracted);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return null;
    } catch {
      return null;
    }
  }
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
}

function normalizeConfidence(value: unknown): "high" | "medium" | "low" {
  if (typeof value !== "string") {
    return "medium";
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "high" || normalized === "medium" || normalized === "low") {
    return normalized;
  }

  return "medium";
}

function scrubMedicalLanguage(text: string): string {
  return text.replace(MEDICAL_TERMS_REGEX, "business audience signal");
}

function enforceGuardrails(input: Interpretation): Interpretation {
  const executiveSummary = scrubMedicalLanguage(input.executive_summary || "");
  const keyFindings = (input.key_findings || []).map((finding) => scrubMedicalLanguage(finding));
  const recommendations = (input.recommendations || []).map((recommendation) =>
    scrubMedicalLanguage(recommendation)
  );

  let limitations = scrubMedicalLanguage(input.limitations || "");
  const hasProbabilisticNotice = /probabilistic|confidence|limitations|uncertain/i.test(limitations);
  if (!hasProbabilisticNotice) {
    limitations = `${limitations} This is a probabilistic audience-insight estimate and should be validated with real user testing.`.trim();
  }

  return {
    executive_summary: executiveSummary,
    key_findings: keyFindings.length > 0 ? keyFindings : ["Evidence is limited and should be interpreted cautiously."],
    recommendations:
      recommendations.length > 0
        ? recommendations
        : ["Collect additional audience evidence before making major creative decisions."],
    confidence: input.confidence,
    limitations,
  };
}

function buildPrompt(params: {
  mode: InterpretMode;
  userInstruction?: string;
  inputType: string;
  userText?: string | null;
  campaignContext?: unknown;
  brainFeatures: Record<string, unknown>;
}) {
  const { mode, userInstruction, inputType, userText, campaignContext, brainFeatures } = params;

  const modeDescriptions: Record<InterpretMode, string> = {
    explain_reaction: "Explain likely audience reaction in clear business language.",
    recommend_improvements: "Provide concrete, actionable improvement recommendations for the asset.",
    compare_variants: "Compare likely audience outcomes across variants if enough evidence exists.",
  };

  return [
    "You are a business insight analyst for media and marketing teams.",
    "You interpret structured brain-response features from TRIBE into practical communication guidance.",
    "",
    `Interpretation mode: ${mode}`,
    `Mode objective: ${modeDescriptions[mode]}`,
    `Asset input type: ${inputType}`,
    `User request text: ${userText ?? "(not provided)"}`,
    `Additional user instruction: ${userInstruction ?? "(none)"}`,
    `Campaign context: ${JSON.stringify(campaignContext ?? {}, null, 2)}`,
    "",
    "Structured brain features:",
    JSON.stringify(brainFeatures, null, 2),
    "",
    "Hard requirements:",
    "1. Do not use medical or diagnostic language.",
    "2. Always include confidence and limitations.",
    "3. Tie each recommendation to evidence from the provided features.",
    "4. If evidence is weak or inconclusive, say so explicitly.",
    "5. Use business framing: attention, emotional engagement, memory encoding, clarity, fatigue risk.",
    "",
    "Return strict JSON only with this schema:",
    "{",
    '  "executive_summary": "string",',
    '  "key_findings": ["string"],',
    '  "recommendations": ["string"],',
    '  "confidence": "high|medium|low",',
    '  "limitations": "string"',
    "}",
  ].join("\n");
}

function buildFallbackInterpretationFromRaw(raw: string, mode: InterpretMode): Interpretation {
  const condensed = stripCodeFences(raw).replace(/\s+/g, " ").trim();
  const shortSummary = condensed.length > 280 ? `${condensed.slice(0, 277)}...` : condensed;

  const modeHint: Record<InterpretMode, string> = {
    explain_reaction: "Frame likely audience reaction using attention, emotion, and memory cues.",
    recommend_improvements: "Prioritize one messaging edit and one creative execution edit.",
    compare_variants: "Compare variants only where signal is strong; otherwise request more evidence.",
  };

  return {
    executive_summary:
      shortSummary ||
      "Initial model output was not in strict JSON, so this summary is a conservative fallback.",
    key_findings: [
      "Brain-feature inference completed successfully and artifacts are available.",
      "Interpretation text required normalization because provider output was not strict JSON.",
    ],
    recommendations: [
      modeHint[mode],
      "Validate this recommendation with additional audience testing before major rollout.",
    ],
    confidence: "medium",
    limitations:
      "Provider response formatting was inconsistent with the requested schema, so this output uses a guarded fallback.",
  };
}

async function loadBrainFeaturesFromStorage(supabase: Awaited<ReturnType<typeof requireAuth>> extends infer T
  ? T extends { supabase: infer S }
    ? S
    : never
  : never, outputJsonPath: string) {
  const { data, error } = await supabase.storage.from("output-files").download(outputJsonPath);
  if (error || !data) {
    return null;
  }

  const raw = await data.text();
  const parsed = parseJsonObject(raw);
  if (!parsed) {
    return null;
  }

  const maybeFeatures = parsed.brain_features;
  if (!maybeFeatures || typeof maybeFeatures !== "object" || Array.isArray(maybeFeatures)) {
    return null;
  }

  return maybeFeatures as Record<string, unknown>;
}

async function callGemini(params: {
  apiKey: string;
  model: string;
  prompt: string;
  temperature: number;
  maxTokens: number;
}) {
  const { apiKey, model, prompt, temperature, maxTokens } = params;

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature,
        maxOutputTokens: maxTokens,
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          required: [
            "executive_summary",
            "key_findings",
            "recommendations",
            "confidence",
            "limitations",
          ],
          properties: {
            executive_summary: { type: "STRING" },
            key_findings: { type: "ARRAY", items: { type: "STRING" } },
            recommendations: { type: "ARRAY", items: { type: "STRING" } },
            confidence: { type: "STRING", enum: ["high", "medium", "low"] },
            limitations: { type: "STRING" },
          },
        },
      },
    }),
    cache: "no-store",
  });

  const payload = (await response.json()) as Record<string, unknown>;

  if (!response.ok) {
    const message =
      typeof payload.error === "object" && payload.error
        ? String((payload.error as Record<string, unknown>).message ?? "Gemini API error")
        : "Gemini API error";

    throw new Error(message);
  }

  const candidates = Array.isArray(payload.candidates)
    ? (payload.candidates as Record<string, unknown>[])
    : [];

  const firstCandidate = candidates[0];
  const content = firstCandidate?.content as Record<string, unknown> | undefined;
  const parts = Array.isArray(content?.parts) ? (content?.parts as Record<string, unknown>[]) : [];
  const text = typeof parts[0]?.text === "string" ? (parts[0].text as string) : "";

  if (!text) {
    throw new Error("Gemini returned empty response");
  }

  return text;
}

function resolveGeminiModel(requestedModel?: string | null) {
  void requestedModel;
  return "gemini-2.5-flash";
}

function toAssistantMessageContent(interpretation: Interpretation) {
  const findings = interpretation.key_findings.map((item) => `- ${item}`).join("\n");
  const recommendations = interpretation.recommendations.map((item) => `- ${item}`).join("\n");

  return [
    "Executive Summary",
    interpretation.executive_summary,
    "",
    "Key Findings",
    findings,
    "",
    "Recommendations",
    recommendations,
    "",
    `Confidence: ${interpretation.confidence}`,
    `Limitations: ${interpretation.limitations}`,
  ].join("\n");
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) {
    return authResult;
  }

  const { supabase, user } = authResult;
  const { id: jobId } = await context.params;

  if (!jobId) {
    return apiError("Missing job id", 400, "INVALID_JOB_ID");
  }

  let body: InterpretJobRequest;
  try {
    body = (await request.json()) as InterpretJobRequest;
  } catch {
    return apiError("Invalid JSON payload", 400, "BAD_JSON");
  }

  if (!isInterpretMode(body.mode)) {
    return apiError("Invalid interpretation mode", 400, "INVALID_MODE");
  }

  const { data: job, error: jobError } = await supabase
    .from("jobs")
    .select(
      "id, status, input_type, metadata, output_json_path, message_id, conversation_id, updated_at"
    )
    .eq("id", jobId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (jobError) {
    return apiError(jobError.message, 500, "DB_ERROR");
  }

  if (!job) {
    return apiError("Job not found", 404, "JOB_NOT_FOUND");
  }

  if (job.status !== "completed") {
    return apiError("Job is not completed", 409, "JOB_NOT_COMPLETED");
  }

  const metadata =
    typeof job.metadata === "object" && job.metadata && !Array.isArray(job.metadata)
      ? (job.metadata as Record<string, unknown>)
      : {};

  let brainFeatures: Record<string, unknown> | null =
    metadata.brain_features && typeof metadata.brain_features === "object" && !Array.isArray(metadata.brain_features)
      ? (metadata.brain_features as Record<string, unknown>)
      : null;

  if (!brainFeatures && job.output_json_path) {
    brainFeatures = await loadBrainFeaturesFromStorage(supabase, job.output_json_path);
  }

  if (!brainFeatures) {
    return apiError("Missing brain features", 422, "MISSING_BRAIN_FEATURES");
  }

  let userText: string | null = null;
  if (job.message_id) {
    const { data: userMessage } = await supabase
      .from("messages")
      .select("content")
      .eq("id", job.message_id)
      .eq("user_id", user.id)
      .maybeSingle();
    userText = userMessage?.content ?? null;
  }

  const temperature =
    typeof body.temperature === "number" && Number.isFinite(body.temperature)
      ? Math.min(Math.max(body.temperature, 0), 1)
      : 0.3;
  const maxTokens =
    typeof body.max_tokens === "number" && Number.isFinite(body.max_tokens)
      ? Math.min(Math.max(Math.floor(body.max_tokens), 200), 1500)
      : 900;

  const requestedModel =
    typeof body.model === "string" && body.model.trim().length > 0 ? body.model.trim() : null;
  const model = resolveGeminiModel(requestedModel);

  const geminiApiKey = process.env.GEMINI_API_KEY;
  if (!geminiApiKey) {
    return apiError("Gemini API key is missing", 500, "GEMINI_CONFIG_MISSING");
  }

  const prompt = buildPrompt({
    mode: body.mode,
    userInstruction: body.user_instruction,
    inputType: job.input_type,
    userText,
    campaignContext: metadata.campaign_context,
    brainFeatures,
  });

  let llmText: string;
  try {
    llmText = await callGemini({
      apiKey: geminiApiKey,
      model,
      prompt,
      temperature,
      maxTokens,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "LLM provider failure";
    return apiError(message, 502, "LLM_UPSTREAM_ERROR");
  }

  const llmParsed = parseJsonObject(llmText);
  const interpretationRaw: Interpretation = llmParsed
    ? {
        executive_summary:
          typeof llmParsed.executive_summary === "string"
            ? llmParsed.executive_summary.trim()
            : "Evidence suggests moderate audience response with uncertain segments.",
        key_findings: toStringArray(llmParsed.key_findings),
        recommendations: toStringArray(llmParsed.recommendations),
        confidence: normalizeConfidence(llmParsed.confidence),
        limitations:
          typeof llmParsed.limitations === "string"
            ? llmParsed.limitations.trim()
            : "This output is probabilistic and should be validated with real audience testing.",
      }
    : buildFallbackInterpretationFromRaw(llmText, body.mode);

  const interpretation = enforceGuardrails(interpretationRaw);
  const assistantContent = toAssistantMessageContent(interpretation);

  const { data: assistantMessage, error: messageError } = await supabase
    .from("messages")
    .insert({
      user_id: user.id,
      conversation_id: job.conversation_id,
      role: "assistant",
      content: assistantContent,
      input_type: null,
      attachment_path: null,
      attachment_url: null,
    })
    .select("id")
    .single();

  if (messageError || !assistantMessage) {
    return apiError(
      messageError?.message ?? "Failed to persist interpretation message",
      500,
      "INTERPRET_PERSIST_FAILED"
    );
  }

  const updatedMetadata = {
    ...metadata,
    interpretation_ready: true,
    interpretation_message_id: assistantMessage.id,
    interpret_mode: body.mode,
    interpret_model: model,
    interpret_version: "v1",
    interpretation,
  } as unknown as Json;

  const { error: updateError } = await supabase
    .from("jobs")
    .update({ metadata: updatedMetadata })
    .eq("id", job.id)
    .eq("user_id", user.id);

  if (updateError) {
    return apiError(updateError.message, 500, "JOB_UPDATE_FAILED");
  }

  const response: InterpretJobResponse = {
    job_id: job.id,
    mode: body.mode,
    message_id: assistantMessage.id,
    interpretation,
  };

  return NextResponse.json(response, { status: 200 });
}
