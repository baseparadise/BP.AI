// lib/ai.ts
// AI helpers shared by webhook routes and the Discord gateway bot.
// Wraps Gemini API with key rotation, Google Search grounding, and image generation.

import axios from "axios";
import { logger } from "./logger";

const GEMINI_MODEL = process.env["GEMINI_MODEL"] || "gemini-2.5-flash";
const GEMINI_IMAGE_MODEL =
  process.env["GEMINI_IMAGE_MODEL"] || "gemini-2.5-flash-image";
const FALLBACK_MODEL =
  process.env["GEMINI_FALLBACK_MODEL"] || "gemini-2.0-flash";

const API_KEYS = (
  process.env["GEMINI_API_KEYS"] ||
  process.env["GEMINI_API_KEY"] ||
  ""
)
  .split(",")
  .map((k) => k.trim())
  .filter(Boolean);

let keyCursor = API_KEYS.length ? Math.floor(Math.random() * API_KEYS.length) : 0;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function callGemini(
  model: string,
  body: unknown,
  timeout: number,
  rounds = 4
): Promise<unknown> {
  if (API_KEYS.length === 0) {
    const e: NodeJS.ErrnoException & { response?: { status: number; data: unknown } } =
      new Error("GEMINI_API_KEYS / GEMINI_API_KEY not set.");
    e.response = { status: 401, data: { error: { message: "API key empty." } } };
    throw e;
  }

  let lastErr: unknown;
  for (let round = 0; round < rounds; round++) {
    for (let i = 0; i < API_KEYS.length; i++) {
      const key = API_KEYS[keyCursor % API_KEYS.length]!;
      keyCursor++;
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
      try {
        const { data } = await axios.post(url, body, { timeout });
        return data;
      } catch (err: unknown) {
        lastErr = err;
        const status = (err as { response?: { status?: number } }).response?.status;
        if (status === 429 || status === 500 || status === 503) {
          logger.warn({ model, status, keyIndex: (keyCursor - 1) % API_KEYS.length }, "Gemini key rate-limited, rotating");
          continue;
        }
        throw err;
      }
    }
    const waitTime = Math.pow(2, round) * 2000 + Math.random() * 1000;
    logger.warn({ waitMs: Math.round(waitTime), round, rounds }, "All Gemini keys busy, backing off");
    await sleep(waitTime);
  }
  throw lastErr;
}

export const SYSTEM_PROMPT = [
  "Kamu adalah AI super cerdas dan serba bisa di server Discord, selevel asisten AI umum modern.",
  "Kamu PUNYA akses internet lewat Google Search. JANGAN PERNAH menolak atau bilang kamu tidak punya data real-time.",
  "Kalau pertanyaan butuh info terkini (harga kripto/saham, berita, cuaca, skor, kurs, rilis terbaru, dll),",
  "cari secara AGRESIF lewat Google Search lalu jawab dengan ANGKA/FAKTA konkret terbaru beserta waktunya.",
  "Contoh: kalau ditanya harga BTC, langsung sebutkan angkanya saat ini, jangan menyuruh user cek sendiri.",
  "Jawab dengan jelas, akurat, dan to-the-point dalam Bahasa Indonesia. Boleh detail kalau memang perlu.",
  "Selalu utamakan kebenaran faktual berdasarkan hasil pencarian, bukan tebakan.",
].join(" ");

export function isImageRequest(text: string): boolean {
  const t = (text || "").toLowerCase();
  return (
    /\b(buat(kan)?|gambar(kan)?|lukis(kan)?|bikin(kan)?|generate|render|design|desain|sketsa|ilustrasi|foto)\b/.test(t) &&
    /\b(gambar|foto|ilustrasi|logo|poster|wallpaper|sketsa|image|picture|art|artwork|desain|design)\b/.test(t)
  );
}

interface GeminiSource {
  title: string;
  uri: string;
}

