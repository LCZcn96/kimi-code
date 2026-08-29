import { useEffect, useMemo, useState } from "react";
import ScrollToBottom, { useScrollToBottom, useSticky } from "react-scroll-to-bottom";
import { IconArrowDown, IconArrowUp, IconList, IconX } from "@tabler/icons-react";
import { ChatMessage } from "./ChatMessage";
import { WelcomeScreen } from "./WelcomeScreen";
import { useChatStore } from "@/stores";
import { cn } from "@/lib/utils";
import { getPromptNavigationItems, type PromptNavigationItem } from "@/lib/prompt-navigation";
import { getConversationUndoCounts } from "@/lib/conversation-undo";
import { getForkTurnIndex } from "shared/fork-turn-index";

const findPromptAnchor = (id: string) => document.querySelector<HTMLElement>(`#${CSS.escape(`prompt-${id}`)}`);
const promptTimeFormatter = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const promptDateTimeFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

function ScrollButton() {
  const scrollToBottom = useScrollToBottom();
  const [sticky] = useSticky();

  if (sticky) return null;

  return (
    <button
      onClick={() => scrollToBottom()}
      className={cn("absolute bottom-4 right-4 p-2 rounded-full z-10", "bg-blue-400 text-white shadow-lg", "hover:bg-blue-600 transition-all")}
    >
      <IconArrowDown className="size-4" />
    </button>
  );
}

function PromptNavigator({ items }: { items: PromptNavigationItem[] }) {
  const [activeIndex, setActiveIndex] = useState(Math.max(0, items.length - 1));
  const [open, setOpen] = useState(false);
  const itemIds = items.map((item) => item.id).join("\n");

  useEffect(() => {
    const ids = itemIds ? itemIds.split("\n") : [];
    const scrollView = document.querySelector<HTMLElement>(".chat-scroll-view");
    if (!scrollView || ids.length < 2) return;

    let frame = 0;
    const syncActivePrompt = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const threshold = scrollView.getBoundingClientRect().top + Math.min(80, scrollView.clientHeight / 4);
        let nextIndex = 0;
        for (let index = 0; index < ids.length; index++) {
          const anchor = findPromptAnchor(ids[index]);
          if (anchor && anchor.getBoundingClientRect().top <= threshold) {
            nextIndex = index;
          } else if (anchor) {
            break;
          }
        }
        setActiveIndex((current) => current === nextIndex ? current : nextIndex);
      });
    };

    syncActivePrompt();
    scrollView.addEventListener("scroll", syncActivePrompt, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      scrollView.removeEventListener("scroll", syncActivePrompt);
    };
  }, [itemIds]);

  if (items.length < 2) return null;

  const navigateTo = (index: number) => {
    const item = items[index];
    if (!item) return;
    findPromptAnchor(item.id)?.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      block: "start",
    });
    setActiveIndex(index);
  };

  return (
    <>
      <nav
        aria-label="Prompt shortcuts"
        className="absolute left-0 top-1/2 -translate-y-1/2 z-20 flex max-h-[70%] flex-col gap-0.5 overflow-y-auto py-2"
      >
        {items.map((item, index) => (
          <button
            key={item.id}
            type="button"
            aria-label={`Go to prompt ${index + 1}: ${item.title}`}
            aria-current={index === activeIndex ? "location" : undefined}
            title={item.title}
            onClick={() => navigateTo(index)}
            className="group flex h-4 w-7 items-center cursor-pointer"
          >
            <span className={cn(
              "block h-0.5 rounded-r-full transition-all",
              index === activeIndex
                ? "w-5 bg-foreground"
                : "w-3 bg-muted-foreground/60 group-hover:w-5 group-hover:bg-foreground",
            )} />
          </button>
        ))}
      </nav>

      {!open ? (
        <button
          type="button"
          aria-label="Open prompt navigation"
          title="Prompt navigation"
          onClick={() => setOpen(true)}
          className="absolute right-14 bottom-4 z-20 flex h-8 items-center gap-1.5 rounded-full border border-border bg-popover px-2.5 text-xs text-muted-foreground shadow-lg hover:text-foreground cursor-pointer"
        >
          <IconList className="size-4" />
          <span>{items.length}</span>
        </button>
      ) : (
        <section
          aria-label="Prompt navigation"
          className="absolute bottom-4 left-1/2 z-30 flex max-h-[55%] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-border bg-popover shadow-2xl"
        >
          <div className="flex shrink-0 items-center gap-1 border-b border-border px-3 py-2">
            <div className="flex-1 text-xs font-semibold">Prompt navigation</div>
            <span className="mr-1 text-[10px] text-muted-foreground">{activeIndex + 1}/{items.length}</span>
            <button
              type="button"
              aria-label="Previous prompt"
              title="Previous prompt"
              disabled={activeIndex === 0}
              onClick={() => navigateTo(activeIndex - 1)}
              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30 cursor-pointer disabled:cursor-default"
            >
              <IconArrowUp className="size-4" />
            </button>
            <button
              type="button"
              aria-label="Next prompt"
              title="Next prompt"
              disabled={activeIndex === items.length - 1}
              onClick={() => navigateTo(activeIndex + 1)}
              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30 cursor-pointer disabled:cursor-default"
            >
              <IconArrowDown className="size-4" />
            </button>
            <button
              type="button"
              aria-label="Close prompt navigation"
              title="Close prompt navigation"
              onClick={() => setOpen(false)}
              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground cursor-pointer"
            >
              <IconX className="size-4" />
            </button>
          </div>
          <div className="overflow-y-auto p-1.5">
            {items.map((item, index) => (
              <button
                key={item.id}
                type="button"
                data-prompt-navigation-index={index}
                aria-label={`Go to prompt ${index + 1}: ${item.title}`}
                aria-current={index === activeIndex ? "location" : undefined}
                onClick={() => navigateTo(index)}
                className={cn(
                  "block w-full rounded-lg px-2.5 py-2 text-left hover:bg-muted cursor-pointer",
                  index === activeIndex && "bg-muted",
                )}
              >
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1 line-clamp-2 text-xs font-semibold leading-relaxed">{item.title}</div>
                  <time
                    dateTime={new Date(item.timestamp).toISOString()}
                    title={promptDateTimeFormatter.format(item.timestamp)}
                    className="shrink-0 pt-0.5 text-[10px] font-normal text-muted-foreground"
                  >
                    {promptTimeFormatter.format(item.timestamp)}
                  </time>
                </div>
                <div className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">
                  {item.preview || "No text response"}
                </div>
              </button>
            ))}
          </div>
        </section>
      )}
    </>
  );
}

