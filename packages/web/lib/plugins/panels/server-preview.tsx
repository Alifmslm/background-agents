"use client"

import { Globe } from "lucide-react"
import type { PanelPlugin, PanelProps, PreviewItem } from "../types"
import { PanelState } from "./PanelState"
import { useSandboxResource, assertSandboxOk } from "@/lib/hooks/useSandboxResource"

/** Body of a successful /api/sandbox/state probe. See that route for the states. */
interface ServerStateResponse {
  state: "ready" | "server-down" | "starting" | "no-recipe" | "failed"
  /** Tail of the dev server's launch log, present when state is "failed". */
  log?: string
}

function ServerPreviewComponent({ item, scale = 1, sandboxId, explicitStart, onRefresh }: PanelProps) {
  const url = item.type === "server" ? item.url : ""
  const port = item.type === "server" ? item.port : null

  // Probe the sandbox before embedding the iframe, so a stopped/expired sandbox
  // shows the shared PanelState (with a refresh/start button) instead of a
  // broken iframe. Passing the port extends that to the process: a sandbox can
  // be running with the dev server long dead, which looks identical to the user
  // but is a different fix. On an explicit refresh the route also replays the
  // command recorded for this port, which is what makes yesterday's preview
  // come back without going through the agent.
  const { status, data, error } = useSandboxResource<ServerStateResponse>({
    sandboxId,
    explicitStart,
    deps: [url],
    load: async ({ autoStart, signal }) => {
      const res = await fetch("/api/sandbox/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sandboxId, autoStart, port }),
        signal,
      })
      await assertSandboxOk(res)
      return res.json()
    },
  })

  // Only gate on the probe when we have a sandbox to probe; otherwise fall back
  // to rendering the iframe best-effort (preserves prior behavior).
  if (sandboxId) {
    if (status === "loading") {
      // An explicit refresh may be booting the sandbox and replaying the dev
      // server command, which takes long enough to deserve saying so.
      return (
        <PanelState
          status="loading"
          message={explicitStart ? "Starting dev server…" : undefined}
        />
      )
    }
    if (status === "stopped") return <PanelState status="stopped" onRefresh={onRefresh} />
    if (status === "expired") return <PanelState status="expired" onRefresh={onRefresh} />
    if (status === "error") {
      return <PanelState status="error" message={error ?? undefined} onRefresh={onRefresh} />
    }

    if (data?.state === "server-down") {
      return <PanelState status="server-down" onRefresh={onRefresh} />
    }
    if (data?.state === "starting") {
      return (
        <PanelState
          status="server-down"
          message="The dev server is still starting. Give it a moment, then refresh."
          onRefresh={onRefresh}
        />
      )
    }
    if (data?.state === "no-recipe") {
      return (
        <PanelState
          status="server-down"
          message={
            `Nothing is listening on port ${port}, and this sandbox has no recorded ` +
            `command to start it. Ask the agent to start the dev server — it will be ` +
            `remembered for next time.`
          }
          onRefresh={onRefresh}
        />
      )
    }
    if (data?.state === "failed") {
      return (
        <PanelState
          status="error"
          message="The dev server failed to start."
          detail={data.log}
          onRefresh={onRefresh}
        />
      )
    }
  }

  // When scale < 1, we expand the iframe and use CSS transform to shrink it
  const iframeStyle: React.CSSProperties = scale < 1
    ? {
        width: `${100 / scale}%`,
        height: `${100 / scale}%`,
        transform: `scale(${scale})`,
        transformOrigin: "top left",
      }
    : {}

  return (
    <div className="h-full w-full overflow-hidden">
      <iframe
        src={url}
        className="border-0 bg-white"
        style={{
          width: "100%",
          height: "100%",
          ...iframeStyle,
        }}
        title="Live preview"
      />
    </div>
  )
}

export const ServerPreviewPlugin: PanelPlugin = {
  id: "server-preview",

  canHandle: (item: PreviewItem) => item.type === "server",

  getLabel: (item: PreviewItem) => {
    if (item.type === "server") {
      return `:${item.port}`
    }
    return "Preview"
  },

  getIcon: () => Globe,

  Component: ServerPreviewComponent,
}
