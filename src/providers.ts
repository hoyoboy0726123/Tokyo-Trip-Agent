import type { Env, GenerateResult, Provider, ToolDecl, Turn } from "./types";

// ---------------- Gemini（Google AI Studio） ----------------

/** 送出前取得額度許可、被拒絕時回報，由 TripRoom 的 GeminiLimiter 實作 */
export interface GeminiGate {
  acquire(estimate: number): Promise<(actualTokens?: number) => void>;
  failed(status: number, body: string): void;
}

/** 粗估這次請求的 token 數（中文約 1–2 字一個 token，取保守值；圖片約 1,100） */
function estimateTokens(system: string, turns: Turn[], tools?: ToolDecl[]): number {
  let chars = system.length + (tools?.length ? JSON.stringify(tools).length : 0);
  let images = 0;
  for (const t of turns) {
    for (const p of t.parts) {
      if ("text" in p) chars += p.text.length;
      else if ("image" in p) images++;
      else chars += JSON.stringify("call" in p ? p.call.args : p.result.response).length + 40;
    }
  }
  return Math.ceil(chars / 1.8) + images * 1100 + 800;
}

export function geminiProvider(env: Env, model?: string, gate?: GeminiGate): Provider {
  const m = model || env.GEMINI_MODEL || "gemini-3.5-flash-lite";
  return {
    id: "gemini",
    model: m,
    async generate({ system, turns, tools, onDelta, json, timeoutMs }) {
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

      // 不自動重試：重試只會更快把 RPM/TPM 用光。失敗就冷卻，由上層改用備援模型
      const report = gate ? await gate.acquire(estimateTokens(system, turns, tools)) : undefined;
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:streamGenerateContent?alt=sse`;
      const res = await fetch(url, {
        method: "POST",
        // 串流卡住時整段放棄，改用備援模型，避免聊天室一直顯示「思考中」
        signal: AbortSignal.timeout(timeoutMs ?? 45_000),
        headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY.trim() },
        body: JSON.stringify(body),
      });
      if (!res.ok || !res.body) {
        const errText = await res.text();
        gate?.failed(res.status, errText);
        throw new Error(`Gemini ${res.status}: ${errText.slice(0, 300)}`);
      }

      let usedTokens = 0;
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
          if (chunk.error) {
            gate?.failed(chunk.error.code ?? 0, JSON.stringify(chunk.error));
            throw new Error(`Gemini：${chunk.error.message}`);
          }
          if (chunk.usageMetadata?.totalTokenCount) usedTokens = chunk.usageMetadata.totalTokenCount;
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
      report?.(usedTokens);
      return result;
    },
  };
}

// ---------------- Cloudflare Workers AI ----------------

export function workersAIProvider(env: Env, model?: string): Provider {
  const m = model || env.WORKERS_AI_MODEL || "@cf/google/gemma-4-26b-a4b-it";
  return {
    id: "workers-ai",
    model: m,
    async generate({ system, turns, tools, onDelta, json, maxTokens }) {
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

      // Gemma 4 預設會先長篇「思考」：一句話要 20–30 秒、額度多用 16 倍，還會把輸出空間用完。關掉後約 1 秒
      const input: Record<string, unknown> = {
        messages,
        max_tokens: maxTokens ?? 2048,
        temperature: json ? 0.2 : 0.6,
        chat_template_kwargs: { enable_thinking: false },
      };
      if (tools?.length) input.tools = tools.map((t) => ({ type: "function", function: t }));

      // 聊天回答用串流，讓文字一個一個出現；整理記憶（json）不需要
      if (onDelta && !json) {
        try {
          return await streamWorkersAI(env, m, input, onDelta);
        } catch (e) {
          console.error("workers-ai stream failed, retry without stream", e);
        }
      }
      const out: any = await runAi(env, m, input);

      const text: string = out?.response ?? out?.choices?.[0]?.message?.content ?? "";
      const rawCalls: any[] = out?.tool_calls ?? out?.choices?.[0]?.message?.tool_calls ?? [];
      const calls = rawCalls.map((c) => {
        const fn = c.function ?? c;
        let args = fn.arguments ?? {};
        if (typeof args === "string") args = parseArgs(args);
        return { id: c.id || `call_${crypto.randomUUID().slice(0, 8)}`, name: fn.name, args };
      });
      if (text && !calls.length) onDelta?.(text);
      return { text: typeof text === "string" ? cleanModelText(text) : JSON.stringify(text), calls };
    },
  };
}

const CHANNEL_TAG = /<\|?\/?channel\|?>/g;

/**
 * Workers AI 偶爾暫時塞車（4002 could not route、3040 capacity），等一下再試一次通常就好。
 * 塞車時也可能一直不回應，所以每次最多等 timeoutMs，逾時就交給備援模型（不會一直顯示「思考中」）
 */
export async function runAi(env: Env, model: string, input: Record<string, unknown>, timeoutMs = 60_000): Promise<any> {
  for (let i = 0; ; i++) {
    let timer: any;
    try {
      return await Promise.race([
        env.AI.run(model as any, input as any),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Workers AI ${timeoutMs / 1000} 秒沒有回應`)), timeoutMs);
        }),
      ]);
    } catch (e) {
      if (i === 0 && /4002|3040|could not route|capacity/i.test(String((e as any)?.message ?? e))) {
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** 工具參數 JSON：串流偶爾重送變成 {…}{…}，取第一個完整的物件 */
export function parseArgs(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {}
  let depth = 0;
  let inStr = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      try {
        return JSON.parse(raw.slice(raw.indexOf("{"), i + 1));
      } catch {
        return {};
      }
    }
  }
  return {};
}

