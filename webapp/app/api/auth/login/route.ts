import { randomBytes } from "crypto";
import { NextResponse } from "next/server";
import { buildAuthorizeUrl } from "@/lib/wcl";

export async function GET() {
  const state = randomBytes(16).toString("hex");
  const res = NextResponse.redirect(buildAuthorizeUrl(state));
  res.cookies.set("wcl_oauth_state", state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });
  return res;
}
