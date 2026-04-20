/**
 * Auth helper utilities for API route handlers.
 * Centralises session resolution and user extraction.
 */

import { createAdminClient, createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

const DEMO_USER_COOKIE = "tribe_demo_user";
const DEMO_EMAIL_COOKIE = "tribe_demo_email";

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function normalizeDemoUserId(rawValue: string) {
  if (isUuid(rawValue)) {
    return rawValue;
  }

  if (rawValue.startsWith("demo-")) {
    const legacyValue = rawValue.slice(5);
    if (isUuid(legacyValue)) {
      return legacyValue;
    }
  }

  return null;
}

async function ensureDemoUserExists(params: {
  demoUserId: string | null;
  demoEmail: string;
}) {
  const { demoUserId, demoEmail } = params;
  const admin = createAdminClient();

  if (demoUserId) {
    const { data, error } = await admin.auth.admin.getUserById(demoUserId);
    if (!error && data.user) {
      return { id: data.user.id, email: data.user.email ?? demoEmail };
    }
  }

  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email: demoEmail,
    email_confirm: true,
    user_metadata: { demo_mode: true },
  });

  if (!createError && created.user) {
    return { id: created.user.id, email: created.user.email ?? demoEmail };
  }

  const { data: listed, error: listError } = await admin.auth.admin.listUsers({
    page: 1,
    perPage: 1000,
  });

  if (!listError) {
    const existing = listed.users.find(
      (user) => (user.email ?? "").toLowerCase() === demoEmail.toLowerCase()
    );
    if (existing) {
      return { id: existing.id, email: existing.email ?? demoEmail };
    }
  }

  return null;
}

/**
 * Resolves the authenticated user from the current session.
 * Returns { user, supabase } on success, or a 401 NextResponse on failure.
 *
 * Usage in a Route Handler:
 *   const result = await requireAuth();
 *   if (result instanceof NextResponse) return result;
 *   const { user, supabase } = result;
 */
export async function requireAuth() {
  const demoIdentity = await (async () => {
    try {
      const { cookies } = await import("next/headers");
      const cookieStore = await cookies();
      const rawUserId = cookieStore.get(DEMO_USER_COOKIE)?.value;
      if (!rawUserId) {
        return null;
      }

      const userId = normalizeDemoUserId(rawUserId);
      const rawEmail = cookieStore.get(DEMO_EMAIL_COOKIE)?.value;
      const email =
        rawEmail && rawEmail.includes("@")
          ? rawEmail
          : `guest-${(userId ?? rawUserId).replace(/[^a-zA-Z0-9]/g, "").slice(0, 12)}@example.com`;

      const ensuredUser = await ensureDemoUserExists({
        demoUserId: userId,
        demoEmail: email,
      });
      if (!ensuredUser) {
        return null;
      }

      if (rawUserId !== ensuredUser.id) {
        cookieStore.set(DEMO_USER_COOKIE, ensuredUser.id, {
          path: "/",
          maxAge: 60 * 60 * 24 * 7,
          sameSite: "lax",
        });
      }

      if (rawEmail !== ensuredUser.email) {
        cookieStore.set(DEMO_EMAIL_COOKIE, ensuredUser.email, {
          path: "/",
          maxAge: 60 * 60 * 24 * 7,
          sameSite: "lax",
        });
      }

      return {
        id: ensuredUser.id,
        email: ensuredUser.email,
      };
    } catch {
      return null;
    }
  })();

  if (demoIdentity) {
    return {
      user: {
        id: demoIdentity.id,
        email: demoIdentity.email,
      },
      supabase: createAdminClient(),
    };
  }

  const supabase = await createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    return NextResponse.json(
      { error: "Unauthorized", code: "AUTH_REQUIRED" },
      { status: 401 }
    );
  }

  return { user, supabase };
}

/**
 * Generic API error helper — returns a typed JSON error response.
 */
export function apiError(
  message: string,
  status: number,
  code?: string
): NextResponse {
  return NextResponse.json({ error: message, ...(code ? { code } : {}) }, { status });
}
