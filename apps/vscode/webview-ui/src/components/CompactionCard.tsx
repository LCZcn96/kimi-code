import { IconLoader2 } from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import type { CompactionStatus } from "@/stores/chat.store";

export function CompactionCard({ status }: { status: CompactionStatus }) {
  const running = status === "running";
  const label = status === "completed"
    ? "Context compacted"
    : status === "cancelled"
      ? "Compaction stopped"
      : status === "blocked"
        ? "Compaction blocked"
        : status === "interrupted"
          ? "Compaction interrupted"
          : "Compacting context…";
  const dot = status === "completed"
    ? "bg-emerald-500"
    : status === "blocked"
      ? "bg-amber-500"
      : "bg-zinc-400";

  return (
    <div className="rounded-lg border border-border bg-muted/20 overflow-hidden">
      <div className="flex items-center gap-3 px-3 py-2.5">
        {running ? (
          <IconLoader2 className="size-4 text-blue-500 animate-spin" />
        ) : (
          <div className="size-4 flex items-center justify-center">
            <div className={cn("size-2 rounded-full", dot)} />
          </div>
        )}
        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium text-foreground">{label}</div>
        </div>
      </div>
    </div>
  );
}
