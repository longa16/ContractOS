"use server";

import { randomBytes, randomUUID } from "node:crypto";
import { headers } from "next/headers";
import { redirect, unstable_rethrow } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { supabase, workerClient } from "@/lib/supabase";
import { requireInternal, requireOwner, requireUser } from "@/lib/auth";
import {
  opportunityInput,
  uuid,
  validateUpload,
  utcDateInput,
} from "@/lib/domain";
import { analyzeRfp, analyzeOpportunity } from "@/lib/ai";
import { extractPdf } from "@/lib/pdf";
import { scanBytes } from "@/lib/malware";

const text = (f: FormData, name: string, max = 4000) =>
  z
    .string()
    .max(max)
    .parse(f.get(name) ?? "");
const id = (f: FormData, name: string) => uuid.parse(f.get(name));
const integer = (f: FormData, name: string, min = 0, max = 100000000000) =>
  z.coerce.number().int().min(min).max(max).parse(f.get(name));
async function csrf() {
  const origin = (await headers()).get("origin");
  const configured = process.env.APP_ORIGIN;
  if (!configured || !origin || new URL(configured).origin !== origin)
    throw new Error("Invalid origin");
}
function checked(result: { error: unknown | null }) {
  if (result.error) throw new Error("Action rejected");
}
async function action(
  path: "/workspace" | "/workspace/catalog" | "/portal" | "/login" | "/mfa",
  work: () => Promise<string | void>,
  rerenderOnly = false,
) {
  let target = `${path}?result=ok`;
  try {
    await csrf();
    const result = await work();
    if (result) target = result;
  } catch (error) {
    unstable_rethrow(error);
    // No credentials, PII, document contents, or database error messages in logs.
    console.warn("ContractOS action rejected", { route: path });
    target = `${path}?result=blocked`;
  }
  revalidatePath(path);
  if (rerenderOnly && target === `${path}?result=ok`) return;
  revalidatePath("/workspace");
  revalidatePath("/portal");
  redirect(target);
}

export async function signIn(form: FormData) {
  return action("/login", async () => {
    const db = await supabase();
    const email = z.email().max(254).parse(form.get("email"));
    const password = z.string().min(1).max(128).parse(form.get("password"));
    checked(await db.auth.signInWithPassword({ email, password }));
    const { data } = await db.from("memberships").select("role");
    return data?.length ? "/mfa" : "/portal";
  });
}
export async function register(form: FormData) {
  return action("/login", async () => {
    const db = await supabase();
    const email = z.email().max(254).parse(form.get("email"));
    const password = z.string().min(14).max(128).parse(form.get("password"));
    const origin = new URL(process.env.APP_ORIGIN!).origin;
    // Internal permissions can only be provisioned by a trusted database administrator.
    const { error } = await db.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: `${origin}/auth/callback` },
    });
    if (error) throw new Error("Registration rejected");
    return "/login?result=confirm";
  });
}
export async function signOut() {
  return action("/login", async () => {
    const db = await supabase();
    checked(await db.auth.signOut());
    const { cookies } = await import("next/headers");
    const jar = await cookies();
    jar.set("contractos-mfa-setup", "", { path: "/mfa", maxAge: 0 });
    jar.set("contractos-invite", "", { path: "/workspace", maxAge: 0 });
    return "/login";
  });
}
export async function verifyMfa(form: FormData) {
  return action("/mfa", async () => {
    const { db } = await requireUser();
    const factorId = id(form, "factor_id");
    const code = z
      .string()
      .regex(/^\d{6}$/)
      .parse(form.get("code"));
    const { data, error } = await db.auth.mfa.challenge({ factorId });
    if (error || !data) throw new Error("MFA rejected");
    checked(await db.auth.mfa.verify({ factorId, challengeId: data.id, code }));
    const { cookies } = await import("next/headers");
    (await cookies()).set("contractos-mfa-setup", "", {
      path: "/mfa",
      maxAge: 0,
    });
    return "/workspace";
  });
}
export async function enrollMfa() {
  return action(
    "/mfa",
    async () => {
      const { db, user } = await requireUser();
      const { data: factors, error } = await db.auth.mfa.listFactors();
      if (error) throw new Error("MFA unavailable");
      if (factors.totp.some((f) => f.status === "verified"))
        throw new Error("Use existing factor");
      for (const factor of factors.all.filter(
        (f) => f.factor_type === "totp" && f.status === "unverified",
      ))
        checked(await db.auth.mfa.unenroll({ factorId: factor.id }));
      const result = await db.auth.mfa.enroll({
        factorType: "totp",
        friendlyName: "ContractOS",
      });
      if (result.error || !result.data)
        throw new Error("MFA enrollment rejected");
      // Supabase owns the encrypted MFA secret. This user's temporary provisioning URI
      // goes only in an HttpOnly setup cookie and private, noncached setup UI, never logs/URLs.
      const { cookies } = await import("next/headers");
      (await cookies()).set(
        "contractos-mfa-setup",
        JSON.stringify({
          id: result.data.id,
          uri: result.data.totp.uri,
          user: user.id,
        }),
        {
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          sameSite: "strict",
          path: "/mfa",
          maxAge: 300,
        },
      );
    },
    true,
  );
}

