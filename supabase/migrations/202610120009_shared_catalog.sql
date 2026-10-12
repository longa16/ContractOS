-- Only official public-source metadata enters this table. Never backfill private dossiers.
create table public.opportunity_catalog (
 id uuid primary key default gen_random_uuid(), notice_id text not null unique check(length(notice_id) between 1 and 200),
 title text not null check(length(title) between 1 and 500), agency text not null check(length(agency)<=500),
 description text not null check(length(description)<=100000), location text not null check(length(location)<=500),
 trade text not null check(length(trade) between 1 and 100), naics text check(length(naics)<=20), set_aside text check(length(set_aside)<=200),
 response_deadline timestamptz not null check(isfinite(response_deadline)),
 source_url text not null check(source_url ~ '^https://sam[.]gov/opp/[^[:space:]]+/view$'),
 revision integer not null default 1, updated_at timestamptz not null default now(), last_seen_at timestamptz not null default now()
);
alter table public.opportunity_catalog enable row level security;
create policy catalog_internal_read on public.opportunity_catalog for select to authenticated using(
 exists(select 1 from public.memberships m where m.user_id=auth.uid() and private.role_for(m.organization_id) is not null)
);
revoke all on public.opportunity_catalog from anon,authenticated;
grant select on public.opportunity_catalog to authenticated;
alter table public.opportunities add column catalog_id uuid references public.opportunity_catalog(id), add column catalog_revision integer;
create unique index organization_catalog_unique on public.opportunities(organization_id,catalog_id) where catalog_id is not null;
create index catalog_deadline on public.opportunity_catalog(response_deadline);
create index catalog_naics on public.opportunity_catalog(naics);
alter table public.organizations add column catalog_preferences jsonb not null default '{}'::jsonb;

