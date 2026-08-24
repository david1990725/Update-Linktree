#!/bin/bash

# Change directory to the project folder
cd "/Users/mis-davidliao/Documents/Update Linktree" || exit 1

# Automatically detect Node.js path (supports NVM, Homebrew, and system installs)
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  source "$HOME/.nvm/nvm.sh"
elif [ -d "$HOME/.nvm/versions/node" ]; then
  NODE_DIR=$(ls -d "$HOME/.nvm/versions/node/"* 2>/dev/null | sort -V | tail -n1)
  export PATH="$NODE_DIR/bin:$PATH"
fi

# Ensure Node.js is available
if ! command -v node &> /dev/null; then
  echo "ERROR: Node.js not found. Please install Node.js or configure NVM." >> run.log
  exit 1
fi

# Write run log timestamp
echo "==================================================" >> run.log
echo "Job Triggered at $(date)" >> run.log
echo "Node.js: $(node --version) at $(which node)" >> run.log
echo "==================================================" >> run.log

# Run the main script and append logs
node index.js >> run.log 2>&1

echo "Job Finished with exit code $? at $(date)" >> run.log
echo "" >> run.log
