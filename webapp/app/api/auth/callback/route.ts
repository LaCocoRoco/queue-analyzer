import { NextRequest, NextResponse } from "next/server";
import { exchangeCodeForToken } from "@/lib/wcl";
import { setSession } from "@/lib/session";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expectedState = req.cookies.get("wcl_oauth_state")?.value;

  if (!code || !state || !expectedState || state !== expectedState) {
    return NextResponse.redirect(new URL("/?error=oauth_state", req.url));
  }

  try {
    const token = await exchangeCodeForToken(code);
    setSession({
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt: Date.now() + token.expires_in * 1000,
    });
  } catch (err) {
    console.error("WCL token exchange failed:", err);
    return NextResponse.redirect(new URL("/?error=oauth_token", req.url));
  }

  const res = NextResponse.redirect(new URL("/", req.url));
  res.cookies.delete("wcl_oauth_state");
  return res;
}
