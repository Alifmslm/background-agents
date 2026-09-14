import { describe, it, expect } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildLaunchCommand,
  buildRecordCommand,
  buildWaitCommand,
  classifyListenRows,
  parseListeningSockets,
  parseRecipes,
  restoreArgSeparator,
  splitListOutput,
  type DevServerRecipe,
} from "./dev-servers"

/** A realistic /proc/net/tcp: a LISTEN on 3000, an established conn on 8080. */
const PROC_NET_TCP = [
  "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
  "   0: 00000000:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 123456 1 ffff8 100 0 0 10 0",
  "   1: 0100007F:1F90 0100007F:C350 01 00000000:00000000 00:00000000 00000000  1000        0 123457 1 ffff8 20 0 0 10 -1",
  "",
].join("\n")

/** The same server's IPv6 socket — a dual-stack listener appears in both tables. */
const PROC_NET_TCP6 = [
  "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
  "   0: 00000000000000000000000000000000:0BB8 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 123458 1 ffff8 100 0 0 10 0",
  "",
].join("\n")

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64")

describe("parseListeningSockets", () => {
  it("returns only LISTEN sockets in the dev-server port range", () => {
    const sockets = parseListeningSockets(PROC_NET_TCP)
    expect(sockets).toEqual([{ port: 3000, inode: "123456" }])
  })

  it("reports a dual-stack listener once", () => {
    const sockets = parseListeningSockets(`${PROC_NET_TCP}${PROC_NET_TCP6}`)
    expect(sockets.map((s) => s.port)).toEqual([3000])
  })

  it("ignores ports outside 3000-9999", () => {
    // 0050 = 80, 270F = 9999, 2710 = 10000.
    const rows = ["0050", "270F", "2710"]
      .map(
        (hex, i) =>
          `   ${i}: 00000000:${hex} 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 90${i} 1 ffff8`
      )
      .join("\n")
    expect(parseListeningSockets(rows).map((s) => s.port)).toEqual([9999])
  })
})

describe("parseRecipes", () => {
  it("decodes a recorded line", () => {
    const line = [
      "3000",
      "/home/daytona/project",
      b64("npm run dev"),
      b64("PORT=3000 "),
      b64("next-server <- npm run dev"),
    ].join("\t")

    const recipe = parseRecipes(line).get(3000)
    expect(recipe).toMatchObject({
      port: 3000,
      command: "npm run dev",
      cwd: "/home/daytona/project",
      env: { PORT: "3000" },
    })
  })

  it("drops env vars outside the allowlist, so secrets never round-trip", () => {
    const line = ["3000", "/x", b64("npm run dev"), b64("PORT=3000 AWS_SECRET=hunter2"), ""].join(
      "\t"
    )
    expect(parseRecipes(line).get(3000)?.env).toEqual({ PORT: "3000" })
  })

  it("skips malformed lines rather than throwing", () => {
    const tsv = ["", "garbage", ["3000", "/x", "", "", ""].join("\t")].join("\n")
    expect(parseRecipes(tsv).size).toBe(0)
  })
})

describe("splitListOutput", () => {
  it("separates the socket tables from the recorded recipes", () => {
    const raw = [
      PROC_NET_TCP,
      "===RECORDED===",
      ["3000", "/home/daytona/project", b64("npm run dev"), "", ""].join("\t"),
    ].join("\n")

    const { sockets, recipes } = splitListOutput(raw)
    expect(sockets.map((s) => s.port)).toEqual([3000])
    expect(recipes.get(3000)?.command).toBe("npm run dev")
  })

  it("handles a sandbox with no recipe file yet", () => {
    const { sockets, recipes } = splitListOutput(`${PROC_NET_TCP}\n===RECORDED===\n`)
    expect(sockets.map((s) => s.port)).toEqual([3000])
    expect(recipes.size).toBe(0)
  })
})

describe("buildRecordCommand", () => {
  const sockets = [{ port: 3000, inode: "123456" }]

  it("looks up already-recorded ports with a literal tab", () => {
    // The TSV is tab-separated and grep's BRE does not understand "\t", so a
    // backslash-t here would silently never match and every poll would re-record.
    expect(buildRecordCommand(sockets)).toContain('grep -q "^${port}\t"')
  })

  it("escapes the brackets of the socket inode for find's glob", () => {
    // `find -lname` matches a GLOB, so an unescaped "socket:[123]" is a
    // character class matching a single digit — it finds nothing, and every
    // server is silently left unrecorded.
    const cmd = buildRecordCommand(sockets)
    expect(cmd).toContain('-lname "socket:\\[${inode}\\]"')
  })

  it("rejects launcher shells so the server command is recorded instead", () => {
    // The ancestor that backgrounded the server (`sh -c '... nohup npm run dev
    // > log 2>&1 &'`) must not be what we replay: it exits the instant it forks,
    // so a healthy server would read back as a crash.
    expect(buildRecordCommand(sockets)).toContain(`*"&"*|*">"*|*"|"*|*";"*|*nohup*`)
  })

  it("is valid POSIX shell", () => {
    expectValidShell(buildRecordCommand(sockets))
  })
})

