# OpenCode Kiro Auth Plugin

OpenCode plugin for AWS Kiro (CodeWhisperer) providing access to the latest Claude 3.5/4.5 models with substantial trial quotas.

## Features

- AWS Builder ID (IDC) authentication with seamless device code flow.
- Intelligent multi-account rotation prioritized by lowest usage.
- Automated token refresh and rate limit handling with exponential backoff.
- Native thinking mode support via virtual model mappings.
- Decoupled storage for credentials and real-time usage metadata.

## Installation

Add the plugin to your `opencode.json` or `opencode.jsonc`:

```json
{
  "plugin": ["@zhafron/opencode-kiro-auth"],
  "provider": {
    "kiro": {
      "models": {
        "claude-opus-4-5": {
          "name": "Claude Opus 4.5",
          "limit": { "context": 200000, "output": 64000 },
          "modalities": { "input": ["text", "image"], "output": ["text"] }
        },
        "claude-opus-4-5-thinking": {
          "name": "Claude Opus 4.5 Thinking",
          "limit": { "context": 200000, "output": 64000 },
          "modalities": { "input": ["text", "image"], "output": ["text"] },
          "variants": {
            "low": { "thinkingConfig": { "thinkingBudget": 8192 } },
            "medium": { "thinkingConfig": { "thinkingBudget": 16384 } },
            "max": { "thinkingConfig": { "thinkingBudget": 32768 } }
          }
        },
        "claude-sonnet-4-5": {
          "name": "Claude Sonnet 4.5",
          "limit": { "context": 200000, "output": 64000 },
          "modalities": { "input": ["text", "image"], "output": ["text"] }
        },
        "claude-sonnet-4-5-thinking": {
          "name": "Claude Sonnet 4.5 Thinking",
          "limit": { "context": 200000, "output": 64000 },
          "modalities": { "input": ["text", "image"], "output": ["text"] },
          "variants": {
            "low": { "thinkingConfig": { "thinkingBudget": 8192 } },
            "medium": { "thinkingConfig": { "thinkingBudget": 16384 } },
            "max": { "thinkingConfig": { "thinkingBudget": 32768 } }
          }
        },
        "claude-haiku-4-5": {
          "name": "Claude Haiku 4.5",
          "limit": { "context": 200000, "output": 64000 },
          "modalities": { "input": ["text", "image"], "output": ["text"] }
        }
      }
    }
  }
}
```

## Setup

1. Run `opencode auth login`.
2. Select `Other`, type `kiro`, and press enter.
3. Follow the terminal instructions to complete the AWS Builder ID authentication.
4. Configuration template will be automatically created at `~/.config/opencode/kiro.json` on first load.

## Storage

- Credentials: `~/.config/opencode/kiro-accounts.json`
- Usage Tracking: `~/.config/opencode/kiro-usage.json`
- Plugin Config: `~/.config/opencode/kiro.json`

## Acknowledgements

Special thanks to [AIClient-2-API](https://github.com/justlovemaki/AIClient-2-API) for providing the foundational Kiro authentication logic and request patterns.

## Disclaimer

This plugin is provided strictly for learning and educational purposes. It is an independent implementation and is not affiliated with, endorsed by, or supported by Amazon Web Services (AWS) or Anthropic. Use of this plugin is at your own risk.

Feel free to open a PR to optimize this plugin further.
