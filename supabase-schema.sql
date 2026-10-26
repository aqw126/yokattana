create table if not exists public.library_items (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.library_items enable row level security;

create policy "Users can read their own library"
on public.library_items for select to authenticated
using ((select auth.uid()) = user_id);

create policy "Users can add their own library items"
on public.library_items for insert to authenticated
with check ((select auth.uid()) = user_id);

create policy "Users can update their own library items"
on public.library_items for update to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy "Users can delete their own library items"
on public.library_items for delete to authenticated
using ((select auth.uid()) = user_id);

-- アプリ内の「アカウントを削除」で使う関数。Supabase の SQL Editor で一度だけ実行する。
-- ログイン中のユーザー自身のアカウントだけを削除する（記録は on delete cascade で一緒に消える）。
create or replace function public.delete_my_account()
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  delete from auth.users where id = auth.uid();
end;
$$;

revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;

-- 共有リンク用。Supabase の SQL Editor で、この下の部分を一度だけ実行する。
-- 共有は「その時点の内容のコピー」を shares に保存し、リンクを知っている人だけが get_share() で読める。
create table if not exists public.shares (
  id text primary key check (id ~ '^[A-Za-z0-9_-]{22,64}$'),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  item_count integer not null,
  payload jsonb not null check (pg_column_size(payload) < 1000000),
  created_at timestamptz not null default now(),
  expires_at timestamptz
);

alter table public.shares enable row level security;

create policy "Users can read their own shares"
on public.shares for select to authenticated
using ((select auth.uid()) = user_id);

create policy "Users can create their own shares"
on public.shares for insert to authenticated
with check ((select auth.uid()) = user_id);

create policy "Users can delete their own shares"
on public.shares for delete to authenticated
using ((select auth.uid()) = user_id);

-- 1人あたり50件まで
create or replace function public.limit_shares()
returns trigger
language plpgsql
as $$
begin
  if (select count(*) from public.shares where user_id = new.user_id) >= 50 then
    raise exception 'too many shares';
  end if;
  return new;
end;
$$;

drop trigger if exists shares_limit on public.shares;
create trigger shares_limit before insert on public.shares
for each row execute function public.limit_shares();

-- 閲覧用。リンクの文字列（id）を知っている人だけが、期限内の1件を読める（一覧は取れない）。
create or replace function public.get_share(p_id text)
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  select jsonb_build_object('payload', payload, 'created_at', created_at, 'expires_at', expires_at)
  from public.shares
  where id = p_id and (expires_at is null or expires_at > now());
$$;

revoke all on function public.get_share(text) from public;
grant execute on function public.get_share(text) to anon, authenticated;

-- 記録の上限と、更新日時の補正。Supabase の SQL Editor で、この下の部分を一度だけ実行する。
-- ・1件は 300KB まで（表紙は端末で 150KB 以内に縮小している）
-- ・1人あたり 5000件、合計 100MB まで（無料枠 500MB を、1人に使い切られないため）
-- ・未来の更新日時（端末の時計のずれ）は、今の時刻に直す。同期は新しい方が勝つので、未来の日時の記録は、二度と上書きできなくなるため
alter table public.library_items drop constraint if exists library_items_payload_size;
alter table public.library_items add constraint library_items_payload_size check (pg_column_size(payload) < 300000) not valid;

create index if not exists library_items_user_id_idx on public.library_items (user_id);

create or replace function public.guard_library_item()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  stamp timestamptz;
begin
  begin
    stamp := (new.payload->>'updatedAt')::timestamptz;
  exception when others then
    stamp := null;
  end;
  if stamp is null or stamp > now() + interval '5 minutes' then
    stamp := now();
    new.payload := jsonb_set(new.payload, '{updatedAt}', to_jsonb(to_char(stamp at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
  end if;
  new.updated_at := stamp;

  if (select count(*) from public.library_items where user_id = new.user_id and id <> new.id) >= 5000 then
    raise exception 'library_limit: too many items';
  end if;
  if (select coalesce(sum(pg_column_size(payload)), 0) from public.library_items where user_id = new.user_id and id <> new.id)
     + pg_column_size(new.payload) > 100000000 then
    raise exception 'library_limit: too much data';
  end if;
  return new;
end;
$$;

drop trigger if exists library_items_guard on public.library_items;
create trigger library_items_guard before insert or update on public.library_items
for each row execute function public.guard_library_item();

-- すでに未来の更新日時で保存されている記録を、今の時刻に直す
update public.library_items
set payload = jsonb_set(payload, '{updatedAt}', to_jsonb(to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
where updated_at > now() + interval '5 minutes';

-- 共有リンクの整理。Supabase の SQL Editor で、この下の部分を一度だけ実行する（何度実行しても大丈夫）。
-- ・題名は100文字まで、件数は1〜100件、期限は作成より後（既存の行は検査しない）
-- ・期限切れの共有は消す。作成のたびに自分の分を、週1回（.github/workflows/keepalive.yml）全員の分を
alter table public.shares drop constraint if exists shares_title_length;
alter table public.shares add constraint shares_title_length check (char_length(title) between 1 and 100) not valid;
alter table public.shares drop constraint if exists shares_item_count;
alter table public.shares add constraint shares_item_count check (item_count between 1 and 100) not valid;
alter table public.shares drop constraint if exists shares_expiry;
alter table public.shares add constraint shares_expiry check (expires_at is null or expires_at > created_at) not valid;

create index if not exists shares_user_id_idx on public.shares (user_id);
create index if not exists shares_expires_at_idx on public.shares (expires_at) where expires_at is not null;

create or replace function public.limit_shares()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- 期限切れのリンクは、50件の数に入れない
  delete from public.shares where user_id = new.user_id and expires_at <= now();
  if (select count(*) from public.shares where user_id = new.user_id) >= 50 then
    raise exception 'too many shares';
  end if;
  return new;
end;
$$;

-- 期限切れの共有を、全員分まとめて消す。消すのは見られなくなったものだけなので、だれが呼んでもよい
create or replace function public.purge_expired_shares()
returns integer
language sql
security definer
set search_path = public
as $$
  with gone as (delete from public.shares where expires_at <= now() returning 1)
  select count(*)::integer from gone;
$$;

revoke all on function public.purge_expired_shares() from public;
grant execute on function public.purge_expired_shares() to anon, authenticated;

select public.purge_expired_shares();
