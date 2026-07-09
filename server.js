/**
 * Sales Playbook Capture Studio — backend
 *
 * Three jobs, all stemming from the same gap: a static HTML file has no safe place to
 * hold a real API key, no way to centralize what employees answer, and (as an emailed
 * attachment) is awkward to share and easy for mail clients to mangle.
 *
 *   1. Serves the frontend itself (public/index.html) as a normal webpage, so employees
 *      get a clickable link instead of a file to download and "open with" a browser.
 *   2. POST /api/generate-question — proxies adaptive follow-up question generation to
 *      GLM (Z.ai). The key lives only here, in an environment variable, never in the
 *      frontend. See ADAPTIVE_QUESTIONS_SPEC.md for the full prompt design.
 *   3. /api/sessions — saves and lists completed interview sessions, so answers from
 *      every employee land in one place instead of being stuck in each person's browser.
 *
 * Storage: a real hosted database (Turso/libSQL) when TURSO_DATABASE_URL is configured —
 * see README.md for setup. Session data used to live in a plain JSON file on Render's
 * disk, which Render's free tier does not guarantee survives a restart or redeploy (this
 * bit us in practice — a redeploy wiped saved sessions). If Turso isn't configured yet,
 * this falls back to that same JSON file purely so local development still works without
 * requiring a database account — that fallback carries the same data-loss risk and should
 * not be relied on for anything real.
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const GLM_API_KEY = process.env.GLM_API_KEY || '';
const GLM_MODEL = process.env.GLM_MODEL || 'glm-4.6'; // placeholder — confirm exact model id with First
const GLM_BASE_URL = process.env.GLM_BASE_URL || 'https://api.z.ai/api/paas/v4/chat/completions';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

const TURSO_DATABASE_URL = process.env.TURSO_DATABASE_URL || '';
const TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN || '';
const USE_TURSO = Boolean(TURSO_DATABASE_URL);

/* ---------------------------------------------------------------------- */
/* Storage: Turso (real, persistent) when configured, JSON file fallback  */
/* ---------------------------------------------------------------------- */
let tursoClient = null;
let tursoReady = null; // promise, resolves once the table exists
if (USE_TURSO) {
  const { createClient } = require('@libsql/client');
  tursoClient = createClient({ url: TURSO_DATABASE_URL, authToken: TURSO_AUTH_TOKEN });
  tursoReady = tursoClient.execute(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      employeeName TEXT,
      startedAt TEXT,
      completedAt TEXT,
      privacy TEXT,
      entries TEXT,
      receivedAt TEXT
    )
  `);
}

const DATA_DIR = path.join(__dirname, 'data');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

function ensureFileStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(SESSIONS_FILE)) fs.writeFileSync(SESSIONS_FILE, '[]', 'utf8');
}
function readSessionsFromFile() {
  ensureFileStore();
  try {
    return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
  } catch (e) {
    console.error('Failed to read sessions store, resetting to empty:', e.message);
    return [];
  }
}
function writeSessionsToFile(sessions) {
  ensureFileStore();
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2), 'utf8');
}

// Unified storage interface — everything below this point calls these, never the
// file/Turso helpers directly, so the rest of the app doesn't care which is active.
async function readSessions() {
  if (USE_TURSO) {
    await tursoReady;
    const result = await tursoClient.execute('SELECT * FROM sessions ORDER BY receivedAt DESC');
    return result.rows.map(row => ({
      id: row.id,
      employeeName: row.employeeName,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
      privacy: row.privacy,
      entries: JSON.parse(row.entries || '[]'),
      receivedAt: row.receivedAt,
    }));
  }
  return readSessionsFromFile();
}
async function addSession(record) {
  if (USE_TURSO) {
    await tursoReady;
    await tursoClient.execute({
      sql: `INSERT INTO sessions (id, employeeName, startedAt, completedAt, privacy, entries, receivedAt)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [
        record.id, record.employeeName, record.startedAt, record.completedAt,
        record.privacy, JSON.stringify(record.entries), record.receivedAt,
      ],
    });
    return;
  }
  const sessions = readSessionsFromFile();
  sessions.unshift(record);
  writeSessionsToFile(sessions);
}
async function deleteSession(id) {
  if (USE_TURSO) {
    await tursoReady;
    await tursoClient.execute({ sql: 'DELETE FROM sessions WHERE id = ?', args: [id] });
    return;
  }
  const sessions = readSessionsFromFile().filter(s => s.id !== id);
  writeSessionsToFile(sessions);
}

