/**
 * `subagent` domain — fork seed preparation.
 *
 * Pure helpers backing the Agent tool's `fork` mode: cutting the calling
 * agent's history down to the closed prefix that can seed a forked subagent's
 * context memory. A fork happens mid-turn, while the parent's trailing
 * assistant message still carries the unanswered Agent tool call — seeding
 * that open exchange would leave the child replaying a tool call that can
 * never close.
 */

import type { ContextMessage } from '#/agent/contextMemory/types';

export function trimTrailingOpenToolExchange(
  history: readonly ContextMessage[],
): ContextMessage[] {
  let lastNonToolIndex = history.length - 1;
  while (lastNonToolIndex >= 0 && history[lastNonToolIndex]?.role === 'tool') {
    lastNonToolIndex -= 1;
  }

  const assistant = history[lastNonToolIndex];
  if (assistant === undefined) return [];
  if (assistant.role !== 'assistant' || assistant.toolCalls.length === 0) return [...history];

  const trailingToolCallIds = new Set(
    history
      .slice(lastNonToolIndex + 1)
      .map((message) => message.toolCallId)
      .filter((toolCallId): toolCallId is string => typeof toolCallId === 'string'),
  );
  const closed = assistant.toolCalls.every((toolCall) => trailingToolCallIds.has(toolCall.id));
  return closed ? [...history] : history.slice(0, lastNonToolIndex);
}
