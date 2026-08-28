import type { ContentPart } from "shared/legacy-sdk";
import type { UIStreamEvent } from "shared/types";

const STREAM_FLUSH_INTERVAL_MS = 48;

type BufferedPart = Extract<ContentPart, { type: "text" | "think" }>;
type BufferedEvent = {
  type: "ContentPart";
  payload: BufferedPart;
  _sessionId?: string;
};

export type ScheduleStreamFlush = (callback: () => void) => () => void;

const scheduleStreamFlush: ScheduleStreamFlush = (callback) => {
  const timer = setTimeout(callback, STREAM_FLUSH_INTERVAL_MS);
  return () => clearTimeout(timer);
};

function getBufferedEvent(event: UIStreamEvent): BufferedEvent | null {
  if (event.type !== "ContentPart" || !("payload" in event)) {
    return null;
  }

  const payload = event.payload;
  if (!payload || typeof payload !== "object" || !("type" in payload)) {
    return null;
  }

  if (payload.type === "text" && "text" in payload && typeof payload.text === "string") {
    return event as BufferedEvent;
  }
  if (payload.type === "think" && "think" in payload && typeof payload.think === "string") {
    return event as BufferedEvent;
  }

  return null;
}

function canMerge(current: BufferedEvent, next: BufferedEvent): boolean {
  if (current._sessionId !== next._sessionId || current.payload.type !== next.payload.type) {
    return false;
  }

  return current.payload.type === "text"
    || current.payload.encrypted === (next.payload as Extract<BufferedPart, { type: "think" }>).encrypted;
}

function merge(current: BufferedEvent, next: BufferedEvent): BufferedEvent {
  if (current.payload.type === "text" && next.payload.type === "text") {
    return {
      ...current,
      payload: { type: "text", text: current.payload.text + next.payload.text },
    };
  }

  const currentThink = current.payload as Extract<BufferedPart, { type: "think" }>;
  const nextThink = next.payload as Extract<BufferedPart, { type: "think" }>;
  return {
    ...current,
    payload: {
      type: "think",
      think: currentThink.think + nextThink.think,
      ...(currentThink.encrypted === undefined ? {} : { encrypted: currentThink.encrypted }),
    },
  };
}

export function createStreamEventBuffer(
  emit: (event: UIStreamEvent) => void,
  schedule: ScheduleStreamFlush = scheduleStreamFlush,
) {
  let pending: BufferedEvent | null = null;
  let cancelScheduledFlush: (() => void) | null = null;

  const flush = () => {
    const event = pending;
    pending = null;

    if (cancelScheduledFlush) {
      const cancel = cancelScheduledFlush;
      cancelScheduledFlush = null;
      cancel();
    }

    if (event) {
      emit(event as UIStreamEvent);
    }
  };

  const schedulePendingFlush = () => {
    if (cancelScheduledFlush) {
      return;
    }
    cancelScheduledFlush = schedule(() => {
      cancelScheduledFlush = null;
      flush();
    });
  };

  return {
    push(event: UIStreamEvent) {
      const bufferedEvent = getBufferedEvent(event);
      if (!bufferedEvent) {
        flush();
        emit(event);
        return;
      }

      if (pending && !canMerge(pending, bufferedEvent)) {
        flush();
      }
      pending = pending ? merge(pending, bufferedEvent) : bufferedEvent;
      schedulePendingFlush();
    },
    flush,
    dispose() {
      flush();
    },
  };
}
