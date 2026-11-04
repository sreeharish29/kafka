# kafka
npx -y @leeroy/mcp-superassistant-proxy@latest --config ./config.json --outputTransport http
uvicorn api.main:app --reload --host 0.0.0.0 --port 8000
