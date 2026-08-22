// api/summary.js — Vercel serverless function for Gemini summaries

export default async function handler(req, res) {
  // CORS headers for Chrome extension
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res
      .status(405)
      .json({ ok: false, error: "Method not allowed. Use POST." });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res
      .status(500)
      .json({ ok: false, error: "Server misconfigured: missing GEMINI_API_KEY" });
  }

  const { subject, topic } = req.body || {};
  const cleanedSubject = (subject || "").trim() || "General";
  const cleanedTopic = (topic || "").trim() || "This topic";

  const prompt = `
You are a helpful college tutor.

Write a concise study summary for a student who just finished a focus session.

Subject: ${cleanedSubject}
Topic: ${cleanedTopic}

Requirements:
- Max 2 short paragraphs.
- Then 3–5 bullet points of key ideas.
- Total under 180 words.
- Very clear and exam-focused.
`.trim();

  const model = "gemini-1.5-flash";

  try {
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [{ text: prompt }]
            }
          ]
        })
      }
    );

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      console.error("Gemini error:", geminiRes.status, errText);
      return res.status(500).json({
        ok: false,
        error: "Gemini API error " + geminiRes.status
      });
    }

    const data = await geminiRes.json();
    const text =
      data?.candidates?.[0]?.content?.parts
        ?.map((p) => p.text || "")
        .join("\n")
        .trim() || "";

    if (!text) {
      return res
        .status(500)
        .json({ ok: false, error: "Empty Gemini response" });
    }

    return res.status(200).json({ ok: true, summary: text });
  } catch (err) {
    console.error("Summary proxy error:", err);
    return res
      .status(500)
      .json({ ok: false, error: "Server error generating summary" });
  }
}
