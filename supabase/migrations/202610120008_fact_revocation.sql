alter table public.company_facts add column revoked_at timestamptz;
alter table public.company_facts add column revoked_by uuid references auth.users(id);
alter table public.company_facts add column revoke_reason text;
create function public.revoke_company_fact(fid uuid, reason text) returns void language plpgsql security definer set search_path='' as $$
declare org uuid;
begin
 select organization_id into org from public.company_facts where id=fid for update;
 perform private.require_role(org,true);
 if length(btrim(reason)) not between 1 and 4000 then raise exception 'Reason required'; end if;
 update public.company_facts set revoked_at=now(),revoked_by=auth.uid(),revoke_reason=reason where id=fid;
 update public.opportunities set revision=revision+1,status=case when status in ('READY','PROPOSAL') then 'PRICING' else status end where organization_id=org and status not in ('SUBMITTED','AWARDED','LOST','REJECTED');
 perform private.audit(org,'company_fact.revoked',fid);
end $$;
revoke all on function public.revoke_company_fact(uuid,text) from public,anon;
grant execute on function public.revoke_company_fact(uuid,text) to authenticated;
create or replace function public.generate_proposal(oid uuid) returns uuid language plpgsql security definer set search_path='' as $$
declare o public.opportunities; s public.pricing_scenarios; pid uuid; claims jsonb; reqs jsonb;
begin
 select * into o from public.opportunities where id=oid for update;
 perform private.require_role(o.organization_id);perform private.assert_open(oid);
 select * into s from public.pricing_scenarios where opportunity_id=oid and revision=o.revision order by created_at desc,id desc limit 1;
 if s.id is null then raise exception 'Current pricing required'; end if;
 if not exists(select 1 from public.approvals where opportunity_id=oid and gate='pricing' and decision and revision=o.revision) then raise exception 'Pricing approval required'; end if;
 select coalesce(jsonb_agg(jsonb_build_object('fact_id',id,'claim',claim,'source',source_reference)),'[]') into claims from public.company_facts where organization_id=o.organization_id and revoked_at is null and (expires_at is null or expires_at>clock_timestamp());
 select coalesce(jsonb_agg(jsonb_build_object('requirement_id',id,'requirement',requirement,'response',evidence,'source_document_id',source_document_id,'page',page_number)),'[]') into reqs from public.requirements where opportunity_id=oid and status='VERIFIED';
 insert into public.proposals(organization_id,opportunity_id,scenario_id,revision,content)
 values(o.organization_id,oid,s.id,o.revision,jsonb_build_object('label','DRAFT — HUMAN REVIEW REQUIRED','title',o.title,'claims',claims,'compliance_responses',reqs,'total_cents',s.total_cents,'pricing_source',s.id,'sections_to_complete',jsonb_build_array('Technical approach','Staffing','Quality control','Safety','Schedule','Required forms'))) returning id into pid;
 update public.opportunities set status='PROPOSAL' where id=oid;
 perform private.audit(o.organization_id,'proposal.generated',pid);return pid;
end $$;
