// The restricted database role of the API and the workers, for a platform without psql in the deploy step
// (scripts/production-db-runtime-role.sql is the psql form of the same statements; keep the two in step). Run as the
// schema owner after the migrations: DATABASE_URL is the owner's, RUNTIME_DB_PASSWORD the password trellis_runtime gets.
// The role can read and write application rows and nothing else: no schema changes, no roles, no migration history.
// Prints no secret.
import postgres from "postgres";

const url = process.env.DATABASE_URL;
const password = process.env.RUNTIME_DB_PASSWORD ?? "";
if (!url || !/^postgres(?:ql)?:/.test(url)) throw new Error("The runtime role step requires the schema owner's DATABASE_URL.");
// The password is written into a statement (CREATE ROLE takes no parameter), so only a plain token is accepted.
if (!/^[A-Za-z0-9]{24,128}$/.test(password)) throw new Error("RUNTIME_DB_PASSWORD must be 24 to 128 letters and digits.");
const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
  const [{ database, owner }] = await sql<{ database: string; owner: string }[]>`select current_database() as database, current_user as owner`;
  if (owner === "trellis_runtime") throw new Error("The runtime role step must run as the schema owner, not as trellis_runtime.");
  const id = (name: string) => `"${name.replace(/"/g, '""')}"`;
  const [exists] = await sql`select 1 from pg_roles where rolname = 'trellis_runtime'`;
  await sql.unsafe(`${exists ? "ALTER" : "CREATE"} ROLE trellis_runtime LOGIN PASSWORD '${password}'`);
  for (const statement of [
    `ALTER ROLE trellis_runtime NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
    `GRANT CONNECT ON DATABASE ${id(database)} TO trellis_runtime`,
    `GRANT USAGE ON SCHEMA public, drizzle TO trellis_runtime`,
    `REVOKE CREATE ON SCHEMA public, drizzle FROM PUBLIC, trellis_runtime`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO trellis_runtime`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO trellis_runtime`,
    `REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA drizzle FROM trellis_runtime`,
    `GRANT SELECT ON ALL TABLES IN SCHEMA drizzle TO trellis_runtime`,
    `REVOKE USAGE, UPDATE ON ALL SEQUENCES IN SCHEMA drizzle FROM trellis_runtime`,
    `GRANT SELECT ON ALL SEQUENCES IN SCHEMA drizzle TO trellis_runtime`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${id(owner)} IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO trellis_runtime`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${id(owner)} IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO trellis_runtime`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${id(owner)} IN SCHEMA drizzle REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLES FROM trellis_runtime`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${id(owner)} IN SCHEMA drizzle GRANT SELECT ON TABLES TO trellis_runtime`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${id(owner)} IN SCHEMA drizzle GRANT SELECT ON SEQUENCES TO trellis_runtime`,
  ]) await sql.unsafe(statement);
  console.log(`Runtime role trellis_runtime is in place on ${database} (owner ${owner}).`);
} finally {
  await sql.end();
}
