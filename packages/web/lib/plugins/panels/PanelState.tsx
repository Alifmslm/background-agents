"use client"

import { Loader2, RefreshCw } from "lucide-react"
import { cn } from "@/lib/utils"

/**
 * Non-content states a preview panel can be in. `ready` is rendered by the
 * panel itself; everything else is rendered by <PanelState>.
 */
export type PanelStatus = "loading" | "stopped" | "server-down" | "expired" | "error"

const DEFAULT_MESSAGE: Record<Exclude<PanelStatus, "loading">, string> = {
  stopped: "This sandbox is stopped.",
  "server-down": "The dev server isn't running.",
  expired: "This sandbox expired.",
  error: "Failed to load.",
}

/** What the refresh button promises, per state. */
const ACTION_TITLE: Record<Exclude<PanelStatus, "loading">, string> = {
  stopped: "Start sandbox",
  "server-down": "Start dev server",
  expired: "Refresh",
  error: "Refresh",
}

export interface PanelStateProps {
  status: PanelStatus
  /** Overrides the default message (and is the error text when status is "error"). */
  message?: string
  /**
   * Verbatim output shown under the message in a scrollable block — e.g. the
   * tail of a dev server's log when it failed to start. Kept separate from
   * `message` so the human-readable line stays readable.
   */
  detail?: string
  /**
   * When provided, renders a centered refresh button above the message.
   * Both the top-bar refresh and the in-panel retry funnel through this.
   */
  onRefresh?: () => void
}

/**
 * Shared presentation for every non-content panel state: a centered spinner
 * (loading) or a centered message with a refresh button above it
 * (stopped / server-down / expired / error). Used by all preview panels so the
 * non-content experience is identical everywhere.
 */
export function PanelState({ status, message, detail, onRefresh }: PanelStateProps) {
  if (status === "loading") {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {message && <span className="text-xs">{message}</span>}
      </div>
    )
  }

  const destructive = status === "error"
  const text = message ?? DEFAULT_MESSAGE[status]
  const actionTitle = ACTION_TITLE[status]

  return (
    <div
      className={cn(
        "h-full flex flex-col items-center justify-center gap-3 p-4 text-center text-sm",
        destructive ? "text-destructive" : "text-muted-foreground"
      )}
    >
      {onRefresh && (
        <button
          type="button"
          onClick={onRefresh}
          title={actionTitle}
          aria-label={actionTitle}
          className="flex h-9 w-9 items-center justify-center rounded-md text-foreground hover:bg-accent cursor-pointer"
        >
          <RefreshCw className="h-5 w-5" />
        </button>
      )}
      <div>{text}</div>
      {detail && (
        <pre className="max-h-48 w-full max-w-lg overflow-auto whitespace-pre-wrap rounded-md bg-muted p-2 text-left font-mono text-[11px] text-muted-foreground">
          {detail}
        </pre>
      )}
    </div>
  )
}
