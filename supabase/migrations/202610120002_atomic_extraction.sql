-- Atomic AI import: no partially imported matrix and one revision change.
create function public.import_requirements(oid uuid, did uuid, extraction jsonb) returns integer
language plpgsql security definer set search_path='' as $$
declare org uuid; item jsonb; count_value integer := 0;
begin
 select organization_id into org from public.opportunities where id=oid for update;
 perform private.require_role(org);
 if not exists(select 1 from public.documents where id=did and opportunity_id=oid and mime_type='application/pdf' and kind in ('SOLICITATION','AMENDMENT')) then raise exception 'Invalid extraction source'; end if;
 if jsonb_typeof(extraction->'requirements')<>'array' or jsonb_array_length(extraction->'requirements')>100 then raise exception 'Invalid extraction'; end if;
 if exists(select 1 from public.requirements where source_document_id=did) then raise exception 'Document already analyzed; review existing requirements'; end if;
 for item in select value from jsonb_array_elements(extraction->'requirements') loop
  insert into public.requirements(organization_id,opportunity_id,requirement,category,mandatory,source_document_id,page_number,source_excerpt)
  values(org,oid,item->>'requirement',item->>'category',(item->>'mandatory')::boolean,did,(item->>'page_number')::integer,item->>'source_excerpt');
  count_value:=count_value+1;
 end loop;
 if count_value=0 then raise exception 'No requirements extracted'; end if;
 perform private.touch_opportunity(oid);
 perform private.audit(org,'ai.requirements.drafted',oid,jsonb_build_object('source_document_id',did,'count',count_value,'risks_count',jsonb_array_length(extraction->'risks')));
 return count_value;
end $$;
revoke all on function public.import_requirements(uuid,uuid,jsonb) from public,anon;
grant execute on function public.import_requirements(uuid,uuid,jsonb) to authenticated;
