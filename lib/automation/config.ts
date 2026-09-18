import "server-only";
export function env(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing configuration: ${name}`);
  return value;
}
export function enabled() { return process.env.AUTOMATION_ENABLED === "true"; }
export function allowedSenders() {
  const values = env("WHATSAPP_ALLOWED_SENDERS").split(",").map(value => value.trim());
  if (values.some(value => !/^\d{5,20}$/.test(value))) throw new Error("Invalid allowed sender configuration");
  return values;
}
export const targetRepository = "somanimk/Mayank-Portfolio-Site";
export function workerRepo() {
  const repo = env("GITHUB_WORKER_REPO");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("Invalid worker repository");
  return repo;
}
