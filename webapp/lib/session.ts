// lib/session.ts
//
// Minimal cookie-based session: the WCL access/refresh token pair lives in
// one httpOnly, secure cookie. No database, no extra auth library -- this
// is a small personal/group tool, not a public multi-tenant SaaS. The
// cookie is httpOnly (JS on the page can't read it) and secure (HTTPS
// only), which is enough for this use case; it is NOT encrypted at rest,
// so don't put anything more sensitive than a WCL OAuth token pair in it.

import { cookies } from "next/headers";

const COOKIE_NAME = "wcl_session";

export interface SessionData {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number; // epoch ms
}

export function setSession(data: SessionData) {
  cookies().set(COOKIE_NAME, JSON.stringify(data), {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
}

export function getSession(): SessionData | null {
  const raw = cookies().get(COOKIE_NAME)?.value;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SessionData;
  } catch {
    return null;
  }
}

export function clearSession() {
  cookies().delete(COOKIE_NAME);
}
