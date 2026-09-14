import type { Sandbox } from "@daytonaio/sdk"
import { quote } from "@background-agents/sdk"
import { PATHS } from "@background-agents/common"

/**
 * Dev-server recording and restore.
 *
 * A stopped sandbox keeps its filesystem but loses every running process, so a
 * preview the user opened yesterday points at a port nothing is listening on.
 * Booting the sandbox is not enough — something has to re-run the dev server,
 * and today that means asking the agent.
 *
 * So: while a server IS running we record how to start it again, into a file in
 * the sandbox (the one thing that survives a stop). On an explicit refresh we
 * replay that recipe. Recording is driven by the `list-servers` poll the preview
 * pane already runs, so it costs one extra round trip the first time a port
 * appears and nothing afterwards.
 *
 * Everything here reads `/proc` directly. `ss`, `netstat` and `lsof` are NOT
 * installed in the sandbox image — a previous `ss`-based port scan silently
 * returned nothing for exactly that reason (see the `list-servers` action).
 */

/** Recorded recipes, one per port. Survives sandbox stop/start with the disk. */
const RECORD_FILE = `${PATHS.SANDBOX_HOME}/.dev-servers.tsv`
/** Per-port launch logs, so a failed restore can say why. */
const LOG_DIR = `${PATHS.SANDBOX_HOME}/.dev-server-logs`

/** Separates the socket tables from the recorded recipes in one round trip. */
const RECORDED_MARKER = "===RECORDED==="

/** Only ports in this range are treated as dev servers (matches list-servers). */
const MIN_PORT = 3000
const MAX_PORT = 9999

/** Env vars worth restoring. Deliberately narrow — the rest is either inherited
 *  from the login shell or a secret that has no business in a plaintext file. */
const ENV_ALLOWLIST = ["PORT", "HOST"] as const

/** How long a restored server gets to start listening before we give up. */
const START_TIMEOUT_SECONDS = 25

/** A listening socket found in /proc/net/tcp, before it has been attributed. */
export interface ListeningSocket {
  port: number
  /** Socket inode — the key that maps the port back to the owning process. */
  inode: string
}

/** Everything needed to start a dev server again. */
export interface DevServerRecipe {
  port: number
  command: string
  cwd: string
  env: Record<string, string>
  /** The process ancestry the command was chosen from, for debugging misses. */
  chain: string
}

export type RestoreResult =
  | { state: "ready" }
  /** Relaunched and the process is alive, but it hasn't bound the port yet. */
  | { state: "starting" }
  /** Listening, but only on 127.0.0.1 — the preview proxy cannot reach it. */
  | { state: "loopback-only" }
  | { state: "no-recipe" }
  | { state: "failed"; log: string }

// =============================================================================
// Listing + parsing
// =============================================================================

/**
 * One command that answers both "what is listening?" and "what do we already
 * know how to restart?", so the 5s poll stays a single round trip.
 */
export const LIST_SERVERS_COMMAND =
  `cat /proc/net/tcp /proc/net/tcp6 2>/dev/null; ` +
  `echo ${quote(RECORDED_MARKER)}; ` +
  `cat ${quote(RECORD_FILE)} 2>/dev/null || true`

/**
 * Parse the LISTEN rows of /proc/net/tcp[6].
 *
 * Columns are `sl local_address rem_address st tx:rx tr:tm retrnsmt uid timeout
 * inode ...`. `st === "0A"` is TCP_LISTEN, `local_address` is "HEXIP:HEXPORT",
 * and the inode at index 9 is what maps the socket back to its owning process.
 */
export function parseListeningSockets(procNetTcp: string): ListeningSocket[] {
  const byPort = new Map<number, ListeningSocket>()
  for (const line of procNetTcp.split("\n")) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 10 || cols[0] === "sl") continue
    if (cols[3] !== "0A") continue
    const port = parseInt(cols[1].split(":")[1], 16)
    if (isNaN(port) || port < MIN_PORT || port > MAX_PORT) continue
    // A server bound on both IPv4 and IPv6 shows up twice; either inode works.
    if (!byPort.has(port)) byPort.set(port, { port, inode: cols[9] })
  }
  return [...byPort.values()].sort((a, b) => a.port - b.port)
}

