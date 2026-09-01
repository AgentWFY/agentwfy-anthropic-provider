# AgentWFY Anthropic Provider Plugin

Anthropic Messages API provider for [AgentWFY](https://agentwfy.com). Uses Claude Pro/Max subscription via OAuth with streaming, extended thinking, and cache control.

## Requirements

- [AgentWFY](https://agentwfy.com) desktop app
- Claude Pro or Max subscription

## Install

Open the Plugins view in AgentWFY, find "anthropic-provider" in the registry, and click Install.

## Features

- **OAuth login** — Authenticate with your Claude Pro/Max subscription. No API key needed.
- **Streaming** — Real-time streaming of model responses.
- **Extended thinking** — Adaptive thinking mode for complex reasoning.
- **Cache control** — Ephemeral cache breakpoints for token efficiency.
- **Image downscaling** — Caps images at 2000px per side, so screenshot-heavy sessions stay within Anthropic's limit for requests carrying more than 20 images.
- **Model selection** — Choose from Claude Fable 5, Opus 5, Opus 4.8, Opus 4.7, Sonnet 4.6, Opus 4.6, Sonnet 4.5, Opus 4.5, Sonnet 4, Opus 4, Haiku 4.5, Sonnet 3.7, and Haiku 3.5.
- **Effort control** — Tune reasoning depth via `low` / `medium` / `high` / `xhigh` / `max` (xhigh is Fable 5 / Opus 5 / 4.8 / 4.7 only).

## Settings

After installing, select "Anthropic" as your provider and open settings to:

1. **Log in** — Click "Log in with Claude", authorize in your browser, paste the code back.
2. **Pick a model** — Default is Claude Opus 5.
3. **Effort** — Default is `xhigh` on Fable 5 / Opus 5 / Opus 4.8 / Opus 4.7, `high` otherwise.
4. **Max output tokens** — Default 16384.
5. **Display options** — Optionally hide thinking messages or intermediate tool call steps.

## Build from source

```
node build.mjs
```

The package is written to `dist/anthropic-provider.plugins.awfy`.

## License

MIT
