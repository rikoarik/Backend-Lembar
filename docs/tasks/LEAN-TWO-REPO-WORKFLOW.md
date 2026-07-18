# Lean Two-Repository Workflow

Tujuan: menjalankan Frontend-Lembar dan Backend-Lembar paralel tanpa recursive orchestrator,
context berulang, atau banyak worktree untuk file yang sama.

## Model kerja

- Satu terminal Claude Code di Frontend-Lembar.
- Satu terminal Claude Code di Backend-Lembar.
- Maksimal satu task aktif per repository; FE dan BE boleh paralel jika dependency terpenuhi.
- Satu task memakai satu branch/session baru.
- Task contract + maksimal tiga dokumen relevan.
- Tidak ada agent yang otomatis memulai task berikutnya.
- Owner menerima hasil, menentukan merge/push, lalu memberi START berikutnya.

## Siklus

1. Periksa task READY dan dependency.
2. Buat branch bernama task, misalnya feat/B1-06-marketing-content.
3. Mulai Claude Code dari root repository dan paste prompt task.
4. Agent inspect, implement, test, commit lokal, dan mengirim handoff <= 500 kata.
5. Owner review diff/evidence; request correction atau merge normal.
6. Sinkronkan OpenAPI artifact sebelum task consumer frontend dimulai.

## CMS sequence

1. B1-06 backend domain + published read API.
2. F1-06 frontend renderer dapat dimulai setelah OpenAPI B1-06 dipublikasikan.
3. B6-06 backend authoring setelah superadmin/ops foundation B6-03.
4. F6-05 frontend ops UI setelah B6-06 artifact tersedia.
5. X6-01 integration gate setelah empat task diterima.

B1-06 dan pekerjaan frontend lain yang tidak memakai CMS boleh paralel. F1-06 tidak boleh
mengarang endpoint sambil menunggu backend.

## Context/cost guard

- Jangan paste PRD penuh atau handoff lama ke prompt.
- Jangan membaca semua docs untuk orientasi ulang.
- Jangan spawn subagent untuk audit/summarize.
- Gunakan rg/git diff/test/screenshot untuk evidence.
- Jika context mendekati 70%, tulis checkpoint singkat di handoff task, compact, lalu lanjutkan
  task yang sama; jangan memulai task baru.
- Dua kegagalan pendekatan yang sama adalah stop-and-report, bukan loop otomatis.

## Merge policy

- Backend owns executable OpenAPI.
- Frontend pins generated artifact/version and does not edit it.
- Merge normal, no force push.
- Production migration/deploy/secret actions always require owner instruction.