function MessageList() {
  const messages = useChatStore((s) => s.messages);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const isUndoing = useChatStore((s) => s.isUndoing);
  const promptItems = useMemo(() => getPromptNavigationItems(messages), [messages]);
  const undoCounts = useMemo(() => getConversationUndoCounts(messages), [messages]);

  return (
    <>
      <div>
        {messages.map((message, idx) => {
          const promptId = message.role === "user" ? `prompt-${message.id}` : undefined;
          return (
            <div key={message.id} id={promptId} className={promptId ? "scroll-mt-3" : undefined}>
              <ChatMessage
                message={message}
                turnIndex={getForkTurnIndex(messages, idx)}
                isStreaming={isStreaming && idx === messages.length - 1 && message.role === "assistant"}
                undoCount={undoCounts.get(message.id)}
                conversationBusy={isStreaming || isUndoing}
              />
            </div>
          );
        })}
      </div>
      <PromptNavigator items={promptItems} />
      <ScrollButton />
    </>
  );
}

export function ChatArea() {
  const messageCount = useChatStore((s) => s.messages.length);

  if (messageCount === 0) {
    return (
      <div className="h-full flex items-center justify-center relative">
        <WelcomeScreen />
      </div>
    );
  }

  return (
    <div className="h-full relative">
      <ScrollToBottom className="h-full" scrollViewClassName="chat-scroll-view h-full overflow-y-auto overflow-x-hidden" followButtonClassName="hidden" initialScrollBehavior="auto">
        <MessageList />
      </ScrollToBottom>
    </div>
  );
}
