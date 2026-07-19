"use client";

import { useTerminal } from "@/lib/store";
import type { ToastKind } from "@/lib/store";

const STYLE: Record<ToastKind, { border: string; dot: string }> = {
  error: { border: "border-down/50", dot: "bg-down" },
  success: { border: "border-up/50", dot: "bg-up" },
  info: { border: "border-accent/50", dot: "bg-accent" },
};

/** Transaction acks and failures, bottom-right. Click to dismiss. */
export default function Toasts() {
  const toasts = useTerminal((s) => s.toasts);
  const dismiss = useTerminal((s) => s.dismissToast);

  if (toasts.length === 0) return null;

  return (
    <div className="pointer-events-none fixed bottom-3 right-3 z-50 flex w-72 flex-col gap-2">
      {toasts.map((t) => (
        <button
          key={t.id}
          data-testid={`toast-${t.kind}`}
          onClick={() => dismiss(t.id)}
          className={`pointer-events-auto flex items-start gap-2 rounded-xl border ${STYLE[t.kind].border} bg-panel px-3 py-2.5 text-left shadow-card transition-all hover:opacity-80`}
        >
          <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${STYLE[t.kind].dot}`} />
          <span className="text-xs leading-relaxed text-ink">{t.text}</span>
        </button>
      ))}
    </div>
  );
}
