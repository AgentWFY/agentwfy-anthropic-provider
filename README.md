# AgentWFY Anthropic Provider Plugin

Anthropic Messages API provider for [AgentWFY](https://agentwfy.com). Uses Claude Pro/Max subscription via OAuth with streaming, extended thinking, and cache control.

## Requirements

- [AgentWFY](https://agentwfy.com) desktop app
- Claude Pro or Max subscription

## Install

Download the latest `anthropic-provider.plugins.awfy` from [Releases](https://github.com/AgentWFY/anthropic-provider-plugin/releases), then install it via the AgentWFY command palette or the Plugins view.

## Features

- **OAuth login** — Authenticate with your Claude Pro/Max subscription. No API key needed.
- **Streaming** — Real-time streaming of model responses.
- **Extended thinking** — Adaptive thinking mode for complex reasoning.
- **Cache control** — Ephemeral cache breakpoints for token efficiency.
- **Model selection** — Choose from Claude Sonnet 4.6, Opus 4.6, Sonnet 4.5, Opus 4.5, Sonnet 4, Opus 4, Haiku 4.5, Sonnet 3.7, and Haiku 3.5.

## Settings

After installing, select "Anthropic" as your provider and open settings to:

1. **Log in** — Click "Log in with Claude", authorize in your browser, paste the code back.
2. **Pick a model** — Default is Claude Sonnet 4.6.
3. **Max output tokens** — Default 16384.
4. **Display options** — Optionally hide thinking messages or intermediate tool call steps.

## Build from source

```
node build.mjs
```

The package is written to `dist/anthropic-provider.plugins.awfy`.

## License

MIT
