import { expect, it } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { socketAddress } from "../server/herdr/client.ts";
import { windowsProcessTable } from "../server/windows-processes.ts";

it.skipIf(process.platform !== "win32")("starts after its launcher exits, stops its owned tree and restarts on Windows", async () => {
  const root = join(import.meta.dir, "..");
  const scratch = mkdtempSync(join(tmpdir(), "herdr windows plugin "));
  const bin = join(scratch, ".bun", "bin");
  mkdirSync(bin, { recursive: true });
  copyFileSync(process.execPath, join(bin, "bun.exe"));
  const manifest = Bun.TOML.parse(readFileSync(join(root, "herdr-plugin.toml"), "utf8")) as {
    startup: { command: string[]; platforms: string[] }[];
    actions: { id: string; command: string[]; platforms?: string[] }[];
  };
  const socket = join(scratch, "herdr.sock");
  writeFileSync(socket, "test");
  // An isolated Herdr wire peer: no real sessions, panes, plugin registry or push keys.
  const peer = createServer(connection => {
    let buffer = "";
    connection.on("data", data => {
      buffer += data.toString();
      if (!buffer.includes("\n")) return;
      const request = JSON.parse(buffer.trim());
      const result = request.method === "ping"
        ? { version: "0.9.3", protocol: 22, capabilities: { direct_terminal_attach: false } }
        : { snapshot: { workspaces: [], panes: [], tabs: [] } };
      connection.end(JSON.stringify({ id: request.id, result }) + "\n");
    });
  });
  await new Promise<void>((resolve, reject) => { peer.once("error", reject); peer.listen(socketAddress(socket), resolve); });
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = reservation.port!;
  reservation.stop(true);
  const config = join(scratch, "config");
  const state = join(scratch, "plugin-state");
  mkdirSync(config);
  writeFileSync(join(config, ".env"), `HOST=127.0.0.1\nPORT=${port}\n`);
  const env = { ...process.env, HOME: scratch, USERPROFILE: scratch, APPDATA: join(scratch, "appdata"),
    // A running Herdr without Bun on PATH: the manifest's real Windows launcher must find it.
    PATH: ["taskkill", "powershell", "git"].map(tool => dirname(Bun.which(tool)!)).join(";"),
    HERDR_SOCKET: socket, HERDR_SOCKET_PATH: socket, HERDR_PLUGIN_ROOT: undefined,
    HERDR_PLUGIN_STATE_DIR: state, HERDR_PLUGIN_CONFIG_DIR: config, HERDR_WEB_STATE_DIR: join(scratch, "app-state"),
    HERDR_WEB_AUTO_UPDATE: "0", HERDR_WEB_TOKEN: "", HOST: "127.0.0.1", PORT: String(port) };
  const run = async (command: string) => {
    const entry = command === "start" ? manifest.startup.find(entry => entry.platforms.includes("windows"))
      : manifest.actions.find(entry => entry.id === `${command}-windows` && entry.platforms?.includes("windows"));
    const child = Bun.spawn(entry!.command, { cwd: root, env, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code, err + out + (existsSync(join(state, "server.log")) ? readFileSync(join(state, "server.log"), "utf8") : "")).toBe(0);
    return out;
  };
  try {
    await run("start");
    // start's process has exited, but the managed server and its children must still answer.
    const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json() as { herdr: { terminal_mirror: boolean } };
    expect(health.herdr.terminal_mirror).toBe(true);
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(200);
    const pid = Number(readFileSync(join(state, "server.pid"), "utf8").trim());
    const rows = await windowsProcessTable(30_000);
    const owned = new Set([pid]);
    for (const parent of owned) for (const row of rows) if (row.parent === parent) owned.add(row.pid);
    expect(owned.size).toBeGreaterThanOrEqual(3);
    await run("start"); // an already running plugin is preserved
    expect(Number(readFileSync(join(state, "server.pid"), "utf8"))).toBe(pid);
    await run("stop");
    for (const member of owned) expect(() => process.kill(member, 0)).toThrow();
    expect(existsSync(join(state, "server.pid"))).toBe(false);
    await run("start"); // forced Windows shutdown leaves a stale lock; restart must recover it
    expect((await fetch(`http://127.0.0.1:${port}/api/health`)).ok).toBe(true);
    await run("stop");
  } finally {
    if (existsSync(join(state, "server.pid"))) await run("stop");
    await new Promise<void>(resolve => peer.close(() => resolve()));
    rmSync(scratch, { recursive: true, force: true });
  }
}, 90_000);
