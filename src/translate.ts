import type { Env } from "./types";

export type Lang = "zh" | "ja";

export interface TranslationResult {
  translation: string;
  reading?: string; // 日文結果的平假名讀音
  engine: string;
}

const PROMPTS: Record<Lang, string> = {
  zh: `你是專業的中翻日口譯，幫台灣旅客在日本跟司機、店員、路人溝通。
把使用者的中文翻成自然、禮貌（です／ます體）的日文，簡短好念。
只輸出 JSON：{"translation":"日文","reading":"整句日文的平假名讀音"}，不要任何解釋。`,
  ja: `你是專業的日翻中口譯，幫台灣旅客聽懂日本人說的話。
把使用者的日文翻成自然的繁體中文（台灣用語）。
只輸出 JSON：{"translation":"繁體中文"}，不要任何解釋。`,
};

/** 中日互譯：先用 Gemma（語氣自然、約 1 秒），失敗再用 Workers AI 的翻譯專用模型 m2m100 */
export async function translate(env: Env, text: string, from: Lang): Promise<TranslationResult> {
  const input = text.trim().slice(0, 1000);
  if (!input) throw new Error("沒有要翻譯的內容");
  try {
    const out: any = await env.AI.run(env.WORKERS_AI_MODEL as any, {
      messages: [
        { role: "system", content: PROMPTS[from] },
        { role: "user", content: input },
      ],
      max_tokens: 800,
      temperature: 0.2,
      // 關掉 Gemma 的思考模式，不然要 20 秒以上
      chat_template_kwargs: { enable_thinking: false },
    } as any);
    const raw = String(out?.choices?.[0]?.message?.content ?? out?.response ?? "");
    const json = JSON.parse(raw.replace(/^\s*```(?:json)?|```\s*$/g, "").trim());
    if (typeof json.translation === "string" && json.translation.trim()) {
      return {
        translation: json.translation.trim(),
        reading: from === "zh" && typeof json.reading === "string" ? json.reading.trim() : undefined,
        engine: "gemma",
      };
    }
  } catch (e) {
    console.error("gemma translate failed", e);
  }
  const out: any = await env.AI.run("@cf/meta/m2m100-1.2b" as any, {
    text: input,
    source_lang: from === "zh" ? "chinese" : "japanese",
    target_lang: from === "zh" ? "japanese" : "chinese",
  } as any);
  if (!out?.translated_text) throw new Error("翻譯服務暫時無法使用");
  return { translation: String(out.translated_text).trim(), engine: "m2m100" };
}

/** 有平假名或片假名就當成日文 */
export function looksJapanese(text: string): boolean {
  return /[぀-ヿ]/.test(text);
}
