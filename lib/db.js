'use strict';
// Postgres access. Production uses Neon over HTTP. Tests swap in an in-memory Postgres via setTestDb().
const { neon } = require('@neondatabase/serverless');

let sql = null;
let testDb = null;
let ready = null;

const SCHEMA = [
  `create table if not exists users (
     id uuid primary key default gen_random_uuid(),
     google_sub text unique not null,
     email text not null,
     name text not null default '',
     created_at timestamptz not null default now(),
     daily_limit numeric(12,2) not null default 0,
     tz text not null default 'America/Toronto',
     key_hash text unique,
     key_enc text,
     session_version integer not null default 1
   )`,
  `create table if not exists purchases (
     id bigserial primary key,
     user_id uuid not null references users(id) on delete cascade,
     title text not null,
     body text not null,
     state text not null default 'open',
     created_at timestamptz not null default now(),
     updated_at timestamptz not null default now()
   )`,
  'create index if not exists purchases_user_created on purchases (user_id, created_at desc)',
  `create table if not exists devices (
     id bigserial primary key,
     user_id uuid not null references users(id) on delete cascade,
     endpoint text unique not null,
     p256dh text not null,
     auth text not null,
     created_at timestamptz not null default now()
   )`,
  `create table if not exists notes_sent (
     user_id uuid not null references users(id) on delete cascade,
     kind text not null,
     day text not null,
     primary key (user_id, kind, day)
   )`
];

const raw = async (text, params) => {
  if (testDb) return testDb(text, params || []);
  if (!sql) {
    const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
    if (!url) throw new Error('No database is connected');
    sql = neon(url);
  }
  return sql.query(text, params || []);
};

// Runs one statement and returns the rows. The tables are made the first time.
const q = async (text, params) => {
  if (!ready) {
    ready = (async () => { for (const s of SCHEMA) await raw(s); })().catch((e) => { ready = null; throw e; });
  }
  await ready;
  return raw(text, params);
};

const setTestDb = (fn) => { testDb = fn; ready = null; };

module.exports = { q, setTestDb };
