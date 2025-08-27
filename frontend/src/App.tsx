import React, { useEffect, useMemo, useRef, useState } from 'react'

// Derive API base from current host by default (works when frontend is opened via server IP/domain)
const DEFAULT_API = (() => {
  if (typeof window !== 'undefined') {
    const proto = window.location.protocol;
    const host = window.location.hostname;
    // assume backend on 4001; override with VITE_API_URL if needed
    return `${proto}//${host}:4001`;
  }
  return 'http://localhost:4001';
})();
const API_BASE = (import.meta.env.VITE_API_URL as string) || DEFAULT_API;

type Msg = { role: 'user' | 'assistant', content: string }
type Step = { tool: string, ok: boolean, args?: any, result?: any, error?: string }

export default function App(){
  const [messages, setMessages] = useState<Msg[]>([
    { role: 'assistant', content: 'Привет! Я универсальный агент по API. Напиши задачу (например: «создай элемент в приложении operacii в разделе beton (ELMA365)»). Я сам проверю .env, найду доку, соберу и выполню запрос.' }
  ])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)

  const [envSummary, setEnvSummary] = useState<{values:Record<string,string>, missing:string[]}>({values:{}, missing:[]})
  const [envText, setEnvText] = useState('')
  const [envPath, setEnvPath] = useState<string>('')
  const [envChanged, setEnvChanged] = useState(false)
  const [envError, setEnvError] = useState<string>('')

  const [steps, setSteps] = useState<Step[]>([])
  const listRef = useRef<HTMLDivElement>(null)

  async function loadEnvSummary(){
    try{
      const r = await fetch(`${API_BASE}/api/env`)
      if(!r.ok) throw new Error(`GET /api/env ${r.status}`)
      const d = await r.json()
      setEnvSummary(d)
    }catch(e:any){
      setEnvError(e?.message || String(e))
    }
  }
  async function loadEnvFile(){
    try{
      const r = await fetch(`${API_BASE}/api/env-file`)
      if(!r.ok) throw new Error(`GET /api/env-file ${r.status}`)
      const d = await r.json()
      setEnvText(d.content ?? '')
      setEnvPath(d.path || '')
      setEnvChanged(false)
      setEnvError('')
    }catch(e:any){
      setEnvError(e?.message || String(e))
    }
  }
  useEffect(()=>{ loadEnvSummary(); loadEnvFile(); },[])

  async function saveEnvFile(){
    try{
      const r = await fetch(`${API_BASE}/api/env-file`, {
        method: 'POST',
        headers: { 'Content-Type':'application/json' },
        body: JSON.stringify({ content: envText })
      })
      if(!r.ok) throw new Error(`POST /api/env-file ${r.status}`)
      setEnvChanged(false)
      await loadEnvSummary()
    }catch(e:any){
      setEnvError(e?.message || String(e))
    }
  }

  async function send(){
    const text = input.trim()
    if(!text) return
    const next = [...messages, { role:'user' as const, content: text }]
    setMessages(next); setInput(''); setSending(true)
    try{
      const r = await fetch(`${API_BASE}/api/agent/chat`, {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ messages: next, allowWeb:true, allowHttp:true })
      })
      const data = await r.json()
      if (Array.isArray(data.steps) && data.steps.length) setSteps(prev => [...prev, ...data.steps])
      const reply: Msg = data.reply || { role:'assistant', content:'Нет ответа' }
      setMessages(prev => [...prev, reply])
      queueMicrotask(()=> listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior:'smooth' }))
    }catch(e:any){
      setMessages(prev => [...prev, { role:'assistant', content:'Ошибка: '+(e.message || String(e)) }])
    }finally{
      setSending(false)
    }
  }

  const missingText = useMemo(()=> envSummary.missing.length ? `Не хватает: ${envSummary.missing.join(', ')}` : 'Готово', [envSummary])

  return (
    <div className="container" style={{maxWidth:980, margin:'0 auto', padding:16}}>
      <div className="card">
        <div style={{padding:12, borderBottom:'1px dashed #e2e2e6'}}>
          <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', gap:8}}>
            <div style={{fontSize:12, color:'#555'}}>ENV · {missingText} {envPath && <span style={{marginLeft:8, color:'#888'}}>Файл: {envPath}</span>}</div>
            <div style={{display:'flex', gap:8}}>
              <button className="btn" onClick={()=>{ loadEnvSummary(); loadEnvFile(); }}>Обновить</button>
              <button className="btn" onClick={saveEnvFile} disabled={!envChanged}>Сохранить</button>
            </div>
          </div>
          {envError && <div style={{color:'#b00', fontSize:12, marginTop:6}}>Ошибка ENV: {envError}</div>}
          <textarea
            value={envText}
            onChange={e=>{ setEnvText(e.target.value); setEnvChanged(true) }}
            placeholder={`OPENAI_API_KEY=...
OPENAI_MODEL=gpt-5
SERVICE_BASE_URL=https://example.com
SERVICE_TOKEN=xxx`}
            style={{width:'100%', minHeight:160, marginTop:8, fontFamily:'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize:13, padding:10, border:'1px solid #ddd', borderRadius:10}}
          />
          <div style={{fontSize:12, color:'#666', marginTop:6}}>
            Подсказка: укажи *_BASE_URL и соответствующий *_TOKEN или *_API_KEY. По умолчанию модель — <b>gpt-5</b>. Текущий API_BASE: {API_BASE}
          </div>
        </div>

        <div ref={listRef} className="chat" style={{minHeight:360,maxHeight:520,overflow:'auto', padding:12, display:'flex', flexDirection:'column', gap:8}}>
          {messages.map((m,i)=>(
            <div key={i} style={{
              alignSelf: m.role==='user' ? 'flex-end' : 'flex-start',
              background: m.role==='user' ? '#000' : '#f3f4f6',
              color: m.role==='user' ? '#fff' : '#111',
              borderRadius:12, padding:'10px 12px', maxWidth:'75%',
              whiteSpace:'pre-wrap', wordBreak:'break-word'
            }}>{m.content}</div>
          ))}
        </div>

        {steps.length>0 && (
          <div style={{borderTop:'1px solid #efeff2', background:'#fafafa', borderRadius:'0 0 16px 16px', maxHeight:260, overflow:'auto', padding:10}}>
            <div style={{fontWeight:600, marginBottom:8}}>Выполненные шаги</div>
            <div style={{display:'grid', gap:8}}>
              {steps.map((s,i)=>(
                <div key={i} style={{fontSize:12, color:'#333', background:'#fff', border:'1px solid #eee', borderRadius:10, padding:8}}>
                  <div><b>{s.tool}</b> {s.ok?'✓':'✗'}</div>
                  {s.args && <div style={{color:'#666', fontSize:12, wordBreak:'break-all'}}>{JSON.stringify(s.args)}</div>}
                  {s.result && <pre style={{whiteSpace:'pre-wrap',wordBreak:'break-word',maxHeight:160,overflow:'auto'}}>{JSON.stringify(s.result,null,2)}</pre>}
                  {s.error && <div style={{color:'#b00'}}>{s.error}</div>}
                </div>
              ))}
            </div>
          </div>
        )}

        <div style={{padding:12, display:'flex', gap:8}}>
          <input className="input" placeholder="Сообщение…" value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>{ if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); send() } }} style={{flex:1}} />
          <button className="btn primary" disabled={sending} onClick={send}>{sending?'...':'Отправить'}</button>
        </div>
      </div>
    </div>
  )
}
