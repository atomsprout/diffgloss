---
id: tenant-scope-required
title: Database queries must include tenant_id scoping
severity: important
kind: llm
include:
  - "src/db/**"
  - "src/**/db*.ts"
exclude:
  - "**/*.test.ts"
pattern: "db\\.query\\("
evidence: file-line-required
tags:
  - security
  - multi-tenant
---
Every newly added or modified `db.query(...)` call must filter by `tenant_id` or go through `scopedQuery(ctx, ...)`.
Exceptions: migration scripts under `migrations/`.