/**
 * Put back the `--` separator npm strips from its own argv.
 *
 * `npm run dev -- --host 0.0.0.0` shows up in /proc/<pid>/cmdline as
 * `npm run dev --host 0.0.0.0`: npm rewrites argv and drops the separator.
 * Replaying that verbatim hands `--host` to npm instead of to the script, so a
 * Vite server comes back bound to 127.0.0.1 and the preview proxy 404s — a
 * silent wrong result, since something *is* listening on the port.
 *
 * Only npm needs this; yarn, pnpm and bun forward trailing args without a
 * separator. An argument that npm itself would own (`--silent`) is rare next to
 * script flags, and misplacing one only passes an extra arg to the script.
 */
export function restoreArgSeparator(command: string): string {
  // The negative lookahead keeps this idempotent: a separator that survived
  // must not gain a second one.
  const match = /^(npm\s+run(?:-script)?\s+[^\s-]\S*)\s+(?!--(?:\s|$))(-.*)$/.exec(command.trim())
  return match ? `${match[1]} -- ${match[2]}` : command
}

/** Parse the TSV written by {@link buildRecordCommand}. */
export function parseRecipes(tsv: string): Map<number, DevServerRecipe> {
  const out = new Map<number, DevServerRecipe>()
  for (const line of tsv.split("\n")) {
    if (!line.trim()) continue
    const [portStr, cwd, cmdB64, envB64, chainB64] = line.split("\t")
    const port = parseInt(portStr, 10)
    if (isNaN(port)) continue
    const command = decodeBase64(cmdB64)
    if (!command) continue
    out.set(port, {
      port,
      command: restoreArgSeparator(command),
      cwd: cwd || PATHS.PROJECT_DIR,
      env: parseEnvPairs(decodeBase64(envB64)),
      chain: decodeBase64(chainB64),
    })
  }
  return out
}

/** Split the combined {@link LIST_SERVERS_COMMAND} output on the marker. */
export function splitListOutput(raw: string): {
  sockets: ListeningSocket[]
  recipes: Map<number, DevServerRecipe>
} {
  const idx = raw.indexOf(RECORDED_MARKER)
  const tcp = idx === -1 ? raw : raw.slice(0, idx)
  const tsv = idx === -1 ? "" : raw.slice(idx + RECORDED_MARKER.length)
  return { sockets: parseListeningSockets(tcp), recipes: parseRecipes(tsv) }
}

function decodeBase64(value: string | undefined): string {
  if (!value) return ""
  try {
    return Buffer.from(value.trim(), "base64").toString("utf8").trim()
  } catch {
    return ""
  }
}

function parseEnvPairs(raw: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const pair of raw.split(/\s+/)) {
    const eq = pair.indexOf("=")
    if (eq <= 0) continue
    const key = pair.slice(0, eq)
    if (!(ENV_ALLOWLIST as readonly string[]).includes(key)) continue
    env[key] = pair.slice(eq + 1)
  }
  return env
}

// =============================================================================
// Recording
// =============================================================================

/**
 * Shell script that attributes each `port:inode` pair to a restartable command
 * and appends it to {@link RECORD_FILE}. Ports already recorded are skipped, so
 * this is a no-op once a server has been seen.
 *
 * Attribution walks UP from the process holding the socket: the listener itself
 * is usually something like `next-server (v15)`, which nothing can re-run. The
 * highest ancestor that still looks like a real command is the one to record —
 * whether the agent used `nohup`, backgrounded the server in its own tool shell,
 * or the user started it from the terminal panel. The walk stops at init, at a
 * bare interactive shell, and at an agent CLI, none of which are restartable.
 *
 * POSIX sh only: the sandbox runs this through `sh`, which may be dash.
 */
