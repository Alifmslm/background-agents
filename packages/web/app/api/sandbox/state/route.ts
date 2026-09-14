import { Daytona } from "@daytonaio/sdk"
import { ensureSandboxStarted } from "@/lib/sandbox"
import { getSandboxOrExpired, passiveReadGate } from "@/lib/sandbox-lifecycle"
import { checkPort, restoreDevServer } from "@/lib/dev-servers"
import { badRequest, serverConfigError, requireSandboxOwner } from "@/lib/db/api-helpers"

// maxDuration configures the timeout for this Vercel function. Restoring a
// dev server boots the sandbox and then waits for the port to come up, so
// this needs more headroom than a plain lifecycle probe.
export const maxDuration = 60

/**
 * POST /api/sandbox/state
 *
 * Lifecycle probe for panels that need to know whether a sandbox is usable
 * before rendering (e.g. the server/web preview, which otherwise embeds a
 * broken iframe against a stopped sandbox).
 *
 * With a `port`, the probe also answers the question a running sandbox alone
 * cannot: is the dev server itself back? Stopping a sandbox kills every process
 * but keeps the disk, so a booted sandbox routinely has nothing listening. When
 * the caller is explicit (`autoStart`, i.e. the user pressed refresh) we replay
 * the command recorded for that port while it was last running.
 *
 * Body: { sandboxId: string, autoStart?: boolean, port?: number }
 * Responses:
 *   200 { state: "ready" }                 — sandbox up, and port listening if asked
 *   200 { state: "server-down" }           — sandbox up, port dead, caller passive
 *   200 { state: "starting" }              — relaunched, alive, not listening yet
 *   200 { state: "loopback-only" }         — listening on 127.0.0.1; the proxy can't reach it
 *   200 { state: "no-recipe" }             — port dead and we never recorded how to start it
 *   200 { state: "failed", log }           — replayed the command; it did not listen
 *   409 stopped · 410 expired
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as {
    sandboxId?: string
    autoStart?: boolean
    port?: number
  } | null

  if (!body?.sandboxId) return badRequest("Missing sandboxId")

  const owner = await requireSandboxOwner(body.sandboxId)
  if (owner instanceof Response) return owner

  const daytonaApiKey = process.env.DAYTONA_API_KEY
  if (!daytonaApiKey) return serverConfigError("DAYTONA_API_KEY")

  const daytona = new Daytona({ apiKey: daytonaApiKey })
  const sandbox = await getSandboxOrExpired(daytona, body.sandboxId)
  if (sandbox instanceof Response) return sandbox

  // Passive by default — a stopped sandbox is only booted on explicit refresh.
  const halt = passiveReadGate(sandbox, body.autoStart)
  if (halt) return halt

  await ensureSandboxStarted(sandbox)

  const port = typeof body.port === "number" ? body.port : null
  if (port === null) return Response.json({ state: "ready" })

  const status = await checkPort(sandbox, port)
  if (status === "ready") return Response.json({ state: "ready" })
  // Listening, but on 127.0.0.1 only. Restarting it would just reproduce the
  // same bind, so say what's wrong instead of replaying.
  if (status === "loopback-only") return Response.json({ state: "loopback-only" })

  // The port is dead. Only an explicit user action may start processes; a
  // background poll just reports it so the panel can offer the button.
  if (!body.autoStart) return Response.json({ state: "server-down" })

  return Response.json(await restoreDevServer(sandbox, port))
}
