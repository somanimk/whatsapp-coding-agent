import "server-only";
import { Pool, type PoolClient } from "pg";
import { env } from "./config";
let pool: Pool | undefined;
export function database() {
  return pool ??= new Pool({ connectionString: env("DATABASE_URL"), max: 3, connectionTimeoutMillis: 10000, idleTimeoutMillis: 10000 });
}
export async function transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await database().connect();
  try { await client.query("BEGIN"); const result = await run(client); await client.query("COMMIT"); return result; }
  catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
export async function notify(client: PoolClient, key: string, sender: string, text: string) {
  await client.query("INSERT INTO whatsapp_outbox(event_key,sender,body) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [key, sender, text]);
}
