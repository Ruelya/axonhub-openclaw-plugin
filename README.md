# AxonHub OpenClaw Plugin

AxonHub AI Gateway provider plugin for OpenClaw — Route requests to 100+ LLM providers through a unified API gateway.

## Features

- Dynamic model discovery from your AxonHub instance
- Custom base URL for self-hosted AxonHub deployments
- Per-model protocol routing across OpenAI Responses / Chat Completions,
  Anthropic Messages, and Gemini APIs
- xhigh / max reasoning support for capable model families
  (OpenAI GPT-5.6, Anthropic Claude Fable 5 / Sonnet 5 / supported Claude 4.x,
  DeepSeek V4, and Google Gemini 3.x); earlier GPT-5.x / o3 / o4-mini models
  expose xhigh without max. Other reasoning models fall back to OpenClaw's
  built-in graceful effort downgrade so unsupported levels do not reach upstream
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

## Model synchronization

There are three distinct synchronization concerns. They operate independently
and should not be confused:

1. **AxonHub channel-model sync (server-side).** AxonHub itself can refresh the
   list of models each upstream channel supports about once an hour when a
   channel has `auto_sync_supported_models` enabled. This happens entirely
   inside your AxonHub instance; the plugin neither controls nor replaces it.

2. **Plugin instance-cache refresh (client-side).** The plugin caches the set of
   models your API key can currently see (`/v1/models`) with a bounded TTL
   (default one hour) and a credential-scoped cache. The cache is refreshed
   automatically on catalog access and is used by onboarding, catalog
   discovery, and dynamic model resolution. You can force a refresh and inspect
   the cache explicitly:

   ```bash
   # Force-refresh and print added / removed / changed model ids
   openclaw axonhub models sync

   # Report cache freshness, source URL, and model count
   openclaw axonhub models status

   # Machine-readable output; scope to an agent / auth profile
   openclaw axonhub models sync --json --agent <path> --profile <id>
   ```

   Output is deterministic and never prints your API key.

3. **Generated enrichment-metadata sync (release-time).** The plugin ships a
   small, deterministic metadata artifact (`model-metadata.generated.ts`) that
   maps model families to the correct AxonHub protocol endpoint
   (Gemini / Anthropic / OpenAI Responses / OpenAI Chat Completions) and to
   reasoning-effort hints. It is generated from a curated, reviewed source
   snapshot — never fetched at runtime — so releases stay reproducible.
   Maintainers regenerate it with:

   ```bash
   npm run sync:model-metadata     # regenerate from the curated source
   npm run check:model-metadata    # fail if regeneration would change output
   ```

   A scheduled GitHub workflow refreshes advisory reasoning hints from the
   pinned upstream catalog and opens a reviewable pull request only when the
   generated artifact actually changes.

## License

MIT
