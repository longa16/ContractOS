-- Run manually as a trusted database administrator after verified email signup.
-- Replace the UUID below. This fails closed unless a confirmed user exists.
do $$
declare owner_id uuid := '00000000-0000-0000-0000-000000000000'; org_id uuid;
begin
 if not exists(select 1 from auth.users where id=owner_id and email_confirmed_at is not null) then
  raise exception 'Replace owner_id with an existing confirmed Supabase Auth user UUID';
 end if;
 if exists(select 1 from public.memberships where user_id=owner_id) then
  raise exception 'Existing membership preserved; bootstrap already completed';
 end if;
 insert into public.organizations(name) values('ContractOS Prime Contractor') returning id into org_id;
 insert into public.memberships(organization_id,user_id,role) values(org_id,owner_id,'owner');
end $$;

-- VA provisioning example, after verifying both UUIDs and the confirmed account:
-- insert into public.memberships(organization_id,user_id,role)
-- values('YOUR_ORGANIZATION_UUID','CONFIRMED_VA_USER_UUID','va');