export function buildRecordCommand(sockets: ListeningSocket[]): string {
  const pairs = sockets.map((s) => `${s.port}:${s.inode}`).join(" ")
  const envPattern = `^(${ENV_ALLOWLIST.join("|")})=`
  return [
    `set -u`,
    `REC=${quote(RECORD_FILE)}`,
    `touch "$REC" 2>/dev/null || exit 0`,
    // Commands we must never record: re-running them would restart the agent or
    // a login shell, not the dev server. An absurdly long command line is also
    // rejected — that shape is an agent tool shell, not a server launcher.
    `is_unusable() {`,
    `  u=$1`,
    `  [ -n "$u" ] || return 0`,
    `  [ \${#u} -le 512 ] || return 0`,
    `  case "$u" in`,
    `    bash|-bash|sh|-sh|/bin/bash|/bin/sh|/usr/bin/bash|/usr/bin/sh) return 0 ;;`,
    `    "bash -l"|"bash -i"|"bash -li"|"bash --login"|"sh -l"|"sh -i") return 0 ;;`,
    `  esac`,
    `  case "$u" in`,
    `    *claude-code*|*opencode*|*openai/codex*|*gemini-cli*|*kimi-code*) return 0 ;;`,
    `    *github/copilot*|*kilocode*|*pi-coding-agent*|*/droid*|*/goose*) return 0 ;;`,
    `    */opt/pty-server*|*sandbox-jobs*) return 0 ;;`,
    `  esac`,
    // A shell operator in the cmdline means this ancestor is the LAUNCHER that
    // backgrounded and redirected the server (`sh -c 'cd x && nohup npm run dev
    // > log 2>&1 &'`), not the server. Replaying a launcher is worse than
    // replaying its child: it self-backgrounds, so it exits immediately and
    // reads back as a crash, and it sends its output somewhere we can't show.
    // The child plus the cwd we record from /proc says the same thing cleanly.
    `  case "$u" in`,
    `    *"&"*|*">"*|*"|"*|*";"*|*nohup*) return 0 ;;`,
    `  esac`,
    `  return 1`,
    `}`,
    `cmd_of() {`,
    `  tr '\\0' ' ' < /proc/"$1"/cmdline 2>/dev/null | sed 's/  *$//'`,
    `}`,
    // /proc/<pid>/stat field 2 (comm) can contain spaces and parentheses, so the
    // only safe split point is the LAST ")". ppid is the second field after it.
    `ppid_of() {`,
    `  r=$(sed 's/^.*) //' /proc/"$1"/stat 2>/dev/null) || return 1`,
    `  set -- $r`,
    `  [ $# -ge 2 ] || return 1`,
    `  printf %s "$2"`,
    `}`,
    `for pair in ${pairs}; do`,
    `  port=\${pair%%:*}`,
    `  inode=\${pair#*:}`,
    `  grep -q "^\${port}\t" "$REC" 2>/dev/null && continue`,
    // -lname matches the symlink TARGET, so one find replaces a readlink fork
    // per open fd in the sandbox. Its pattern is a GLOB, so the brackets of
    // "socket:[123]" must be escaped — unescaped they are a character class,
    // which matches nothing and silently records no servers at all.
    `  fd_dir=$(find /proc/[0-9]*/fd -maxdepth 1 -lname "socket:\\[\${inode}\\]" -printf '%h\\n' 2>/dev/null | head -1)`,
    `  [ -n "$fd_dir" ] || continue`,
    `  pid=\${fd_dir#/proc/}`,
    `  pid=\${pid%/fd}`,
    `  cand_pid=$pid`,
    `  cand_cmd=$(cmd_of "$pid")`,
    `  [ -n "$cand_cmd" ] || continue`,
    `  chain=$cand_cmd`,
    `  cur=$pid`,
    `  depth=0`,
    `  while [ $depth -lt 12 ]; do`,
    `    depth=$((depth + 1))`,
    `    par=$(ppid_of "$cur") || break`,
    `    [ -n "$par" ] || break`,
    `    [ "$par" -gt 1 ] 2>/dev/null || break`,
    `    par_cmd=$(cmd_of "$par")`,
    `    chain="$chain <- $par_cmd"`,
    `    is_unusable "$par_cmd" && break`,
    `    cand_pid=$par`,
    `    cand_cmd=$par_cmd`,
    `    cur=$par`,
    `  done`,
    `  cwd=$(readlink /proc/"$cand_pid"/cwd 2>/dev/null) || cwd=""`,
    `  [ -n "$cwd" ] || cwd=${quote(PATHS.PROJECT_DIR)}`,
    `  envs=$(tr '\\0' '\\n' < /proc/"$cand_pid"/environ 2>/dev/null | grep -E ${quote(envPattern)} | tr '\\n' ' ')`,
    `  printf '%s\\t%s\\t%s\\t%s\\t%s\\n' "$port" "$cwd" \\`,
    `    "$(printf %s "$cand_cmd" | base64 -w0)" \\`,
    `    "$(printf %s "$envs" | base64 -w0)" \\`,
    `    "$(printf %s "$chain" | base64 -w0)" >> "$REC"`,
    `done`,
  ].join("\n")
}

