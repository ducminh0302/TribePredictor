import { NextResponse } from "next/server";
import { apiError, requireAuth } from "@/lib/auth";

type SignArtifactRequest = {
  path?: string;
  expiresIn?: number;
};

export async function POST(request: Request) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) {
    return authResult;
  }

  const { supabase, user } = authResult;

  let body: SignArtifactRequest;
  try {
    body = (await request.json()) as SignArtifactRequest;
  } catch {
    return apiError("Invalid JSON payload", 400, "BAD_JSON");
  }

  const path = body.path?.trim();
  if (!path) {
    return apiError("Missing artifact path", 400, "INVALID_PATH");
  }

  const expectedPrefix = `${user.id}/`;
  if (!path.startsWith(expectedPrefix)) {
    return apiError("Invalid artifact path prefix", 422, "INVALID_PATH_PREFIX");
  }

  const expiresIn =
    typeof body.expiresIn === "number" && Number.isFinite(body.expiresIn)
      ? Math.min(Math.max(Math.floor(body.expiresIn), 60), 86400)
      : 3600;

  const { data, error } = await supabase.storage.from("output-files").createSignedUrl(path, expiresIn);
  if (error || !data?.signedUrl) {
    return apiError(error?.message ?? "Failed to sign artifact URL", 500, "SIGN_URL_FAILED");
  }

  return NextResponse.json({ path, signedUrl: data.signedUrl }, { status: 200 });
}