create table public.analysis_runs (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null,
 opportunity_id uuid not null, source_document_id uuid, kind text not null check(kind in ('RFP','SCREENING')),
 output jsonb not null, revision integer not null, created_at timestamptz not null default now(),
 actor_id uuid not null references auth.users(id),
 foreign key(organization_id,opportunity_id) references public.opportunities(organization_id,id),
 foreign key(organization_id,source_document_id) references public.documents(organization_id,id)
);
alter table public.analysis_runs enable row level security;
create policy analysis_read on public.analysis_runs for select to authenticated using(private.role_for(organization_id) is not null);
revoke all on public.analysis_runs from anon,authenticated;
grant select on public.analysis_runs to authenticated;

create function public.record_screening(oid uuid, analysis jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare o public.opportunities; aid uuid;
begin
 select * into o from public.opportunities where id=oid for update;
 perform private.require_role(o.organization_id);
 if o.status in ('SUBMITTED','AWARDED','LOST','REJECTED') then raise exception 'Opportunity closed'; end if;
 if length(analysis::text)>30000 or jsonb_typeof(analysis)<>'object' then raise exception 'Invalid analysis'; end if;
 insert into public.analysis_runs(organization_id,opportunity_id,kind,output,revision,actor_id) values(o.organization_id,oid,'SCREENING',analysis,o.revision,auth.uid()) returning id into aid;
 perform private.audit(o.organization_id,'ai.opportunity.drafted',oid,jsonb_build_object('analysis_id',aid,'revision',o.revision));
 return aid;
end $$;
create function public.update_opportunity(oid uuid, data jsonb) returns void language plpgsql security definer set search_path='' as $$
declare o public.opportunities;
begin
 select * into o from public.opportunities where id=oid for update;
 perform private.require_role(o.organization_id);
 if o.status in ('SUBMITTED','AWARDED','LOST','REJECTED') then raise exception 'Opportunity closed'; end if;
 update public.opportunities set title=data->>'title',agency=data->>'agency',description=data->>'description',location=data->>'location',trade=data->>'trade',response_deadline=(data->>'response_deadline')::timestamptz,source_url=data->>'source_url',set_aside=data->>'set_aside' where id=oid;
 perform private.touch_opportunity(oid);
 perform private.audit(o.organization_id,'opportunity.updated',oid);
end $$;
revoke all on function public.record_screening(uuid,jsonb),public.update_opportunity(uuid,jsonb) from public,anon;
grant execute on function public.record_screening(uuid,jsonb),public.update_opportunity(uuid,jsonb) to authenticated;

create or replace function public.import_requirements(oid uuid, did uuid, extraction jsonb) returns integer
language plpgsql security definer set search_path='' as $$
declare o public.opportunities; item jsonb; count_value integer := 0;
begin
 select * into o from public.opportunities where id=oid for update;
 perform private.require_role(o.organization_id);
 if o.status in ('SUBMITTED','AWARDED','LOST','REJECTED') then raise exception 'Opportunity closed'; end if;
 if not exists(select 1 from public.documents where id=did and opportunity_id=oid and mime_type='application/pdf' and kind in ('SOLICITATION','AMENDMENT')) then raise exception 'Invalid extraction source'; end if;
 if jsonb_typeof(extraction->'requirements') is distinct from 'array' or jsonb_array_length(extraction->'requirements')>100 or jsonb_typeof(extraction->'risks') is distinct from 'array' or length(extraction::text)>250000 then raise exception 'Invalid extraction'; end if;
 if exists(select 1 from public.requirements where source_document_id=did) then raise exception 'Document already analyzed; review existing requirements'; end if;
 for item in select value from jsonb_array_elements(extraction->'requirements') loop
  insert into public.requirements(organization_id,opportunity_id,requirement,category,mandatory,source_document_id,page_number,source_excerpt)
  values(o.organization_id,oid,item->>'requirement',item->>'category',(item->>'mandatory')::boolean,did,(item->>'page_number')::integer,item->>'source_excerpt');
  count_value:=count_value+1;
 end loop;
 if count_value=0 then raise exception 'No requirements extracted'; end if;
 perform private.touch_opportunity(oid);
 insert into public.analysis_runs(organization_id,opportunity_id,source_document_id,kind,output,revision,actor_id)
 values(o.organization_id,oid,did,'RFP',extraction,o.revision+1,auth.uid());
 perform private.audit(o.organization_id,'ai.requirements.drafted',oid,jsonb_build_object('source_document_id',did,'count',count_value,'risks_count',jsonb_array_length(extraction->'risks')));
 return count_value;
end $$;
