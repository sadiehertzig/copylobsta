import { spawn } from "node:child_process";
import { Resolver } from "node:dns/promises";
import { accessSync, constants } from "node:fs";
import { join } from "node:path";
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
const PROBE_TIMEOUT_MS = 3_000;
const PROBE_TOTAL_WAIT_MS = 20_000;
const PROBE_RETRY_MS = 1_000;
const active = new Map<string, ActiveTunnel>();
const keyByUrl = new Map<string, string>();
const publicDnsResolver = new Resolver();
publicDnsResolver.setServers(["1.1.1.1", "1.0.0.1"]);

function getTunnelTtlMs(): number {
  return Math.max(5, SHARING_TTL_MINUTES) * 60_000;
}

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

function resolveCloudflaredBinary(): string {
  const home = process.env.HOME || "";
  const localCandidate = home ? join(home, ".local", "bin", "cloudflared") : "";
  if (localCandidate) {
    try {
      accessSync(localCandidate, constants.X_OK);
      return localCandidate;
    } catch {
      // Fall back to PATH lookup.
    }
  }
  return "cloudflared";
}

async function probeTunnel(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${url}/api/health`, {
      method: "GET",
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function probeTunnelPublicDns(url: string): Promise<boolean> {
  try {
    const host = new URL(url).hostname;
    const [a4, a6] = await Promise.allSettled([
      publicDnsResolver.resolve4(host),
      publicDnsResolver.resolve6(host),
    ]);
    const hasA4 = a4.status === "fulfilled" && a4.value.length > 0;
    const hasA6 = a6.status === "fulfilled" && a6.value.length > 0;
    return hasA4 || hasA6;
  } catch {
    return false;
  }
}

async function waitForTunnelReady(url: string): Promise<void> {
  const deadline = Date.now() + PROBE_TOTAL_WAIT_MS;
  while (Date.now() < deadline) {
    if (await probeTunnel(url)) return;
    // Fallback for hosts where local DNS (systemd-resolved) lags or caches NXDOMAIN.
    if (await probeTunnelPublicDns(url)) return;
    await new Promise((r) => setTimeout(r, PROBE_RETRY_MS));
  }
  throw new Error(`Cloudflare tunnel did not become reachable in time: ${url}`);
}

function renewTunnelLease(tunnel: ActiveTunnel, ttlMs: number): string {
  clearTimeout(tunnel.timeout);
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  const timeout = setTimeout(() => {
    void stopTunnel(tunnel.key);
  }, ttlMs);
  timeout.unref();
  tunnel.expiresAt = expiresAt;
  tunnel.timeout = timeout;
  active.set(tunnel.key, tunnel);
  return expiresAt;
}

export async function ensureOnDemandTunnel(key: string): Promise<{ url: string; expiresAt: string; pid: number | null }> {
  const ttlMs = getTunnelTtlMs();
  const existing = active.get(key);
  if (existing && Date.now() < new Date(existing.expiresAt).getTime()) {
    // If process is gone or URL is unreachable, recycle the tunnel.
    const stillRunning = existing.process.exitCode === null;
    if (stillRunning && await probeTunnel(existing.url)) {
      const expiresAt = renewTunnelLease(existing, ttlMs);
      return { url: existing.url, expiresAt, pid: existing.pid };
    }
    await stopTunnel(key);
  } else if (existing) {
    await stopTunnel(key);
  }

  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  const cloudflaredBin = resolveCloudflaredBinary();

  return new Promise((resolve, reject) => {
    const proc = spawn(cloudflaredBin, ["tunnel", "--url", `http://127.0.0.1:${PORT}`, "--no-autoupdate"], {
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

      waitForTunnelReady(url)
        .then(() => resolve({ url, expiresAt, pid: proc.pid ?? null }))
        .catch(async (err: unknown) => {
          await stopTunnel(key);
          reject(err instanceof Error ? err : new Error(String(err)));
        });
    };

    proc.stdout?.on("data", onOutput);
    proc.stderr?.on("data", onOutput);

    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      reject(new Error(`${cloudflaredBin} failed to start: ${err.message}`));
    });

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

export function refreshTunnelByUrl(url: string): { url: string; expiresAt: string; pid: number | null } | null {
  const key = keyByUrl.get(url);
  if (!key) return null;
  const tunnel = active.get(key);
  if (!tunnel) return null;
  if (tunnel.process.exitCode !== null) return null;
  const expiresAt = renewTunnelLease(tunnel, getTunnelTtlMs());
  return { url: tunnel.url, expiresAt, pid: tunnel.pid };
}
