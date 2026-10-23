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
