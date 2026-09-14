import { prisma } from "./prisma"
import type { DevServerRecipe } from "@/lib/dev-servers"

/**
 * Persistence for dev-server restart recipes.
 *
 * These live on `Chat.devServers` rather than inside the sandbox, because the
 * sandbox is the one thing guaranteed to go away: Daytona stops it after 5 idle
 * minutes and deletes it 4 days after that, while the chat carries on and gets a
 * freshly created sandbox. Keeping the recipes on the chat means a preview can
 * still be restarted in a sandbox that was replaced, not merely stopped.
 *
 * The routes address sandboxes, not chats, so every read and write here resolves
 * the chat by `sandboxId` first. A sandbox can also belong to a scheduled-job run
 * rather than a chat; those have no preview pane, so they simply store nothing.
 */

/** One stored entry. `port` is the map key, so it isn't repeated in the value. */
type StoredRecipe = {
  command: string
  cwd: string
  env: Record<string, string>
  chain: string
  /** Which sandbox this was observed in — may not be the current one. */
  sandboxId: string
  recordedAt: string
}

function isStoredRecipe(value: unknown): value is StoredRecipe {
  if (!value || typeof value !== "object") return false
  const candidate = value as Partial<StoredRecipe>
  return typeof candidate.command === "string" && typeof candidate.cwd === "string"
}

/** Resolve the chat that owns `sandboxId`, or null when a run owns it. */
async function findChatIdBySandbox(sandboxId: string): Promise<string | null> {
  const chat = await prisma.chat.findFirst({
    where: { sandboxId },
    select: { id: true },
    orderBy: { lastActiveAt: "desc" },
  })
  return chat?.id ?? null
}

/**
 * Every recipe recorded for the chat that owns `sandboxId`, keyed by port.
 * Returns an empty map when nothing is recorded or the column holds anything
 * unexpected — a bad row must degrade to "ask the agent", never throw.
 */
export async function readDevServers(
  sandboxId: string
): Promise<Map<number, DevServerRecipe>> {
  const chat = await prisma.chat.findFirst({
    where: { sandboxId },
    select: { devServers: true },
    orderBy: { lastActiveAt: "desc" },
  })

  const out = new Map<number, DevServerRecipe>()
  const stored = chat?.devServers
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return out

  for (const [portKey, value] of Object.entries(stored as Record<string, unknown>)) {
    const port = parseInt(portKey, 10)
    if (isNaN(port) || !isStoredRecipe(value)) continue
    out.set(port, {
      port,
      command: value.command,
      cwd: value.cwd,
      env: value.env ?? {},
      chain: value.chain ?? "",
    })
  }
  return out
}

/**
 * Merge freshly attributed recipes into the chat's stored map.
 *
 * Last observation wins: a port re-recorded after the agent changed how it starts
 * the server should describe how it is started *now*. Best-effort, like the
 * recording it follows — a write failure only costs a later restart.
 */
export async function saveDevServers(
  sandboxId: string,
  recipes: Map<number, DevServerRecipe>
): Promise<void> {
  if (recipes.size === 0) return
  try {
    const chatId = await findChatIdBySandbox(sandboxId)
    if (!chatId) return

    const existing = await readDevServers(sandboxId)
    const merged: Record<string, StoredRecipe> = {}
    const recordedAt = new Date().toISOString()

    for (const [port, recipe] of existing) {
      merged[String(port)] = {
        command: recipe.command,
        cwd: recipe.cwd,
        env: recipe.env,
        chain: recipe.chain,
        sandboxId,
        recordedAt,
      }
    }
    for (const [port, recipe] of recipes) {
      merged[String(port)] = {
        command: recipe.command,
        cwd: recipe.cwd,
        env: recipe.env,
        chain: recipe.chain,
        sandboxId,
        recordedAt,
      }
    }

    await prisma.chat.update({ where: { id: chatId }, data: { devServers: merged } })
  } catch (error) {
    console.warn("[dev-servers] Failed to persist dev servers:", error)
  }
}
