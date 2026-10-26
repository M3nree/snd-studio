@echo off
chcp 65001 >nul
rem Запуск публичного доступа к SND Studio через Cloudflare Tunnel.
rem Требуется: сервер уже запущен (npm start) и cloudflared установлен.
rem Ссылка https://....trycloudflare.com появится в этом окне.
rem ВАЖНО: пока это окно открыто — сайт доступен другим. Закроешь — доступ пропадёт.

set "CF=C:\Program Files (x86)\cloudflared\cloudflared.exe"
if not exist "%CF%" set "CF=cloudflared"

echo Проверяю локальный сервер на порту 3000...
curl.exe -s -o nul --noproxy "*" --max-time 5 http://127.0.0.1:3000/api/health >nul
if errorlevel 1 (
  echo [ОШИБКА] Сервер не отвечает. Сначала запусти: npm start
  pause
  exit /b 1
)

echo Поднимаю туннель (HTTP/2)...
"%CF%" tunnel --url http://localhost:3000 --protocol http2 --no-autoupdate
pause
