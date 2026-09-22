/** Operator commands that need the owner connection: `promote <email>` / `demote <email>` (platform admin flag). */
import pg from "pg";
import { ownerUrl } from "./owner-url";

const [cmd, emailArg] = process.argv.slice(2);
if ((cmd !== "promote" && cmd !== "demote") || !emailArg) {
  console.error("usage: admin-cli <promote|demote> <email>");
  process.exit(2);
}
const client = new pg.Client({ connectionString: ownerUrl() });
await client.connect();
try {
  const r = await client.query("update users set is_platform_admin = $2 where email = $1 returning id", [emailArg.trim().toLowerCase(), cmd === "promote"]);
  if (!r.rowCount) { console.error("No user with that email."); process.exitCode = 1; }
  else console.log(`${emailArg} is ${cmd === "promote" ? "now" : "no longer"} a platform admin.`);
} finally { await client.end(); }
