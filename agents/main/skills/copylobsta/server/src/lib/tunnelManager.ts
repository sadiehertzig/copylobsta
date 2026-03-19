import { spawn } from "node:child_process";
import { PORT, SHARING_TTL_MINUTES } from "../config.js";

interface ActiveTunnel {
  key: string;
  url: string;
  pid: number | null;
  expiresAt: string;
  process: ReturnType<typeof spawn>;
  timeout: NodeJS.Timeout;
}

const START_TIMEOUT_MS = 25_000;
const KILL_GRACE_MS = 3_000;
const active = new Map<string, ActiveTunnel>();
const keyByUrl = new Map<string, string>();

function extractTunnelUrl(line: string): string | null {
  const match = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
  return match ? match[0] : null;
}

function killProcess(proc: ReturnType<typeof spawn>): void {
  if (proc.killed) return;
  proc.kill("SIGTERM");
  setTimeout(() => {
    if (!proc.killed) {
      proc.kill("SIGKILL");
    }
  }, KILL_GRACE_MS).unref();
}

export async function ensureOnDemandTunnel(key: string): Promise<{ url: string; expiresAt: string; pid: number | null }> {
  const existing = active.get(key);
  if (existing && Date.now() < new Date(existing.expiresAt).getTime()) {
    return { url: existing.url, expiresAt: existing.expiresAt, pid: existing.pid };
  }

  await stopTunnel(key);

  const ttlMs = Math.max(5, SHARING_TTL_MINUTES) * 60_000;
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();

  return new Promise((resolve, reject) => {
    const proc = spawn("cloudflared", ["tunnel", "--url", `http://127.0.0.1:${PORT}`, "--no-autoupdate"], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let settled = false;

    const onOutput = (chunk: Buffer): void => {
      if (settled) return;
      const line = chunk.toString("utf8");
      const url = extractTunnelUrl(line);
      if (!url) return;

      settled = true;
      const timeout = setTimeout(() => {
        void stopTunnel(key);
      }, ttlMs);
      timeout.unref();

      const tunnel: ActiveTunnel = {
        key,
        url,
        pid: proc.pid ?? null,
        expiresAt,
        process: proc,
        timeout,
      };
      active.set(key, tunnel);
      keyByUrl.set(url, key);
      resolve({ url, expiresAt, pid: proc.pid ?? null });
    };

    proc.stdout?.on("data", onOutput);
    proc.stderr?.on("data", onOutput);

    proc.on("exit", (code) => {
      const current = active.get(key);
      if (current && current.process.pid === proc.pid) {
        clearTimeout(current.timeout);
        active.delete(key);
        keyByUrl.delete(current.url);
      }
      if (!settled) {
        settled = true;
        reject(new Error(`cloudflared exited before tunnel URL was available (code ${code ?? "unknown"})`));
      }
    });

    setTimeout(() => {
      if (settled) return;
      settled = true;
      killProcess(proc);
      reject(new Error("Timed out starting Cloudflare tunnel"));
    }, START_TIMEOUT_MS).unref();
  });
}

export async function stopTunnel(key: string): Promise<void> {
  const tunnel = active.get(key);
  if (!tunnel) return;
  clearTimeout(tunnel.timeout);
  active.delete(key);
  keyByUrl.delete(tunnel.url);
  killProcess(tunnel.process);
}

export async function stopTunnelByUrl(url: string): Promise<void> {
  const key = keyByUrl.get(url);
  if (!key) return;
  await stopTunnel(key);
}
