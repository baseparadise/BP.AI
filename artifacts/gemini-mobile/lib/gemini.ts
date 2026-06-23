export interface GeminiSource {
  title: string;
  uri: string;
}

export interface ConversationMessage {
  role: "user" | "model";
  parts: Array<{ text: string }>;
}

const SYSTEM_PROMPT =
  "Kamu adalah AI super cerdas dan serba bisa, selevel asisten AI umum modern. " +
  "Kamu PUNYA akses internet lewat Google Search. JANGAN PERNAH menolak atau bilang kamu tidak punya data real-time. " +
  "Kalau pertanyaan butuh info terkini, cari secara AGRESIF lewat Google Search lalu jawab dengan ANGKA/FAKTA konkret terbaru beserta waktunya. " +
  "Jawab dengan jelas, akurat, dan to-the-point dalam Bahasa Indonesia. Boleh detail kalau memang perlu.";

export function isImageRequest(text: string): boolean {
  const t = (text || "").toLowerCase();
  return (
    /\b(buat(kan)?|gambar(kan)?|lukis(kan)?|bikin(kan)?|generate|render|design|desain|sketsa|ilustrasi|foto)\b/.test(t) &&
    /\b(gambar|foto|ilustrasi|logo|poster|wallpaper|sketsa|image|picture|art|artwork|desain|design)\b/.test(t)
  );
}

export async function askGemini(
  question: string,
  history: ConversationMessage[],
  apiKey: string,
  model = "gemini-2.5-flash"
): Promise<{ text: string; sources: GeminiSource[] }> {
  const contents: ConversationMessage[] = [
    ...history,
    { role: "user", parts: [{ text: question }] },
  ];

  const body = {
    contents,
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    tools: [{ google_search: {} }],
  };

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = (err as { error?: { message?: string } })?.error?.message || `HTTP ${res.status}`;
    throw new Error(msg);
  }

  const data = await res.json();
  const candidate = data?.candidates?.[0];
  const text =
    candidate?.content?.parts
      ?.map((p: { text?: string }) => p.text)
      .filter(Boolean)
      .join("") || "Tidak ada jawaban.";

  const chunks: Array<{ web?: { title?: string; uri?: string } }> =
    candidate?.groundingMetadata?.groundingChunks || [];
  const seen = new Set<string>();
  const sources: GeminiSource[] = [];
  for (const c of chunks) {
    if (c.web?.uri && !seen.has(c.web.uri)) {
      seen.add(c.web.uri);
      sources.push({ title: c.web.title || c.web.uri, uri: c.web.uri });
    }
    if (sources.length >= 5) break;
  }

  return { text, sources };
}

export async function generateImage(
  prompt: string,
  apiKey: string,
  model = "gemini-2.5-flash-preview-05-20"
): Promise<{ imageBase64: string | null; text: string }> {
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
  };

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = (err as { error?: { message?: string } })?.error?.message || `HTTP ${res.status}`;
    throw new Error(msg);
  }

  const data = await res.json();
  const parts: Array<{ inlineData?: { data?: string }; text?: string }> =
    data?.candidates?.[0]?.content?.parts || [];

  let imageBase64: string | null = null;
  let text = "";
  for (const p of parts) {
    if (p.inlineData?.data) imageBase64 = p.inlineData.data;
    else if (p.text) text += p.text;
  }
  return { imageBase64, text };
}
