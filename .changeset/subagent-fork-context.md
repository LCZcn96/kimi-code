---
"@moonshot-ai/kimi-code": minor
---

Subagents can now fork the current context: the Agent tool accepts an optional `fork` parameter that starts the subagent with a snapshot of the calling agent's completed conversation history — same agent type, tool set, and model — instead of zero context. The model opts in per spawn with `fork: true` when a task builds on the current conversation.
