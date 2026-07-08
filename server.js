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
 * Storage is a plain JSON file (data/sessions.json), not a real database. That's a
 * deliberate simplification for a free-tier prototype — see README.md for the caveat
 * about Render's free tier not guaranteeing disk persistence across restarts, and the
 * upgrade path (Supabase/Turso) once this is proven out.
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

const DATA_DIR = path.join(__dirname, 'data');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(SESSIONS_FILE)) fs.writeFileSync(SESSIONS_FILE, '[]', 'utf8');
}
function readSessions() {
  ensureStore();
  try {
    return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
  } catch (e) {
    console.error('Failed to read sessions store, resetting to empty:', e.message);
    return [];
  }
}
function writeSessions(sessions) {
  ensureStore();
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2), 'utf8');
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
app.post('/api/sessions', (req, res) => {
  const session = req.body;
  if (!session || !Array.isArray(session.entries)) {
    return res.status(400).json({ ok: false, error: 'Expected a session object with an entries array.' });
  }
  const sessions = readSessions();
  const record = {
    id: session.id || ('s_' + Date.now()),
    employeeName: session.employeeName || 'Unknown',
    startedAt: session.startedAt || null,
    completedAt: session.completedAt || new Date().toISOString(),
    privacy: session.privacy || 'private',
    entries: session.entries,
    receivedAt: new Date().toISOString(),
  };
  sessions.unshift(record);
  writeSessions(sessions);
  res.json({ ok: true, session: record });
});

// Admin-only: see every employee's saved sessions in one place.
app.get('/api/sessions', requireAdmin, (req, res) => {
  res.json({ ok: true, sessions: readSessions() });
});

app.delete('/api/sessions/:id', requireAdmin, (req, res) => {
  const sessions = readSessions().filter(s => s.id !== req.params.id);
  writeSessions(sessions);
  res.json({ ok: true });
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

app.post('/api/generate-question', async (req, res) => {
  if (!GLM_API_KEY) {
    return res.status(500).json({ ok: false, error: 'GLM_API_KEY is not configured on the server.' });
  }
  const { persona, stages, transcriptSoFar, phase } = req.body || {};

  const messages = [
    { role: 'system', content: buildSystemPrompt(persona, stages, phase) },
    { role: 'user', content: `Transcript so far:\n\n${transcriptToText(transcriptSoFar)}\n\nGenerate the next ${phase === 'scenario' ? 'hypothetical scenario' : 'question'} now.` },
  ];

  try {
    const glmRes = await fetch(GLM_BASE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GLM_API_KEY}`,
      },
      body: JSON.stringify({
        model: GLM_MODEL,
        messages,
        temperature: 0.6,
        max_tokens: 700,
      }),
    });

    if (!glmRes.ok) {
      const errText = await glmRes.text().catch(() => '');
      return res.status(502).json({ ok: false, error: `GLM API returned ${glmRes.status}`, detail: errText.slice(0, 500) });
    }

    const data = await glmRes.json();
    const rawText = data?.choices?.[0]?.message?.content || '';
    const parsed = extractJson(rawText);

    if (!parsed) {
      return res.status(502).json({ ok: false, error: 'Could not parse a JSON question from the model response.', raw: rawText.slice(0, 500) });
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
  } catch (e) {
    res.status(502).json({ ok: false, error: 'Request to GLM failed.', detail: String(e.message || e) });
  }
});

app.listen(PORT, () => {
  console.log(`Sales Playbook backend listening on port ${PORT}`);
  console.log(`GLM model configured as: ${GLM_MODEL} (confirm this is correct with First before relying on it)`);
  console.log(`Admin token set: ${ADMIN_TOKEN ? 'yes' : 'NO — /api/sessions reads will fail until ADMIN_TOKEN is set'}`);
});
