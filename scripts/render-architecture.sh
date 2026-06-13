#!/usr/bin/env bash
# Render spica-cli architecture diagrams
# Requires: mmdc (npm i -g @mermaid-js/mermaid-cli)
# Requires: google-chrome-stable or chromium

set -euo pipefail
cd "$(dirname "$0")/.."

PUPPETEER_CONFIG=""
if [[ -f ".puppeteer-config.json" ]]; then
  PUPPETEER_CONFIG="-p .puppeteer-config.json"
fi

echo "Rendering English architecture diagram (detailed)..."
mmdc -i docs/architecture.mermaid -o docs/architecture.png \
  -w 2400 -H 3600 -b white -s 2 $PUPPETEER_CONFIG

echo "Rendering Chinese architecture diagram (detailed)..."
mmdc -i docs/architecture_cn.mermaid -o docs/architecture_cn.png \
  -w 2400 -H 3600 -b white -s 2 $PUPPETEER_CONFIG

echo "Rendering simplified architecture diagram..."
mmdc -i docs/architecture-simplified.mermaid -o docs/architecture-simplified.png \
  -w 1800 -H 2000 -b white -s 2 $PUPPETEER_CONFIG

echo "Done. Output files:"
echo "  docs/architecture.png"
echo "  docs/architecture_cn.png"
echo "  docs/architecture-simplified.png"
ls -lh docs/architecture.png docs/architecture_cn.png docs/architecture-simplified.png
