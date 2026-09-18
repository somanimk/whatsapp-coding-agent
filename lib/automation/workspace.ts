import "server-only";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, readdir, lstat, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type { FileEdit } from "../../types/automation";
import { targetRepository } from "./config";
const execute = promisify(execFile);
export async function createWorkspace(sha: string) {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("Invalid base SHA");
  const root = await mkdtemp(join(tmpdir(), "whatsapp-task-"));
  try {
    const cleanEnv: NodeJS.ProcessEnv = { NODE_ENV: "production", PATH: process.env.PATH, HOME: root, GIT_TERMINAL_PROMPT: "0" };
    await execute("git", ["clone", "--quiet", `https://github.com/${targetRepository}.git`, root], { env: cleanEnv, timeout: 120000 });
    await execute("git", ["-C", root, "checkout", "--quiet", "--detach", sha], { env: cleanEnv, timeout: 30000 });
    await rm(join(root, ".git"), { recursive: true, force: true });
    return root;
  } catch { await rm(root, { recursive: true, force: true }); throw new Error("Repository checkout failed"); }
}
export async function sourceFiles(root: string): Promise<FileEdit[]> {
  const result: FileEdit[] = [];
  let size = 0;
  async function visit(relative: string) {
    for (const name of (await readdir(join(root, relative))).sort()) {
      if (name.startsWith(".") || name === "node_modules") continue;
      const path = `${relative}/${name}`;
      const stat = await lstat(join(root, path));
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) await visit(path);
      else if (/\.(js|jsx|ts|tsx|css|json)$/.test(path)) {
        const content = await readFile(join(root, path), "utf8");
        size += content.length;
        if (size > 180000 || result.length >= 100) throw new Error("Repository context exceeds this adapter's limit");
        result.push({ path, content });
      }
    }
  }
  for (const dir of ["app", "components", "lib"]) {
    try { const stat = await lstat(join(root, dir)); if (stat.isDirectory() && !stat.isSymbolicLink()) await visit(dir); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return result;
}
export async function applyEdits(root: string, files: FileEdit[]) {
  for (const file of files) {
    const parts = file.path.split("/");
    for (let index = 1; index <= parts.length; index++) {
      try {
        if ((await lstat(join(root, ...parts.slice(0, index)))).isSymbolicLink()) throw new Error("Symlink edit rejected");
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    await mkdir(dirname(join(root, file.path)), { recursive: true });
    await writeFile(join(root, file.path), file.content);
  }
}
export async function validateWorkspace(root: string) {
  // Repository code runs in a container with only the candidate source mounted.
  // No GitHub, database, WhatsApp, or model credentials are passed into it.
  try {
    await execute("docker", ["run", "--rm", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=512", "--memory=3g", "--cpus=2", "--user", `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`, "--tmpfs", "/tmp:rw,size=1g", "-e", "HOME=/tmp", "-e", "NPM_CONFIG_CACHE=/tmp/npm", "-v", `${root}:/workspace`, "-w", "/workspace", "node:22-bookworm", "sh", "-c", "npm ci --ignore-scripts && npm run lint && npx --no-install next build --webpack"], { timeout: 600000, maxBuffer: 2 * 1024 * 1024 });
  } catch { throw new Error("Candidate lint/build failed or timed out in the isolated validator; no PR was published"); }
}
