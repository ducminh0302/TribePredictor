import { NextResponse } from "next/server";
import { apiError, requireAuth } from "@/lib/auth";

export async function GET() {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) {
    return authResult;
  }

  const { supabase, user } = authResult;

  const { data, error } = await supabase
    .from("conversations")
    .select("id, title, created_at, updated_at")
    .eq("user_id", user.id)
    .order("updated_at", { ascending: false });

  if (error) {
    return apiError(error.message, 500, "DB_ERROR");
  }

  return NextResponse.json({ conversations: data ?? [] }, { status: 200 });
}

export async function POST() {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) {
    return authResult;
  }

  const { supabase, user } = authResult;

  const { data, error } = await supabase
    .from("conversations")
    .insert({
      user_id: user.id,
      title: user.email?.startsWith("guest-") ? "Guest Conversation" : "Untitled Conversation",
    })
    .select("id, title, created_at, updated_at")
    .single();

  if (error || !data) {
    return apiError(error?.message ?? "Failed to create conversation", 500, "DB_ERROR");
  }

  return NextResponse.json({ conversation: data }, { status: 201 });
}
