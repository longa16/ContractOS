-- ContractOS MVP. Authorization is enforced in PostgreSQL, including MFA.
create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;

create table public.organizations (
 id uuid primary key default gen_random_uuid(), name text not null check(length(name) between 1 and 200),
 require_malware_scan boolean not null default true
);
create table public.memberships (
 organization_id uuid not null references public.organizations(id),
 user_id uuid not null references auth.users(id), role text not null check(role in ('owner','va')),
 primary key(organization_id,user_id)
);
create function private.role_for(org uuid) returns text language sql stable security definer
 set search_path = '' as $$
 select role from public.memberships where organization_id=org and user_id=auth.uid()
 and auth.jwt()->>'aal'='aal2'
 and exists(select 1 from auth.users u where u.id=auth.uid() and u.email_confirmed_at is not null and (u.banned_until is null or u.banned_until<=now()))
 and exists(select 1 from auth.mfa_factors f where f.user_id=auth.uid() and f.status='verified')
$$;
create function private.require_role(org uuid, owner_only boolean default false) returns void
 language plpgsql stable security definer set search_path = '' as $$
begin
 if private.role_for(org) is null or (owner_only and private.role_for(org)<>'owner') then
  raise exception 'Not authorized' using errcode='42501';
 end if;
end $$;

create table public.opportunities (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id),
 source text not null check(source in ('manual','sam','maryland')),
 solicitation_number text not null check(length(solicitation_number) between 1 and 200),
 title text not null check(length(title) between 1 and 500), agency text not null default '',
 description text not null default '' check(length(description)<=100000),
 location text not null default '', trade text not null default 'janitorial', naics text,
 set_aside text, source_url text check(source_url is null or source_url ~ '^https://[A-Za-z0-9.-]+(:443)?([/?#][^[:space:]]*)?$'),
 response_deadline timestamptz not null check(isfinite(response_deadline)),
 estimated_value_cents bigint check(estimated_value_cents between 0 and 100000000000000),
 status text not null default 'NEW' check(status in ('NEW','SOURCING','PRICING','PROPOSAL','READY','SUBMITTED','REJECTED','AWARDED','LOST')),
 revision integer not null default 1, created_at timestamptz not null default now(),
 unique(organization_id,source,solicitation_number), unique(organization_id,id)
);
create table public.contractors (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id),
 user_id uuid references auth.users(id), company_name text not null check(length(company_name) between 1 and 200),
 email text not null, trade text not null, service_area text not null,
 capacity integer not null default 0 check(capacity>=0), available boolean not null default false,
 status text not null default 'DOCUMENTS_PENDING' check(status in ('DOCUMENTS_PENDING','QUALIFIED','INACTIVE')),
 created_at timestamptz not null default now(), unique(organization_id,id), unique(organization_id,user_id)
);
create table public.contractor_invitations (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id),
 email text not null, token_hash text not null unique, expires_at timestamptz not null,
 accepted_at timestamptz, created_by uuid not null references auth.users(id)
);
create function private.contractor_access(org uuid, contractor uuid) returns boolean
 language sql stable security definer set search_path = '' as $$
 select exists(select 1 from auth.users u where u.id=auth.uid() and u.email_confirmed_at is not null and (u.banned_until is null or u.banned_until<=now()))
 and case when exists(select 1 from public.memberships where user_id=auth.uid())
 then private.role_for(org) is not null else exists(
 select 1 from public.contractors where id=contractor and organization_id=org and user_id=auth.uid()) end
$$;

