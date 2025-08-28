/**
 * Backend: GPT-5 (no temperature) + DOC-FIRST + spec.hints + AUTO-RUN
 * - Без подтверждений: после script.save сразу выполняем запрос (script.run(auto))
 * - Инструменты: spec.hints, web.search (с провайдерами и fallback), openapi.probe/load, http, env.list, script.save/run
 * - Маршруты: /api/health, /api/env, /api/env-file (GET/POST), /api/scripts (GET/POST), /api/agent/chat
 * - Безопасность HTTP: только http/https, запрет приватных IP/хостов
 */

const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const dns = require("dns").promises;
const net = require("net");
const dotenv = require("dotenv");

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 4001);

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "4mb" }));

const DATA_DIR = path.resolve(__dirname, "data");
const ENV_FILE = path.join(__dirname, ".env");
const JSON_ENV_FILE = path.join(DATA_DIR, "env.json");
const CONN_FILE = path.join(DATA_DIR, "connections.json");
const SCRIPTS_FILE = path.join(DATA_DIR, "scripts.json");
fs.mkdirSync(DATA_DIR, { recursive: true });

function readJsonSafe(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
function writeJsonSafe(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}
function readDotenvFile() {
  try { const txt = fs.readFileSync(ENV_FILE, "utf8"); const parsed = dotenv.parse(txt); return { txt, parsed }; }
  catch { return { txt: "", parsed: {} }; }
}
function normalizeId(id){ return String(id||"").trim().toUpperCase().replace(/[^A-Z0-9]+/g,'_').replace(/^_+|_+$/g,''); }
function mergeEnv() {
  const { parsed } = readDotenvFile();
  const jsonEnv = readJsonSafe(JSON_ENV_FILE, {});
  const conns = readJsonSafe(CONN_FILE, { connections: [] });
  const connEnv = {};
  for (const c of conns.connections || []) {
    const ID = normalizeId(c.id || c.name || ""); if (!ID) continue;
    if (c.baseUrl) connEnv[ID+"_BASE_URL"] = c.baseUrl;
    if (c.token) connEnv[ID+"_TOKEN"] = c.token;
    if (c.openapiUrl) connEnv[ID+"_OPENAPI_URL"] = c.openapiUrl;
    if (c.apiDocUrl) connEnv[ID+"_API_DOC_URL"] = c.apiDocUrl;
  }
  return { ...process.env, ...jsonEnv, ...connEnv, ...parsed };
}
function mask(v){ if(!v) return ""; const s=String(v); return s.length<=6?"****":s.slice(0,3)+"…"+s.slice(-3); }
function publicEnvView(){
  const e = mergeEnv(); const out = {};
  for (const k of Object.keys(e)) {
    if (/_BASE_URL$/.test(k) || /(OPENAI_MODEL|SERPAPI_API_KEY|BING_SEARCH_API_KEY|GOOGLE_API_KEY|GOOGLE_CSE_ID|BRAVE_SEARCH_API_KEY|OPENAI_API_KEY)/.test(k)) {
      out[k] = /(KEY|TOKEN)/.test(k) ? mask(e[k]) : e[k];
    }
  }
  if (!out.OPENAI_MODEL) out.OPENAI_MODEL = e.OPENAI_MODEL || "gpt-5";
  return out;
}
function collectSpecHints(env){
  const map = {};
  for (const k of Object.keys(env)) {
    let m = k.match(/^([A-Z0-9_]+)_(OPENAPI_URL|API_DOC_URL)$/);
    if (m) {
      const svc = m[1];
      map[svc] = map[svc] || { service: svc, openapiUrl:null, docUrl:null, baseVar:null, tokenVar:null };
      if (m[2] === "OPENAPI_URL") map[svc].openapiUrl = env[k];
      else map[svc].docUrl = env[k];
      continue;
    }
    if (/_BASE_URL$/.test(k)) {
      const svc = k.replace(/_BASE_URL$/,"");
      map[svc] = map[svc] || { service: svc, openapiUrl:null, docUrl:null, baseVar:null, tokenVar:null };
      map[svc].baseVar = k; continue;
    }
    if (/_TOKEN$/.test(k) || /_API_KEY$/.test(k)) {
      const svc = k.replace(/_(TOKEN|API_KEY)$/,"");
      map[svc] = map[svc] || { service: svc, openapiUrl:null, docUrl:null, baseVar:null, tokenVar:null };
      map[svc].tokenVar = k; continue;
    }
  }
  return Object.values(map);
}

/* ---------- Safe HTTP ---------- */
function isPrivateIP(ip){
  if(!net.isIP(ip)) return false;
  const p=ip.split(".").map(Number);
  if(p[0]===10) return true;
  if(p[0]===172&&p[1]>=16&&p[1]<=31) return true;
  if(p[0]===192&&p[1]===168) return true;
  if(p[0]===127) return true;
  if(p[0]===169&&p[1]===254) return true;
  return false;
}
async function assertPublicHostname(urlStr){
  const u = new URL(urlStr);
  if(!/^https?:$/.test(u.protocol)) throw new Error("Only http/https are allowed");
  const host = u.hostname;
  if(net.isIP(host)){ if(isPrivateIP(host)) throw new Error("Private IPs are blocked"); return; }
  const lr = await dns.lookup(host);
  if(isPrivateIP(lr.address)) throw new Error("Private IPs are blocked");
}
function pickBaseForPath(env, baseVar) {
  if (baseVar && env[baseVar]) return env[baseVar];
  const baseKeys = Object.keys(env).filter(k => /_BASE_URL$/.test(k));
  if (baseKeys.length === 1) return env[baseKeys[0]];
  if (baseKeys.length === 0) throw new Error("No *_BASE_URL found; provide args.url or set a BASE_URL");
  throw new Error("Multiple *_BASE_URL found; specify args.baseVar");
}
function findTokenForUrl(env, url) {
  try {
    const u = new URL(url);
    const baseKeys = Object.keys(env).filter(k => /_BASE_URL$/.test(k));
    for (const bk of baseKeys) {
      const base = String(env[bk] || "").replace(/\/$/,"");
      if (!base) continue;
      const bu = new URL(base);
      if (bu.host === u.host) {
        const prefix = bk.replace(/_BASE_URL$/,"");
        for (const cand of [prefix+"_TOKEN", prefix+"_API_KEY", "API_TOKEN", "TOKEN", "API_KEY"]) {
          if (env[cand]) return { header:"Authorization", value:"Bearer "+env[cand] };
        }
      }
    }
    return null;
  } catch { return null; }
}
async function safeFetch({method="GET",url,headers={},body}){
  await assertPublicHostname(url);
  const init={method,headers};
  if(method!=="GET" && method!=="HEAD"){
    init.body = body ?? undefined;
    if(!init.headers["content-type"] && typeof body==="string" && body.trim().startsWith("{")) init.headers["content-type"]="application/json";
  }
  const start=Date.now();
  const r=await fetch(url,init);
  const ms=Date.now()-start;
  const buf=await r.arrayBuffer();
  const text=Buffer.from(buf).toString("utf8");
  const headersOut={}; r.headers.forEach((v,k)=>headersOut[k]=v);
  return { ok:r.ok, status:r.status, statusText:r.statusText, durationMs:ms, sizeBytes:buf.byteLength, headers:headersOut, bodyText:text, contentType:headersOut["content-type"]||"" };
}

/* ---------- web.search providers + fallback ---------- */
async function searchBing(q, key){
  const u = new URL("https://api.bing.microsoft.com/v7.0/search"); u.searchParams.set("q", q); u.searchParams.set("mkt", "en-US");
  const r = await fetch(u.toString(), { headers:{ "Ocp-Apim-Subscription-Key": key } });
  const d = await r.json(); const web = d.webPages?.value || [];
  return web.slice(0,6).map(x=>({ title:x.name, url:x.url, snippet:x.snippet, displayUrl:x.displayUrl }));
}
async function searchSerpApi(q, key){
  const u = new URL("https://serpapi.com/search.json"); u.searchParams.set("engine","google"); u.searchParams.set("q", q); u.searchParams.set("api_key", key);
  const r = await fetch(u.toString()); const d = await r.json();
  return (d.organic_results||[]).slice(0,6).map(x=>({ title:x.title, url:x.link, snippet:x.snippet, displayUrl:x.displayed_link }));
}
async function searchGoogleCSE(q, apiKey, cx){
  const u = new URL("https://www.googleapis.com/customsearch/v1"); u.searchParams.set("key", apiKey); u.searchParams.set("cx", cx); u.searchParams.set("q", q);
  const r = await fetch(u.toString()); const d = await r.json();
  return (d.items||[]).slice(0,6).map(x=>({ title:x.title, url:x.link, snippet:x.snippet, displayUrl:x.displayLink }));
}
async function searchBrave(q, key){
  const u = new URL("https://api.search.brave.com/res/v1/web/search"); u.searchParams.set("q", q);
  const r = await fetch(u.toString(), { headers:{ "X-Subscription-Token": key } });
  const d = await r.json(); const web = d.web?.results || [];
  return web.slice(0,6).map(x=>({ title:x.title, url:x.url, snippet:x.description, displayUrl: (x.meta_url&&x.meta_url.display_url)||x.url }));
}
async function searchDDGLite(q){
  const u = new URL("https://html.duckduckgo.com/html/"); u.searchParams.set("q", q);
  const r = await fetch(u.toString(), { headers:{ "User-Agent": "api-eater/1.0" } });
  const html = await r.text();
  const results = []; const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>(.*?)<\/a>/gi; let m;
  while ((m = re.exec(html)) && results.length < 6) {
    let href = m[1]; let title = m[2].replace(/<[^>]*>/g,"");
    try { const urlObj = new URL(href, "https://html.duckduckgo.com"); const uddg = urlObj.searchParams.get("uddg"); if (uddg) href = decodeURIComponent(uddg); } catch {}
    results.push({ title, url: href, snippet: "", displayUrl: href.replace(/^https?:\/\//,"") });
  }
  return results;
}
async function webSearch(q) {
  const env = mergeEnv();
  try { if (env.BING_SEARCH_API_KEY) return await searchBing(q, env.BING_SEARCH_API_KEY); } catch {}
  try { if (env.SERPAPI_API_KEY) return await searchSerpApi(q, env.SERPAPI_API_KEY); } catch {}
  try { if (env.GOOGLE_API_KEY && env.GOOGLE_CSE_ID) return await searchGoogleCSE(q, env.GOOGLE_API_KEY, env.GOOGLE_CSE_ID); } catch {}
  try { if (env.BRAVE_SEARCH_API_KEY) return await searchBrave(q, env.BRAVE_SEARCH_API_KEY); } catch {}
  return await searchDDGLite(q);
}

/* ---------- OpenAPI helpers ---------- */
function looksLikeOpenAPIJson(text){
  try { const j = JSON.parse(text); if (j && (j.openapi || j.swagger) && j.paths) return { ok:true, json:j }; return { ok:false }; }
  catch { return { ok:false }; }
}
function summarizeOpenAPI(obj){
  try {
    const paths = Object.keys(obj.paths || {}); const first = paths.slice(0, 40);
    const methods = {}; for (const p of first) { const ops = Object.keys(obj.paths[p]||{}); methods[p] = ops; }
    return { openapi: obj.openapi || obj.swagger || "", servers: obj.servers || [], count: paths.length, sample: methods };
  } catch { return { openapi:"", servers:[], count:0, sample:{} }; }
}
async function discoverOpenAPISpec(baseUrl){
  const candidates = ["/openapi.json","/swagger.json","/.well-known/openapi.json","/v3/api-docs","/swagger/v1/swagger.json","/api-docs","/api-docs.json","/api/swagger.json","/openapi.yaml","/swagger.yaml","/swagger/v1/swagger.yaml"];
  for (const p of candidates) {
    try {
      const u = String(baseUrl).replace(/\/$/,"") + p;
      const r = await safeFetch({ url:u, method:"GET", headers:{} });
      if (!r.ok) continue;
      const ct = (r.contentType||"").toLowerCase();
      if (ct.includes("json") || r.bodyText.trim().startsWith("{")) {
        const parsed = looksLikeOpenAPIJson(r.bodyText);
        if (parsed.ok) return { ok:true, url:u, type:"json", spec: parsed.json, summary: summarizeOpenAPI(parsed.json) };
      }
      if (ct.includes("yaml") || /(^|\n)\s*openapi:/.test(r.bodyText)) {
        return { ok:true, url:u, type:"yaml", text: r.bodyText.slice(0, 200000) };
      }
    } catch {}
  }
  return { ok:false, error:"Spec not found on common paths" };
}

/* ---------- OpenAI (GPT-5, no temperature) ---------- */
async function callOpenAI(messages){
  const env = mergeEnv();
  if (!env.OPENAI_API_KEY) return { role:"assistant", content:"Не задан OPENAI_API_KEY. Добавьте ключ в backend/.env" };
  const model = env.OPENAI_MODEL || "gpt-5";
  const payload = { model, messages };
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method:"POST",
    headers:{ "Authorization":"Bearer "+env.OPENAI_API_KEY, "Content-Type":"application/json" },
    body: JSON.stringify(payload)
  });
  const data = await r.json();
  if (!r.ok || data.error) {
    const msg = (data && data.error && data.error.message) || r.statusText || "OpenAI API error";
    return { role:"assistant", content:"Ошибка модели ("+model+"): "+msg };
  }
  const message = (data.choices && data.choices[0] && data.choices[0].message) || { role:"assistant", content:"Пустой ответ модели." };
  return message;
}
function extractToolCall(text){
  const m = text && text.match(/```tool\s+([\s\S]+?)\s+```/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

/* ---------- SYSTEM PROMPT ---------- */
const SYSTEM_PROMPT = [
  "Ты — универсальный агент по интеграциям с внешними API.",
  "Твоя задача: по пользовательскому запросу найти описания API (OpenAPI/Swagger и страницы документации), понять требуемую операцию и корректно выполнить её через HTTP.",
  "ПРИНЦИПЫ:",
  "- Никаких предположений об эндпоинтах. Используй спецификацию и/или официальную документацию.",
  "- Сначала используй подсказки из окружения (*_OPENAPI_URL, *_API_DOC_URL). Затем openapi.load → чтение страниц Docs (http GET к *_API_DOC_URL). Если нет подсказок — web.search и openapi.probe.",
  "- Ключи/базовые URL не вшивай в скрипты: они берутся из окружения (*_BASE_URL, *_TOKEN). Если чего-то не хватает — запроси у пользователя отдельно (полями интерфейса).",
  "- Проверяй URL на публичность (только http/https, не внутренние IP/домены).",
  "- Выполняй работу итеративно: если ответ об ошибке — проанализируй и исправь запрос (параметры, метод, заголовки, путь).",
  "- Будь конкретен: указывай метод, путь, параметры, минимально необходимые заголовки.",
  "ИНСТРУМЕНТЫ (ровно один за шаг):",
  "- spec.hints: перечисли кандидаты URL спецификации и документации для именованных сервисов.",
  "- openapi.probe: попробуй типовые пути спеки относительно *_BASE_URL.",
  "- openapi.load: загрузка и сводка OpenAPI по прямой ссылке.",
  "- web.search: поиск страниц документации и примеров.",
  "- http: выполнение конкретного HTTP-запроса.",
  "- script.save: сохрани финальный запрос (server выполнит его автоматически).",
  "- script.run: запуск сохранённого/сформированного запроса.",
  "ФОРМАТ ВЫЗОВА ИНСТРУМЕНТА: оформляй JSON в блоке ```tool ... ```.",
  "ЗАВЕРШЕНИЕ: дай краткий лог шагов (не мысли): что нашёл (OpenAPI/Docs), какой запрос выполнил (метод/путь, статус), какие исправления внёс."
].join("\n");

/* ---------- ROUTES ---------- */
app.get("/api/health", function(_req,res){ res.json({ok:true}); });

app.get("/api/env", function(_req,res){
  const e = publicEnvView(); const merged = mergeEnv(); const missing = [];
  if (!merged.OPENAI_API_KEY) missing.push("OPENAI_API_KEY");
  const baseKeys = Object.keys(merged).filter(function(k){ return /_BASE_URL$/.test(k); });
  if (baseKeys.length === 0) missing.push("*_BASE_URL");
  res.json({ values:e, missing });
});

app.get("/api/env-file", function(_req,res){
  const d = readDotenvFile();
  res.json({ path: ENV_FILE, content: d.txt });
});
app.post("/api/env-file", function(req,res){
  const content = String((req.body && req.body.content) || "");
  try { if (fs.existsSync(ENV_FILE)) { const bak = ENV_FILE + "." + new Date().toISOString().replace(/[:.]/g,"-") + ".bak"; fs.copyFileSync(ENV_FILE, bak); } } catch {}
  fs.writeFileSync(ENV_FILE, content); res.json({ ok:true });
});

// Connections CRUD
app.get("/api/connections", function(_req,res){
  const data = readJsonSafe(CONN_FILE, { connections: [] });
  const safe = (data.connections||[]).map(function(c){
    return { id:c.id, name:c.name||c.id, baseUrl:c.baseUrl||"", token: mask(c.token||""), openapiUrl:c.openapiUrl||"", apiDocUrl:c.apiDocUrl||"" };
  });
  res.json({ connections: safe });
});
app.post("/api/connections", function(req,res){
  const b = req.body || {};
  const idRaw = b.id || b.name || "";
  const id = normalizeId(idRaw);
  if (!id) return res.status(400).json({ error:"Missing id" });
  const entry = { id, name: b.name || id, baseUrl: String(b.baseUrl||""), token: String(b.token||""), openapiUrl: String(b.openapiUrl||""), apiDocUrl: String(b.apiDocUrl||"") };
  const data = readJsonSafe(CONN_FILE, { connections: [] });
  const idx = (data.connections||[]).findIndex(function(c){ return normalizeId(c.id)===id; });
  if (idx>=0) data.connections[idx] = { ...data.connections[idx], ...entry };
  else (data.connections = data.connections || []).unshift(entry);
  writeJsonSafe(CONN_FILE, data);
  res.json({ ok:true, id });
});
app.delete("/api/connections/:id", function(req,res){
  const id = normalizeId(req.params.id||"");
  const data = readJsonSafe(CONN_FILE, { connections: [] });
  data.connections = (data.connections||[]).filter(function(c){ return normalizeId(c.id)!==id; });
  writeJsonSafe(CONN_FILE, data);
  res.json({ ok:true });
});

app.get("/api/scripts", function(_req,res){ res.json(readJsonSafe(SCRIPTS_FILE, { scripts: [] })); });
app.post("/api/scripts", function(req,res){
  const s = req.body || {};
  if (!s || !s.request) return res.status(400).json({ error:"Bad script" });
  s.id = s.id || Math.random().toString(36).slice(2,10);
  s.createdAt = s.createdAt || new Date().toISOString();
  s.updatedAt = new Date().toISOString();
  const data = readJsonSafe(SCRIPTS_FILE, { scripts: [] });
  const idx = data.scripts.findIndex(function(x){ return x.id===s.id; });
  if (idx>=0) data.scripts[idx]=s; else data.scripts.unshift(s);
  writeJsonSafe(SCRIPTS_FILE, data);
  res.json({ ok:true, id:s.id });
});

/* ---------- CHAT LOOP ---------- */
app.post("/api/agent/chat", async function(req,res){
  const body = req.body || {};
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const allowWeb = (body.allowWeb!==false);
  const allowHttp = (body.allowHttp!==false);
  const steps = [];
  let convo = [{ role:"system", content: SYSTEM_PROMPT }].concat(messages);

  for (let i=0;i<12;i++){
    const reply = await callOpenAI(convo);
    const content = reply.content || "";
    const tool = extractToolCall(content);
    if (!tool) { return res.json({ reply, steps }); }

    try{
      if (tool.tool === "env.list") {
        const e = mergeEnv(); const present = {}; Object.keys(e).forEach(function(k){ present[k] = !!e[k]; });
        steps.push({ tool:"env.list", ok:true, result: present });
        convo.push({ role:"user", content:"РЕЗУЛЬТАТ ИНСТРУМЕНТА env.list:\n"+ JSON.stringify(present).slice(0,4000) });
        continue;
      }

      if (tool.tool === "spec.hints") {
        const env = mergeEnv();
        const hints = collectSpecHints(env);
        steps.push({ tool:"spec.hints", ok:true, result: hints });
        convo.push({ role:"user", content:"РЕЗУЛЬТАТ ИНСТРУМЕНТА spec.hints:\n"+ JSON.stringify(hints).slice(0,4000) });
        continue;
      }

      if (tool.tool === "web.search") {
        if (!allowWeb) throw new Error("Web search disabled");
        const q = (tool.args && tool.args.q) || "";
        const result = await webSearch(q);
        steps.push({ tool:"web.search", ok:true, args:{q:q}, result: result });
        convo.push({ role:"user", content:"РЕЗУЛЬТАТ ИНСТРУМЕНТА web.search:\n"+ JSON.stringify(result).slice(0,4000) });
        continue;
      }

      if (tool.tool === "openapi.probe") {
        const env = mergeEnv();
        const baseUrl = (tool.args && tool.args.baseUrl) || (tool.args && tool.args.baseVar && env[tool.args.baseVar]) || null;
        if (!baseUrl) {
          const baseKeys = Object.keys(env).filter(function(k){ return /_BASE_URL$/.test(k); });
          if (baseKeys.length===1) {
            const u = env[baseKeys[0]]; const out = await discoverOpenAPISpec(u);
            steps.push({ tool:"openapi.probe", ok:out.ok, args:{ baseVar: (tool.args && tool.args.baseVar) || baseKeys[0], baseUrl:u }, result: out });
            convo.push({ role:"user", content:"РЕЗУЛЬТАТ ИНСТРУМЕНТА openapi.probe:\n"+ JSON.stringify(out).slice(0,4000) });
            continue;
          }
          throw new Error("Укажи baseVar или baseUrl для openapi.probe");
        }
        const out = await discoverOpenAPISpec(baseUrl);
        steps.push({ tool:"openapi.probe", ok:out.ok, args:{ baseUrl: baseUrl }, result: out });
        convo.push({ role:"user", content:"РЕЗУЛЬТАТ ИНСТРУМЕНТА openapi.probe:\n"+ JSON.stringify(out).slice(0,4000) });
        continue;
      }

      if (tool.tool === "openapi.load") {
        const url = (tool.args && tool.args.url) || "";
        if (!url) throw new Error("openapi.load: url required");
        const r = await safeFetch({ method:"GET", url:url, headers:{} });
        if (!r.ok) throw new Error("openapi.load: failed "+r.status);
        let result;
        const parsed = looksLikeOpenAPIJson(r.bodyText);
        if (parsed.ok) result = { ok:true, type:"json", url:url, spec: parsed.json, summary: summarizeOpenAPI(parsed.json) };
        else result = { ok:true, type:(r.contentType||"text"), url:url, text: r.bodyText.slice(0,200000) };
        steps.push({ tool:"openapi.load", ok:true, args:{ url:url }, result: result });
        convo.push({ role:"user", content:"РЕЗУЛЬТАТ ИНСТРУМЕНТА openapi.load:\n"+ JSON.stringify(result).slice(0,4000) });
        continue;
      }

      if (tool.tool === "http") {
        if (!allowHttp) throw new Error("HTTP disabled");
        const args = tool.args || {};
        const env = mergeEnv();
        let url = args.url;
        if (!url && args.path) {
          const base = pickBaseForPath(env, args.baseVar);
          const p = String(args.path).replace(/^\//,"");
          url = String(base || "").replace(/\/$/,"") + "/" + p;
        }
        if (!url) throw new Error("No url/path");
        const headers = args.headers || {};
        const hasAuth = Object.keys(headers).some(function(k){ return /^authorization$/i.test(k); });
        if (!hasAuth) { const tok = findTokenForUrl(env, url); if (tok) headers[tok.header] = tok.value; }
        const result = await safeFetch({ method: args.method || "GET", url:url, headers:headers, body: args.body || "" });
        steps.push({ tool:"http", ok:true, args:{ method: args.method||"GET", url:url }, result: { status: result.status, ok: result.ok, contentType: result.contentType, sample: result.bodyText.slice(0,1200) } });
        convo.push({ role:"user", content:"РЕЗУЛЬТАТ ИНСТРУМЕНТА http:\n"+ JSON.stringify(result).slice(0,4000) });
        continue;
      }

      if (tool.tool === "script.save") {
        const s = tool.args || {};
        s.id = s.id || Math.random().toString(36).slice(2,10);
        s.createdAt = s.createdAt || new Date().toISOString();
        s.updatedAt = new Date().toISOString();
        const data = readJsonSafe(SCRIPTS_FILE, { scripts: [] });
        const idx = data.scripts.findIndex(function(x){ return x.id===s.id; });
        if (idx>=0) data.scripts[idx]=s; else data.scripts.unshift(s);
        writeJsonSafe(SCRIPTS_FILE, data);
        steps.push({ tool:"script.save", ok:true, result:{ id:s.id, name:s.name||"" } });
        convo.push({ role:"user", content:"РЕЗУЛЬТАТ ИНСТРУМЕНТА script.save:\n"+ JSON.stringify({ id:s.id, name:s.name||"" }) });

        // авто-запуск сразу после сохранения
        let reqSpec = s.request;
        if (reqSpec) {
          const env = mergeEnv();
          let url = reqSpec.url;
          if (!url && reqSpec.path) {
            const base = pickBaseForPath(env, reqSpec.baseVar);
            const p = String(reqSpec.path).replace(/^\//,"");
            url = String(base || "").replace(/\/$/,"") + "/" + p;
          }
          if (!url) {
            steps.push({ tool:"script.run(auto)", ok:false, error:"No url for script.run(auto)" });
            convo.push({ role:"user", content:"ИНСТРУМЕНТ ВЫДАЛ ОШИБКУ script.run(auto): No url" });
          } else {
            const headers = reqSpec.headers || {};
            const hasAuth = Object.keys(headers).some(function(k){ return /^authorization$/i.test(k); });
            if (!hasAuth) { const tok = findTokenForUrl(env, url); if (tok) headers[tok.header] = tok.value; }
            const runRes = await safeFetch({ method: reqSpec.method || "GET", url:url, headers:headers, body: reqSpec.body || "" });
            steps.push({ tool:"script.run(auto)", ok:true, args:{ method:reqSpec.method||"GET", url:url }, result:{ status: runRes.status, ok: runRes.ok, contentType: runRes.contentType, sample: runRes.bodyText.slice(0,1200) } });
            convo.push({ role:"user", content:"РЕЗУЛЬТАТ ИНСТРУМЕНТА script.run(auto):\n"+ JSON.stringify(runRes).slice(0,4000) });
          }
        }
        continue;
      }

      if (tool.tool === "script.run") {
        const a = tool.args || {};
        let reqSpec = a.request;
        if (!reqSpec && a.id) {
          const data = readJsonSafe(SCRIPTS_FILE, { scripts: [] });
          const found = data.scripts.find(function(x){ return x.id===a.id; });
          if (!found) throw new Error("Script not found: "+a.id);
          reqSpec = found.request;
        }
        if (!reqSpec) throw new Error("No request provided");
        const env = mergeEnv();
        let url = reqSpec.url;
        if (!url && reqSpec.path) {
          const base = pickBaseForPath(env, reqSpec.baseVar);
          const p = String(reqSpec.path).replace(/^\//,"");
          url = String(base || "").replace(/\/$/,"") + "/" + p;
        }
        if (!url) throw new Error("No url for script.run");
        const headers = reqSpec.headers || {};
        const hasAuth = Object.keys(headers).some(function(k){ return /^authorization$/i.test(k); });
        if (!hasAuth) { const tok = findTokenForUrl(env, url); if (tok) headers[tok.header] = tok.value; }
        const result = await safeFetch({ method: reqSpec.method || "GET", url:url, headers:headers, body: reqSpec.body || "" });
        steps.push({ tool:"script.run", ok:true, args:{ method:reqSpec.method||"GET", url:url }, result:{ status: result.status, ok: result.ok, contentType: result.contentType, sample: result.bodyText.slice(0,1200) } });
        convo.push({ role:"user", content:"РЕЗУЛЬТАТ ИНСТРУМЕНТА script.run:\n"+ JSON.stringify(result).slice(0,4000) });
        continue;
      }

      throw new Error("UNKNOWN_TOOL: "+tool.tool);
    } catch (e) {
      steps.push({ tool: tool.tool || "unknown", ok:false, error: (e && e.message) || String(e) });
      convo.push({ role:"user", content:"ИНСТРУМЕНТ ВЫДАЛ ОШИБКУ "+(tool.tool||"unknown")+": "+((e && e.message) || String(e)) });
      continue;
    }
  }

  const final = await callOpenAI(convo);
  res.json({ reply: final, steps });
});

/* ---------- START ---------- */
app.listen(PORT, function(){ console.log("Backend auto-run ready on http://0.0.0.0:" + PORT); });
