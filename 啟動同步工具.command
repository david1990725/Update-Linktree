#!/bin/bash
cd "$(dirname "$0")" || exit 1
if [ -s "$HOME/.nvm/nvm.sh" ]; then source "$HOME/.nvm/nvm.sh"; fi
if ! command -v node >/dev/null; then echo '找不到 Node.js，請先安裝 Node.js。'; read -r -p '按 Enter 結束'; exit 1; fi
node dashboard.js
