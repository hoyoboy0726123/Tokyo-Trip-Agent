import type { Env, GenerateResult, Provider, ToolDecl, Turn } from "./types";

// ---------------- Gemini（Google AI Studio） ----------------

export function geminiProvider(env: Env, model?: string): Provider {
  const m = model || env.GEMINI_MODEL || "gemini-3.5-flash-lite";
  return {
    id: "gemini",
    model: m,
    async generate({ system, turns, tools, onDelta, json }) {
      if (!env.GEMINI_API_KEY) throw new Error("尚未設定 GEMINI_API_KEY");
      const body: Record<string, unknown> = {
        systemInstruction: { parts: [{ text: system }] },
        contents: turns.map((t) => ({
          role: t.role,
          parts: t.parts.map((p) => {
            if ("text" in p) return { text: p.text };
            if ("image" in p) return { inlineData: { mimeType: p.image.mime, data: p.image.data } };
            if ("call" in p) {
              const part: Record<string, unknown> = { functionCall: { id: p.call.id, name: p.call.name, args: p.call.args } };
              if (p.call.sig) part.thoughtSignature = p.call.sig;
              return part;
            }
            return { functionResponse: { id: p.result.id, name: p.result.name, response: { result: p.result.response } } };
          }),
        })),
        generationConfig: json ? { responseMimeType: "application/json", temperature: 0.2 } : { temperature: 0.6 },
      };
      if (tools?.length) body.tools = [{ functionDeclarations: tools }];

      const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:streamGenerateContent?alt=sse`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
        body: JSON.stringify(body),
      });
      if (!res.ok || !res.body) {
        throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }

      const result: GenerateResult = { text: "", calls: [] };
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        let idx: number;
        while ((idx = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line.startsWith("data:")) continue;
          let chunk: any;
          try {
            chunk = JSON.parse(line.slice(5));
          } catch {
            continue;
          }
          if (chunk.error) throw new Error(`Gemini：${chunk.error.message}`);
          const parts = chunk.candidates?.[0]?.content?.parts ?? [];
          for (const part of parts) {
            if (part.functionCall) {
              result.calls.push({
                id: part.functionCall.id || `call_${crypto.randomUUID().slice(0, 8)}`,
                name: part.functionCall.name,
                args: part.functionCall.args ?? {},
                sig: part.thoughtSignature,
              });
            } else if (typeof part.text === "string" && !part.thought) {
              result.text += part.text;
              onDelta?.(part.text);
            }
          }
        }
      }
      return result;
    },
  };
}

// ---------------- Cloudflare Workers AI ----------------

export function workersAIProvider(env: Env, model?: string): Provider {
  const m = model || env.WORKERS_AI_MODEL || "@cf/meta/llama-4-scout-17b-16e-instruct";
  return {
    id: "workers-ai",
    model: m,
    async generate({ system, turns, tools, onDelta, json }) {
      const messages: any[] = [{ role: "system", content: system + (json ? "\n只輸出 JSON，不要任何其他文字。" : "") }];
      for (const t of turns) {
        const texts: string[] = [];
        const images: string[] = [];
        const calls: any[] = [];
        for (const p of t.parts) {
          if ("text" in p) texts.push(p.text);
          else if ("image" in p) images.push(`data:${p.image.mime};base64,${p.image.data}`);
          else if ("call" in p) calls.push({ id: p.call.id, type: "function", function: { name: p.call.name, arguments: JSON.stringify(p.call.args) } });
          else messages.push({ role: "tool", tool_call_id: p.result.id, name: p.result.name, content: JSON.stringify(p.result.response) });
        }
        if (t.role === "model") {
          if (calls.length || texts.length) messages.push({ role: "assistant", content: texts.join("\n"), ...(calls.length ? { tool_calls: calls } : {}) });
        } else if (images.length) {
          messages.push({
            role: "user",
            content: [{ type: "text", text: texts.join("\n") }, ...images.map((url) => ({ type: "image_url", image_url: { url } }))],
          });
        } else if (texts.length) {
          messages.push({ role: "user", content: texts.join("\n") });
        }
      }

      const input: Record<string, unknown> = { messages, max_tokens: 2048, temperature: json ? 0.2 : 0.6 };
      if (tools?.length) input.tools = tools.map((t) => ({ type: "function", function: t }));
      const out: any = await env.AI.run(m as any, input as any);

      const text: string = out?.response ?? out?.choices?.[0]?.message?.content ?? "";
      const rawCalls: any[] = out?.tool_calls ?? out?.choices?.[0]?.message?.tool_calls ?? [];
      const calls = rawCalls.map((c) => {
        const fn = c.function ?? c;
        let args = fn.arguments ?? {};
        if (typeof args === "string") {
          try {
            args = JSON.parse(args);
          } catch {
            args = {};
          }
        }
        return { id: c.id || `call_${crypto.randomUUID().slice(0, 8)}`, name: fn.name, args };
      });
      if (text && !calls.length) onDelta?.(text);
      return { text: typeof text === "string" ? text : JSON.stringify(text), calls };
    },
  };
}

export function providerFor(env: Env, id: string): Provider {
  return id === "workers-ai" ? workersAIProvider(env) : geminiProvider(env);
}