/** Gemma 偶爾把對話樣板的標記（開頭的 thought、<channel|>）混進回答，清掉 */
function cleanModelText(s: string): string {
  // 整段思考過程漏出來（thought … <channel|> 正式回答）：只留正式回答；沒有正式回答就當作沒回，讓上層請它重答
  if (/^[\s:<|>/a-z]{0,16}thought/i.test(s.slice(0, 24)) && /Thinking Process|思考過程|\*\*Analyze/i.test(s.slice(0, 400))) {
    const close = s.lastIndexOf("<channel|>");
    s = close >= 0 ? s.slice(close + "<channel|>".length) : "";
  }
  return s.replace(CHANNEL_TAG, "").replace(/^\s*:?thought\s*\n/, "").replace(/^\s+/, "");
}

/** Workers AI 串流（SSE）：同時支援 OpenAI 格式（choices[].delta）與舊格式（response） */
async function streamWorkersAI(env: Env, model: string, input: Record<string, unknown>, onDelta: (t: string) => void): Promise<GenerateResult> {
  const stream = (await runAi(env, model, { ...input, stream: true }, 30_000)) as ReadableStream<Uint8Array>;
  if (!stream || typeof (stream as any).getReader !== "function") throw new Error("沒有收到串流");
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let text = "";
  let sentAny = false;
  const pending: string[] = [];
  const calls = new Map<number, { id?: string; name: string; args: string }>();
  const legacyCalls: any[] = [];

  // 模型有時先講一段話再決定呼叫工具；先暫存開頭，確定不是工具呼叫再送出
  const flush = (force = false) => {
    if (calls.size || legacyCalls.length) return;
    // 開頭先多收一點，才能清掉 Gemma 偶爾夾帶的「thought <channel|>」標記
    if (!sentAny) {
      if (!force && text.length < 24) return;
      const head = cleanModelText(pending.splice(0).join(""));
      if (head) onDelta(head);
      sentAny = true;
      return;
    }
    while (pending.length) {
      const piece = pending.shift()!.replace(CHANNEL_TAG, "");
      if (piece) onDelta(piece);
    }
  };

  for (;;) {
    // 30 秒沒有新內容就放棄，讓上層改用備援模型
    let timer: any;
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Workers AI 30 秒沒有回應")), 30_000);
      }),
    ]).finally(() => clearTimeout(timer));
    if (done) break;
    buffer += value;
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let chunk: any;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      const delta = chunk.choices?.[0]?.delta ?? {};
      const piece: string = typeof delta.content === "string" ? delta.content : typeof chunk.response === "string" ? chunk.response : "";
      for (const tc of delta.tool_calls ?? []) {
        const i = tc.index ?? calls.size;
        const cur = calls.get(i) ?? { id: undefined, name: "", args: "" };
        if (tc.id) cur.id = tc.id;
        // Gemma 串流有時會把工具名稱重送一次（變成 train_statustrain_status）
        if (tc.function?.name && cur.name !== tc.function.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.args += typeof tc.function.arguments === "string" ? tc.function.arguments : JSON.stringify(tc.function.arguments);
        calls.set(i, cur);
      }
      if (Array.isArray(chunk.tool_calls)) legacyCalls.push(...chunk.tool_calls);
      if (piece) {
        text += piece;
        pending.push(piece);
        flush();
      }
    }
  }
  flush(true);

  const parsed = [
    ...[...calls.values()].map((c) => ({ id: c.id, name: c.name, arguments: c.args })),
    ...legacyCalls.map((c) => ({ id: c.id, name: c.function?.name ?? c.name, arguments: c.function?.arguments ?? c.arguments })),
  ]
    .filter((c) => c.name)
    .map((c) => {
      let args: any = c.arguments ?? {};
      if (typeof args === "string") args = parseArgs(args);
      return { id: c.id || `call_${crypto.randomUUID().slice(0, 8)}`, name: c.name, args };
    });
  return { text: cleanModelText(text), calls: parsed };
}

/** gemini = 主要模型；gemini-backup = 另一個 Gemini 模型（目前備援順序未使用） */
export function providerFor(env: Env, id: string, gate?: GeminiGate): Provider {
  if (id === "workers-ai") return workersAIProvider(env);
  if (id === "gemini-backup") return geminiProvider(env, env.GEMINI_BACKUP_MODEL || "gemini-3.1-flash-lite", gate);
  return geminiProvider(env, undefined, gate);
}
