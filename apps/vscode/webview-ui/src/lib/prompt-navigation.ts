import { Content } from "./content";
import type { ChatMessage } from "@/stores/chat.store";

export interface PromptNavigationItem {
  id: string;
  title: string;
  preview: string;
}

const promptTitleCache = new WeakMap<ChatMessage, string>();

function compactNavigationText(text: string): string {
  return text.replaceAll(/\s+/g, " ").trim().slice(0, 320);
}

function getPromptTitle(message: ChatMessage): string {
  const cached = promptTitleCache.get(message);
  if (cached) return cached;
  const title = compactNavigationText(Content.getText(message.content)) || "Media prompt";
  promptTitleCache.set(message, title);
  return title;
}

function contentPrefix(message: ChatMessage): string {
  if (typeof message.content === "string") {
    return message.content.slice(0, 400);
  }

  let text = "";
  for (const part of message.content) {
    if (part.type === "text") {
      text += `${text ? " " : ""}${part.text}`;
      if (text.length >= 400) break;
    }
  }
  return text.slice(0, 400);
}

export function getPromptNavigationItems(messages: ChatMessage[]): PromptNavigationItem[] {
  const items: PromptNavigationItem[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      items.push({ id: message.id, title: getPromptTitle(message), preview: "" });
    } else if (items.length > 0 && !items.at(-1)!.preview) {
      items.at(-1)!.preview = compactNavigationText(contentPrefix(message));
    }
  }
  return items;
}