export async function askGemini(
  question: string,
  model: string = GEMINI_MODEL
): Promise<{ text: string; sources: GeminiSource[] }> {
  const body = {
    contents: [{ role: "user", parts: [{ text: question }] }],
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    tools: [{ google_search: {} }],
  };

  try {
    const data = (await callGemini(model, body, 20000)) as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
        groundingMetadata?: {
          groundingChunks?: Array<{ web?: { title?: string; uri?: string } }>;
        };
      }>;
    };

    const candidate = data?.candidates?.[0];
    const text =
      candidate?.content?.parts
        ?.map((p) => p.text)
        .filter(Boolean)
        .join("") || "Tidak ada jawaban.";

    const chunks = candidate?.groundingMetadata?.groundingChunks || [];
    const sources = chunks
      .map((c) => c.web)
      .filter(Boolean)
      .map((w) => ({ title: w!.title || w!.uri || "", uri: w!.uri || "" }));

    return { text, sources };
  } catch (err: unknown) {
    const status = (err as { response?: { status?: number } }).response?.status;
    if (
      (status === 500 || status === 503) &&
      model === GEMINI_MODEL &&
      FALLBACK_MODEL !== GEMINI_MODEL
    ) {
      logger.warn({ model, fallback: FALLBACK_MODEL }, "Primary model overloaded, switching to fallback");
      return askGemini(question, FALLBACK_MODEL);
    }
    throw err;
  }
}

export async function generateImage(
  prompt: string
): Promise<{ imageBuffer: Buffer | null; text: string }> {
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
  };

  const data = (await callGemini(GEMINI_IMAGE_MODEL, body, 30000)) as {
    candidates?: Array<{
      content?: {
        parts?: Array<{ inlineData?: { data?: string }; text?: string }>;
      };
    }>;
  };

  const parts = data?.candidates?.[0]?.content?.parts || [];
  let imageBuffer: Buffer | null = null;
  let text = "";
  for (const p of parts) {
    if (p.inlineData?.data) {
      imageBuffer = Buffer.from(p.inlineData.data, "base64");
    } else if (p.text) {
      text += p.text;
    }
  }
  return { imageBuffer, text };
}

export function formatAnswer(text: string, sources: GeminiSource[] = []): string {
  let out = text || "Tidak ada jawaban.";

  if (sources.length > 0) {
    const seen = new Set<string>();
    const unique: GeminiSource[] = [];
    for (const s of sources) {
      if (s.uri && !seen.has(s.uri)) {
        seen.add(s.uri);
        unique.push(s);
      }
      if (unique.length >= 5) break;
    }
    const list = unique.map((s, i) => `${i + 1}. [${s.title}](<${s.uri}>)`).join("\n");
    const footer = `\n\n📚 **Sumber:**\n${list}`;
    const maxBody = 2000 - footer.length;
    if (out.length > maxBody) out = out.slice(0, maxBody - 1) + "…";
    out += footer;
  } else if (out.length > 2000) {
    out = out.slice(0, 1999) + "…";
  }

  return out;
}

export function friendlyError(err: unknown): string {
  const e = err as { response?: { status?: number; data?: { error?: { message?: string } } }; message?: string };
  const status = e.response?.status;
  const apiMsg = e.response?.data?.error?.message || e.message || "unknown error";
  logger.error({ status, apiMsg }, "AI request failed");

  if (status === 429) return "⚠️ Rate limit Gemini tercapai. Coba lagi sebentar lagi.";
  if (status === 503 || status === 500)
    return "⚠️ Server Gemini sedang sibuk/overload. Ini sementara — coba lagi beberapa saat lagi.";
  if (status === 404)
    return `⚠️ Model "${GEMINI_MODEL}" tidak ditemukan/sudah dipensiunkan. Set env GEMINI_MODEL ke model yang aktif.`;
  return `⚠️ Gagal memproses jawaban AI. (${status || "error"}: ${apiMsg})`;
}
