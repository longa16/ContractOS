import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { execFileSync } from "node:child_process";
import { createHmac, randomBytes, randomUUID } from "node:crypto";

process.loadEnvFile(".env.local");
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
if (!url || !["127.0.0.1", "localhost"].includes(new URL(url).hostname))
  throw new Error("Browser tests require the disposable LOCAL Supabase stack.");
const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const org = randomUUID();
const suffix = randomBytes(6).toString("hex");
const password = `Local1!${randomBytes(24).toString("base64url")}`;
const accounts = {
  owner: `owner-${suffix}@example.test`,
  va: `va-${suffix}@example.test`,
  a: `a-${suffix}@example.test`,
  b: `b-${suffix}@example.test`,
};
const ids: Record<string, string> = {};
let catalogId: string;
function sql(statement: string) {
  return execFileSync(
    "docker",
    [
      "exec",
      "supabase_db_contractos",
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-Atc",
      statement,
    ],
    { encoding: "utf8" },
  ).trim();
}
function totp(secret: string) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of secret.toUpperCase().replace(/=+$/, ""))
    bits += alphabet.indexOf(c).toString(2).padStart(5, "0");
  const key = Buffer.from(
    (bits.match(/.{8}/g) || []).map((x) => parseInt(x, 2)),
  );
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const hmac = createHmac("sha1", key).update(counter).digest();
  const offset = hmac[19] & 15;
  return ((hmac.readUInt32BE(offset) & 0x7fffffff) % 1000000)
    .toString()
    .padStart(6, "0");
}

