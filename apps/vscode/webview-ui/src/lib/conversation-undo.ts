import type { ChatMessage } from "@/stores/chat.store";
import { countSteers } from "shared/fork-turn-index";

/** Map each currently undoable user prompt to the SDK undo count it needs. */
export function getConversationUndoCounts(messages: readonly ChatMessage[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  const lastBoundary = messages.findLastIndex((message) => {
    if (
      message.role === "user"
      && message.forkable === false
      && typeof message.content === "string"
      && /^\/(?:clear|reset)(?:\s|$)/i.test(message.content.trim())
    ) {
      return true;
    }
    return message.steps?.some((step) =>
      step.items.some((item) => item.type === "compaction" && item.status === "completed"),
    ) ?? false;
  });

  let count = 0;
  for (let index = messages.length - 1; index > lastBoundary; index -= 1) {
    const message = messages[index];
    if (message.role === "assistant" && message.forkable !== false) {
      count += countSteers(message);
      continue;
    }
    if (message.role === "user" && message.forkable !== false) {
      counts.set(message.id, ++count);
    }
  }
  return counts;
}
