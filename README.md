# Kimicord

A Discord bot that bridges Discord threads to [Kimi CLI](https://www.moonshot.cn/) sessions via Wire mode.

## Features

- **Channel mode** — respond to @mentions or all messages in configured channels
- **Forum mode** — auto-reply to new forum posts
- **Slash commands** — `/new`, `/stop`, `/status`, `/workdir`, `/sessions`, `/compact`, `/clear`, `/yolo`, `/plan`, `/add-dir`, `/export`, `/init`
- **Dashboard** — lightweight HTTP dashboard for live session stats
- **MCP support** — auto-detects `/app/data/mcp.json` and passes it to `kimi`

## Quick start

1. Copy the example environment file and fill in your values:
   ```bash
   cp .env.example .env
   ```

2. Build and run with Docker Compose:
   ```bash
   docker compose up --build -d
   ```

3. Log in to Kimi CLI inside the container:
   ```bash
   docker compose exec bot bash
   kimi login
   ```

4. Create `/root/.kimi/config.toml` with your model:
   ```toml
   model = "kimi-k2.5"
   ```

5. Restart the bot if needed:
   ```bash
   docker compose restart
   ```

## Environment variables

See `.env.example` for all available options and defaults.

## License

MIT