test.describe.serial("Local Auth, MFA, application and private Storage", () => {
  test.beforeAll(async () => {
    for (const [role, email] of Object.entries(accounts)) {
      const { data, error } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });
      if (error || !data.user)
        throw new Error("Local test account provisioning failed");
      ids[role] = data.user.id;
    }
    const catalog = await admin.rpc("ingest_catalog_opportunity", {
      data: {
        solicitation_number: `CATALOG-${suffix}`,
        title: `Public catalog ${suffix}`,
        agency: "Official Test",
        description: "Public synthetic metadata",
        location: "Maryland",
        trade: "janitorial",
        naics: "561720",
        response_deadline: "2099-01-01T00:00:00Z",
      },
    });
    if (catalog.error || !catalog.data)
      throw new Error("Local catalog fixture failed");
    catalogId = catalog.data;
    sql(`insert into public.organizations(id,name) values('${org}','Browser Security Test');
      insert into public.memberships values('${org}','${ids.owner}','owner'),('${org}','${ids.va}','va');
      insert into public.contractors(organization_id,user_id,company_name,email,trade,service_area) values
      ('${org}','${ids.a}','Isolated Contractor A','${accounts.a}','janitorial','Maryland'),
      ('${org}','${ids.b}','Isolated Contractor B','${accounts.b}','janitorial','Maryland');`);
  });
  test.afterAll(async () => {
    const documents = await admin
      .from("documents")
      .select("object_path")
      .eq("organization_id", org);
    if (documents.data?.length)
      await admin.storage
        .from("contractos-documents")
        .remove(documents.data.map((d) => d.object_path));
    const tables = [
      "analysis_runs",
      "audit_events",
      "approvals",
      "proposals",
      "pricing_scenarios",
      "requirements",
      "rates",
      "company_facts",
      "documents",
      "contractor_invitations",
      "contractors",
      "opportunities",
      "memberships",
    ];
    sql(
      tables
        .map((t) => `delete from public.${t} where organization_id='${org}';`)
        .join("\n") + `delete from public.organizations where id='${org}';`,
    );
    if (catalogId)
      sql(`delete from public.opportunity_catalog where id='${catalogId}';`);
    for (const id of Object.values(ids)) await admin.auth.admin.deleteUser(id);
  });
  test("Anonymous routes are protected and response security headers exist", async ({
    page,
    request,
  }) => {
    const response = await request.get("/");
    expect(response.status()).toBe(200);
    expect(response.headers()["content-security-policy"]).toContain(
      "frame-ancestors 'none'",
    );
    expect(response.headers()["content-security-policy"]).toContain(
      "script-src 'self' 'nonce-",
    );
    expect(response.headers()["x-content-type-options"]).toBe("nosniff");
    expect(response.headers()["cache-control"]).toContain("no-store");
    await page.goto("/workspace");
    await expect(page).toHaveURL(/\/login$/);
    expect((await request.get(`/api/documents/${randomUUID()}`)).status()).toBe(
      401,
    );
    expect(
      (
        await request.post("/api/integrations/sam", {
          headers: { authorization: "Bearer incorrect" },
        })
      ).status(),
    ).toBe(401);
  });
  test("Owner must enroll and verify TOTP before creating an opportunity; XSS stays text", async ({
    page,
    context,
  }) => {
    await page.goto("/login");
    await page
      .getByLabel("E-mail", { exact: true })
      .first()
      .fill(accounts.owner);
    await page
      .getByLabel("Mot de passe", { exact: true })
      .first()
      .fill(password);
    await page
      .getByRole("button", { name: "Se connecter", exact: true })
      .click();
    await expect(page).toHaveURL(/\/mfa/);
    await page.goto("/workspace");
    await expect(page).toHaveURL(/\/mfa/);
    await page
      .getByRole("button", { name: "Configurer l’authentificateur" })
      .click();
    const secret = await page.locator("pre").innerText();
    await page.getByLabel("Code à six chiffres").fill(totp(secret));
    await page.getByRole("button", { name: "Vérifier et continuer" }).click();
    await expect(page).toHaveURL(/\/workspace/);
    await expect(
      page.getByRole("heading", { name: "Décisions & exceptions" }),
    ).toBeVisible();
    const cookies = await context.cookies();
    const session = cookies.filter(
      (c) => c.name.startsWith("sb-") && c.name.includes("auth-token"),
    );
    expect(session.length).toBeGreaterThan(0);
    expect(session.every((c) => c.httpOnly)).toBe(true);
    expect(cookies.some((c) => c.name === "contractos-mfa-setup")).toBe(false);
    await page
      .getByText("Ajouter un marché · import manuel ou Maryland", {
        exact: true,
      })
      .click();
    const title = '<img src=x onerror="window.contractosXss=true">';
    await page.getByLabel("Titre", { exact: true }).fill(title);
    await page
      .getByLabel("Référence de sollicitation")
      .fill(`BROWSER-${suffix}`);
    await page
      .getByLabel("Date limite · UTC", { exact: true })
      .fill("2099-01-01T12:00");
    await page.getByLabel("Zone de service exacte").fill("Maryland");
    await page
      .getByRole("button", { name: "Enregistrer l’opportunité", exact: true })
      .click();
    await expect(
      page.getByRole("link", { name: title, exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => Object.hasOwn(window, "contractosXss")),
    ).toBe(false);
    await expect(
      page.getByText("Pricing missing or stale", { exact: true }),
    ).toBeVisible();
    await page
      .getByText("Enregistrer une décision humaine", { exact: true })
      .click();
    await page
      .getByLabel("Validation", { exact: true })
      .selectOption("submission");
    await page
      .getByLabel("Justification et références vérifiées")
      .fill("This incomplete bid must be blocked.");
    await page
      .getByRole("button", { name: "Enregistrer la décision", exact: true })
      .click();
    await expect(
      page.getByRole("alert").filter({ hasText: "Action refusée" }),
    ).toBeVisible();

    await page
      .getByRole("link", { name: "Catalogue SAM.gov", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Catalogue commun SAM.gov" }),
    ).toBeVisible();
    await page.getByLabel("Zone géographique").fill("Maryland");
    await page
      .getByRole("button", {
        name: "Enregistrer les filtres de l’organisation",
      })
      .click();
    await expect(page).toHaveURL(/catalog\?result=ok/);
    await expect(page.getByLabel("Zone géographique")).toHaveValue("Maryland");
    const card = page
      .locator("article")
      .filter({
        has: page.getByRole("heading", {
          name: `Public catalog ${suffix}`,
          exact: true,
        }),
      });
    await card.getByRole("button", { name: "Créer mon dossier privé" }).click();
    await expect(page).toHaveURL(/workspace\?opportunity=/);
    await expect(
      page.getByRole("link", { name: `Public catalog ${suffix}`, exact: true }),
    ).toBeVisible();
    const changed = await admin.rpc("ingest_catalog_opportunity", {
      data: {
        solicitation_number: `CATALOG-${suffix}`,
        title: `Public amendment ${suffix}`,
        agency: "Official Test",
        description: "Public synthetic metadata",
        location: "Maryland",
        trade: "janitorial",
        naics: "561720",
        response_deadline: "2099-01-01T00:00:00Z",
      },
    });
    expect(changed.error).toBeNull();
    await page.reload();
    await expect(
      page.getByText(
        "Catalog notice changed: refresh and review the private dossier",
        { exact: true },
      ),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Actualiser depuis le catalogue" })
      .click();
    await expect(
      page.getByRole("link", {
        name: `Public amendment ${suffix}`,
        exact: true,
      }),
    ).toBeVisible();
  });
  test("Contractor uploads privately and another contractor cannot download or self-verify", async ({
    page,
  }) => {
    await page.goto("/login");
    await page.getByLabel("E-mail", { exact: true }).first().fill(accounts.a);
    await page
      .getByLabel("Mot de passe", { exact: true })
      .first()
      .fill(password);
    await page
      .getByRole("button", { name: "Se connecter", exact: true })
      .click();
    await expect(page).toHaveURL(/\/portal/);
    await expect(
      page.getByRole("heading", { name: "Isolated Contractor A" }),
    ).toBeVisible();
    await expect(
      page.getByText("Isolated Contractor B", { exact: true }),
    ).toHaveCount(0);
    await page.getByText("Ajouter un document privé", { exact: true }).click();
    await page.getByLabel("Type", { exact: true }).selectOption("W9");
    await page.getByLabel("PDF, PNG ou JPEG · 10 Mo maximum").setInputFiles({
      name: "private-w9.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.7\nlocal test only"),
    });
    await page.getByRole("button", { name: "Importer", exact: true }).click();
    await expect(
      page.getByRole("link", { name: "private-w9.pdf", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Vérifier après inspection" }),
    ).toHaveCount(0);
    const href = await page
      .getByRole("link", { name: "private-w9.pdf", exact: true })
      .getAttribute("href");
    const own = await page.request.get(href!);
    expect(own.status()).toBe(200);
    expect(own.headers()["content-disposition"]).toContain("attachment");
    await page
      .getByRole("button", { name: "Déconnexion", exact: true })
      .click();
    await page.getByLabel("E-mail", { exact: true }).first().fill(accounts.b);
    await page
      .getByLabel("Mot de passe", { exact: true })
      .first()
      .fill(password);
    await page
      .getByRole("button", { name: "Se connecter", exact: true })
      .click();
    await expect(page).toHaveURL(/\/portal/);
    await expect(page.getByText("private-w9.pdf", { exact: true })).toHaveCount(
      0,
    );
    expect((await page.request.get(href!)).status()).toBe(404);
  });
  test("VA passes MFA but cannot see owner approval or qualification controls", async ({
    page,
  }) => {
    await page.goto("/login");
    await page.getByLabel("E-mail", { exact: true }).first().fill(accounts.va);
    await page
      .getByLabel("Mot de passe", { exact: true })
      .first()
      .fill(password);
    await page
      .getByRole("button", { name: "Se connecter", exact: true })
      .click();
    await expect(page).toHaveURL(/\/mfa/);
    await page
      .getByRole("button", { name: "Configurer l’authentificateur" })
      .click();
    await page
      .getByLabel("Code à six chiffres")
      .fill(totp(await page.locator("pre").innerText()));
    await page.getByRole("button", { name: "Vérifier et continuer" }).click();
    await expect(page).toHaveURL(/\/workspace/);
    await expect(
      page.getByText("Enregistrer une décision humaine", { exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole("link", { name: "Réseau prestataires", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Isolated Contractor A" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Vérifier après inspection" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", {
        name: "Qualifier après vérification W-9 / assurance / licence",
      }),
    ).toHaveCount(0);
  });
});
