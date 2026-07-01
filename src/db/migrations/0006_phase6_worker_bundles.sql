alter table processing_jobs
  add column if not exists input_hash text,
  add column if not exists generation_key text not null default 'default';

create index if not exists processing_jobs_generation_idx
  on processing_jobs (type, subject_kind, generation_key);

create unique index if not exists bundles_auto_group_key_uq
  on bundles ((metadata->>'groupKey'))
  where metadata->>'createdBy' = 'auto_bundle_service';

create unique index if not exists bundle_messages_message_auto_uq
  on bundle_messages (message_id);
