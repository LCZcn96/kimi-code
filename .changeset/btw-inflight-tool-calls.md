---
"@moonshot-ai/kimi-code": patch
---

Fix side-question conversations started while the main agent is mid-task: tool calls still running on the main agent are now marked as unfinished in the side conversation instead of dangling, so the side agent no longer reports their results as lost.
