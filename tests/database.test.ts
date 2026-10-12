import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

// Real PostgreSQL engine (WASM). Only Supabase's auth/storage schemas are stubbed.
// No application policy or RPC is mocked. Service role is explicitly bypass-RLS.
const org = "10000000-0000-4000-8000-000000000001";
const org2 = "10000000-0000-4000-8000-000000000002";
const owner = "20000000-0000-4000-8000-000000000001";
const va = "20000000-0000-4000-8000-000000000002";
const userA = "20000000-0000-4000-8000-000000000003";
const userB = "20000000-0000-4000-8000-000000000004";
const outsider = "20000000-0000-4000-8000-000000000005";
const contractorA = "30000000-0000-4000-8000-000000000001";
const contractorB = "30000000-0000-4000-8000-000000000002";
const foreignContractor = "30000000-0000-4000-8000-000000000003";

test("PostgreSQL authorization and acquisition-to-submission workflow", async (t) => {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create schema storage;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz);
    create table auth.mfa_factors(id uuid primary key default gen_random_uuid(),user_id uuid,status text);
    create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz);
    create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
    create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid $$;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,unique(bucket_id,name));
    alter table storage.objects enable row level security;
    grant usage on schema public,auth,storage to authenticated,anon,service_role;
    grant execute on all functions in schema auth to authenticated,anon,service_role;
    grant select,insert,update,delete on storage.objects to authenticated;
  `);
  for (const path of (
    await readdir(new URL("../supabase/migrations/", import.meta.url))
  )
    .filter((p) => p.endsWith(".sql"))
    .sort()) {
    await db.exec(
      await readFile(
        new URL(`../supabase/migrations/${path}`, import.meta.url),
        "utf8",
      ),
    );
  }
  await db.exec(`
    insert into auth.users(id,email,email_confirmed_at) values
    ('${owner}','owner@example.test',now()),('${va}','va@example.test',now()),
    ('${userA}','a@example.test',now()),('${userB}','b@example.test',now()),('${outsider}','outsider@example.test',now());
    insert into organizations(id,name,require_malware_scan) values ('${org}','Facilities Prime',false),('${org2}','Other Prime',true);
    insert into memberships values ('${org}','${owner}','owner'),('${org}','${va}','va');
    insert into auth.mfa_factors(user_id,status) values ('${owner}','verified'),('${va}','verified');
    insert into auth.sessions(id,user_id) select id,id from auth.users;
    insert into contractors(id,organization_id,user_id,company_name,email,trade,service_area,capacity,available) values
    ('${contractorA}','${org}','${userA}','A','a@example.test','janitorial','Maryland',100,true),
    ('${contractorB}','${org}','${userB}','B','b@example.test','janitorial','Maryland',100,true),
    ('${foreignContractor}','${org2}',null,'Other','other@example.test','janitorial','Virginia',100,true);
  `);
  async function as<T>(
    user: string | null,
    aal: "aal1" | "aal2",
    work: () => Promise<T>,
    role = "authenticated",
  ) {
    await db.exec(`set role ${role}`);
    await db.query(`select set_config('request.jwt.claims',$1,false)`, [
      JSON.stringify({ sub: user, aal, session_id: user }),
    ]);
    try {
      return await work();
    } finally {
      await db.exec("reset role");
    }
  }
  async function rpc<T = string>(sql: string, args: unknown[] = []) {
    const result = await db.query<{ value: T }>(`select ${sql} as value`, args);
    return result.rows[0].value;
  }
  let oid: string;
  let source: string;
  let rid: string;
  let rate: string;
  let scenario: string;
  const opportunityData = {
    source: "manual",
    title: "Federal janitorial services",
    solicitation_number: "TEST-001",
    agency: "Test Agency",
    response_deadline: "2099-01-01T00:00:00Z",
    trade: "janitorial",
    location: "Maryland",
  };
  await t.test(
    "MFA required for internal read and write; anonymous has no access",
    async () => {
      await as(owner, "aal1", async () => {
        assert.equal(
          (await db.query("select * from organizations")).rows.length,
          0,
        );
        await assert.rejects(
          rpc("create_opportunity($1,$2)", [org, opportunityData]),
          /Not authorized/,
        );
      });
      await as(
        null,
        "aal1",
        async () => {
          await assert.rejects(
            db.query("select * from opportunities"),
            /permission denied/,
          );
        },
        "anon",
      );
    },
  );
  await t.test(
    "VA creates opportunity; duplicate source identities rejected",
    async () => {
      oid = await as(va, "aal2", () =>
        rpc("create_opportunity($1,$2)", [org, opportunityData]),
      );
      await as(va, "aal2", () =>
        assert.rejects(
          rpc("create_opportunity($1,$2)", [org, opportunityData]),
          /duplicate key/,
        ),
      );
      await as(owner, "aal2", () =>
        assert.rejects(
          rpc("create_opportunity($1,$2)", [org2, opportunityData]),
          /Not authorized/,
        ),
      );
    },
  );
  await t.test(
    "Revoked MFA enrollment and banned accounts cannot reuse an aal2 JWT",
    async () => {
      await db.query(
        "update auth.mfa_factors set status='unverified' where user_id=$1",
        [owner],
      );
      await as(owner, "aal2", () =>
        assert.rejects(
          rpc("create_opportunity($1,$2)", [
            org,
            { ...opportunityData, solicitation_number: "REVOKED-MFA" },
          ]),
          /Not authorized/,
        ),
      );
      await db.query(
        "update auth.mfa_factors set status='verified' where user_id=$1",
        [owner],
      );
      await db.query(
        "update auth.users set banned_until=now()+interval '1 day' where id=$1",
        [owner],
      );
      await as(owner, "aal2", () =>
        assert.rejects(
          rpc("create_opportunity($1,$2)", [
            org,
            { ...opportunityData, solicitation_number: "BANNED" },
          ]),
          /Not authorized/,
        ),
      );
      await db.query("update auth.users set banned_until=null where id=$1", [
        owner,
      ]);
    },
  );
  await t.test("A revoked session cannot reuse an unexpired JWT", async () => {
    await db.query("delete from auth.sessions where user_id=$1", [owner]);
    await as(owner, "aal2", () =>
      assert.rejects(
        rpc("create_opportunity($1,$2)", [
          org,
          { ...opportunityData, solicitation_number: "LOGGED-OUT" },
        ]),
        /Not authorized/,
      ),
    );
    await as(owner, "aal2", async () => {
      assert.equal(
        (await db.query("select * from organizations")).rows.length,
        0,
      );
    });
    await db.query("insert into auth.sessions(id,user_id) values($1,$1)", [
      owner,
    ]);
  });
  await t.test(
    "No direct status, role, evidence or audit tampering",
    async () => {
      await as(owner, "aal2", async () => {
        await assert.rejects(
          db.query(`update opportunities set status='READY'`),
          /permission denied/,
        );
        await assert.rejects(
          db.query(
            `insert into memberships values ('${org}','${outsider}','owner')`,
          ),
          /permission denied/,
        );
        await assert.rejects(
          db.query("delete from audit_events"),
          /permission denied/,
        );
        await assert.rejects(
          rpc("private.touch_opportunity($1)", [oid]),
          /permission denied/,
        );
        await assert.rejects(
          rpc("ingest_opportunity($1,$2)", [org, opportunityData]),
          /permission denied/,
        );
      });
      await as(va, "aal2", () =>
        assert.rejects(
          rpc("approve_gate($1,$2,true,$3)", [oid, "pursue", "Looks viable"]),
          /Not authorized/,
        ),
      );
      await as(owner, "aal2", () =>
        rpc("approve_gate($1,$2,true,$3)", [
          oid,
          "pursue",
          "Owner authorizes investigation",
        ]),
      );
    },
  );
  await t.test(
    "Contractor and cross-company isolation, including storage paths",
    async () => {
      await as(userA, "aal1", async () => {
        const rows = await db.query<{ id: string }>(
          "select id from contractors",
        );
        assert.deepEqual(
          rows.rows.map((r) => r.id),
          [contractorA],
        );
        assert.equal(
          (await db.query("select * from opportunities")).rows.length,
          0,
        );
        await assert.rejects(
          rpc("update_contractor($1,10,true)", [contractorB]),
          /Not authorized/,
        );
        await assert.rejects(
          rpc("qualify_contractor($1)", [contractorA]),
          /Not authorized/,
        );
        await assert.rejects(
          rpc("register_document($1,$2,$3)", [
            org,
            crypto.randomUUID(),
            {
              contractor_id: contractorB,
              kind: "W9",
              file_name: "w9.pdf",
              size_bytes: 100,
              mime_type: "application/pdf",
            },
          ]),
          /Not authorized/,
        );
      });
      await as(owner, "aal2", () =>
        assert.rejects(
          rpc("register_document($1,$2,$3)", [
            org,
            crypto.randomUUID(),
            {
              contractor_id: foreignContractor,
              kind: "W9",
              file_name: "w9.pdf",
              size_bytes: 100,
              mime_type: "application/pdf",
            },
          ]),
          /foreign key/,
        ),
      );
    },
  );
  await t.test(
    "An internal member cannot bypass MFA through a contractor identity",
    async () => {
      await db.query("update contractors set user_id=$1 where id=$2", [
        owner,
        contractorA,
      ]);
      await as(owner, "aal1", async () => {
        assert.equal(
          (await db.query("select * from contractors")).rows.length,
          0,
        );
        await assert.rejects(
          rpc("update_contractor($1,10,true)", [contractorA]),
          /Not authorized/,
        );
      });
      await db.query("update contractors set user_id=$1 where id=$2", [
        userA,
        contractorA,
      ]);
    },
  );
  async function document(
    kind: string,
    contractor_id: string | null,
    opportunity_id: string | null,
    expires_at: string | null = null,
    supersedes: string | null = null,
  ) {
    const did = crypto.randomUUID();
    await as(
      contractor_id ? userA : owner,
      contractor_id ? "aal1" : "aal2",
      () =>
        rpc("register_document($1,$2,$3)", [
          org,
          did,
          {
            contractor_id,
            opportunity_id,
            kind,
            file_name: `${kind}.pdf`,
            mime_type: "application/pdf",
            size_bytes: 100,
            expires_at,
            supersedes,
          },
        ]),
    );
    await as(
      contractor_id ? userA : owner,
      contractor_id ? "aal1" : "aal2",
      () =>
        db.query("insert into storage.objects(bucket_id,name) values ($1,$2)", [
          "contractos-documents",
          `${org}/${did}`,
        ]),
    );
    await as(owner, "aal2", () => rpc("verify_document($1)", [did]));
    return did;
  }
  await t.test(
    "Metadata without uploaded object cannot be verified; uploads are append-only",
    async () => {
      const did = crypto.randomUUID();
      await as(userA, "aal1", () =>
        rpc("register_document($1,$2,$3)", [
          org,
          did,
          {
            contractor_id: contractorA,
            kind: "OTHER",
            file_name: "test.pdf",
            size_bytes: 100,
            mime_type: "application/pdf",
          },
        ]),
      );
      await as(owner, "aal2", () =>
        assert.rejects(rpc("verify_document($1)", [did]), /Upload missing/),
      );
      await as(userB, "aal1", () =>
        assert.rejects(
          db.query(
            "insert into storage.objects(bucket_id,name) values ($1,$2)",
            ["contractos-documents", `${org}/${did}`],
          ),
          /row-level security/,
        ),
      );
      await as(userA, "aal1", async () => {
        await db.query(
          "insert into storage.objects(bucket_id,name) values ($1,$2)",
          ["contractos-documents", `${org}/${did}`],
        );
        assert.equal(
          (
            await db.query("update storage.objects set name=$1 returning id", [
              "hijacked",
            ])
          ).rows.length,
          0,
        );
        assert.equal(
          (await db.query("delete from storage.objects returning id")).rows
            .length,
          0,
        );
      });
      await as(owner, "aal2", () => rpc("verify_document($1)", [did]));
      await as(userB, "aal1", async () => {
        assert.equal(
          (await db.query("select * from documents")).rows.length,
          0,
        );
        assert.equal(
          (await db.query("select * from storage.objects")).rows.length,
          0,
        );
        await assert.rejects(
          rpc("audit_document_access($1)", [did]),
          /Not authorized/,
        );
      });
    },
  );
  await t.test(
    "Malware quarantine is on by default and users cannot forge scanner results",
    async () => {
      assert.equal(
        (
          await db.query<{ require_malware_scan: boolean }>(
            "select require_malware_scan from organizations where id=$1",
            [org2],
          )
        ).rows[0].require_malware_scan,
        true,
      );
      await db.query(
        "update organizations set require_malware_scan=true where id=$1",
        [org],
      );
      const did = crypto.randomUUID();
      await as(userA, "aal1", () =>
        rpc("register_document($1,$2,$3)", [
          org,
          did,
          {
            contractor_id: contractorA,
            kind: "OTHER",
            file_name: "quarantine.pdf",
            size_bytes: 100,
            mime_type: "application/pdf",
          },
        ]),
      );
      await as(userA, "aal1", () =>
        db.query("insert into storage.objects(bucket_id,name) values($1,$2)", [
          "contractos-documents",
          `${org}/${did}`,
        ]),
      );
      await as(owner, "aal2", () =>
        assert.rejects(
          rpc("verify_document($1)", [did]),
          /Clean malware scan required/,
        ),
      );
      await as(owner, "aal2", () =>
        assert.rejects(
          rpc("record_document_scan($1,$2,true,$3)", [
            did,
            "a".repeat(64),
            "ClamAV test engine",
          ]),
          /permission denied/,
        ),
      );
      await as(owner, "aal2", () =>
        assert.rejects(
          rpc("audit_document_access($1)", [did]),
          /Not authorized/,
        ),
      );
      await as(
        null,
        "aal1",
        () =>
          rpc("record_document_scan($1,$2,true,$3)", [
            did,
            "a".repeat(64),
            "Trusted worker fixture",
          ]),
        "service_role",
      );
      await as(owner, "aal2", () => rpc("verify_document($1)", [did]));
      await as(owner, "aal2", () => rpc("audit_document_access($1)", [did]));
      await as(
        null,
        "aal1",
        () =>
          rpc("record_document_scan($1,$2,false,$3)", [
            did,
            "a".repeat(64),
            "Trusted worker fixture",
          ]),
        "service_role",
      );
      await as(userA, "aal1", () =>
        assert.rejects(
          rpc("audit_document_access($1)", [did]),
          /Not authorized/,
        ),
      );
      await as(owner, "aal2", () =>
        assert.rejects(rpc("verify_document($1)", [did]), /revoked/),
      );
      await db.query(
        "update organizations set require_malware_scan=false where id=$1",
        [org],
      );
    },
  );
  await t.test(
    "Contractor qualification and pricing require verified documents",
    async () => {
      await as(owner, "aal2", () =>
        assert.rejects(
          rpc("qualify_contractor($1)", [contractorA]),
          /Missing verified/,
        ),
      );
      for (const kind of ["W9", "INSURANCE", "LICENSE"])
        await document(
          kind,
          contractorA,
          null,
          kind === "W9" ? null : "2099-01-01T00:00:00Z",
        );
      await as(owner, "aal2", () =>
        rpc("qualify_contractor($1)", [contractorA]),
      );
      const quote = await document(
        "QUOTE",
        contractorA,
        null,
        "2099-01-01T00:00:00Z",
      );
      rate = await as(owner, "aal2", () =>
        rpc("add_rate($1,$2)", [
          contractorA,
          {
            service: "Janitorial",
            unit: "hour",
            rate_cents: 1234,
            expires_at: "2099-01-01T00:00:00Z",
            source_document_id: quote,
          },
        ]),
      );
      await as(va, "aal2", () =>
        assert.rejects(
          rpc("add_rate($1,$2)", [contractorA, {}]),
          /Not authorized/,
        ),
      );
    },
  );
  await t.test(
    "Traceable matrix: verified sources and owner-only evidence verification",
    async () => {
      source = await document("SOLICITATION", null, oid);
      rid = await as(va, "aal2", () =>
        rpc("add_requirement($1,$2)", [
          oid,
          {
            requirement: "Liability insurance required",
            mandatory: true,
            source_document_id: source,
            page_number: 1,
            source_excerpt: "Liability insurance is required.",
          },
        ]),
      );
      await as(va, "aal2", () =>
        assert.rejects(
          rpc("review_requirement($1,$2,$3)", [
            rid,
            "Verified policy reference",
            "VERIFIED",
          ]),
          /Not authorized/,
        ),
      );
      await as(owner, "aal2", () =>
        assert.rejects(
          rpc("review_requirement($1,$2,$3)", [rid, "", "VERIFIED"]),
          /check constraint/,
        ),
      );
      await as(owner, "aal2", () =>
        rpc("review_requirement($1,$2,$3)", [
          rid,
          "Owner inspected policy reference INS-123",
          "VERIFIED",
        ]),
      );
      const blocks = await as(owner, "aal2", () =>
        rpc<string[]>("compliance_blockers($1)", [oid]),
      );
      assert(blocks.includes("Pricing missing or stale"));
      await as(owner, "aal2", () =>
        assert.rejects(
          rpc("approve_gate($1,$2,true,$3)", [oid, "submission", "Submit"]),
          /Submission blocked/,
        ),
      );
    },
  );
  await t.test("Deterministic pricing and proposal provenance", async () => {
    await as(owner, "aal2", () =>
      rpc("add_company_fact($1,$2,$3,null)", [
        org,
        "Company operates in Maryland",
        "Verified business registration BR-1",
      ]),
    );
    scenario = await as(va, "aal2", () =>
      rpc("create_pricing($1,$2,10,1000,$3,1500)", [
        oid,
        rate,
        "Materials, management and contingency quote C-1",
      ]),
    );
    const price = await db.query<{ total_cents: number }>(
      "select total_cents from pricing_scenarios where id=$1",
      [scenario],
    );
    assert.equal(Number(price.rows[0].total_cents), 15341);
    await as(va, "aal2", () =>
      assert.rejects(
        rpc("generate_proposal($1)", [oid]),
        /Pricing approval required/,
      ),
    );
    for (const gate of ["rules", "contractor", "pricing"])
      await as(owner, "aal2", () =>
        rpc("approve_gate($1,$2,true,$3)", [
          oid,
          gate,
          "Verified opportunity-specific subcontracting/set-aside and strategy",
        ]),
      );
    const pid = await as(va, "aal2", () => rpc("generate_proposal($1)", [oid]));
    const proposal = await db.query<{
      content: {
        claims: { fact_id: string; source: string }[];
        compliance_responses: { requirement_id: string }[];
      };
    }>("select content from proposals where id=$1", [pid]);
    assert(proposal.rows[0].content.claims[0].fact_id);
    assert.equal(
      proposal.rows[0].content.compliance_responses[0].requirement_id,
      rid,
    );
  });
  await t.test(
    "Amendments invalidate pricing and all downstream gates",
    async () => {
      await document("FINAL_PACKAGE", null, oid);
      assert.deepEqual(
        await as(owner, "aal2", () =>
          rpc<string[]>("compliance_blockers($1)", [oid]),
        ),
        [],
      );
      await as(owner, "aal2", () =>
        rpc("approve_gate($1,$2,true,$3)", [
          oid,
          "submission",
          "Final package reviewed",
        ]),
      );
      const amendment = await document("AMENDMENT", null, oid, null, source);
      const blocks = await as(owner, "aal2", () =>
        rpc<string[]>("compliance_blockers($1)", [oid]),
      );
      assert(blocks.includes("Solicitation/amendment not fully reviewed"));
      assert(blocks.includes("Pricing missing or stale"));
      await as(owner, "aal2", () =>
        assert.rejects(
          rpc("record_submission($1,$2)", [oid, "receipt"]),
          /Submission blocked/,
        ),
      );
      const arid = await as(va, "aal2", () =>
        rpc("add_requirement($1,$2)", [
          oid,
          {
            requirement: "Amended schedule reviewed",
            mandatory: true,
            source_document_id: amendment,
            page_number: 1,
            source_excerpt: "Schedule is amended.",
          },
        ]),
      );
      await as(owner, "aal2", () =>
        rpc("review_requirement($1,$2,$3)", [
          arid,
          "Reviewed against current schedule S-2",
          "VERIFIED",
        ]),
      );
      await as(owner, "aal2", () =>
        rpc("review_requirement($1,$2,$3)", [
          rid,
          "Insurance requirement re-reviewed against amendment",
          "VERIFIED",
        ]),
      );
      scenario = await as(va, "aal2", () =>
        rpc("create_pricing($1,$2,10,1000,$3,1500)", [
          oid,
          rate,
          "Amendment priced",
        ]),
      );
      for (const gate of ["rules", "contractor", "pricing"])
        await as(owner, "aal2", () =>
          rpc("approve_gate($1,$2,true,$3)", [
            oid,
            gate,
            "Re-approved current revision",
          ]),
        );
      await as(va, "aal2", () => rpc("generate_proposal($1)", [oid]));
      await document("FINAL_PACKAGE", null, oid);
    },
  );
  await t.test(
    "Expired evidence blocks submission even without a user mutation",
    async () => {
      assert.deepEqual(
        await as(owner, "aal2", () =>
          rpc<string[]>("compliance_blockers($1)", [oid]),
        ),
        [],
      );
      await db.exec(
        `update documents set expires_at=now()-interval '1 day' where kind='INSURANCE' and contractor_id='${contractorA}'`,
      );
      assert(
        (
          await as(owner, "aal2", () =>
            rpc<string[]>("compliance_blockers($1)", [oid]),
          )
        ).includes("Contractor document missing or expired: INSURANCE"),
      );
      await as(owner, "aal2", () =>
        assert.rejects(
          rpc("approve_gate($1,$2,true,$3)", [oid, "submission", "Submit"]),
          /Submission blocked/,
        ),
      );
      await db.exec(
        `update documents set expires_at='2099-01-01' where kind='INSURANCE' and contractor_id='${contractorA}'`,
      );
    },
  );
  await t.test(
    "A replaced final PDF cannot reuse the approval for its predecessor",
    async () => {
      await as(owner, "aal2", () =>
        rpc("approve_gate($1,$2,true,$3)", [
          oid,
          "submission",
          "Approve existing immutable PDF",
        ]),
      );
      await document("FINAL_PACKAGE", null, oid);
      await as(owner, "aal2", () =>
        assert.rejects(
          rpc("record_submission($1,$2)", [oid, "wrong artifact"]),
          /Submission blocked/,
        ),
      );
    },
  );
  await t.test(
    "Authorized human records submission; no autonomous external sending",
    async () => {
      await as(owner, "aal2", () =>
        rpc("approve_gate($1,$2,true,$3)", [
          oid,
          "submission",
          "Final package and forms inspected",
        ]),
      );
      await as(va, "aal2", () =>
        assert.rejects(
          rpc("record_submission($1,$2)", [oid, "receipt"]),
          /Not authorized/,
        ),
      );
      await as(owner, "aal2", () =>
        rpc("record_submission($1,$2)", [oid, "Portal receipt TEST-RECEIPT-1"]),
      );
      assert.equal(
        (
          await db.query<{ status: string }>(
            "select status from opportunities where id=$1",
            [oid],
          )
        ).rows[0].status,
        "SUBMITTED",
      );
      const logs = await db.query<{ action: string }>(
        "select action from audit_events",
      );
      assert(logs.rows.some((r) => r.action === "submission.recorded"));
      assert(logs.rows.some((r) => r.action === "approval.submission"));
    },
  );
  await t.test(
    "Closed dossiers reject direct RPC edits despite hidden UI controls",
    async () => {
      await as(va, "aal2", () =>
        assert.rejects(
          rpc("review_requirement($1,$2,$3)", [rid, "tampered", "MISSING"]),
          /Opportunity closed/,
        ),
      );
      await as(va, "aal2", () =>
        assert.rejects(
          rpc("create_pricing($1,$2,10,0,$3,1000)", [oid, rate, "tampered"]),
          /Opportunity closed/,
        ),
      );
      await as(va, "aal2", () =>
        assert.rejects(
          rpc("generate_proposal($1)", [oid]),
          /Opportunity closed/,
        ),
      );
      await as(owner, "aal2", () =>
        assert.rejects(
          rpc("revoke_approvals($1,$2)", [oid, "already submitted"]),
          /Opportunity closed/,
        ),
      );
    },
  );
  await t.test(
    "Email-bound, expiring, single-use contractor invitation",
    async () => {
      const token = "test-token-".padEnd(50, "x");
      await as(owner, "aal2", () =>
        rpc("invite_contractor($1,$2,$3)", [
          org,
          "outsider@example.test",
          token,
        ]),
      );
      await as(userA, "aal1", () =>
        assert.rejects(
          rpc("accept_invitation($1,$2,$3,$4)", [
            token,
            "Wrong",
            "janitorial",
            "Maryland",
          ]),
          /Invalid invitation/,
        ),
      );
      await as(outsider, "aal1", () =>
        rpc("accept_invitation($1,$2,$3,$4)", [
          token,
          "New company",
          "janitorial",
          "Maryland",
        ]),
      );
      await as(outsider, "aal1", () =>
        assert.rejects(
          rpc("accept_invitation($1,$2,$3,$4)", [
            token,
            "Duplicate",
            "janitorial",
            "Maryland",
          ]),
          /Invalid invitation/,
        ),
      );
      await as(outsider, "aal1", async () => {
        assert.equal(
          (await db.query("select * from memberships")).rows.length,
          0,
        );
        assert.equal(
          (await db.query("select * from opportunities")).rows.length,
          0,
        );
      });
    },
  );
  await t.test(
    "Ingestion deduplicates identical notices and invalidates changed input",
    async () => {
      const data = { ...opportunityData, solicitation_number: "SAM-NOTICE-1" };
      const id1 = await as(
        null,
        "aal1",
        () => rpc("ingest_opportunity($1,$2)", [org, data]),
        "service_role",
      );
      const id2 = await as(
        null,
        "aal1",
        () => rpc("ingest_opportunity($1,$2)", [org, data]),
        "service_role",
      );
      assert.equal(id1, id2);
      assert.equal(
        (
          await db.query<{ revision: number }>(
            "select revision from opportunities where id=$1",
            [id1],
          )
        ).rows[0].revision,
        1,
      );
      await as(
        null,
        "aal1",
        () =>
          rpc("ingest_opportunity($1,$2)", [
            org,
            { ...data, title: "Changed terms" },
          ]),
        "service_role",
      );
      assert.equal(
        (
          await db.query<{ revision: number }>(
            "select revision from opportunities where id=$1",
            [id1],
          )
        ).rows[0].revision,
        2,
      );
      await as(
        null,
        "aal1",
        () =>
          rpc("ingest_opportunity($1,$2)", [
            org,
            { ...data, title: "Changed terms", location: "Virginia" },
          ]),
        "service_role",
      );
      assert.equal(
        (
          await db.query<{ revision: number }>(
            "select revision from opportunities where id=$1",
            [id1],
          )
        ).rows[0].revision,
        3,
      );
      await db.query(
        "update opportunities set status='SUBMITTED' where id=$1",
        [id1],
      );
      await as(
        null,
        "aal1",
        () =>
          rpc("ingest_opportunity($1,$2)", [
            org,
            { ...data, title: "Later update" },
          ]),
        "service_role",
      );
      assert.equal(
        (
          await db.query<{ revision: number }>(
            "select revision from opportunities where id=$1",
            [id1],
          )
        ).rows[0].revision,
        3,
      );
    },
  );
  await t.test(
    "Revoked company claims are excluded from later proposal drafts",
    async () => {
      const newOid = await as(va, "aal2", () =>
        rpc("create_opportunity($1,$2)", [
          org,
          { ...opportunityData, solicitation_number: "FACT-REVOCATION" },
        ]),
      );
      await as(owner, "aal2", () =>
        rpc("approve_gate($1,$2,true,$3)", [
          newOid,
          "pursue",
          "Proceed with verified facts only",
        ]),
      );
      const fid = await as(owner, "aal2", () =>
        rpc("add_company_fact($1,$2,$3,null)", [
          org,
          "Claim to withdraw",
          "Reference superseded",
        ]),
      );
      await as(va, "aal2", () =>
        assert.rejects(
          rpc("revoke_company_fact($1,$2)", [fid, "Correction"]),
          /Not authorized/,
        ),
      );
      await as(owner, "aal2", () =>
        rpc("revoke_company_fact($1,$2)", [fid, "Unsupported claim withdrawn"]),
      );
      await as(va, "aal2", () =>
        rpc("create_pricing($1,$2,10,1000,$3,1500)", [
          newOid,
          rate,
          "Verified base quote",
        ]),
      );
      await as(owner, "aal2", () =>
        rpc("approve_gate($1,$2,true,$3)", [
          newOid,
          "pricing",
          "Verified financial strategy",
        ]),
      );
      const pid = await as(va, "aal2", () =>
        rpc("generate_proposal($1)", [newOid]),
      );
      const rows = await db.query<{
        content: { claims: { fact_id: string }[] };
      }>("select content from proposals where id=$1", [pid]);
      assert(rows.rows[0].content.claims.length > 0);
      assert(!rows.rows[0].content.claims.some((c) => c.fact_id === fid));
    },
  );
  await db.close();
});
