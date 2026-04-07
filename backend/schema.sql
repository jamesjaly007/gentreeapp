create table if not exists users (
  id bigint generated always as identity primary key,
  name text not null,
  is_admin smallint not null default 0,
  created_at timestamptz default now()
);

create table if not exists people (
  id bigint generated always as identity primary key,
  first_name text not null,
  last_name text not null,
  gender text null,
  birth_date text null,
  death_date text null,
  is_deceased smallint not null default 0,
  photo_url text null,
  notes text null,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  deleted_at timestamptz null
);

create table if not exists relationships (
  id bigint generated always as identity primary key,
  source_person_id bigint not null references people(id),
  target_person_id bigint not null references people(id),
  relationship_type text not null,
  created_at timestamptz default now(),
  deleted_at timestamptz null
);

create table if not exists change_requests (
  id bigint generated always as identity primary key,
  entity_type text not null,
  action_type text not null,
  entity_id bigint null,
  payload_json text not null,
  status text not null default 'pending',
  requested_by bigint not null references users(id),
  reviewed_by bigint null references users(id),
  review_note text null,
  created_at timestamptz default now(),
  reviewed_at timestamptz null
);

create table if not exists app_settings (
  key text primary key,
  value text not null
);

insert into users(name, is_admin)
select 'Admin', 1
where not exists (select 1 from users where name = 'Admin');

insert into users(name, is_admin)
select 'Contributor', 0
where not exists (select 1 from users where name = 'Contributor');
