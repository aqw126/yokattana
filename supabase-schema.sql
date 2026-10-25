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
