#!/bin/sh
# Все автоматические проверки. Нужен запущенный docker compose.
# Использование: sh tools/check.sh [http://localhost:5173]
set -e
cd "$(dirname "$0")/.."
BASE=${1:-http://localhost:5173}
python3 tools/smoke.py "$BASE"
python3 tools/test_api.py "$BASE"
docker compose exec -T frontend npm test