/**
 * Record any of `sockets` not attributed yet. Best-effort: a failure here must
 * never break the poll that called it — it only means a later refresh finds no
 * recipe and falls back to asking the agent.
 */
export async function recordDevServers(
  sandbox: Sandbox,
  sockets: ListeningSocket[]
): Promise<void> {
  if (sockets.length === 0) return
  try {
    await sandbox.process.executeCommand(buildRecordCommand(sockets), undefined, undefined, 20)
  } catch (error) {
    console.warn("[dev-servers] Failed to record dev servers:", error)
  }
}

// =============================================================================
// Liveness + restore
// =============================================================================

/**
 * grep pattern matching a LISTEN row for `port` in /proc/net/tcp[6]. The kernel
 * formats those tables with single-space separators and uppercase hex, so the
 * port can be matched textually without re-parsing every row.
 */
function portHex(port: number): string {
  return port.toString(16).toUpperCase().padStart(4, "0")
}

function listenTest(port: number): string {
  const pattern = `:${portHex(port)} [0-9A-F]+:[0-9A-F]+ 0A `
  return `grep -qE ${quote(pattern)} /proc/net/tcp /proc/net/tcp6 2>/dev/null`
}

/** Hex `local_address` of the loopback interfaces, as /proc writes them. */
const LOOPBACK_HEX = new Set(["0100007F", "00000000000000000000000001000000"])

/** How usable a port is from outside the sandbox. */
export type PortStatus = "down" | "loopback-only" | "ready"

/**
 * Classify what is listening on `port`.
 *
 * A bare "is something listening?" is not enough: a dev server bound to
 * 127.0.0.1 (Vite's default without `--host`) satisfies it, but the preview
 * proxy cannot reach it, so the panel would embed an iframe that renders the
 * proxy's 404 as a blank page. Distinguishing that case lets the panel say what
 * is actually wrong.
 */
export async function checkPort(sandbox: Sandbox, port: number): Promise<PortStatus> {
  const hex = portHex(port)
  const res = await sandbox.process.executeCommand(
    `grep -hE ${quote(`:${hex} [0-9A-F]+:[0-9A-F]+ 0A `)} /proc/net/tcp /proc/net/tcp6 2>/dev/null || true`,
    undefined,
    undefined,
    10
  )
  return classifyListenRows(res.result ?? "")
}

/** Classify the LISTEN rows for one port. Split out from {@link checkPort} so
 *  the address handling is testable without a sandbox. */
export function classifyListenRows(rows: string): PortStatus {
  const addresses = rows
    .split("\n")
    .map((line) => line.trim().split(/\s+/)[1]?.split(":")[0])
    .filter((addr): addr is string => Boolean(addr))

  if (addresses.length === 0) return "down"
  return addresses.every((addr) => LOOPBACK_HEX.has(addr)) ? "loopback-only" : "ready"
}

/** Read the recipe recorded for `port`, if any. */
async function readRecipe(
  sandbox: Sandbox,
  port: number
): Promise<DevServerRecipe | null> {
  const res = await sandbox.process.executeCommand(
    `cat ${quote(RECORD_FILE)} 2>/dev/null || true`,
    undefined,
    undefined,
    10
  )
  return parseRecipes(res.result ?? "").get(port) ?? null
}

