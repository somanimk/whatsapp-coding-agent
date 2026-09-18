import { readFile } from "node:fs/promises";
import { database } from "../lib/automation/store";
try { await database().query(await readFile(new URL("./schema.sql", import.meta.url), "utf8")); console.log("Automation schema applied."); }
finally { await database().end(); }
