# Публикация SND Studio на Render (бесплатно, постоянный адрес)

Итог: сайт получает адрес вида `https://snd-studio.onrender.com`, работает без твоего ПК,
ИИ-запросы идут с американского сервера Render — значит блокировка Gemini «User location is not supported» не мешает.

Ограничения бесплатного тарифа:
- Сайт «засыпает» после 15 минут без посетителей. Первый заход будит его ~30–60 секунд.
- 512 МБ RAM, слабый CPU — генерация музыки может идти на пару секунд дольше, чем локально.
- 750 часов работы в месяц — для одного сайта с запасом.

---

## Шаг 1. GitHub (бесплатно, карта не нужна)

1. Открой https://github.com и войди (или зарегистрируйся).
2. Нажми **New repository**.
3. Имя: `snd-studio`. Тип: **Public**. Галочки README/gitignore/license — **не ставить**.
4. **Create repository**.
5. Пришли мне свой ник GitHub — я сделаю коммит и push. При первом push откроется окно
   входа в GitHub в браузере, просто подтверди.

## Шаг 2. Render

1. Открой https://render.com → **Get Started** → **GitHub** (вход через тот же аккаунт).
2. **New** → **Web Service** → выбери репозиторий `snd-studio` → **Connect**.
3. Render сам прочитает `render.yaml`. Проверь:
   - Runtime: **Node**
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Instance Type: **Free**
4. В разделе **Environment Variables** добавь:
   - Key: `GEMINI_API_KEY`
   - Value: ключ из файла `.env` (строка после `GEMINI_API_KEY=`)
5. **Create Web Service** и подожди 2–4 минуты, пока сборка закончится.

## Шаг 3. Проверка

- `https://<имя>.onrender.com/` — открывается SND Studio.
- `https://<имя>.onrender.com/api/health` — должно быть `{"ok":true,...}`.
- Сгенерируй трек в панели AI Music — должен прийти ответ.

---

## Если понадобится обновить сайт

Любой `git push` в ветку `main` → Render пересобирает сайт автоматически (~2 минуты).

## Что НЕ нужно

- VPN на твоём ПК для работы сайта.
- Держать ПК включённым.
- Платить: Render Free + Gemini Free Tier.
