import { clearSessionCookie, createSessionCookie, readSession, safeEqual, sign } from "./auth";
import type { Env } from "./types";

export { TripRoom } from "./room";

function room(env: Env) {
  return env.ROOM.get(env.ROOM.idFromName("main"));
}

function json(data: unknown, init: ResponseInit = {}) {
  return Response.json(data, init);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/api/login" && req.method === "POST") {
      const body = await req.text();
      const res = await room(env).fetch("https://room/login", {
        method: "POST",
        body,
        headers: { "x-ip": req.headers.get("cf-connecting-ip") ?? "local" },
      });
      const data = (await res.json()) as { ok: boolean; user?: { name: string; admin: boolean }; error?: string };
      if (!data.ok || !data.user) return json(data, { status: res.status });
      return json(data, { headers: { "set-cookie": await createSessionCookie(env, data.user) } });
    }

    if (path === "/api/logout" && req.method === "POST") {
      return json({ ok: true }, { headers: { "set-cookie": clearSessionCookie() } });
    }

    // 旅遊日記分享連結：不用登入，看不看得到由聊天室裡的分享碼決定（管理員可隨時關閉）
    if (path.startsWith("/share/") && req.method === "GET") {
      return room(env).fetch(new Request("https://room" + path + url.search, { headers: { "x-origin": url.origin } }));
    }

    if (path.startsWith("/api/") || path === "/ws") {
      const user = await readSession(req, env);
      if (!user) return json({ ok: false, error: "請先登入" }, { status: 401 });
      const headers = new Headers(req.headers);
      headers.set("x-user-name", encodeURIComponent(user.name));
      headers.set("x-user-admin", user.admin ? "1" : "0");

      if (path === "/api/me") return json({ ok: true, user });

      // 旅遊日記網頁（日記＋照片），可列印成 PDF；?print=1 打開就直接列印
      if (path === "/api/album" && req.method === "GET") {
        headers.set("x-origin", url.origin);
        return room(env).fetch(new Request("https://room/album" + url.search, { headers }));
      }

      // 網路圖片轉送：避免原網站擋外連；網址由 find_images 簽章，不能當成公開代理使用
      if (path === "/api/img" && req.method === "GET") {
        const target = url.searchParams.get("u") ?? "";
        const sig = url.searchParams.get("s") ?? "";
        if (!/^https?:\/\//.test(target) || !safeEqual(sig, await sign(env, "img:" + target))) {
          return new Response("Forbidden", { status: 403 });
        }
        try {
          const res = await fetch(target, {
            headers: { "user-agent": "Mozilla/5.0 (compatible; TokyoTripAgent/1.0)", accept: "image/*" },
            signal: AbortSignal.timeout(15_000),
          });
          const type = res.headers.get("content-type") ?? "";
          if (!res.ok || !type.startsWith("image/") || Number(res.headers.get("content-length") || 0) > 5_000_000) {
            await res.body?.cancel();
            return new Response("Image unavailable", { status: 502 });
          }
          return new Response(res.body, { headers: { "content-type": type, "cache-control": "private, max-age=86400" } });
        } catch {
          return new Response("Image unavailable", { status: 502 });
        }
      }

      if (path === "/ws") {
        if (req.headers.get("Upgrade") !== "websocket") return new Response("Expected WebSocket", { status: 426 });
        return room(env).fetch(new Request("https://room/ws", { headers }));
      }

      if (path === "/api/photo" && req.method === "POST") {
        return room(env).fetch(new Request("https://room/photo", { method: "POST", headers, body: req.body }));
      }

      const photo = path.match(/^\/api\/photo\/([\w-]+)$/);
      if (photo && req.method === "GET") {
        return room(env).fetch(new Request(`https://room/photo/${photo[1]}`, { headers }));
      }

      return json({ ok: false, error: "Not found" }, { status: 404 });
    }

    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;