create table public.documents (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id),
 contractor_id uuid, opportunity_id uuid,
 kind text not null check(kind in ('W9','INSURANCE','LICENSE','CAPABILITY','QUOTE','SOLICITATION','AMENDMENT','FINAL_PACKAGE','OTHER')),
 file_name text not null check(length(file_name) between 1 and 255),
 object_path text not null unique, size_bytes integer not null check(size_bytes between 1 and 10485760),
 mime_type text not null check(mime_type in ('application/pdf','image/png','image/jpeg')),
 expires_at timestamptz check(expires_at is null or isfinite(expires_at)), verified_at timestamptz, verified_by uuid references auth.users(id),
 revoked_at timestamptz, revoked_by uuid references auth.users(id), revoke_reason text,
 scan_status text not null default 'PENDING' check(scan_status in ('PENDING','CLEAN','REJECTED')),
 scanned_at timestamptz, scanned_sha256 text, scan_engine text,
 supersedes uuid, bound_revision integer, retained_until timestamptz not null default now()+interval '7 years',
 created_at timestamptz not null default now(), created_by uuid not null references auth.users(id),
 unique(organization_id,id),
 check((contractor_id is not null)::integer+(opportunity_id is not null)::integer=1),
 foreign key(organization_id,contractor_id) references public.contractors(organization_id,id),
 foreign key(organization_id,opportunity_id) references public.opportunities(organization_id,id),
 foreign key(organization_id,supersedes) references public.documents(organization_id,id),
 check(object_path=organization_id::text || '/' || id::text)
);
create table public.requirements (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null,
 opportunity_id uuid not null, requirement text not null check(length(requirement) between 1 and 4000),
 category text not null default 'scope', mandatory boolean not null default true,
 source_document_id uuid not null, page_number integer not null check(page_number>0),
 source_excerpt text not null check(length(source_excerpt) between 1 and 8000),
 evidence text, status text not null default 'MISSING' check(status in ('MISSING','CONFLICT','VERIFIED')),
 verified_by uuid references auth.users(id), reviewed_at timestamptz, unique(organization_id,id),
 foreign key(organization_id,opportunity_id) references public.opportunities(organization_id,id),
 foreign key(organization_id,source_document_id) references public.documents(organization_id,id),
 check(status<>'VERIFIED' or (verified_by is not null and length(btrim(evidence))>0))
);
create function private.evidence_valid(did uuid) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.documents d join public.organizations o on o.id=d.organization_id
 where d.id=did and d.verified_at is not null and d.revoked_at is null and (d.expires_at is null or d.expires_at>now())
 and d.scan_status<>'REJECTED' and (not o.require_malware_scan or d.scan_status='CLEAN'))
$$;
create table public.rates (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null, contractor_id uuid not null,
 service text not null, unit text not null, rate_cents bigint not null check(rate_cents between 1 and 100000000000),
 expires_at timestamptz not null check(isfinite(expires_at)), source_document_id uuid not null, verified_by uuid references auth.users(id),
 unique(organization_id,id),
 foreign key(organization_id,contractor_id) references public.contractors(organization_id,id),
 foreign key(organization_id,source_document_id) references public.documents(organization_id,id)
);
create table public.company_facts (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id),
 claim text not null check(length(claim) between 1 and 4000), source_reference text not null,
 verified_by uuid not null references auth.users(id), expires_at timestamptz check(expires_at is null or isfinite(expires_at)), unique(organization_id,id)
);
create table public.pricing_scenarios (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null, opportunity_id uuid not null,
 contractor_id uuid not null, rate_id uuid not null, units integer not null check(units between 1 and 1000000),
 other_cost_cents bigint not null check(other_cost_cents between 0 and 100000000000),
 cost_basis text not null check(length(cost_basis) between 1 and 4000),
 markup_bps integer not null check(markup_bps between 0 and 100000), total_cents bigint not null check(total_cents between 1 and 100000000000000),
 revision integer not null, created_at timestamptz not null default now(), unique(organization_id,id),
 foreign key(organization_id,opportunity_id) references public.opportunities(organization_id,id),
 foreign key(organization_id,contractor_id) references public.contractors(organization_id,id),
 foreign key(organization_id,rate_id) references public.rates(organization_id,id)
);
create table public.proposals (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null, opportunity_id uuid not null,
 scenario_id uuid not null, revision integer not null, content jsonb not null,
 created_at timestamptz not null default now(), unique(organization_id,id),
 foreign key(organization_id,opportunity_id) references public.opportunities(organization_id,id),
 foreign key(organization_id,scenario_id) references public.pricing_scenarios(organization_id,id)
);
create table public.approvals (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null, opportunity_id uuid not null,
 gate text not null check(gate in ('pursue','contractor','pricing','submission','rules')),
 revision integer not null, decision boolean not null, rationale text not null check(length(btrim(rationale)) between 1 and 4000),
 actor_id uuid not null references auth.users(id), created_at timestamptz not null default now(), final_package_id uuid,
 unique(opportunity_id,gate,revision,final_package_id), foreign key(organization_id,opportunity_id) references public.opportunities(organization_id,id),
 foreign key(organization_id,final_package_id) references public.documents(organization_id,id)
);
create unique index approval_non_submission_once on public.approvals(opportunity_id,gate,revision) where gate<>'submission';
create table public.audit_events (
 id bigint generated always as identity primary key, organization_id uuid not null,
 actor_id uuid, action text not null, entity_id uuid, metadata jsonb not null default '{}',
 created_at timestamptz not null default now()
);
-- Audit metadata contains IDs/revisions, never document contents, email, secrets or prompts.
create function private.audit(org uuid, action_name text, entity uuid, detail jsonb default '{}') returns void
 language sql security definer set search_path = '' as $$
 insert into public.audit_events(organization_id,actor_id,action,entity_id,metadata)
 values(org,auth.uid(),action_name,entity,detail)
