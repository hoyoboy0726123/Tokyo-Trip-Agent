import { clearSessionCookie, createSessionCookie, readSession } from "./auth";
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

    if (path.startsWith("/api/") || path === "/ws") {
      const user = await readSession(req, env);
      if (!user) return json({ ok: false, error: "請先登入" }, { status: 401 });
      const headers = new Headers(req.headers);
      headers.set("x-user-name", encodeURIComponent(user.name));
      headers.set("x-user-admin", user.admin ? "1" : "0");

      if (path === "/api/me") return json({ ok: true, user });

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
