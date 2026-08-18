---
"@moonshot-ai/kimi-code": minor
---

Subagents can now fork the current context: the Agent tool accepts an optional `fork` parameter that starts the subagent with a snapshot of the calling agent's conversation history — same agent type, tool set, and model — instead of zero context. Tool calls still in flight at fork time are carried over explicitly marked as unfinished. The model opts in per spawn with `fork: true` when a task builds on the current conversation.