function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) {
    return res.status(500).json({ ok: false, error: 'Server is missing ADMIN_TOKEN configuration.' });
  }
  const supplied = req.get('x-admin-token');
  if (supplied !== ADMIN_TOKEN) {
    return res.status(401).json({ ok: false, error: 'Invalid or missing admin token.' });
  }
  next();
}

/* ---------------------------------------------------------------------- */
/* Health check                                                           */
/* ---------------------------------------------------------------------- */
app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'sales-playbook-backend', time: new Date().toISOString() });
});

/* ---------------------------------------------------------------------- */
/* Sessions: save + list                                                  */
/* ---------------------------------------------------------------------- */
app.post('/api/sessions', async (req, res) => {
  const session = req.body;
  if (!session || !Array.isArray(session.entries)) {
    return res.status(400).json({ ok: false, error: 'Expected a session object with an entries array.' });
  }
  const record = {
    id: session.id || ('s_' + Date.now()),
    employeeName: session.employeeName || 'Unknown',
    startedAt: session.startedAt || null,
    completedAt: session.completedAt || new Date().toISOString(),
    privacy: session.privacy || 'private',
    entries: session.entries,
    receivedAt: new Date().toISOString(),
  };
  try {
    await addSession(record);
    res.json({ ok: true, session: record });
  } catch (e) {
    console.error('Failed to save session:', e.message);
    res.status(500).json({ ok: false, error: 'Failed to save session to storage.', detail: String(e.message || e) });
  }
});

// Admin-only: see every employee's saved sessions in one place.
app.get('/api/sessions', requireAdmin, async (req, res) => {
  try {
    res.json({ ok: true, sessions: await readSessions() });
  } catch (e) {
    console.error('Failed to read sessions:', e.message);
    res.status(500).json({ ok: false, error: 'Failed to read sessions from storage.', detail: String(e.message || e) });
  }
});

