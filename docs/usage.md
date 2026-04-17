# plugin.anthropic-provider

Anthropic Messages API provider for AgentWFY. Uses Claude Pro/Max subscription via OAuth with streaming, extended thinking, and cache control.

## Authentication

Uses OAuth 2.0 with PKCE to authenticate with your Claude Pro or Max subscription. Open the provider settings view to log in — no API key required.

## Configuration

All settings are accessible from the provider settings view:

- **Model** — Select a Claude model (default: `claude-opus-4-7`). Available models: Opus 4.7, Sonnet 4.6, Opus 4.6, Sonnet 4.5, Opus 4.5, Sonnet 4, Opus 4, Haiku 4.5, Sonnet 3.7, Haiku 3.5.
- **Effort** — Controls reasoning depth and token spend on supported models (Opus 4.7, Opus 4.6, Sonnet 4.6, Opus 4.5). Values: `low`, `medium`, `high`, `xhigh` (Opus 4.7 only), `max`. Default: `xhigh` for Opus 4.7, `high` otherwise.
- **Max Output Tokens** — Maximum tokens the model can generate per response (default: 16384).
- **Hide Thinking** — Hide Claude's thinking/reasoning messages from the chat.
- **Hide Intermediate Steps** — Show only the final assistant response, hiding intermediate tool calls.

## Features

- **Streaming** — Real-time streaming of model responses via SSE.
- **Extended Thinking** — Adaptive thinking mode for complex reasoning tasks.
- **Cache Control** — Ephemeral cache breakpoints on the latest user message for token efficiency.
- **Token Display** — Input token count shown in the status line.
- **Auto Token Refresh** — OAuth tokens are refreshed automatically before expiry.
