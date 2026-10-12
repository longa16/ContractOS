create index documents_contractor_kind on public.documents(contractor_id,kind);
create index documents_opportunity_created on public.documents(opportunity_id,created_at desc,id desc);
create index requirements_opportunity on public.requirements(opportunity_id);
create index requirements_source on public.requirements(source_document_id);
create index rates_contractor on public.rates(contractor_id);
create index scenarios_opportunity_created on public.pricing_scenarios(opportunity_id,created_at desc,id desc);
create index proposals_opportunity_created on public.proposals(opportunity_id,created_at desc,id desc);
create index audit_organization_id on public.audit_events(organization_id,id desc);
create index analysis_opportunity on public.analysis_runs(opportunity_id);
create index facts_organization on public.company_facts(organization_id);

create function public.revoke_approvals(oid uuid, reason text) returns void language plpgsql security definer set search_path='' as $$
declare o public.opportunities;
begin
 select * into o from public.opportunities where id=oid for update;
 perform private.require_role(o.organization_id,true);
 perform private.assert_open(oid);
 if length(btrim(reason)) not between 1 and 4000 then raise exception 'Reason required'; end if;
 perform private.touch_opportunity(oid);
 perform private.audit(o.organization_id,'approvals.revoked',oid,jsonb_build_object('previous_revision',o.revision));
 insert into public.approvals(organization_id,opportunity_id,gate,revision,decision,rationale,actor_id)
 values(o.organization_id,oid,'submission',o.revision+1,false,reason,auth.uid());
end $$;
revoke all on function public.revoke_approvals(uuid,text) from public,anon;
grant execute on function public.revoke_approvals(uuid,text) to authenticated;

create function public.revoke_document(did uuid, reason text) returns void language plpgsql security definer set search_path='' as $$
declare d public.documents;
begin
 select * into d from public.documents where id=did for update;
 perform private.require_role(d.organization_id,true);
 if length(btrim(reason)) not between 1 and 4000 then raise exception 'Reason required'; end if;
 update public.documents set revoked_at=now(),revoked_by=auth.uid(),revoke_reason=reason where id=did;
 if d.opportunity_id is not null then perform private.touch_opportunity(d.opportunity_id); end if;
 if d.contractor_id is not null then perform private.invalidate_contractor(d.contractor_id); end if;
 perform private.audit(d.organization_id,'document.revoked',did);
end $$;
revoke all on function public.revoke_document(uuid,text) from public,anon;
grant execute on function public.revoke_document(uuid,text) to authenticated;