export async function createOpportunity(form: FormData) {
  return action("/workspace", async () => {
    const { db, org } = await requireInternal();
    const deadline = utcDateInput(text(form, "response_deadline", 100));
    const data = opportunityInput.parse({
      title: text(form, "title", 500),
      solicitation_number: text(form, "solicitation_number", 200),
      source: text(form, "source", 20),
      agency: text(form, "agency", 500),
      description: text(form, "description", 100000),
      location: text(form, "location", 500),
      trade: text(form, "trade", 100),
      response_deadline: deadline,
      source_url: text(form, "source_url", 2048) || undefined,
    });
    checked(await db.rpc("create_opportunity", { org, data }));
  });
}
export async function updateOpportunity(form: FormData) {
  return action("/workspace", async () => {
    const { db } = await requireInternal();
    const data = opportunityInput.parse({
      title: text(form, "title", 500),
      solicitation_number: "unchanged",
      source: "manual",
      agency: text(form, "agency", 500),
      description: text(form, "description", 100000),
      location: text(form, "location", 500),
      trade: text(form, "trade", 100),
      response_deadline: utcDateInput(text(form, "response_deadline", 100)),
      source_url: text(form, "source_url", 2048) || undefined,
      set_aside: text(form, "set_aside", 200) || undefined,
    });
    checked(
      await db.rpc("update_opportunity", {
        oid: id(form, "opportunity_id"),
        data,
      }),
    );
  });
}
export async function screenOpportunity(form: FormData) {
  return action("/workspace", async () => {
    const { db } = await requireInternal();
    if (form.get("ai_consent") !== "on") throw new Error("Consent required");
    const oid = id(form, "opportunity_id");
    const { data, error } = await db
      .from("opportunities")
      .select(
        "title,description,agency,location,trade,set_aside,naics,response_deadline",
      )
      .eq("id", oid)
      .single();
    if (error || !data) throw new Error("Not authorized");
    const analysis = await analyzeOpportunity(data);
    checked(await db.rpc("record_screening", { oid, analysis }));
  });
}
export async function inviteContractor(form: FormData) {
  return action("/workspace", async () => {
    const { db, org, user } = await requireOwner();
    const token = randomBytes(32).toString("base64url");
    checked(
      await db.rpc("invite_contractor", {
        org,
        email_address: z.email().max(254).parse(form.get("email")),
        token,
      }),
    );
    // No automatic outreach. Token is shown once to the owner for an approved communication.
    const { cookies } = await import("next/headers");
    (await cookies()).set(
      "contractos-invite",
      JSON.stringify({ token, org, user: user.id }),
      {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "strict",
        path: "/workspace",
        maxAge: 300,
      },
    );
  });
}
export async function acceptInvitation(form: FormData) {
  return action("/portal", async () => {
    const { db } = await requireUser();
    checked(
      await db.rpc("accept_invitation", {
        token: text(form, "token", 100),
        company: text(form, "company", 200),
        trade_name: text(form, "trade", 100),
        area: text(form, "area", 500),
      }),
    );
  });
}
export async function updateContractor(form: FormData) {
  return action("/portal", async () => {
    const { db } = await requireUser();
    checked(
      await db.rpc("update_contractor", {
        cid: id(form, "contractor_id"),
        capacity_value: integer(form, "capacity", 0, 1000000),
        is_available: form.get("available") === "on",
      }),
    );
  });
}
export async function qualifyContractor(form: FormData) {
  return action("/workspace", async () => {
    const { db } = await requireOwner();
    checked(
      await db.rpc("qualify_contractor", { cid: id(form, "contractor_id") }),
    );
  });
}
export async function uploadDocument(form: FormData) {
  const target = form.get("context") === "portal" ? "/portal" : "/workspace";
  return action(target, async () => {
    const { db, user } = await requireUser();
    let org: string;
    const cid = text(form, "contractor_id", 36) || null;
    const oid = text(form, "opportunity_id", 36) || null;
    if (cid) {
      uuid.parse(cid);
      const { data, error } = await db
        .from("contractors")
        .select("organization_id,user_id")
        .eq("id", cid)
        .single();
      if (error || !data) throw new Error("Not authorized");
      org = data.organization_id;
      if (data.user_id !== user.id) await requireInternal();
    } else {
      org = (await requireInternal()).org;
      uuid.parse(oid);
    }
    const file = form.get("file");
    if (!(file instanceof File) || file.size > 10485760 || file.size < 1)
      throw new Error("Invalid file");
    const bytes = new Uint8Array(await file.arrayBuffer());
    validateUpload(bytes, file.type, file.size);
    const did = randomUUID();
    const path = `${org}/${did}`;
    const expires = text(form, "expires_at", 100);
    const data = {
      contractor_id: cid,
      opportunity_id: oid,
      kind: z
        .enum([
          "W9",
          "INSURANCE",
          "LICENSE",
          "CAPABILITY",
          "QUOTE",
          "SOLICITATION",
          "AMENDMENT",
          "FINAL_PACKAGE",
          "OTHER",
        ])
        .parse(form.get("kind")),
      file_name: file.name.replace(/[\x00-\x1f\x7f/\\]/g, "_").slice(0, 255),
      size_bytes: file.size,
      mime_type: file.type,
      expires_at: expires ? utcDateInput(expires) : null,
      supersedes: text(form, "supersedes", 36) ? id(form, "supersedes") : null,
    };
    checked(await db.rpc("register_document", { org, did, data }));
    // A failed upload leaves an unverified metadata record; it cannot pass compliance.
    checked(
      await db.storage
        .from("contractos-documents")
        .upload(path, bytes, { contentType: file.type, upsert: false }),
    );
  });
}
export async function verifyDocument(form: FormData) {
  return action("/workspace", async () => {
    const { db } = await requireOwner();
    checked(await db.rpc("verify_document", { did: id(form, "document_id") }));
  });
}
export async function revokeDocument(form: FormData) {
  return action("/workspace", async () => {
    const { db } = await requireOwner();
    checked(
      await db.rpc("revoke_document", {
        did: id(form, "document_id"),
        reason: text(form, "reason"),
      }),
    );
  });
}
export async function scanDocument(form: FormData) {
  return action("/workspace", async () => {
    const { db } = await requireOwner();
    const did = id(form, "document_id");
    const { data, error } = await db
      .from("documents")
      .select("object_path,mime_type,size_bytes")
      .eq("id", did)
      .single();
    if (error || !data) throw new Error("Not authorized");
    const worker = workerClient();
    const file = await worker.storage
      .from("contractos-documents")
      .download(data.object_path);
    checked(file);
    if (!file.data || file.data.size > 10485760)
      throw new Error("Invalid document");
    const bytes = new Uint8Array(await file.data.arrayBuffer());
    validateUpload(bytes, data.mime_type, data.size_bytes);
    const report = await scanBytes(bytes);
    checked(
      await worker.rpc("record_document_scan", {
        did,
        digest: report.digest,
        clean: report.clean,
        engine: report.engine,
      }),
    );
  });
}
export async function addRequirement(form: FormData) {
  return action("/workspace", async () => {
    const { db } = await requireInternal();
    checked(
      await db.rpc("add_requirement", {
        oid: id(form, "opportunity_id"),
        data: {
          requirement: z
            .string()
            .min(1)
            .max(4000)
            .parse(form.get("requirement")),
          category: text(form, "category", 100) || "scope",
          mandatory: form.get("mandatory") === "on",
          source_document_id: id(form, "source_document_id"),
          page_number: integer(form, "page_number", 1, 10000),
          source_excerpt: z
            .string()
            .min(1)
            .max(8000)
            .parse(form.get("source_excerpt")),
        },
      }),
    );
  });
}
export async function reviewRequirement(form: FormData) {
  return action("/workspace", async () => {
    const { db } = await requireInternal();
    checked(
      await db.rpc("review_requirement", {
        rid: id(form, "requirement_id"),
        evidence_text: text(form, "evidence"),
        state: z
          .enum(["VERIFIED", "MISSING", "CONFLICT"])
          .parse(form.get("state")),
      }),
    );
  });
}
export async function extractRequirements(form: FormData) {
  return action("/workspace", async () => {
    const { db } = await requireInternal();
    if (form.get("ai_consent") !== "on")
      throw new Error("Explicit AI processing consent required");
    const did = id(form, "document_id");
    const { data: document, error } = await db
      .from("documents")
      .select("*")
      .eq("id", did)
      .single();
    if (
      error ||
      !document ||
      document.mime_type !== "application/pdf" ||
      !document.opportunity_id ||
      !["SOLICITATION", "AMENDMENT"].includes(document.kind)
    )
      throw new Error("Only public solicitation PDFs may be analyzed");
    const policy = await db
      .from("organizations")
      .select("require_malware_scan")
      .eq("id", document.organization_id)
      .single();
    if (
      policy.error ||
      !policy.data ||
      (policy.data.require_malware_scan && document.scan_status !== "CLEAN") ||
      document.revoked_at
    )
      throw new Error("Clean document required");
    checked(await db.rpc("audit_document_access", { did }));
    const file = await db.storage
      .from("contractos-documents")
      .download(document.object_path);
    checked(file);
    if (!file.data) throw new Error("Missing PDF");
    const bytes = new Uint8Array(await file.data.arrayBuffer());
    const pages = await extractPdf(bytes);
    const analysis = await analyzeRfp(pages);
    // All rows start MISSING. AI cannot mark evidence verified or invoke approvals.
    checked(
      await db.rpc("import_requirements", {
        oid: document.opportunity_id,
        did,
        extraction: analysis,
      }),
    );
  });
}
export async function addRate(form: FormData) {
  return action("/workspace", async () => {
    const { db } = await requireOwner();
    checked(
      await db.rpc("add_rate", {
        cid: id(form, "contractor_id"),
        data: {
          service: text(form, "service", 200),
          unit: text(form, "unit", 100),
          rate_cents: integer(form, "rate_cents", 1),
          expires_at: utcDateInput(text(form, "expires_at", 100)),
          source_document_id: id(form, "source_document_id"),
        },
      }),
    );
  });
}
export async function addFact(form: FormData) {
  return action("/workspace", async () => {
    const { db, org } = await requireOwner();
    const expiry = text(form, "expires_at", 100);
    checked(
      await db.rpc("add_company_fact", {
        org,
        claim_text: text(form, "claim"),
        source_text: text(form, "source"),
        expiry: expiry ? utcDateInput(expiry) : null,
      }),
    );
  });
}
export async function revokeFact(form: FormData) {
  return action("/workspace", async () => {
    const { db } = await requireOwner();
    checked(
      await db.rpc("revoke_company_fact", {
        fid: id(form, "fact_id"),
        reason: text(form, "reason"),
      }),
    );
  });
}
export async function createPricing(form: FormData) {
  return action("/workspace", async () => {
    const { db } = await requireInternal();
    checked(
      await db.rpc("create_pricing", {
        oid: id(form, "opportunity_id"),
        rid: id(form, "rate_id"),
        quantity: integer(form, "units", 1, 1000000),
        other_cents: integer(form, "other_cents"),
        basis: text(form, "basis"),
        markup: integer(form, "markup", 0, 100000),
      }),
    );
  });
}
export async function approveGate(form: FormData) {
  return action("/workspace", async () => {
    const { db } = await requireOwner();
    checked(
      await db.rpc("approve_gate", {
        oid: id(form, "opportunity_id"),
        gate_name: z
          .enum(["pursue", "contractor", "pricing", "rules", "submission"])
          .parse(form.get("gate")),
        approved: form.get("decision") === "approve",
        reason: text(form, "rationale"),
      }),
    );
  });
}
export async function generateProposal(form: FormData) {
  return action("/workspace", async () => {
    const { db } = await requireInternal();
    checked(
      await db.rpc("generate_proposal", { oid: id(form, "opportunity_id") }),
    );
  });
}
export async function recordSubmission(form: FormData) {
  return action("/workspace", async () => {
    const { db } = await requireOwner();
    checked(
      await db.rpc("record_submission", {
        oid: id(form, "opportunity_id"),
        receipt: text(form, "receipt"),
      }),
    );
  });
}
export async function revokeApprovals(form: FormData) {
  return action("/workspace", async () => {
    const { db } = await requireOwner();
    checked(
      await db.rpc("revoke_approvals", {
        oid: id(form, "opportunity_id"),
        reason: text(form, "reason"),
      }),
    );
  });
}

export async function selectCatalogOpportunity(form: FormData) {
  return action("/workspace/catalog", async () => {
    const { db, org } = await requireInternal();
    const result = await db.rpc("select_catalog_opportunity", {
      org,
      cid: id(form, "catalog_id"),
    });
    checked(result);
    return `/workspace?opportunity=${uuid.parse(result.data)}`;
  });
}
export async function refreshCatalogOpportunity(form: FormData) {
  return action("/workspace", async () => {
    const { db } = await requireInternal();
    const oid = id(form, "opportunity_id");
    checked(await db.rpc("refresh_catalog_opportunity", { oid }));
    return `/workspace?opportunity=${oid}`;
  });
}
export async function saveCatalogPreferences(form: FormData) {
  return action("/workspace/catalog", async () => {
    const { db, org } = await requireInternal();
    const data = {
      trade: text(form, "trade", 100),
      location: text(form, "location", 100),
      naics: text(form, "naics", 20),
      set_aside: text(form, "set_aside", 200),
    };
    checked(await db.rpc("save_catalog_preferences", { org, data }));
  });
}
