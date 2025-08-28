import React, { useEffect, useRef, useState } from "react";

type Msg = { role: "user" | "assistant" | "system"; content: string; kind?: "reply" | "action" | "status" };
type Step = { tool: string; ok: boolean; args?: any; result?: any; error?: string };

const API_BASE = (import.meta as any).env.VITE_API_BASE || (typeof window !== "undefined" ? `${window.location.protocol}//${window.location.hostname}:4001` : "http://localhost:4001");

function iconForTool(t: string) {
  if (t === "env.list") return "🧩";
  if (t === "spec.hints") return "🧭";
  if (t === "web.search") return "🔎";
  if (t === "openapi.probe") return "🧪";
  if (t === "openapi.load") return "📥";
  if (t === "http") return "🔗";
  if (t.startsWith("script.save")) return "💾";
  if (t.startsWith("script.run")) return "▶️";
  return "•";
}

export default function App() {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Msg[]>([
    {
      role: "assistant",
      kind: "reply",
      content:
        "Привет! Я универсальный агент по API (gpt‑5). Опишите задачу — я найду спецификацию/доки, сформирую и выполню корректный запрос. Ключи и базовые URL хранятся отдельно и в скрипты не попадают.",
    },
  ]);
  const [steps, setSteps] = useState<Step[]>([]);
  const [busy, setBusy] = useState(false);
  const thinkingIndexRef = useRef<number | null>(null);

  // Connections
  type Conn = { id: string; name: string; baseUrl: string; token: string; openapiUrl?: string; apiDocUrl?: string };
  const [connections, setConnections] = useState<Conn[]>([]);
  const [connForm, setConnForm] = useState<{ id: string; name: string; baseUrl: string; token: string; openapiUrl: string; apiDocUrl: string }>({ id: "", name: "", baseUrl: "", token: "", openapiUrl: "", apiDocUrl: "" });

  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, steps]);

  // No .env editor anymore

  // Connections load/save
  const reloadConns = async () => {
    try {
      const r = await fetch(`${API_BASE}/api/connections`);
      const t = await r.text();
      const j = t ? JSON.parse(t) : { connections: [] };
      setConnections(j.connections || []);
    } catch (e) {
      console.warn("Failed to load connections:", e);
    }
  };
  const [connSaving, setConnSaving] = useState(false);
  const [connNotice, setConnNotice] = useState<string>("");
  const saveConn = async () => {
    try {
      setConnSaving(true);
      setConnNotice("");
      const body = { ...connForm };
      if (!body.id && body.name) body.id = body.name;
      const url = `${API_BASE}/api/connections`;
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) {
        const msg = await r.text();
        throw new Error(`Не удалось сохранить подключение (${r.status}). URL: ${url}. Ответ: ${msg.slice(0,120)}`);
      }
      setConnForm({ id: "", name: "", baseUrl: "", token: "", openapiUrl: "", apiDocUrl: "" });
      setConnNotice("Сохранено");
      reloadConns();
    } catch (e: any) {
      setConnNotice("Ошибка сохранения: " + String(e?.message || e));
    } finally {
      setConnSaving(false);
      setTimeout(() => setConnNotice(""), 3000);
    }
  };
  const deleteConn = async (id: string) => {
    await fetch(`${API_BASE}/api/connections/${encodeURIComponent(id)}`, { method: "DELETE" });
    reloadConns();
  };
  useEffect(() => {
    reloadConns();
  }, []);

  // Chat call
  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    const mUser: Msg = { role: "user", content: text };
    const mThinking: Msg = { role: "assistant", kind: "status", content: "⏳ Выполняю задачу… ищу спецификацию и готовлю запрос" };
    const next = [...messages, mUser, mThinking];
    thinkingIndexRef.current = next.length - 1;
    setMessages(next);
    setInput("");
    setBusy(true);
    setSteps([]);
    try {
      const chatUrl = `${API_BASE}/api/agent/chat`;
      const r = await fetch(chatUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [...messages, mUser], allowWeb: true, allowHttp: true }),
      });
      const text = await r.text();
      let j: any = null;
      try { j = text ? JSON.parse(text) : null; } catch {}
      if (!r.ok) {
        const body = text?.slice(0, 200) || '';
        throw new Error(`HTTP ${r.status} ${r.statusText || ''}; URL: ${chatUrl}; ${body}`.trim());
      }
      const stepsArr: Step[] = Array.isArray(j?.steps) ? (j.steps as Step[]) : [];
      const actionMsgs: Msg[] = stepsArr.map((s: Step) => ({
            role: "assistant",
            kind: "action",
            content: `${iconForTool(s.tool)} ${s.tool}${s.ok ? " — OK" : " — ошибка"}${s.result?.status ? ` (status ${s.result.status})` : ""}`,
          }));
      const finalMsg: Msg = j?.reply ? j.reply : { role: "assistant", kind: "reply", content: "Не удалось получить ответ от модели." };
      setSteps(stepsArr);

      setMessages((m) => {
        const idx = thinkingIndexRef.current;
        if (idx != null && idx >= 0 && idx < m.length) {
          const clone = m.slice();
          clone.splice(idx, 1, ...actionMsgs, finalMsg);
          thinkingIndexRef.current = null;
          return clone;
        }
        return [...m, ...actionMsgs, finalMsg];
      });
    } catch (e: any) {
      setMessages((m) => [
        ...m.slice(0, thinkingIndexRef.current == null ? m.length : thinkingIndexRef.current),
        { role: "assistant", kind: "reply", content: "Ошибка вызова backend: " + String(e?.message || e) },
      ]);
    } finally {
      setBusy(false);
    }
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="container">
      <div className="twoCols">
        {/* Chat */}
        <div className="card" style={{ display: "flex", flexDirection: "column", minHeight: "70vh" }}>
          <div className="header">API‑eater — Chat (GPT‑5, doc‑first, auto‑run)</div>
          <div className="chat" style={{ flex: 1, overflow: "auto" }}>
            {messages.map((m, i) => (
              <div key={i} className={`bubble ${m.role === "user" ? "user" : "assistant"}`}>
                <div className="role">
                  <div className="avatar">{m.role === "user" ? "U" : "A"}</div>
                  <div className="small">{m.role}</div>
                </div>
                <div>{m.content}</div>
              </div>
            ))}
            <div ref={endRef} />
          </div>
          <div className="composer">
            <input
              className="input"
              placeholder='Опишите задачу… (например: "найди OpenAPI и получи список клиентов")'
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKey}
            />
            <button className="btn primary" disabled={busy} onClick={send}>
              {busy ? "Выполняю…" : "Отправить"}
            </button>
          </div>
        </div>

        {/* Sidebar */}
        <div className="list">
          <div className="card">
            <div className="header">Подключения к API (секреты отдельно)</div>
            <div className="section">
              <div className="row">
                <div style={{ flex: 1 }}>
                  <div className="small">ID (A‑Z, 0‑9, _)</div>
                  <input className="input" placeholder="CRM" value={connForm.id} onChange={(e) => setConnForm({ ...connForm, id: e.target.value })} />
                </div>
                <div style={{ flex: 1 }}>
                  <div className="small">Название</div>
                  <input className="input" placeholder="Любое" value={connForm.name} onChange={(e) => setConnForm({ ...connForm, name: e.target.value })} />
                </div>
              </div>
            </div>
            <div className="section">
              <div className="small">Базовый URL</div>
              <input className="input" placeholder="https://api.example.com" value={connForm.baseUrl} onChange={(e) => setConnForm({ ...connForm, baseUrl: e.target.value })} />
            </div>
            <div className="section">
              <div className="small">Токен/ключ (не показывается полностью)</div>
              <input className="input" placeholder="скопируйте сюда" value={connForm.token} onChange={(e) => setConnForm({ ...connForm, token: e.target.value })} />
            </div>
            <div className="section">
              <div className="row">
                <div style={{ flex: 1 }}>
                  <div className="small">OpenAPI URL (опц.)</div>
                  <input className="input" placeholder="https://.../openapi.json" value={connForm.openapiUrl} onChange={(e) => setConnForm({ ...connForm, openapiUrl: e.target.value })} />
                </div>
                <div style={{ flex: 1 }}>
                  <div className="small">Docs URL (опц.)</div>
                  <input className="input" placeholder="https://.../docs" value={connForm.apiDocUrl} onChange={(e) => setConnForm({ ...connForm, apiDocUrl: e.target.value })} />
                </div>
              </div>
            </div>
            <div className="section">
              <div className="row">
                <button className="btn primary" onClick={saveConn} disabled={connSaving}>{connSaving ? "Сохраняю…" : "Сохранить подключение"}</button>
                <button className="btn" onClick={reloadConns}>Обновить</button>
              </div>
              {connNotice && <div className="small" style={{ marginTop: 6 }}>{connNotice}</div>}
              <div className="small" style={{ marginTop: 8 }}>
                После сохранения переменные доступны как: <span className="mono">ID_BASE_URL</span>, <span className="mono">ID_TOKEN</span>, <span className="mono">ID_OPENAPI_URL</span>, <span className="mono">ID_API_DOC_URL</span>.
              </div>
            </div>
            <div className="section">
              <div className="small" style={{ fontWeight: 600, marginBottom: 6 }}>Текущие подключения</div>
              <div className="list" style={{ maxHeight: 240, overflow: "auto" }}>
                {connections.length === 0 && <div className="small">Пусто</div>}
                {connections.map((c) => (
                  <div key={c.id} className="card" style={{ borderRadius: 12 }}>
                    <div className="section" style={{ borderBottom: "none" }}>
                      <div className="small"><b>{c.name}</b> <span style={{ opacity: 0.6 }}>({c.id})</span></div>
                      <div className="small">BASE: {c.baseUrl || "-"}</div>
                      <div className="small">TOKEN: {c.token || "-"}</div>
                      {c.openapiUrl && <div className="small">OpenAPI: {c.openapiUrl}</div>}
                      {c.apiDocUrl && <div className="small">Docs: {c.apiDocUrl}</div>}
                      <div className="row" style={{ marginTop: 6 }}>
                        <button className="btn" onClick={() => deleteConn(c.id)}>Удалить</button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* .env panel removed by request */}
        </div>
      </div>
    </div>
  );
}
