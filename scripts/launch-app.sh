#!/bin/bash
app_path="${1%/}"
project_dir="$(dirname "$app_path")"
cd "$project_dir" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
if [ -s "$HOME/.nvm/nvm.sh" ]; then source "$HOME/.nvm/nvm.sh"; fi
if ! command -v node >/dev/null; then echo '找不到 Node.js，請安裝 Node.js 後重試。'; exit 1; fi
if [ ! -f dashboard.js ] || [ ! -d node_modules ]; then echo '找不到程式或套件。請將 App 放在專案資料夾內，並先執行 npm install。'; exit 1; fi
mkdir -p data
url_file="data/dashboard-url"
open_existing() {
  [ -f "$url_file" ] || return 1
  local url token origin
  url="$(cat "$url_file")"
  token="${url##*#}"
  origin="${url%%/#*}"
  [[ "$origin" =~ ^http://127\.0\.0\.1:[0-9]+$ ]] || return 1
  [[ "$token" =~ ^[0-9a-f]{64}$ ]] || return 1
  curl --silent --fail --max-time 2 -H "X-Dashboard-Token: $token" "$origin/api/status" >/dev/null || return 1
  open "$url"
}
if open_existing; then exit 0; fi
DASHBOARD_NO_OPEN=true nohup "$(command -v node)" dashboard.js >> data/dashboard.log 2>&1 </dev/null &
server_pid=$!
for attempt in {1..50}; do
  if open_existing; then exit 0; fi
  if ! kill -0 "$server_pid" 2>/dev/null; then echo '無法啟動同步工具，請檢查 data/dashboard.log。'; exit 1; fi
  sleep 0.1
done
echo '同步工具啟動逾時，請檢查 data/dashboard.log。'
exit 1
