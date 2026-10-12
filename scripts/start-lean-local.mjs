import { execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  chmodSync,
} from "node:fs";
import { createHmac, randomBytes } from "node:crypto";
const marker = "# ContractOS managed local development configuration";
const envFile = ".env.docker.local";
let stage = "initialization";
const run = (command, args, input) =>
  execFileSync(command, args, {
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
const compose = (args) =>
  run("docker", [
    "compose",
    "--env-file",
    envFile,
    "-f",
    "docker-compose.local.yml",
    ...args,
  ]);
const sql = (statement) =>
  run(
    "docker",
    [
      "exec",
      "-i",
      "supabase_db_contractos",
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-Atq",
    ],
    statement,
  );
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function ready(url) {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(2000) })).ok) return;
    } catch {}
    await sleep(1000);
  }
  throw new Error("Service unavailable");
}
try {
  if (
    existsSync(".env.local") &&
    !readFileSync(".env.local", "utf8").startsWith(marker)
  )
    throw new Error("Existing user configuration must be preserved");
  mkdirSync(".local", { mode: 0o700, recursive: true });
  if (!existsSync(envFile)) {
    const password = randomBytes(32).toString("base64url");
    const secret = randomBytes(48).toString("base64url");
    const jwt = (role) => {
      const head = Buffer.from(
        JSON.stringify({ alg: "HS256", typ: "JWT" }),
      ).toString("base64url");
      const body = Buffer.from(
        JSON.stringify({
          role,
          iss: "contractos-local",
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 10 * 365 * 86400,
        }),
      ).toString("base64url");
      const data = `${head}.${body}`;
      return `${data}.${createHmac("sha256", secret).update(data).digest("base64url")}`;
    };
    writeFileSync(
      envFile,
      `${marker}\nLOCAL_DB_PASSWORD=${password}\nLOCAL_JWT_SECRET=${secret}\nLOCAL_ANON_KEY=${jwt("anon")}\nLOCAL_SERVICE_KEY=${jwt("service_role")}\n`,
      { mode: 0o600 },
    );
  }
  const envText = readFileSync(envFile, "utf8");
  if (!envText.startsWith(marker))
    throw new Error("Unmanaged local configuration");
  const values = Object.fromEntries(
    envText
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index), line.slice(index + 1)];
      }),
  );
  let augmented = envText;
  for (const name of [
    "LOCAL_AUTH_PASSWORD",
    "LOCAL_STORAGE_PASSWORD",
    "LOCAL_REST_PASSWORD",
  ]) {
    if (!values[name]) {
      values[name] = randomBytes(32).toString("base64url");
      augmented += `${name}=${values[name]}\n`;
    }
    if (!/^[A-Za-z0-9_-]{43}$/.test(values[name]))
      throw new Error("Invalid generated service credential");
  }
  if (augmented !== envText) writeFileSync(envFile, augmented, { mode: 0o600 });
  if (!/^[A-Za-z0-9_-]{43}$/.test(values.LOCAL_DB_PASSWORD || ""))
    throw new Error("Invalid generated local password");
  stage = "PostgreSQL image and startup";
  compose(["up", "-d", "db", "mail"]);
  for (let i = 0; i < 60; i++) {
    try {
      sql("select 1;");
      break;
    } catch {
      if (i === 59) throw new Error("Database unavailable");
      await sleep(1000);
    }
  }
  stage = "local Supabase role bootstrap";
  const hasBootstrap =
    sql(
      "select exists(select 1 from pg_roles where rolname='supabase_auth_admin');",
    ).trim() === "t";
  if (!hasBootstrap)
    sql(`
    create schema extensions;create extension if not exists pgcrypto with schema extensions;
    create extension if not exists "uuid-ossp" with schema extensions;
    create role anon nologin noinherit;create role authenticated nologin noinherit;
    create role service_role nologin noinherit bypassrls;
    create role authenticator login noinherit password '${values.LOCAL_REST_PASSWORD}';
    grant anon,authenticated,service_role to authenticator;
    create role supabase_auth_admin login noinherit password '${values.LOCAL_AUTH_PASSWORD}';
    create role supabase_storage_admin login noinherit bypassrls password '${values.LOCAL_STORAGE_PASSWORD}';
    grant anon,authenticated,service_role to supabase_storage_admin;
    create schema auth authorization supabase_auth_admin;create schema storage authorization supabase_storage_admin;
    grant usage on schema public,extensions,auth,storage to anon,authenticated,service_role;
    grant usage on schema extensions to supabase_auth_admin,supabase_storage_admin;
    grant usage,create on schema public to supabase_auth_admin,supabase_storage_admin;
    alter role supabase_auth_admin set search_path=auth,public,extensions;
    alter role supabase_storage_admin set search_path=storage,public,extensions;
    create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
    create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid $$;
    create function auth.role() returns text language sql stable as $$ select auth.jwt()->>'role' $$;
    create function auth.email() returns text language sql stable as $$ select auth.jwt()->>'email' $$;
    alter function auth.jwt() owner to supabase_auth_admin;alter function auth.uid() owner to supabase_auth_admin;
    alter function auth.role() owner to supabase_auth_admin;alter function auth.email() owner to supabase_auth_admin;
    grant create on database postgres to supabase_auth_admin,supabase_storage_admin;
    grant execute on all functions in schema auth to anon,authenticated,service_role,supabase_storage_admin;
    alter default privileges for role supabase_auth_admin in schema auth grant select,references on tables to postgres,supabase_storage_admin;
    alter default privileges for role postgres in schema public grant all on tables to service_role;
    alter default privileges for role postgres in schema public grant all on sequences to service_role;
    alter default privileges for role supabase_storage_admin in schema storage grant all on tables to anon,authenticated,service_role;
    alter default privileges for role supabase_storage_admin in schema storage grant all on sequences to anon,authenticated,service_role;
  `);
  sql(
    "alter function auth.jwt() owner to supabase_auth_admin;alter function auth.uid() owner to supabase_auth_admin;alter function auth.role() owner to supabase_auth_admin;alter function auth.email() owner to supabase_auth_admin;grant create on database postgres to supabase_auth_admin,supabase_storage_admin;",
  );
  sql(
    `alter role authenticator password '${values.LOCAL_REST_PASSWORD}';alter role supabase_auth_admin password '${values.LOCAL_AUTH_PASSWORD}';alter role supabase_storage_admin password '${values.LOCAL_STORAGE_PASSWORD}';`,
  );
  stage = "gateway configuration";
  writeFileSync(
    ".local/kong.yml",
    `_format_version: "2.1"\nservices:\n  - name: auth\n    url: http://auth:9999/\n    routes:\n      - name: auth\n        paths: [/auth/v1/]\n        strip_path: true\n  - name: rest\n    url: http://rest:3000/\n    routes:\n      - name: rest\n        paths: [/rest/v1/]\n        strip_path: true\n  - name: storage\n    url: http://storage:5000/\n    routes:\n      - name: storage\n        paths: [/storage/v1/]\n        strip_path: true\n`,
    { mode: 0o644 },
  );
  chmodSync(".local/kong.yml", 0o644);
  compose(["create", "gateway"]);
  run("docker", [
    "cp",
    ".local/kong.yml",
    "contractos_gateway:/tmp/contractos-kong.yml",
  ]);
  stage = "Auth and Storage migrations";
  compose(["up", "-d", "auth", "rest", "storage"]);
  compose(["start", "gateway"]);
  await ready("http://127.0.0.1:54321/auth/v1/health");
  await ready("http://127.0.0.1:54321/storage/v1/status");
  sql(`set role supabase_auth_admin;
    create or replace function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid $$;
    create or replace function auth.role() returns text language sql stable as $$ select auth.jwt()->>'role' $$;
    create or replace function auth.email() returns text language sql stable as $$ select auth.jwt()->>'email' $$;
    reset role;
    grant execute on all functions in schema auth to anon,authenticated,service_role,supabase_storage_admin;
  `);
  stage = "application migrations";
  sql(
    "create schema if not exists contractos_local;create table if not exists contractos_local.applied_migrations(name text primary key);",
  );
  for (const file of readdirSync("supabase/migrations")
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    const done =
      sql(
        `select exists(select 1 from contractos_local.applied_migrations where name='${file}');`,
      ).trim() === "t";
    if (!done)
      sql(
        `begin;\n${readFileSync(`supabase/migrations/${file}`, "utf8")}\ninsert into contractos_local.applied_migrations values('${file}');commit;`,
      );
  }
  sql("notify pgrst,'reload schema';");
  const existing = existsSync(".env.local")
    ? readFileSync(".env.local", "utf8")
    : "";
  const token =
    existing.match(/^INTEGRATION_TOKEN=([A-Za-z0-9_-]{43,256})$/m)?.[1] ||
    randomBytes(32).toString("base64url");
  writeFileSync(
    ".env.local",
    `${marker}\nNEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321\nNEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=${values.LOCAL_ANON_KEY}\nSUPABASE_SERVICE_ROLE_KEY=${values.LOCAL_SERVICE_KEY}\nAPP_ORIGIN=http://localhost:3000\nINTEGRATION_TOKEN=${token}\n`,
    { mode: 0o600 },
  );
  console.log(
    "Local PostgreSQL, Supabase Auth and private Storage are ready. Bindings saved without printing credentials.",
  );
} catch {
  console.error(
    `Local setup failed at: ${stage}. No configuration was published. Inspect local service status without dumping credentials.`,
  );
  process.exitCode = 1;
}