create function public.ingest_catalog_opportunity(data jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare cid uuid; previous_revision integer; current_revision integer;
begin
 select revision into previous_revision from public.opportunity_catalog where notice_id=data->>'solicitation_number';
 insert into public.opportunity_catalog(notice_id,title,agency,description,location,trade,naics,set_aside,response_deadline,source_url)
 values(data->>'solicitation_number',data->>'title',coalesce(data->>'agency',''),coalesce(data->>'description',''),coalesce(data->>'location',''),coalesce(data->>'trade','janitorial'),data->>'naics',data->>'set_aside',(data->>'response_deadline')::timestamptz,
 'https://sam.gov/opp/'||(data->>'solicitation_number')||'/view')
 on conflict(notice_id) do update set title=excluded.title,agency=excluded.agency,description=excluded.description,location=excluded.location,trade=excluded.trade,naics=excluded.naics,set_aside=excluded.set_aside,response_deadline=excluded.response_deadline,
 revision=public.opportunity_catalog.revision+case when
 (public.opportunity_catalog.title,public.opportunity_catalog.agency,public.opportunity_catalog.description,public.opportunity_catalog.location,public.opportunity_catalog.trade,public.opportunity_catalog.naics,public.opportunity_catalog.set_aside,public.opportunity_catalog.response_deadline)
 is distinct from (excluded.title,excluded.agency,excluded.description,excluded.location,excluded.trade,excluded.naics,excluded.set_aside,excluded.response_deadline) then 1 else 0 end,
 updated_at=case when (public.opportunity_catalog.title,public.opportunity_catalog.agency,public.opportunity_catalog.description,public.opportunity_catalog.location,public.opportunity_catalog.trade,public.opportunity_catalog.naics,public.opportunity_catalog.set_aside,public.opportunity_catalog.response_deadline)
 is distinct from (excluded.title,excluded.agency,excluded.description,excluded.location,excluded.trade,excluded.naics,excluded.set_aside,excluded.response_deadline) then now() else public.opportunity_catalog.updated_at end,
 last_seen_at=now() returning id,revision into cid,current_revision;
 -- Catalog changes invalidate approvals, but never overwrite private work.
 if previous_revision is not null and previous_revision<>current_revision then
  update public.opportunities set revision=revision+1,status=case when status in ('READY','PROPOSAL') then 'PRICING' else status end
  where catalog_id=cid and status not in ('SUBMITTED','AWARDED','LOST','REJECTED');
 end if;
 return cid;
end $$;

create function public.select_catalog_opportunity(org uuid, cid uuid) returns uuid language plpgsql security definer set search_path='' as $$
declare c public.opportunity_catalog; oid uuid;
begin
 perform private.require_role(org);
 select * into c from public.opportunity_catalog where id=cid for share;
 if c.id is null or c.response_deadline<=now() then raise exception 'Catalog notice unavailable or expired'; end if;
 insert into public.opportunities(organization_id,source,solicitation_number,title,agency,description,location,trade,naics,set_aside,response_deadline,source_url,catalog_id,catalog_revision)
 values(org,'sam',c.notice_id,c.title,c.agency,c.description,c.location,c.trade,c.naics,c.set_aside,c.response_deadline,c.source_url,c.id,c.revision)
 on conflict(organization_id,source,solicitation_number) do nothing returning id into oid;
 if oid is null then
  select id into oid from public.opportunities where organization_id=org and source='sam' and solicitation_number=c.notice_id;
  -- Link a pre-existing private SAM dossier without copying its content into the catalog.
  update public.opportunities set catalog_id=c.id,catalog_revision=coalesce(catalog_revision,0)
  where id=oid and catalog_id is null;
 end if;
 perform private.audit(org,'catalog.selected',oid,jsonb_build_object('catalog_id',cid)); return oid;
end $$;
create function public.refresh_catalog_opportunity(oid uuid) returns void language plpgsql security definer set search_path='' as $$
declare o public.opportunities; c public.opportunity_catalog;
begin
 select * into o from public.opportunities where id=oid for update;
 perform private.require_role(o.organization_id); perform private.assert_open(oid);
 select * into c from public.opportunity_catalog where id=o.catalog_id for share;
 if c.id is null then raise exception 'Catalog notice unavailable'; end if;
 if o.catalog_revision=c.revision then return; end if;
 update public.opportunities set title=c.title,agency=c.agency,description=c.description,location=c.location,trade=c.trade,naics=c.naics,set_aside=c.set_aside,response_deadline=c.response_deadline,source_url=c.source_url,catalog_revision=c.revision where id=oid;
 perform private.touch_opportunity(oid);
 update public.requirements set status='MISSING',reviewed_at=null,verified_by=null where opportunity_id=oid and mandatory;
 perform private.audit(o.organization_id,'catalog.refreshed',oid,jsonb_build_object('catalog_revision',c.revision));
end $$;
create function public.save_catalog_preferences(org uuid, data jsonb) returns void language plpgsql security definer set search_path='' as $$
begin
 perform private.require_role(org);
 if length(coalesce(data->>'trade',''))>100 or length(coalesce(data->>'location',''))>100 or length(coalesce(data->>'naics',''))>20 or length(coalesce(data->>'set_aside',''))>200 then raise exception 'Invalid filters'; end if;
 update public.organizations set catalog_preferences=jsonb_build_object('trade',coalesce(data->>'trade',''),'location',coalesce(data->>'location',''),'naics',coalesce(data->>'naics',''),'set_aside',coalesce(data->>'set_aside','')) where id=org;
 perform private.audit(org,'catalog.preferences.updated',org);
end $$;
-- Keep the original gate logic and add a stale-source blocker for direct API calls too.
alter function public.compliance_blockers(uuid) rename to compliance_blockers_before_catalog;
revoke all on function public.compliance_blockers_before_catalog(uuid) from public,anon,authenticated,service_role;
create function public.compliance_blockers(oid uuid) returns text[] language plpgsql stable security definer set search_path='' as $$
declare blocks text[];
begin
 blocks:=public.compliance_blockers_before_catalog(oid);
 if exists(select 1 from public.opportunities o join public.opportunity_catalog c on c.id=o.catalog_id where o.id=oid and o.catalog_revision is distinct from c.revision) then
  blocks:=array_append(blocks,'Catalog notice changed: refresh and review the private dossier');
 end if;
 return blocks;
end $$;
revoke all on function public.ingest_catalog_opportunity(jsonb),public.select_catalog_opportunity(uuid,uuid),public.refresh_catalog_opportunity(uuid),public.save_catalog_preferences(uuid,jsonb),public.compliance_blockers(uuid) from public,anon,authenticated;
grant execute on function public.ingest_catalog_opportunity(jsonb) to service_role;
grant execute on function public.select_catalog_opportunity(uuid,uuid),public.refresh_catalog_opportunity(uuid),public.save_catalog_preferences(uuid,jsonb),public.compliance_blockers(uuid) to authenticated;