app.delete('/api/sessions/:id', requireAdmin, async (req, res) => {
  try {
    await deleteSession(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    console.error('Failed to delete session:', e.message);
    res.status(500).json({ ok: false, error: 'Failed to delete session from storage.', detail: String(e.message || e) });
  }
});

/* ---------------------------------------------------------------------- */
/* Adaptive question generation (proxies to GLM, key never leaves server) */
/* ---------------------------------------------------------------------- */
const INTERVIEW_SYSTEM_PROMPT = `You are an interview assistant helping a company capture how its sales team actually works, so it can be turned into a written sales playbook.

The persona being interviewed: {{PERSONA_LABEL}} — {{PERSONA_DESCRIPTION}}

The process this interview should cover, roughly in order, is:
{{STAGES}}

You will be given the full transcript of what's been asked and answered so far. Your job is to generate ONE follow-up question:
- If the most recent answer was shallow, vague, or skipped something important, dig deeper into that same stage instead of moving on.
- If the current stage has been explored thoroughly, move to the next stage that hasn't been covered yet.
- Keep questions specific and concrete — ask what the person actually does, not abstract principles.
- Do not repeat a stage that's already been thoroughly covered in the transcript.

Respond with ONLY a JSON object, no markdown fences, no extra commentary, matching exactly this shape:
{
  "stage": "<the stage or sub-stage this question targets>",
  "prompt": "<the question to ask, written the way a thoughtful interviewer would ask a colleague>",
  "chips": ["<3 to 6 short answer-option chips relevant to this specific question>"],
  "checklist": [{"label": "<short first-person checklist statement>", "kw": ["<keyword1>", "<keyword2>"]}],
  "example": "<a realistic 2-3 sentence example answer, written in first person>",
  "hint": "<a short question to help someone who's stuck answering>"
}

If every stage already has reasonable coverage in the transcript, respond with exactly: {"done": true}`;

const SCENARIO_SYSTEM_PROMPT = `You are an interview assistant helping a company understand how its sales team would actually behave under pressure, so it can be turned into a written playbook of judgment calls — not just routine steps.

The persona: {{PERSONA_LABEL}} — {{PERSONA_DESCRIPTION}}

Background on the real process this person works within, for context only (don't ask about these stages directly — that's covered elsewhere):
{{STAGES}}

You will be given the transcript of hypothetical scenarios already presented in this session and how the person said they'd respond. Your job is to generate ONE new hypothetical situation — realistic, specific, and different in kind from the scenarios already covered (e.g. a pricing conflict, a knowledge gap, an angry customer, an ownership dispute, a stock shortage under deadline pressure). It should put real pressure on a judgment call, not just ask about routine steps.

Respond with ONLY a JSON object, no markdown fences, no extra commentary, matching exactly this shape:
{
  "stage": "<short label for the type of pressure this scenario tests, e.g. 'Pricing Pressure'>",
  "situation": "<2-3 sentences setting up a realistic, specific hypothetical situation>",
  "prompt": "<a short follow-up question, e.g. 'What do you actually do — in the moment, and after?'>",
  "chips": ["<3 to 6 short answer-option chips relevant to this specific scenario>"],
  "checklist": [{"label": "<short first-person checklist statement>", "kw": ["<keyword1>", "<keyword2>"]}],
  "example": "<a realistic 2-3 sentence example answer, written in first person>",
  "hint": "<a short question to help someone who's stuck answering>"
}

If a good spread of distinct pressure-test types has already been covered in the transcript, respond with exactly: {"done": true}`;

function buildSystemPrompt(persona, stages, phase) {
  const template = phase === 'scenario' ? SCENARIO_SYSTEM_PROMPT : INTERVIEW_SYSTEM_PROMPT;
  return template
    .replace('{{PERSONA_LABEL}}', persona?.label || 'Salesperson')
    .replace('{{PERSONA_DESCRIPTION}}', persona?.description || '')
    .replace('{{STAGES}}', (stages || []).map((s, i) => `${i + 1}. ${s}`).join('\n'));
}

function transcriptToText(transcriptSoFar) {
  if (!Array.isArray(transcriptSoFar) || !transcriptSoFar.length) {
    return '(No answers yet — this is the very first question.)';
  }
  return transcriptSoFar.map((e, i) => {
    const q = e.prompt || e.situation || '(unknown question)';
    const a = e.freeform || e.summary || '(no answer given)';
    return `Q${i + 1} [stage: ${e.stage || 'unknown'}]: ${q}\nA${i + 1}: ${a}`;
  }).join('\n\n');
}

function extractJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch (e) {
    return null;
  }
}

