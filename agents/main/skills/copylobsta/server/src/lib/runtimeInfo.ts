import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RELEASE_TAG } from "../config.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

function resolveRepoDir(): string {
  return process.env.COPYLOBSTA_REPO_DIR
    || resolve(realpathSync(__dirname), "..", "..", "..", "..", "..", "..", "..");
}

function resolveGitDir(repoDir: string): string | null {
  try {
    const dotGit = readFileSync(resolve(repoDir, ".git"), "utf8").trim();
    if (dotGit.startsWith("gitdir:")) {
      const gitPath = dotGit.slice("gitdir:".length).trim();
      return resolve(repoDir, gitPath);
    }
  } catch {
    // .git may be a directory instead of a file.
  }

  const candidate = resolve(repoDir, ".git");
  try {
    readFileSync(resolve(candidate, "HEAD"), "utf8");
    return candidate;
  } catch {
    return null;
  }
}

function readGitSha(repoDir: string): string {
  const gitDir = resolveGitDir(repoDir);
  if (!gitDir) return RELEASE_TAG || "unknown";

  try {
    const head = readFileSync(resolve(gitDir, "HEAD"), "utf8").trim();
    if (!head.startsWith("ref:")) return head.slice(0, 12);

    const refPath = head.slice("ref:".length).trim();
    const sha = readFileSync(resolve(gitDir, refPath), "utf8").trim();
    return sha.slice(0, 12);
  } catch {
    return RELEASE_TAG || "unknown";
  }
}

export function getRuntimeGitSha(): string {
  return readGitSha(resolveRepoDir());
}