$$;
create function private.touch_opportunity(oid uuid) returns void language plpgsql security definer set search_path = '' as $$
begin
 update public.opportunities set revision=revision+1,status=case when status in ('READY','PROPOSAL') then 'PRICING' else status end where id=oid and status not in ('SUBMITTED','AWARDED','LOST','REJECTED');
end $$;
create function private.assert_open(oid uuid) returns void language plpgsql security definer set search_path='' as $$
declare state text;
begin
 select status into state from public.opportunities where id=oid for update;
 if state is null or state in ('SUBMITTED','AWARDED','LOST','REJECTED') then raise exception 'Opportunity closed'; end if;
end $$;
create function private.invalidate_contractor(cid uuid) returns void language plpgsql security definer set search_path = '' as $$
declare row record;
begin
 for row in select distinct opportunity_id from public.pricing_scenarios where contractor_id=cid loop
  perform private.touch_opportunity(row.opportunity_id);
 end loop;
end $$;

-- No direct mutations are granted to clients. All business writes use validated RPCs.
alter table public.organizations enable row level security;
alter table public.memberships enable row level security;
create policy organization_read on public.organizations for select to authenticated using(private.role_for(id) is not null);
create policy membership_read on public.memberships for select to authenticated using(user_id=auth.uid());
do $$ declare t text; begin
 foreach t in array array['opportunities','requirements','rates','company_facts','pricing_scenarios','proposals','approvals','audit_events','contractor_invitations'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('create policy internal_read on public.%I for select to authenticated using (private.role_for(organization_id) is not null)',t);
 end loop;
end $$;
alter table public.contractors enable row level security;
create policy contractor_read on public.contractors for select to authenticated using(private.contractor_access(organization_id,id));
alter table public.documents enable row level security;
create policy document_read on public.documents for select to authenticated using(
 private.role_for(organization_id) is not null or (contractor_id is not null and private.contractor_access(organization_id,contractor_id)));

create function public.create_opportunity(org uuid, data jsonb) returns uuid language plpgsql security definer set search_path = '' as $$
declare oid uuid;
begin
 perform private.require_role(org);
 insert into public.opportunities(organization_id,source,solicitation_number,title,agency,description,location,trade,response_deadline,source_url)
 values(org,coalesce(data->>'source','manual'),data->>'solicitation_number',data->>'title',coalesce(data->>'agency',''),coalesce(data->>'description',''),coalesce(data->>'location',''),coalesce(data->>'trade','janitorial'),(data->>'response_deadline')::timestamptz,data->>'source_url') returning id into oid;
 perform private.audit(org,'opportunity.created',oid); return oid;
end $$;
create function public.invite_contractor(org uuid, email_address text, token text) returns uuid language plpgsql security definer set search_path = '' as $$
declare iid uuid;
begin
 perform private.require_role(org,true);
 if length(token)<43 or length(email_address)>254 or email_address !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then raise exception 'Invalid invitation'; end if;
 insert into public.contractor_invitations(organization_id,email,token_hash,expires_at,created_by)
 values(org,lower(email_address),encode(sha256(convert_to(token,'UTF8')),'hex'),now()+interval '7 days',auth.uid()) returning id into iid;
 perform private.audit(org,'contractor.invited',iid); return iid;
end $$;
create function public.accept_invitation(token text, company text, trade_name text, area text) returns uuid language plpgsql security definer set search_path = '' as $$
declare inv public.contractor_invitations; cid uuid; user_email text;
begin
 if auth.uid() is null then raise exception 'Not authorized' using errcode='42501'; end if;
 select email into user_email from auth.users where id=auth.uid() and email_confirmed_at is not null and (banned_until is null or banned_until<=now());
 select * into inv from public.contractor_invitations where token_hash=encode(sha256(convert_to(token,'UTF8')),'hex') and accepted_at is null and expires_at>now() for update;
 if inv.id is null or lower(user_email) is distinct from inv.email then raise exception 'Invalid invitation' using errcode='42501'; end if;
 insert into public.contractors(organization_id,user_id,company_name,email,trade,service_area) values(inv.organization_id,auth.uid(),company,inv.email,trade_name,area) returning id into cid;
 update public.contractor_invitations set accepted_at=now() where id=inv.id;
 perform private.audit(inv.organization_id,'contractor.registered',cid); return cid;
end $$;
create function public.update_contractor(cid uuid, capacity_value integer, is_available boolean) returns void language plpgsql security definer set search_path = '' as $$
declare c public.contractors;
begin
 select * into c from public.contractors where id=cid for update;
 if c.id is null or not private.contractor_access(c.organization_id,cid) then raise exception 'Not authorized' using errcode='42501'; end if;
 update public.contractors set capacity=capacity_value,available=is_available where id=cid;
 perform private.invalidate_contractor(cid); perform private.audit(c.organization_id,'contractor.updated',cid);
end $$;
create function public.register_document(org uuid, did uuid, data jsonb) returns uuid language plpgsql security definer set search_path = '' as $$
declare cid uuid := (data->>'contractor_id')::uuid; oid uuid := (data->>'opportunity_id')::uuid; o public.opportunities;
begin
 if cid is not null then
  if not private.contractor_access(org,cid) then raise exception 'Not authorized' using errcode='42501'; end if;
 else perform private.require_role(org); end if;
 if (data->>'kind') in ('SOLICITATION','AMENDMENT','FINAL_PACKAGE') and oid is null then raise exception 'Opportunity target required'; end if;
 if oid is not null then
  select * into o from public.opportunities where id=oid for update;
  if o.status in ('SUBMITTED','AWARDED','LOST','REJECTED') then raise exception 'Opportunity closed'; end if;
 end if;
 if data->>'kind'='FINAL_PACKAGE' and data->>'mime_type'<>'application/pdf' then raise exception 'Final package must be PDF'; end if;
 if (data->>'supersedes') is not null and not exists(select 1 from public.documents where id=(data->>'supersedes')::uuid and organization_id=org and opportunity_id=oid and kind in ('SOLICITATION','AMENDMENT')) then raise exception 'Invalid amendment'; end if;
 insert into public.documents(id,organization_id,contractor_id,opportunity_id,kind,file_name,object_path,size_bytes,mime_type,expires_at,supersedes,created_by,bound_revision)
 values(did,org,cid,oid,data->>'kind',data->>'file_name',org::text||'/'||did::text,(data->>'size_bytes')::integer,data->>'mime_type',(data->>'expires_at')::timestamptz,(data->>'supersedes')::uuid,auth.uid(),case when data->>'kind'='FINAL_PACKAGE' then o.revision else null end);
 if oid is not null and data->>'kind'<>'FINAL_PACKAGE' then perform private.touch_opportunity(oid); end if;
 if data->>'kind' in ('SOLICITATION','AMENDMENT') then update public.requirements set status='MISSING',verified_by=null,reviewed_at=null where opportunity_id=oid and mandatory; end if;
 if data->>'kind'='FINAL_PACKAGE' then update public.opportunities set status='PROPOSAL' where id=oid and status='READY'; end if;
 if cid is not null then perform private.invalidate_contractor(cid); end if;
 perform private.audit(org,'document.registered',did); return did;
end $$;
create function public.verify_document(did uuid) returns void language plpgsql security definer set search_path = '' as $$
declare d public.documents;
begin
 select * into d from public.documents where id=did for update;
 perform private.require_role(d.organization_id,true);
 if d.opportunity_id is not null then perform private.assert_open(d.opportunity_id); end if;
 if d.id is null or d.expires_at<=now() or d.revoked_at is not null then raise exception 'Document missing, revoked or expired'; end if;
 if d.scan_status='REJECTED' or (d.scan_status<>'CLEAN' and (select require_malware_scan from public.organizations where id=d.organization_id)) then raise exception 'Clean malware scan required'; end if;
 if d.kind in ('INSURANCE','LICENSE','QUOTE') and d.expires_at is null then raise exception 'Expiration date required'; end if;
 -- An upload must exist in the private bucket; metadata alone is never evidence.
 if not exists(select 1 from storage.objects where bucket_id='contractos-documents' and name=d.object_path) then raise exception 'Upload missing'; end if;
 update public.documents set verified_at=now(),verified_by=auth.uid() where id=did;
 if d.opportunity_id is not null and d.kind<>'FINAL_PACKAGE' then perform private.touch_opportunity(d.opportunity_id); end if;
 if d.contractor_id is not null then perform private.invalidate_contractor(d.contractor_id); end if;
 perform private.audit(d.organization_id,'document.verified',did);
end $$;
create function public.qualify_contractor(cid uuid) returns void language plpgsql security definer set search_path = '' as $$
declare c public.contractors; k text;
begin
 select * into c from public.contractors where id=cid for update;
 perform private.require_role(c.organization_id,true);
 foreach k in array array['W9','INSURANCE','LICENSE'] loop
  if not exists(select 1 from public.documents where contractor_id=cid and kind=k and private.evidence_valid(id)) then raise exception 'Missing verified qualification document: %',k; end if;
 end loop;
 update public.contractors set status='QUALIFIED' where id=cid;
 perform private.invalidate_contractor(cid); perform private.audit(c.organization_id,'contractor.qualified',cid);
end $$;
create function public.add_requirement(oid uuid, data jsonb) returns uuid language plpgsql security definer set search_path = '' as $$
declare org uuid; rid uuid; did uuid := (data->>'source_document_id')::uuid;
begin
 select organization_id into org from public.opportunities where id=oid for update;
 perform private.require_role(org);
 perform private.assert_open(oid);
 if not exists(select 1 from public.documents where id=did and opportunity_id=oid and kind in ('SOLICITATION','AMENDMENT')) then raise exception 'Invalid requirement source'; end if;
 insert into public.requirements(organization_id,opportunity_id,requirement,category,mandatory,source_document_id,page_number,source_excerpt)
 values(org,oid,data->>'requirement',coalesce(data->>'category','scope'),coalesce((data->>'mandatory')::boolean,true),did,(data->>'page_number')::integer,data->>'source_excerpt') returning id into rid;
 perform private.touch_opportunity(oid); perform private.audit(org,'requirement.created',rid); return rid;
end $$;
create function public.review_requirement(rid uuid, evidence_text text, state text) returns void language plpgsql security definer set search_path = '' as $$
declare r public.requirements;
begin
 select * into r from public.requirements where id=rid for update;
 perform private.require_role(r.organization_id,state='VERIFIED');
 perform private.assert_open(r.opportunity_id);
 update public.requirements set evidence=evidence_text,status=state,verified_by=case when state='VERIFIED' then auth.uid() else null end,reviewed_at=now() where id=rid;
 perform private.touch_opportunity(r.opportunity_id); perform private.audit(r.organization_id,'requirement.reviewed',rid,jsonb_build_object('status',state));
end $$;
create function public.add_rate(cid uuid, data jsonb) returns uuid language plpgsql security definer set search_path = '' as $$
declare c public.contractors; rid uuid; did uuid := (data->>'source_document_id')::uuid;
begin
 select * into c from public.contractors where id=cid;
 perform private.require_role(c.organization_id,true);
 if not exists(select 1 from public.documents where id=did and contractor_id=cid and kind='QUOTE' and private.evidence_valid(id)) then raise exception 'Verified quote required'; end if;
 insert into public.rates(organization_id,contractor_id,service,unit,rate_cents,expires_at,source_document_id,verified_by)
 values(c.organization_id,cid,data->>'service',data->>'unit',(data->>'rate_cents')::bigint,(data->>'expires_at')::timestamptz,did,auth.uid()) returning id into rid;
 perform private.invalidate_contractor(cid); perform private.audit(c.organization_id,'rate.created',rid); return rid;
end $$;
create function public.add_company_fact(org uuid, claim_text text, source_text text, expiry timestamptz default null) returns uuid language plpgsql security definer set search_path = '' as $$
declare fid uuid;
begin
 perform private.require_role(org,true);
 if length(btrim(source_text))<1 then raise exception 'Source required'; end if;
 insert into public.company_facts(organization_id,claim,source_reference,verified_by,expires_at) values(org,claim_text,source_text,auth.uid(),expiry) returning id into fid;
 -- New verified material changes invalidate all existing proposal approvals.
 update public.opportunities set revision=revision+1,status=case when status='READY' then 'PRICING' else status end where organization_id=org and status not in ('SUBMITTED','AWARDED','LOST','REJECTED');
 perform private.audit(org,'company_fact.verified',fid); return fid;
end $$;
create function public.create_pricing(oid uuid, rid uuid, quantity integer, other_cents bigint, basis text, markup integer) returns uuid language plpgsql security definer set search_path = '' as $$
declare o public.opportunities; r public.rates; sid uuid; total bigint;
begin
 select * into o from public.opportunities where id=oid for update;
 perform private.require_role(o.organization_id);
 perform private.assert_open(oid);
 select * into r from public.rates where id=rid and organization_id=o.organization_id and expires_at>now() and verified_by is not null and private.evidence_valid(source_document_id);
 if r.id is null then raise exception 'Verified fresh rate required'; end if;
 if not exists(select 1 from public.approvals where opportunity_id=oid and gate='pursue' and decision=true) then raise exception 'Pursue approval required'; end if;
 total := ceil(((r.rate_cents::numeric * quantity)+other_cents)*(10000+markup)/10000);
 perform private.touch_opportunity(oid);
 insert into public.pricing_scenarios(organization_id,opportunity_id,contractor_id,rate_id,units,other_cost_cents,cost_basis,markup_bps,total_cents,revision)
 values(o.organization_id,oid,r.contractor_id,rid,quantity,other_cents,basis,markup,total,o.revision+1) returning id into sid;
 update public.opportunities set status='PRICING' where id=oid;
 perform private.audit(o.organization_id,'pricing.created',sid); return sid;
end $$;

create function public.compliance_blockers(oid uuid) returns text[] language plpgsql stable security definer set search_path = '' as $$
declare o public.opportunities; s public.pricing_scenarios; p public.proposals; package public.documents; blocks text[] := '{}'; k text;
begin
 select * into o from public.opportunities where id=oid;
 perform private.require_role(o.organization_id);
 if o.response_deadline<=now() then blocks:=array_append(blocks,'Response deadline passed'); end if;
 if not exists(select 1 from public.requirements where opportunity_id=oid and mandatory) then blocks:=array_append(blocks,'Mandatory requirements not reviewed'); end if;
 if exists(select 1 from public.requirements r where r.opportunity_id=oid and r.mandatory and (r.status<>'VERIFIED' or not private.evidence_valid(r.source_document_id))) then blocks:=array_append(blocks,'Mandatory evidence unresolved, expired or source unverified'); end if;
 if exists(select 1 from public.documents d where d.opportunity_id=oid and d.kind in ('SOLICITATION','AMENDMENT') and (not private.evidence_valid(d.id) or not exists(select 1 from public.requirements r where r.source_document_id=d.id))) then blocks:=array_append(blocks,'Solicitation/amendment not fully reviewed'); end if;
 if exists(select 1 from public.requirements r join public.documents amendment on amendment.supersedes=r.source_document_id where r.opportunity_id=oid and r.mandatory and (r.reviewed_at is null or r.reviewed_at<=amendment.created_at)) then blocks:=array_append(blocks,'Superseded evidence requires re-review'); end if;
 select * into s from public.pricing_scenarios where opportunity_id=oid order by created_at desc,id desc limit 1;
 if s.id is null or s.revision<>o.revision then blocks:=array_append(blocks,'Pricing missing or stale');
 else
  if not exists(select 1 from public.rates r where r.id=s.rate_id and r.expires_at>now() and r.verified_by is not null and private.evidence_valid(r.source_document_id)) then blocks:=array_append(blocks,'Quote/rate expired or unverified'); end if;
  if not exists(select 1 from public.contractors where id=s.contractor_id and status='QUALIFIED' and available and capacity>=s.units) then blocks:=array_append(blocks,'Contractor qualification/capacity/availability unresolved'); end if;
  foreach k in array array['W9','INSURANCE','LICENSE'] loop
   if not exists(select 1 from public.documents where contractor_id=s.contractor_id and kind=k and private.evidence_valid(id)) then blocks:=array_append(blocks,'Contractor document missing or expired: '||k); end if;
  end loop;
 end if;
 foreach k in array array['pursue','rules','contractor','pricing'] loop
  if not exists(select 1 from public.approvals where opportunity_id=oid and gate=k and decision and (k='pursue' or revision=o.revision)) then blocks:=array_append(blocks,'Human approval missing/stale: '||k); end if;
 end loop;
 select * into p from public.proposals where opportunity_id=oid order by created_at desc,id desc limit 1;
 if p.id is null or p.revision<>o.revision or p.scenario_id is distinct from s.id then blocks:=array_append(blocks,'Proposal missing or stale'); end if;
 if exists(select 1 from public.company_facts f where f.organization_id=o.organization_id and f.expires_at<=now() and p.content->'claims' @> jsonb_build_array(jsonb_build_object('fact_id',f.id))) then blocks:=array_append(blocks,'Proposal claim evidence expired'); end if;
 select * into package from public.documents where opportunity_id=oid and kind='FINAL_PACKAGE' order by created_at desc,id desc limit 1;
 if package.id is null or not private.evidence_valid(package.id) or package.bound_revision<>o.revision then blocks:=array_append(blocks,'Final PDF package missing, unverified, expired or stale'); end if;
 return blocks;
end $$;
create function public.approve_gate(oid uuid, gate_name text, approved boolean, reason text) returns void language plpgsql security definer set search_path = '' as $$
declare o public.opportunities; blocks text[]; package_id uuid;
begin
 select * into o from public.opportunities where id=oid for update;
 perform private.require_role(o.organization_id,true);
 if o.status in ('SUBMITTED','AWARDED','LOST','REJECTED') then raise exception 'Opportunity closed'; end if;
 if gate_name='submission' and approved then
  blocks:=public.compliance_blockers(oid);
  if cardinality(blocks)>0 then raise exception 'Submission blocked: %',array_to_string(blocks,'; '); end if;
  select id into package_id from public.documents where opportunity_id=oid and kind='FINAL_PACKAGE' order by created_at desc,id desc limit 1;
 end if;
 insert into public.approvals(organization_id,opportunity_id,gate,revision,decision,rationale,actor_id,final_package_id)
 values(o.organization_id,oid,gate_name,o.revision,approved,reason,auth.uid(),package_id);
 if gate_name='pursue' then update public.opportunities set status=case when approved then 'SOURCING' else 'REJECTED' end where id=oid; end if;
 if gate_name='submission' and approved then update public.opportunities set status='READY' where id=oid; end if;
 if gate_name='submission' and not approved then perform private.touch_opportunity(oid); end if;
 perform private.audit(o.organization_id,'approval.'||gate_name,oid,jsonb_build_object('revision',o.revision,'approved',approved));
end $$;
create function public.generate_proposal(oid uuid) returns uuid language plpgsql security definer set search_path = '' as $$
declare o public.opportunities; s public.pricing_scenarios; pid uuid; claims jsonb; reqs jsonb;
begin
 select * into o from public.opportunities where id=oid for update;
 perform private.require_role(o.organization_id);
 perform private.assert_open(oid);
 select * into s from public.pricing_scenarios where opportunity_id=oid and revision=o.revision order by created_at desc,id desc limit 1;
 if s.id is null then raise exception 'Current pricing required'; end if;
 if not exists(select 1 from public.approvals where opportunity_id=oid and gate='pricing' and decision and revision=o.revision) then raise exception 'Pricing approval required'; end if;
 select coalesce(jsonb_agg(jsonb_build_object('fact_id',id,'claim',claim,'source',source_reference)),'[]') into claims from public.company_facts where organization_id=o.organization_id and (expires_at is null or expires_at>now());
 select coalesce(jsonb_agg(jsonb_build_object('requirement_id',id,'requirement',requirement,'response',evidence,'source_document_id',source_document_id,'page',page_number)),'[]') into reqs from public.requirements where opportunity_id=oid and status='VERIFIED';
 insert into public.proposals(organization_id,opportunity_id,scenario_id,revision,content)
 values(o.organization_id,oid,s.id,o.revision,jsonb_build_object('label','DRAFT — HUMAN REVIEW REQUIRED','title',o.title,'claims',claims,'compliance_responses',reqs,'total_cents',s.total_cents,'pricing_source',s.id,'sections_to_complete',jsonb_build_array('Technical approach','Staffing','Quality control','Safety','Schedule','Required forms'))) returning id into pid;
 update public.opportunities set status='PROPOSAL' where id=oid;
 perform private.audit(o.organization_id,'proposal.generated',pid); return pid;
end $$;
create function public.record_submission(oid uuid, receipt text) returns void language plpgsql security definer set search_path = '' as $$
declare o public.opportunities;
begin
 select * into o from public.opportunities where id=oid for update;
 perform private.require_role(o.organization_id,true);
 if o.status<>'READY' or length(btrim(receipt)) not between 1 and 4000 or cardinality(public.compliance_blockers(oid))>0 or not exists(select 1 from public.approvals where opportunity_id=oid and gate='submission' and decision and revision=o.revision and final_package_id=(select id from public.documents where opportunity_id=oid and kind='FINAL_PACKAGE' order by created_at desc,id desc limit 1)) then raise exception 'Submission blocked'; end if;
 update public.opportunities set status='SUBMITTED' where id=oid;
 perform private.audit(o.organization_id,'submission.recorded',oid,jsonb_build_object('revision',o.revision,'receipt_reference',receipt));
end $$;
create function public.audit_document_access(did uuid) returns void language plpgsql security definer set search_path = '' as $$
declare d public.documents;
begin
 select * into d from public.documents where id=did;
 if d.id is null or not (private.role_for(d.organization_id) is not null or (d.contractor_id is not null and private.contractor_access(d.organization_id,d.contractor_id))) then raise exception 'Not authorized' using errcode='42501'; end if;
 perform private.audit(d.organization_id,'document.download_authorized',did);
end $$;

-- Dedicated worker RPC: service-role integrations cannot choose a mutation function.
create function public.ingest_opportunity(org uuid, data jsonb) returns uuid language plpgsql security definer set search_path = '' as $$
declare oid uuid; old public.opportunities;
begin
 select * into old from public.opportunities where organization_id=org and source='sam' and solicitation_number=data->>'solicitation_number' for update;
 insert into public.opportunities(organization_id,source,solicitation_number,title,agency,description,location,trade,response_deadline,source_url,naics,set_aside)
 values(org,'sam',data->>'solicitation_number',data->>'title',coalesce(data->>'agency',''),coalesce(data->>'description',''),coalesce(data->>'location',''),'janitorial',(data->>'response_deadline')::timestamptz,data->>'source_url',data->>'naics',data->>'set_aside')
 on conflict(organization_id,source,solicitation_number) do update set
 title=excluded.title, agency=excluded.agency, description=excluded.description,location=excluded.location,
 response_deadline=excluded.response_deadline,source_url=excluded.source_url,naics=excluded.naics,set_aside=excluded.set_aside,
 revision=public.opportunities.revision+case when (public.opportunities.title,public.opportunities.description,public.opportunities.response_deadline,public.opportunities.set_aside) is distinct from (excluded.title,excluded.description,excluded.response_deadline,excluded.set_aside) then 1 else 0 end,
 status=case when public.opportunities.status='READY' and (public.opportunities.title,public.opportunities.description,public.opportunities.response_deadline,public.opportunities.set_aside) is distinct from (excluded.title,excluded.description,excluded.response_deadline,excluded.set_aside) then 'PRICING' else public.opportunities.status end returning id into oid;
 perform private.audit(org,'opportunity.ingested',oid); return oid;
end $$;

-- Explicit grants protect functions from PostgreSQL's default PUBLIC EXECUTE.
revoke all on all tables in schema public from anon,authenticated;
grant select on all tables in schema public to authenticated;
revoke all on all functions in schema private from public,anon,authenticated;
grant execute on function private.role_for(uuid),private.contractor_access(uuid,uuid) to authenticated;
revoke all on all functions in schema public from public,anon,authenticated;
grant execute on function public.create_opportunity(uuid,jsonb), public.invite_contractor(uuid,text,text),
 public.accept_invitation(text,text,text,text), public.update_contractor(uuid,integer,boolean),
 public.register_document(uuid,uuid,jsonb),public.verify_document(uuid),public.qualify_contractor(uuid),
 public.add_requirement(uuid,jsonb),public.review_requirement(uuid,text,text),public.add_rate(uuid,jsonb),
 public.add_company_fact(uuid,text,text,timestamptz),public.create_pricing(uuid,uuid,integer,bigint,text,integer),
 public.compliance_blockers(uuid),public.approve_gate(uuid,text,boolean,text),public.generate_proposal(uuid),
 public.record_submission(uuid,text),public.audit_document_access(uuid) to authenticated;
grant execute on function public.ingest_opportunity(uuid,jsonb) to service_role;

-- Private object storage; append-only uploads prevent replacing approved evidence.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('contractos-documents','contractos-documents',false,10485760,array['application/pdf','image/png','image/jpeg']);
create policy contractos_object_read on storage.objects for select to authenticated using(
 bucket_id='contractos-documents' and exists(select 1 from public.documents d where d.object_path=name));
create policy contractos_object_insert on storage.objects for insert to authenticated with check(
 bucket_id='contractos-documents' and exists(select 1 from public.documents d where d.object_path=name and d.created_by=auth.uid() and d.verified_at is null));
-- No UPDATE/DELETE storage policies. Retention cleanup uses a separately reviewed admin job.