// One attempt at calling GLM and getting back a parsed question object (or a thrown
// Error describing what went wrong). Pulled out on its own so generate-question can
// retry it once before giving up — a single slow/flaky GLM response shouldn't force a
// fallback to the scripted question if trying again would have worked.
async function callGlmForQuestion(messages) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000); // don't hang forever — fail fast and retry/fallback instead
  let glmRes;
  try {
    glmRes = await fetch(GLM_BASE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GLM_API_KEY}`,
      },
      body: JSON.stringify({
        model: GLM_MODEL,
        messages,
        temperature: 0.6,
        max_tokens: 1800, // 700 was too tight — responses were getting cut off mid-JSON
        thinking: { type: 'disabled' }, // this task doesn't need chain-of-thought; disabling
        // both speeds up the response and stops reasoning tokens from eating into the
        // budget meant for the actual JSON answer
        response_format: { type: 'json_object' }, // Z.ai's own JSON mode — a stronger
        // guarantee of valid JSON than just asking for it in the prompt, which is all we
        // were doing before. Should cut down on parse failures specifically.
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!glmRes.ok) {
    const errText = await glmRes.text().catch(() => '');
    throw new Error(`GLM API returned ${glmRes.status}: ${errText.slice(0, 500)}`);
  }

  const data = await glmRes.json();
  const rawText = data?.choices?.[0]?.message?.content || '';
  const parsed = extractJson(rawText);
  if (!parsed) {
    throw new Error(`Could not parse a JSON question from the model response. Raw: ${rawText.slice(0, 500)}`);
  }
  return parsed;
}

app.post('/api/generate-question', async (req, res) => {
  if (!GLM_API_KEY) {
    return res.status(500).json({ ok: false, error: 'GLM_API_KEY is not configured on the server.' });
  }
  const { persona, stages, transcriptSoFar, phase } = req.body || {};

  const messages = [
    { role: 'system', content: buildSystemPrompt(persona, stages, phase) },
    { role: 'user', content: `Transcript so far:\n\n${transcriptToText(transcriptSoFar)}\n\nGenerate the next ${phase === 'scenario' ? 'hypothetical scenario' : 'question'} now.` },
  ];

  let parsed;
  try {
    try {
      parsed = await callGlmForQuestion(messages);
    } catch (firstError) {
      // One retry — most GLM failures we've seen are transient (a slow response, an
      // occasional malformed reply), not a systemic problem, so trying again before
      // falling back to a scripted question meaningfully cuts down on unnecessary
      // fallbacks without making anyone wait drastically longer.
      console.warn('generate-question: first attempt failed, retrying once:', firstError.message);
      parsed = await callGlmForQuestion(messages);
    }
  } catch (e) {
    return res.status(502).json({ ok: false, error: 'Request to GLM failed after a retry.', detail: String(e.message || e) });
  }

  if (parsed.done) {
    return res.json({ ok: true, done: true });
  }
  if (!parsed.prompt) {
    return res.status(502).json({ ok: false, error: 'Model response was missing a "prompt" field.', raw: parsed });
  }
  if (phase === 'scenario' && !parsed.situation) {
    return res.status(502).json({ ok: false, error: 'Scenario response was missing a "situation" field.', raw: parsed });
  }
  parsed.type = phase === 'scenario' ? 'scenario' : 'interview';

  res.json({ ok: true, question: parsed });
});

/* ---------------------------------------------------------------------- */
/* Playbook synthesis — combines every saved session into one written     */
/* playbook document, instead of leaving Max to read raw transcripts one  */
/* by one in Team Results.                                                */
/* ---------------------------------------------------------------------- */
const PLAYBOOK_SYSTEM_PROMPT = `You are helping turn a set of structured interviews with a company's salespeople into a written sales playbook — a document a new hire could actually learn their job from.

The persona interviewed: {{PERSONA_LABEL}} — {{PERSONA_DESCRIPTION}}

The process these interviews cover, roughly in order:
{{STAGES}}

You will be given transcripts from one or more employees. Each transcript has two parts: routine "how do you work" questions tied to a stage of the process above, and hypothetical judgment scenarios testing how the person handles pressure or ambiguity.

Write a clear, well-organized sales playbook in Markdown that:
- Is organized by stage of the process above (use the stages as section headers, skip any stage nobody actually answered questions about)
- Synthesizes common patterns across employees into recommended practice — don't just list every person's answer separately, describe what the team actually does and call out the reasoning behind it
- Explicitly flags where employees described handling the same situation differently, under a short "Needs alignment" note, so leadership can decide on one standard instead of the inconsistency staying invisible
- Includes a "Judgment Calls" section near the end, built from the hypothetical scenario answers, capturing how experienced reps actually handle pressure situations (angry customers, stock shortages, pricing pressure, etc.) — written as guidance, not just a recap of what was said
- Is concrete and specific — actual steps, actual phrases people use, actual thresholds (like "follow up twice over 3-4 days then mark cold") — not generic sales advice that could apply to any company
- If only one employee's data is available, say so plainly at the top rather than writing as if this represents team-wide consensus

Output only the playbook document in Markdown — no preamble, no meta-commentary about what you're about to do, no closing summary of your own process.`;

function buildPlaybookSystemPrompt(persona, stages) {
  return PLAYBOOK_SYSTEM_PROMPT
    .replace('{{PERSONA_LABEL}}', persona?.label || 'Salesperson')
    .replace('{{PERSONA_DESCRIPTION}}', persona?.description || '')
    .replace('{{STAGES}}', (stages || []).map((s, i) => `${i + 1}. ${s}`).join('\n'));
}

function sessionsToTranscriptText(sessions) {
  return sessions.map(s => {
    const header = `--- Session: ${s.employeeName || 'Unknown'} (${s.completedAt ? new Date(s.completedAt).toLocaleDateString() : 'unknown date'}) ---`;
    const body = (s.entries || [])
      .filter(e => !e.skipped)
      .map(e => {
        const q = e.prompt || e.situation || '(unknown question)';
        const a = e.freeform || e.summary || '(no answer given)';
        const situationLine = e.situation ? `Situation: ${e.situation}\n` : '';
        return `[${e.stage || 'General'}]\n${situationLine}Q: ${q}\nA: ${a}`;
      })
      .join('\n\n');
    return `${header}\n${body}`;
  }).join('\n\n');
}

// Same shape as callGlmForQuestion but for free-form long-document generation, not a
// small structured JSON reply — no response_format constraint (we want prose/Markdown),
// higher max_tokens (a real document, not one question), and a longer timeout since
// synthesizing several sessions at once takes noticeably longer than one question.
async function callGlmForPlaybook(messages) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90000);
  let glmRes;
  try {
    glmRes = await fetch(GLM_BASE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GLM_API_KEY}`,
      },
      body: JSON.stringify({
        model: GLM_MODEL,
        messages,
        temperature: 0.5,
        max_tokens: 8000,
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!glmRes.ok) {
    const errText = await glmRes.text().catch(() => '');
    throw new Error(`GLM API returned ${glmRes.status}: ${errText.slice(0, 500)}`);
  }

  const data = await glmRes.json();
  const rawText = data?.choices?.[0]?.message?.content || '';
  if (!rawText.trim()) {
    throw new Error('Model returned an empty response.');
  }
  return rawText.trim();
}

app.post('/api/generate-playbook', requireAdmin, async (req, res) => {
  if (!GLM_API_KEY) {
    return res.status(500).json({ ok: false, error: 'GLM_API_KEY is not configured on the server.' });
  }
  const { persona, stages } = req.body || {};

  let sessions;
  try {
    sessions = await readSessions();
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'Failed to read sessions from storage.', detail: String(e.message || e) });
  }
  if (!sessions.length) {
    return res.status(400).json({ ok: false, error: 'No saved sessions to synthesize yet.' });
  }

  const messages = [
    { role: 'system', content: buildPlaybookSystemPrompt(persona, stages) },
    { role: 'user', content: `${sessionsToTranscriptText(sessions)}\n\nWrite the playbook now, based on the ${sessions.length} session(s) above.` },
  ];

  try {
    let playbook;
    try {
      playbook = await callGlmForPlaybook(messages);
    } catch (firstError) {
      console.warn('generate-playbook: first attempt failed, retrying once:', firstError.message);
      playbook = await callGlmForPlaybook(messages);
    }
    res.json({ ok: true, playbook, sessionCount: sessions.length });
  } catch (e) {
    res.status(502).json({ ok: false, error: 'Request to GLM failed after a retry.', detail: String(e.message || e) });
  }
});

app.listen(PORT, () => {
  console.log(`Sales Playbook backend listening on port ${PORT}`);
  console.log(`GLM model configured as: ${GLM_MODEL} (confirm this is correct with First before relying on it)`);
  console.log(`Admin token set: ${ADMIN_TOKEN ? 'yes' : 'NO — /api/sessions reads will fail until ADMIN_TOKEN is set'}`);
  console.log(`Session storage: ${USE_TURSO ? 'Turso (persistent)' : 'local JSON file (NOT persistent across Render restarts/redeploys — set TURSO_DATABASE_URL to fix this)'}`);
});
