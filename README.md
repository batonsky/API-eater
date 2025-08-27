# API Eater — clean start

## Как развернуть

1) Удали старые папки (по желанию):
```bash
rm -rf backend frontend
```

2) Распакуй архив в корень репозитория (там появятся `backend/` и `frontend/`).

3) Ставим зависимости и стартуем backend:
```bash
cd backend
cp -n .env.sample .env  # если .env ещё нет
# вставь свой OPENAI_API_KEY и, по желанию, поисковый ключ (SERPAPI или BING)
npm install
node index.js
# сервер: http://localhost:4001  (или 0.0.0.0:4001)
```

4) Ставим зависимости и стартуем frontend (в новом терминале):
```bash
cd ../frontend
npm install
npm run dev -- --host --port 3001
# UI: http://localhost:3001/
```

5) В UI заполни бокс ENV (ELMA365_BASE_URL, ELMA365_TOKEN и при желании SERPAPI/BING key).

6) В чате напиши: `создай элемент в приложении operacii в разделе beton elma365`.
Агент сам проверит ENV, поищет доку, соберёт запрос, при ошибке попробует исправить и сохранит скрипт.
