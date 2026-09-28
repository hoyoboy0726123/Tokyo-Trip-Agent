import type { Env, SessionUser } from "./types";

const COOKIE = "tta_session";
const MAX_AGE = 60 * 60 * 24 * 30; // 30 天

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): string {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(pad);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

/** 沒設 SESSION_SECRET 時由兩組密碼推導；改密碼 = 所有人重新登入 */
async function secret(env: Env): Promise<string> {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(`tta|${(env.ROOM_PASSWORD ?? "").trim()}|${(env.ADMIN_PASSWORD ?? "").trim()}`));
  return b64url(new Uint8Array(digest));
}

async function sign(env: Env, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(await secret(env)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data))));
}

export function safeEqual(a: string, b: string): boolean {
  const x = enc.encode(a), y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export async function createSessionCookie(env: Env, user: SessionUser): Promise<string> {
  const payload = b64url(enc.encode(JSON.stringify({ ...user, exp: Date.now() + MAX_AGE * 1000 })));
  const token = `${payload}.${await sign(env, payload)}`;
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${MAX_AGE}`;
}

export function clearSessionCookie(): string {
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export async function readSession(req: Request, env: Env): Promise<SessionUser | null> {
  const cookie = req.headers.get("Cookie") ?? "";
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!match) return null;
  const [payload, sig] = match[1].split(".");
  if (!payload || !sig || !safeEqual(sig, await sign(env, payload))) return null;
  try {
    const data = JSON.parse(fromB64url(payload)) as SessionUser & { exp: number };
    if (!data.exp || data.exp < Date.now()) return null;
    return { name: data.name, admin: !!data.admin };
  } catch {
    return null;
  }
}