describe("restoreArgSeparator", () => {
  it("puts back the -- that npm strips from its own argv", () => {
    // Observed in a node:22-bookworm container: `npm run dev -- --host 0.0.0.0
    // --port 5173` reads back from /proc without the separator. Replaying it
    // verbatim gives the flags to npm, so Vite starts bare, binds 127.0.0.1,
    // and the preview proxy 404s while the port still looks "up".
    expect(restoreArgSeparator("npm run dev --host 0.0.0.0 --port 5173")).toBe(
      "npm run dev -- --host 0.0.0.0 --port 5173"
    )
  })

  it("leaves a command with no script arguments alone", () => {
    expect(restoreArgSeparator("npm run dev")).toBe("npm run dev")
  })

  it("is idempotent when the separator survived", () => {
    expect(restoreArgSeparator("npm run dev -- --host")).toBe("npm run dev -- --host")
  })

  it("leaves other package managers alone, since they forward args directly", () => {
    for (const cmd of ["yarn dev --host", "pnpm dev --host", "bun run dev --host"]) {
      expect(restoreArgSeparator(cmd)).toBe(cmd)
    }
  })

  it("leaves a plain command alone", () => {
    expect(restoreArgSeparator("node server.js --port 3000")).toBe("node server.js --port 3000")
  })
})

describe("classifyListenRows", () => {
  const row = (addr: string) =>
    `   0: ${addr}:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1001        0 132411 1 ffff8`

  it("treats a 0.0.0.0 bind as reachable", () => {
    expect(classifyListenRows(row("00000000"))).toBe("ready")
  })

  it("flags a loopback-only bind rather than calling it ready", () => {
    // Vite without --host binds ::1, which the preview proxy cannot reach — the
    // port looks up, so the panel would otherwise embed a blank 404 iframe.
    expect(classifyListenRows(row("00000000000000000000000001000000"))).toBe("loopback-only")
    expect(classifyListenRows(row("0100007F"))).toBe("loopback-only")
  })

  it("is ready when any one bind is reachable", () => {
    expect(classifyListenRows([row("0100007F"), row("00000000")].join("\n"))).toBe("ready")
  })

  it("reports down when nothing is listening", () => {
    expect(classifyListenRows("")).toBe("down")
  })
})

describe("buildLaunchCommand", () => {
  const recipe: DevServerRecipe = {
    port: 4000,
    command: "npm run dev",
    cwd: "/home/daytona/project",
    env: { PORT: "4000" },
    chain: "",
  }

  it("restores the recorded cwd and env", () => {
    // The whole launch is nested inside an outer `sh -c '...'`, so every inner
    // quote arrives escaped as '\''.
    const cmd = buildLaunchCommand(recipe)
    expect(cmd).toContain(`cd '\\''/home/daytona/project'\\''`)
    expect(cmd).toContain(`export PORT='\\''4000'\\''`)
    expect(cmd).toContain(`sh -c '\\''npm run dev'\\''`)
  })

  it("backgrounds only a simple command", () => {
    // Backgrounding a compound makes the shell fork a subshell that holds this
    // call's stdout open, so executeCommand blocks until it times out. The setup
    // must run in the foreground and only `setsid` may be backgrounded.
    const cmd = buildLaunchCommand(recipe)
    expect(cmd).toContain("{ setsid sh -c ")
    expect(cmd).not.toMatch(/&&[^&]*setsid[^&]*&\s*}/)
  })

  it("quotes a command containing single quotes", () => {
    const cmd = buildLaunchCommand({ ...recipe, command: `node -e 'console.log(1)'` })
    expectValidShell(cmd)
  })
})

describe("buildWaitCommand", () => {
  it("matches the port as uppercase hex in a LISTEN row", () => {
    // 4000 decimal is 0FA0 hex; /proc/net/tcp writes it zero-padded and upper.
    expect(buildWaitCommand(4000, "123")).toContain(":0FA0 ")
    expect(buildWaitCommand(4000, "123")).toContain("[ -d /proc/123 ]")
  })

  it("reports DEAD rather than probing /proc itself when the pid is unknown", () => {
    // `[ -d /proc/ ]` is always true, which would report every dead server as
    // still starting.
    const cmd = buildWaitCommand(4000, null)
    expect(cmd).not.toContain("/proc/ ")
    expect(cmd.trim().endsWith("echo DEAD")).toBe(true)
  })

  it("is valid POSIX shell", () => {
    expectValidShell(buildWaitCommand(3000, "42"))
  })
})

/**
 * The shell here is assembled as a string and runs under the sandbox's `sh`
 * (possibly dash), so a quoting slip is invisible until it fails in a real
 * sandbox. `sh -n` parses without executing.
 */
function expectValidShell(script: string): void {
  const dir = mkdtempSync(join(tmpdir(), "dev-servers-"))
  const file = join(dir, "script.sh")
  writeFileSync(file, script, "utf8")
  expect(() => execFileSync("sh", ["-n", file], { stdio: "pipe" })).not.toThrow()
}
