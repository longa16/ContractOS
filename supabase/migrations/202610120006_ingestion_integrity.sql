create or replace function public.ingest_opportunity(org uuid, data jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare oid uuid; old public.opportunities;
begin
 select * into old from public.opportunities where organization_id=org and source='sam' and solicitation_number=data->>'solicitation_number' for update;
 if old.id is not null and old.status in ('SUBMITTED','AWARDED','LOST','REJECTED') then
  perform private.audit(org,'opportunity.ingestion.closed_skipped',old.id); return old.id;
 end if;
 insert into public.opportunities(organization_id,source,solicitation_number,title,agency,description,location,trade,response_deadline,source_url,naics,set_aside)
 values(org,'sam',data->>'solicitation_number',data->>'title',coalesce(data->>'agency',''),coalesce(data->>'description',''),coalesce(data->>'location',''),'janitorial',(data->>'response_deadline')::timestamptz,data->>'source_url',data->>'naics',data->>'set_aside')
 on conflict(organization_id,source,solicitation_number) do update set
 title=excluded.title,agency=excluded.agency,description=excluded.description,location=excluded.location,trade=excluded.trade,
 response_deadline=excluded.response_deadline,source_url=excluded.source_url,naics=excluded.naics,set_aside=excluded.set_aside,
 revision=public.opportunities.revision+case when
 (public.opportunities.title,public.opportunities.agency,public.opportunities.description,public.opportunities.location,public.opportunities.trade,public.opportunities.response_deadline,public.opportunities.source_url,public.opportunities.naics,public.opportunities.set_aside)
 is distinct from (excluded.title,excluded.agency,excluded.description,excluded.location,excluded.trade,excluded.response_deadline,excluded.source_url,excluded.naics,excluded.set_aside) then 1 else 0 end,
 status=case when public.opportunities.status in ('READY','PROPOSAL') and
 (public.opportunities.title,public.opportunities.agency,public.opportunities.description,public.opportunities.location,public.opportunities.trade,public.opportunities.response_deadline,public.opportunities.source_url,public.opportunities.naics,public.opportunities.set_aside)
 is distinct from (excluded.title,excluded.agency,excluded.description,excluded.location,excluded.trade,excluded.response_deadline,excluded.source_url,excluded.naics,excluded.set_aside) then 'PRICING' else public.opportunities.status end
 where public.opportunities.status not in ('SUBMITTED','AWARDED','LOST','REJECTED') returning id into oid;
 if oid is null then select id into oid from public.opportunities where organization_id=org and source='sam' and solicitation_number=data->>'solicitation_number'; end if;
 perform private.audit(org,'opportunity.ingested',oid); return oid;
end $$;

alter table public.opportunities add constraint bounded_metadata check(length(agency)<=500 and length(location)<=500 and length(trade) between 1 and 100 and (naics is null or length(naics)<=20) and (set_aside is null or length(set_aside)<=200));
alter table public.contractors add constraint bounded_profile check(length(email)<=254 and length(trade) between 1 and 100 and length(service_area) between 1 and 500 and capacity<=1000000);
alter table public.requirements add constraint bounded_category check(length(category) between 1 and 100);
alter table public.rates add constraint bounded_service check(length(service) between 1 and 200 and length(unit) between 1 and 100);
alter table public.company_facts add constraint bounded_reference check(length(source_reference) between 1 and 4000);
