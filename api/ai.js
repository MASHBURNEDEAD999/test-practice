// Vercel serverless function: POST /api/ai
// The API key lives in Vercel environment variables, never in the browser or GitHub.
const POS = [
  "PO1 Engineering knowledge", "PO2 Problem analysis", "PO3 Design of solutions",
  "PO4 Investigation", "PO5 Modern tool usage", "PO6 Society and safety",
  "PO7 Environment", "PO8 Ethics", "PO9 Teamwork", "PO10 Communication",
  "PO11 Project management", "PO12 Lifelong learning",
  "PSO1 Software development", "PSO2 Data and systems", "PSO3 Emerging technology"
];

function buildPrompt(task, course, cos, levels) {
  const list = cos.map((c, i) => "CO" + c.n + ": " + c.text).join("\n");
  const head = "Course: " + (course.code || "?") + " " + (course.title || "") + "\n\nCourse outcomes:\n" + list + "\n\n";
  if (task === "map") {
    return "You are an academic curriculum analyst for an engineering university using outcome-based education.\n" +
      "Map each course outcome (CO) to the program outcomes below. Levels: 3 strong, 2 moderate, 1 slight, 0 no link. " +
      "Be selective: a typical CO links to 2 to 5 outcomes. The PSOs are generic placeholders.\n\nOutcomes in order:\n" +
      POS.map((p, i) => (i + 1) + ". " + p).join("\n") + "\n\n" + head +
      "Return ONLY JSON, no markdown: {\"mapping\":[{\"levels\":[" + POS.length + " integers in the order above],\"reason\":\"one short sentence\"}]} " +
      "with exactly " + cos.length + " entries, in the same order as the COs.";
  }
  const table = cos.map((c, i) => "CO" + c.n + ": " + (levels[i] || []).join(",")).join("\n");
  return "You are a strict reviewer of course specifications for an engineering university.\n" + head +
    "Current mapping levels (columns: " + POS.map(p => p.split(" ")[0]).join(",") + "):\n" + table + "\n\n" +
    "Find real quality problems: vague or unmeasurable verbs (understand, know), outcomes that are too broad, " +
    "mapping levels that do not fit the CO wording, and overlapping COs. Do not repeat trivial formatting issues. " +
    "Return ONLY JSON, no markdown: {\"issues\":[{\"sev\":\"error|warning|info\",\"msg\":\"one clear sentence naming the CO\"}]} with at most 8 issues.";
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });
  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ error: "GEMINI_API_KEY is not set in Vercel settings." });

  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = null; } }
  if (!b || !Array.isArray(b.cos) || !b.cos.length) return res.status(400).json({ error: "No course outcomes sent." });
  if (b.task !== "map" && b.task !== "review") return res.status(400).json({ error: "Unknown task." });

  const cos = b.cos.slice(0, 30).map(c => ({ n: Number(c.n) || 0, text: String(c.text || "").slice(0, 500) }));
  const course = { code: String((b.course && b.course.code) || "").slice(0, 40), title: String((b.course && b.course.title) || "").slice(0, 120) };
  const levels = Array.isArray(b.levels) ? b.levels : [];
  const model = process.env.GEMINI_MODEL || "gemini-3.8-flash";

  try {
    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: buildPrompt(b.task, course, cos, levels) }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.2 }
      })
    });
    const j = await r.json();
    if (!r.ok) return res.status(502).json({ error: (j.error && j.error.message) || ("Gemini returned HTTP " + r.status) });

    const parts = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
    const text = parts.filter(p => !p.thought).map(p => p.text || "").join("");
    let out;
    try { out = JSON.parse(text.replace(/```json|```/g, "").trim()); }
    catch (e) { return res.status(502).json({ error: "The AI returned invalid JSON. Try again." }); }

    if (b.task === "map") {
      const m = Array.isArray(out.mapping) ? out.mapping : [];
      const clean = m.map(x => ({
        levels: Array.isArray(x.levels) && x.levels.length === POS.length
          ? x.levels.map(v => Math.max(0, Math.min(3, Math.round(Number(v)) || 0))) : null,
        reason: String(x.reason || "").slice(0, 300)
      }));
      return res.status(200).json({ mapping: clean });
    }
    const iss = (Array.isArray(out.issues) ? out.issues : []).slice(0, 8).map(x => ({
      sev: ["error", "warning", "info"].includes(x.sev) ? x.sev : "warning",
      msg: String(x.msg || "").slice(0, 300)
    })).filter(x => x.msg);
    return res.status(200).json({ issues: iss });
  } catch (e) {
    return res.status(502).json({ error: "Could not reach the AI service." });
  }
};
