import { NextResponse } from "next/server";
import { apiError, requireAuth } from "@/lib/auth";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) {
    return authResult;
  }

  const { supabase, user } = authResult;
  const { id: conversationId } = await context.params;

  if (!conversationId) {
    return apiError("Missing conversation id", 400, "INVALID_CONVERSATION_ID");
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

  const { data: messages, error: messagesError } = await supabase
    .from("messages")
    .select("id, role, content, input_type, attachment_path, attachment_url, created_at")
    .eq("conversation_id", conversationId)
    .eq("user_id", user.id)
    .order("created_at", { ascending: true });

  if (messagesError) {
    return apiError(messagesError.message, 500, "DB_ERROR");
  }

  return NextResponse.json({ conversation_id: conversationId, messages: messages ?? [] }, { status: 200 });
}
