# AxonHub OpenClaw Plugin

AxonHub AI Gateway provider plugin for OpenClaw — Route requests to 100+ LLM providers through a unified API gateway.

## Features

- Dynamic model discovery from your AxonHub instance
- Custom base URL for self-hosted AxonHub deployments
- OpenAI-compatible API transport (`openai-completions`)
- xhigh reasoning support for capable models (gpt-5.x, o3, o4-mini)
- Automatic model metadata: context window, pricing, capabilities

## Installation

```bash
openclaw plugins install @ruelya/axonhub-openclaw-plugin
```

Or explicitly from ClawHub:

```bash
openclaw plugins install clawhub:@ruelya/axonhub-openclaw-plugin
```

Restart the gateway after installing.

## Setup

Run onboarding to configure AxonHub:

```bash
openclaw onboard --axonhub-api-key <your-api-key>
```

## Configuration

| Setting | Description |
|---------|-------------|
| API Key | Your AxonHub API key |
| Base URL | AxonHub instance URL (default: `http://localhost:8090`) |

## License

MIT
