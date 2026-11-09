// Choix du fournisseur d'IA et adaptateur Groq (API compatible OpenAI) <-> format Anthropic.
// Anthropic (Claude) est utilisé quand ANTHROPIC_API_KEY est défini ; sinon Groq si GROQ_API_KEY est défini.
// AI_PROVIDER=groq|anthropic force le choix.

export function aiConfig(env = process.env) {
  const forced = String(env.AI_PROVIDER || '').toLowerCase();
  const useGroq = forced === 'groq' ? !!env.GROQ_API_KEY : forced === 'anthropic' ? false : !env.ANTHROPIC_API_KEY && !!env.GROQ_API_KEY;
  const groq = env.GROQ_API_KEY ? { provider: 'groq', apiKey: env.GROQ_API_KEY, model: env.GROQ_MODEL || 'openai/gpt-oss-120b', visionModel: env.GROQ_VISION_MODEL || 'qwen/qwen3.8-27b', label: 'Groq' } : null;
  if (useGroq) return groq;
  if (env.ANTHROPIC_API_KEY) return { provider: 'anthropic', apiKey: env.ANTHROPIC_API_KEY, model: env.ANTHROPIC_MODEL || 'claude-sonnet-5-5', visionModel: env.ANTHROPIC_MODEL || 'claude-sonnet-5-5', label: 'Claude', fallback: forced === 'anthropic' ? null : groq };
  return null;
}

// Exécute avec le fournisseur principal ; si Claude échoue (crédit épuisé, clé refusée, surcharge…) et qu'une clé Groq existe, bascule sur Groq.
export async function withFallback(cfg, run) {
  try { return await run(cfg); }
  catch (e) {
    if (!cfg.fallback || !e.switchable) throw e;
    const out = await run(cfg.fallback);
    if (out && typeof out === 'object') out.fallbackFrom = cfg.label;
    return out;
  }
}

export const NO_KEY = "L'assistant n'est pas encore configuré : ajoutez GROQ_API_KEY (gratuit) ou ANTHROPIC_API_KEY dans Vercel, puis redéployez.";
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

function toOpenAI({ system, tools, messages }) {
  const out = system ? [{ role: 'system', content: system }] : [];
  for (const m of messages) {
    if (typeof m.content === 'string') { out.push({ role: m.role, content: m.content }); continue; }
    if (m.role === 'assistant') {
      const text = m.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      const calls = m.content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input || {}) } }));
      out.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
    } else {
      const res = m.content.filter((b) => b.type === 'tool_result');
      res.forEach((b) => out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: typeof b.content === 'string' ? b.content : JSON.stringify(b.content) }));
      const text = m.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      if (text) out.push({ role: 'user', content: text });
    }
  }
  return {
    messages: out,
    tools: (tools || []).map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } })),
  };
}

function fromOpenAI(j) {
  const msg = (j.choices && j.choices[0] && j.choices[0].message) || {};
  const content = [];
  if (msg.content) content.push({ type: 'text', text: msg.content });
  (msg.tool_calls || []).forEach((c, i) => {
    let input = {};
    try { input = JSON.parse((c.function && c.function.arguments) || '{}') || {}; } catch (e) { input = {}; }
    content.push({ type: 'tool_use', id: c.id || 'call_' + i, name: c.function && c.function.name, input });
  });
  return { content, stop_reason: (msg.tool_calls || []).length ? 'tool_use' : 'end_turn' };
}

function errMsg(cfg, status, raw) {
  const who = cfg.provider === 'groq' ? 'GROQ_API_KEY' : 'ANTHROPIC_API_KEY';
  if (status === 401) return `Clé ${who} refusée : vérifiez-la dans Vercel`;
  if (status === 429) return cfg.provider === 'groq' ? 'Limite gratuite Groq atteinte pour le moment : réessayez dans une minute' : 'Trop de demandes, réessayez dans un instant';
  if (/credit|billing/i.test(raw)) return 'Crédit Anthropic insuffisant : rechargez le compte sur console.anthropic.com';
  return 'Service IA indisponible : ' + raw;
}

// Appel unique au modèle, au format Anthropic (system, tools, messages) -> { content, stop_reason }
export async function callLLM(cfg, { system, tools, messages, max_tokens = 1200, model }, fetchImpl) {
  let res, j;
  if (cfg.provider === 'groq') {
    const o = toOpenAI({ system, tools, messages });
    const body = { model: model || cfg.model, messages: o.messages, max_completion_tokens: Math.max(max_tokens, 2000), temperature: 0.2 };
    if (o.tools.length) { body.tools = o.tools; body.tool_choice = 'auto'; }
    res = await fetchImpl(GROQ_URL, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + cfg.apiKey }, body: JSON.stringify(body) });
    j = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(errMsg(cfg, res.status, (j && j.error && j.error.message) || 'Erreur ' + res.status)), { status: 502 });
    return fromOpenAI(j);
  }
  res = await fetchImpl('https://api.anthropic.com/v1/messages', { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: model || cfg.model, max_tokens, ...(system ? { system } : {}), ...(tools && tools.length ? { tools } : {}), messages }) });
  j = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(errMsg(cfg, res.status, (j && j.error && j.error.message) || 'Erreur ' + res.status)), { status: 502, switchable: res.status !== 400 || /credit|billing/i.test(JSON.stringify(j)) });
  return { content: j.content || [], stop_reason: j.stop_reason };
}

// Lecture d'images/PDF : contenu multimodal. Groq : images seulement (pas de PDF).
export async function callVision(cfg, { prompt, files, max_tokens = 1500 }, fetchImpl) {
  if (cfg.provider === 'groq') {
    if (files.some((f) => f.type === 'application/pdf')) throw Object.assign(new Error('PDF à convertir en images'), { status: 415, code: 'need_images' });
    const content = [{ type: 'text', text: prompt }, ...files.slice(0, 3).map((f) => ({ type: 'image_url', image_url: { url: `data:${f.type};base64,${f.data}` } }))];
    const r = await callLLM(cfg, { messages: [{ role: 'user', content: [] }], max_tokens, model: cfg.visionModel }, async (url, o) => {
      const b = JSON.parse(o.body); b.messages = [{ role: 'user', content }]; delete b.tools; return fetchImpl(url, { ...o, body: JSON.stringify(b) });
    });
    return r.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  }
  const blocks = files.map((f) => ({ type: f.type === 'application/pdf' ? 'document' : 'image', source: { type: 'base64', media_type: f.type, data: f.data } }));
  const r = await callLLM(cfg, { messages: [{ role: 'user', content: [...blocks, { type: 'text', text: prompt }] }], max_tokens, model: cfg.visionModel }, fetchImpl);
  return r.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}
