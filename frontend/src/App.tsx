import React, { useEffect, useMemo, useRef, useState } from "react";

type Msg = { role: "user" | "assistant" | "system"; content: string };
type Step =
  | { tool: string; ok: boolean; args?: any; result?: any; error?: string };

const API_BASE =(import.meta as any).env.VITE_API_BASE || (typeof window !== "undefined" ? window.location.origin.replace(/:\d+$/, ":4001"): "http://localhost:4001");

export default function App() {
  const [envText, setEnvText] = useState<string>("");
  const [envLoading, setEnvLoading] = useState<boolean>(false);
  const [envSaving, setEnvSaving] = useState<boolean>(false);

  const [input, setInput] = useState<string>("");
  const [messages, setMessages] = useState<Msg[]>([
    { role: "assistant", content:
`Привет! Я универсальный агент по API (модель: gpt-5).
Напиши задачу (например: «создай элемент в приложении operacii в разделе beton (ELMA365)»).
Я посмотрю .env, прочту OpenAPI/Docs (если указаны), соберу и выполню запрос и дам лог шагов.` }
  ]);
  const [steps, setSteps] = useState<Step[]>([]);
  const [busy, setBusy] = useState<boolean>(false);

  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, steps]);

  // --- ENV load/save ---
  const reloadEnv = async () => {
    setEnvLoading(true);
    try {
      const r = await fetch(`${API_BASE}/api/env-file`);
      const j = await r.json();
      setEnvText(j.content || "");
    } catch (e) {
      setEnvText(`# не удалось получить backend/.env: ${String(e)}`);
    } finally {
      setEnvLoading(false);
    }
  };
  const saveEnv = async () => {
    setEnvSaving(true);
    try {
      await fetch(`${API_BASE}/api/env-file`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: envText }),
      });
    } finally {
      setEnvSaving(false);
    }
  };
  useEffect(() => { reloadEnv(); }, []);

  // --- Chat call ---
  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    const next = [...messages, { role: "user" as const, content: text }];
    setMessages(next);
    setInput("");
    setBusy(true);
    setSteps([]);
    try {
      const r = await fetch(`${API_BASE}/api/agent/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: next, allowWeb: true, allowHttp: true }),
      });
      const j = await r.json();
      if (j.reply) {
        setMessages(m => [...m, j.reply]);
      } else {
        setMessages(m => [...m, { role: "assistant", content: "Не удалось получить ответ от модели." }]);
      }
      setSteps(Array.isArray(j.steps) ? j.steps : []);
    } catch (e:any) {
      setMessages(m => [...m, { role: "assistant", content: "Ошибка вызова backend: " + String(e?.message || e) }]);
    } finally {
      setBusy(false);
    }
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  };

  return (
    <div className="min-h-screen w-full bg-neutral-50 text-neutral-900 flex gap-4 p-4">
      {/* Left: Chat */}
      <div className="flex-1 flex flex-col bg-white border rounded-xl shadow-sm">
        <header className="px-4 py-3 border-b font-medium">
          API-eater — Chat (GPT-5, doc-first, auto-run)
        </header>
        <div className="flex-1 overflow-auto p-4 space-y-3">
          {messages.map((m, i) => (
            <div key={i} className={`p-3 rounded-lg border ${m.role === "user" ? "bg-blue-50 border-blue-200" : "bg-gray-50 border-gray-200"}`}>
              <div className="text-xs mb-1 opacity-60">{m.role}</div>
              <div style={{ whiteSpace: "pre-wrap" }}>{m.content}</div>
            </div>
          ))}
          <div ref={endRef} />
        </div>
        <div className="border-t p-3">
          <textarea
            className="w-full h-24 p-3 border rounded-lg outline-none focus:ring"
            placeholder='Напишите запрос… (напр. "покажи поля в приложении operacii в разделе beton (ELMA365)")'
            value={input}
            onChange={(e)=>setInput(e.target.value)}
            onKeyDown={onKey}
          />
          <div className="mt-2 flex gap-2">
            <button
              className={`px-4 py-2 rounded-lg text-white ${busy ? "bg-gray-400" : "bg-blue-600 hover:bg-blue-700"}`}
              disabled={busy}
              onClick={send}
            >
              {busy ? "Выполняю…" : "Отправить"}
            </button>
            <button
              className="px-3 py-2 rounded-lg border hover:bg-gray-50"
              onClick={()=>setSteps([])}
            >
              Очистить шаги
            </button>
          </div>
        </div>
      </div>

      {/* Right: ENV + Steps */}
      <div className="w-[420px] flex flex-col gap-4">
        <div className="bg-white border rounded-xl shadow-sm">
          <div className="px-4 py-3 border-b font-medium">.env (backend/.env)</div>
          <div className="p-3">
            <textarea
              className="w-full h-64 p-3 border rounded-lg font-mono text-sm"
              value={envText}
              onChange={(e)=>setEnvText(e.target.value)}
              placeholder="# Здесь будет реальное содержимое backend/.env"
            />
            <div className="mt-2 flex gap-2">
              <button
                className={`px-4 py-2 rounded-lg text-white ${envSaving ? "bg-gray-400" : "bg-emerald-600 hover:bg-emerald-700"}`}
                onClick={saveEnv}
                disabled={envSaving}
              >
                {envSaving ? "Сохраняю…" : "Сохранить"}
              </button>
              <button className="px-3 py-2 rounded-lg border hover:bg-gray-50" onClick={reloadEnv} disabled={envLoading}>
                Обновить
              </button>
            </div>
            <div className="text-xs opacity-60 mt-2">
              Поддерживаются подсказки для доки/спеки:
              <div className="font-mono">
                SERVICE_OPENAPI_URL=<br/>
                SERVICE_API_DOC_URL=
              </div>
              (например, ELMA365_OPENAPI_URL, ELMA365_API_DOC_URL)
            </div>
          </div>
        </div>

        <div className="bg-white border rounded-xl shadow-sm">
          <div className="px-4 py-3 border-b font-medium">Выполненные шаги</div>
          <div className="p-3 space-y-2 max-h-[40vh] overflow-auto">
            {steps.length === 0 && <div className="text-sm opacity-60">Пока пусто</div>}
            {steps.map((s, i) => (
              <div key={i} className="border rounded-lg p-2">
                <div className="text-sm">
                  <b>{s.tool}</b> {s.ok ? "— OK" : "— ошибка"}
                </div>
                {s.args && (
                  <pre className="text-xs bg-gray-50 p-2 rounded overflow-auto">{JSON.stringify(s.args, null, 2)}</pre>
                )}
                {s.error && (
                  <div className="text-xs text-red-600">{s.error}</div>
                )}
                {s.result && (
                  <pre className="text-xs bg-gray-50 p-2 rounded overflow-auto">{JSON.stringify(s.result, null, 2)}</pre>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}