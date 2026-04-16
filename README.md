# AxonHub OpenClaw Plugin

AxonHub AI Gateway provider plugin for OpenClaw.

## Features

- Route requests to 100+ LLM providers via OpenAI-compatible API
- Dynamic model resolution

## Installation

```bash
npm install @ruelya/axonhub-openclaw-plugin
```

## Configuration

In OpenClaw settings, configure the plugin with your AxonHub credentials:

| Setting | Description |
|---------|-------------|
| API Key | Your AxonHub API key |
| Base URL | AxonHub instance URL (default: `http://localhost:8090`) |


Publishing is automated via GitHub Actions. Push a version tag to trigger the workflow.

## License

MIT
