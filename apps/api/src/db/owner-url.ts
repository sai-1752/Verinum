/**
 * Operator commands (migrate, admin) connect as the schema owner and need nothing else, so they read
 * only DATABASE_MIGRATION_URL rather than validating the whole server configuration.
 */
const DEV_URL = "postgres://verinum_owner:owner_dev_pw@127.0.0.1:5432/verinum";

export function ownerUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.DATABASE_MIGRATION_URL;
  if (url) return url;
  if (env.NODE_ENV === "production") { console.error("DATABASE_MIGRATION_URL is required in production."); process.exit(2); }
  return DEV_URL;
}
