-- A logged-out/revoked session cannot reuse an otherwise unexpired JWT through REST.
create function private.session_active() returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from auth.users u join auth.sessions s on s.user_id=u.id
 where u.id=auth.uid() and u.email_confirmed_at is not null
 and (u.banned_until is null or u.banned_until<=clock_timestamp())
 and s.id=(auth.jwt()->>'session_id')::uuid and (s.not_after is null or s.not_after>clock_timestamp()))
$$;
revoke all on function private.session_active() from public,anon,authenticated;
grant execute on function private.session_active() to authenticated;
create or replace function private.role_for(org uuid) returns text language sql stable security definer set search_path='' as $$
 select role from public.memberships where organization_id=org and user_id=auth.uid()
 and private.session_active() and auth.jwt()->>'aal'='aal2'
 and exists(select 1 from auth.mfa_factors f where f.user_id=auth.uid() and f.status='verified')
$$;
create or replace function private.contractor_access(org uuid, contractor uuid) returns boolean language sql stable security definer set search_path='' as $$
 select private.session_active() and case when exists(select 1 from public.memberships where user_id=auth.uid())
 then private.role_for(org) is not null else exists(select 1 from public.contractors where id=contractor and organization_id=org and user_id=auth.uid()) end
$$;
drop policy membership_read on public.memberships;
create policy membership_read on public.memberships for select to authenticated using(user_id=auth.uid() and private.session_active());
create or replace function public.accept_invitation(token text, company text, trade_name text, area text) returns uuid language plpgsql security definer set search_path='' as $$
declare inv public.contractor_invitations; cid uuid; user_email text;
begin
 if not private.session_active() then raise exception 'Not authorized' using errcode='42501'; end if;
 select email into user_email from auth.users where id=auth.uid();
 select * into inv from public.contractor_invitations where token_hash=encode(sha256(convert_to(token,'UTF8')),'hex') and accepted_at is null and expires_at>clock_timestamp() for update;
 if inv.id is null or inv.expires_at<=clock_timestamp() or lower(user_email) is distinct from inv.email then raise exception 'Invalid invitation' using errcode='42501'; end if;
 insert into public.contractors(organization_id,user_id,company_name,email,trade,service_area) values(inv.organization_id,auth.uid(),company,inv.email,trade_name,area) returning id into cid;
 update public.contractor_invitations set accepted_at=now() where id=inv.id;
 perform private.audit(inv.organization_id,'contractor.registered',cid);return cid;
end $$;