/**
 * Re-run the recorded command for `port` and wait for it to listen.
 *
 * The command being replayed already ran in this same sandbox, started by the
 * agent or by the user; replaying it on an explicit refresh grants nothing that
 * was not already there.
 */
function logPath(port: number): string {
  return `${LOG_DIR}/${port}.log`
}

/**
 * Shell that relaunches a recorded dev server, detached, and prints the leader
 * pid. Split out from {@link restoreDevServer} so it can be exercised directly.
 */
export function buildLaunchCommand(recipe: DevServerRecipe): string {
  const log = logPath(recipe.port)
  const envExports = Object.entries(recipe.env)
    .map(([k, v]) => `export ${k}=${quote(v)}; `)
    .join("")

  // Run the recorded command under its own `sh -c` so the redirection wraps it
  // whole, even when it is a compound command.
  const inner =
    `cd ${quote(recipe.cwd)} 2>/dev/null || cd ${quote(PATHS.PROJECT_DIR)}; ` +
    `${envExports}sh -c ${quote(recipe.command)} >> ${quote(log)} 2>&1`

  // The backgrounded part MUST be a simple command. Backgrounding a compound
  // (`mkdir && setsid ...`) makes the shell fork a subshell that keeps this
  // call's stdout open, so executeCommand blocks until it times out instead of
  // returning. Do the setup in the foreground, background only `setsid`, then
  // print the leader pid — liveness is what separates "slow" from "dead" later.
  return (
    `mkdir -p ${quote(LOG_DIR)} && : > ${quote(log)} && ` +
    `{ setsid sh -c ${quote(inner)} < /dev/null > /dev/null 2>&1 & echo $!; }`
  )
}

/**
 * Shell that waits for `port` to start listening, then reports whether the
 * launcher `pid` is still alive — a dev server that is merely slow to bind (a
 * cold Next build routinely outlasts this window) must not read as a failure.
 */
export function buildWaitCommand(port: number, pid: string | null): string {
  return (
    `i=0; while [ $i -lt ${START_TIMEOUT_SECONDS} ]; do ` +
    `${listenTest(port)} && { echo READY; exit 0; }; ` +
    `sleep 1; i=$((i + 1)); done; ` +
    (pid ? `[ -d /proc/${pid} ] && echo STARTING || echo DEAD` : `echo DEAD`)
  )
}

export async function restoreDevServer(
  sandbox: Sandbox,
  port: number
): Promise<RestoreResult> {
  const recipe = await readRecipe(sandbox, port)
  if (!recipe) return { state: "no-recipe" }

  console.log(
    `[dev-servers] Restoring port ${port}: ${recipe.command} (cwd ${recipe.cwd})`
  )

  const launched = await sandbox.process.executeCommand(
    buildLaunchCommand(recipe),
    undefined,
    undefined,
    20
  )
  // Anything but a bare number means the launch printed something unexpected;
  // fall back to "no liveness check" rather than testing `/proc/` itself, which
  // always exists and would report every dead server as still starting.
  const rawPid = (launched.result ?? "").trim().split("\n").pop()?.trim() ?? ""
  const pid = /^\d+$/.test(rawPid) ? rawPid : null

  // Wait inside the sandbox rather than round-tripping once a second.
  const waited = await sandbox.process.executeCommand(
    buildWaitCommand(port, pid),
    undefined,
    undefined,
    START_TIMEOUT_SECONDS + 10
  )
  const outcome = (waited.result ?? "").trim().split("\n").pop()?.trim() ?? ""

  if (outcome === "READY") {
    // It bound the port — but to which interface? A loopback-only bind is
    // invisible to the proxy and would render as a blank iframe.
    const status = await checkPort(sandbox, port)
    return { state: status === "loopback-only" ? "loopback-only" : "ready" }
  }
  if (outcome === "STARTING") return { state: "starting" }

  const tail = await sandbox.process.executeCommand(
    `tail -n 40 ${quote(logPath(port))} 2>/dev/null || true`,
    undefined,
    undefined,
    10
  )
  const text = (tail.result ?? "").trim()
  return { state: "failed", log: text || "The dev server exited without listening." }
}
