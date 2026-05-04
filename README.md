# AxonHub OpenClaw Plugin

AxonHub AI Gateway provider plugin for OpenClaw — Route requests to 100+ LLM providers through a unified API gateway.

## Features

- Dynamic model discovery from your AxonHub instance
- Custom base URL for self-hosted AxonHub deployments
- OpenAI-compatible API transport (`openai-completions`)
- xhigh / max reasoning support for capable model families
  (OpenAI gpt-5.x / o3 / o4-mini, Anthropic Claude opus-4.7 / sonnet-4.7,
  DeepSeek V4, Google Gemini 3.x); other reasoning models fall back to OpenClaw's
  built-in graceful effort downgrade so xhigh requests don't hit upstream 400s
- Forward-compat: if AxonHub later exposes per-model reasoning effort lists in
  `capabilities.reasoning_efforts` (or alias keys), the plugin reads them
  preferentially over the built-in family table
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
