# 2026-09-30 — CI quality gate (kanban t_2e396f27): dev deploy tanpa gate apa pun

**Task:** `t_2e396f27` ([CI], assignee `lembar-devops`). Temuan AUDIT-2
(`t_4790fef9`), revisi `3f8dbe0`.
**Repo:** `Backend-Lembar`. Branch kerja
`p_270d5536/t_2e396f27-ci-no-quality-gate-on-dev-deploy-backend`, di-base dari
`origin/dev` `3f8dbe0`.

## Gejala

`.github/workflows/` hanya berisi satu workflow, `deploy-backend.yml`, dan
job-nya cuma menjalankan `pnpm install --frozen-lockfile`, `pnpm run build`,
`pm2 restart`, lalu poll `/health`. Tidak ada typecheck, lint, format, test,
test:db, openapi, atau secret scan. `package.json` bahkan tidak punya script
secret-scan, padahal AGENTS.md mensyaratkannya.

Akibatnya, pada tip dev yang sama: `pnpm lint` 260 problem (258 error),
`pnpm format:check` 168 file, `pnpm test` 1 gagal, `pnpm test:db` 9 gagal,
`pnpm openapi:breaking` drift — dan **semuanya auto-deploy ke produksi setiap
push ke `dev`**.

## Patch

- `scripts/quality-gate.sh` (baru) — urutan gate AGENTS.md dalam satu tempat,
  fail-fast: install → typecheck → lint → format:check → test → test:db →
  openapi:validate + openapi:breaking → secret:scan. `GATE_CONTINUE_ON_FAIL=1`
  menjalankan semua langkah untuk triage.
- `package.json` — script `gate` (`bash scripts/quality-gate.sh`) dan
  `secret:scan`.
- `.github/workflows/deploy-backend.yml` — job baru `gate`; job `deploy`
  sekarang `needs: gate`, jadi gate merah **memblokir deploy produksi**. Gate
  ditaruh di workflow yang sama karena `needs:` GitHub Actions tidak bisa
  menyeberangi file workflow — workflow terpisah bisa selesai _setelah_ deploy
  sudah jalan. Filter `paths` diperlebar (`test/**`, `scripts/**`,
  `eslint.config.mjs`, `.prettierrc.json`, `.prettierignore`,
  `compose.test.yaml`).
- `.github/workflows/quality-gate.yml` (baru) — gate yang sama untuk
  `pull_request` dan push ke branch selain `dev`, supaya pohon rusak tertangkap
  sebelum mendarat di dev.
- `scripts/secret-scan.ts` + `scripts/secret-scan.allow` (baru) — gate secret
  scan yang AGENTS.md syaratkan tapi belum ada. Memindai **hanya** file
  git-tracked (jadi `node_modules/`, `dist/`, `.env` di luar cakupan secara
  konstruksi), tidak pernah mencetak nilai (hanya path, baris, rule id, preview
  ter-redaksi 2 karakter + panjang), dan menolak suppression tanpa alasan
  (exit 2).
- `test/scripts/quality-gate.test.ts` (baru) — mengunci urutan langkah gate,
  edge `deploy needs: gate`, dan kebijakan secret-scan (scanner wajib tetap
  menolak suppression tanpa alasan, allowlist wajib memuat larangan
  allowlist kredensial nyata).
- `.prettierignore` — `scripts/quality-gate.sh` dan `scripts/secret-scan.allow`
  tidak punya parser prettier; tanpa entri ini `format:check` error-out.
- `docs/contracts/CI-QUALITY-GATE.md` (baru) — apa yang jalan, di mana,
  keputusan test:db in-CI, baseline, dan rollback.

## Keputusan desain

**test:db di CI, bukan out-of-CI.** `pnpm test:db` adalah langkah ke-6 gate,
memakai Postgres ephemeral dari `compose.test.yaml` di `127.0.0.1:55432`. Runner
self-hosted punya docker, jadi tidak ada alasan mendokumentasikannya sebagai
out-of-CI. Konsekuensinya runner wajib punya `docker`; kalau tidak, `test:db`
gagal dan deploy diblokir — arah fail-closed yang memang diinginkan.

**Entropy sweep ditolak.** Versi pertama scanner memakai sapuan Shannon-entropy
atas setiap literal. Di pohon ini ia menyala ~580 kali, seluruhnya pada
identifier, kode error (`SCHEMA_VALIDATION_FAILED`), UUID, pointer `$ref` YAML,
dan path absolut. Gate yang berisik seperti itu akan dimatikan atau di-allowlist
borongan — lebih buruk daripada tidak ada gate. Yang dipakai: rule bentuk
(blok private key, prefix token vendor, JWT, connection URL berpassword) plus
satu rule berbasis **nama**: literal yang di-assign ke nama berakhiran kata
kredensial (`apiKey`, `jwtSecret`, `csrfToken`, `OPENAI_API_KEY`). Nama seperti
`password_too_short`, `templateKey`, `idempotencyKey`, `trackingKey` sengaja
tidak ikut — di codebase ini itu identifier logis, bukan material kredensial.
Alasan ini ditulis di header script supaya tidak ada yang menambahkan kembali
entropy sweep telanjang.

**Gate dijalankan sebagai user `hermes`.** Runner self-hosted berjalan sebagai
root tanpa `HOME` dan tanpa `node`/`pnpm` di PATH (keduanya di
`/home/hermes/.local/bin`). Run CI pertama mati di langkah pertama dengan
`fatal: $HOME not set`. Gate sekarang lewat pola `sudo -u hermes -H` yang sama
dengan job deploy, dengan `chown` workspace runner (milik root) dulu — ini juga
yang memberi gate akses docker group untuk `test:db`.

## Bukti: gate GAGAL pada commit yang rusak

Run CI nyata pada branch ini (workflow `quality-gate.yml`, runner self-hosted):

- Run URL: https://github.com/rikoarik/Backend-Lembar/actions/runs/36755101377
  — commit `835f787`, **failure**.
- Ringkasan gate di log run itu:

```
v22.23.1
11.14.0
=== gate: install ===
=== gate: typecheck ===
=== gate: lint ===
=== gate summary ===
PASS  install
PASS  typecheck
FAIL  lint
gate FAILED at step: lint
```

Run pertama (`36752580823`) juga merah tapi karena bug runner (`$HOME not set`),
bukan karena kode; run `36752944054` merah karena hal yang sama. Yang dikutip di
atas adalah run setelah perbaikan, jadi yang gagal memang langkah gate, bukan
infrastruktur runner.

Reproduksi lokal dengan environment runner yang sama
(`sudo -u hermes -H ... pnpm gate`, log
`/home/hermes/.hermes/profiles/lembar-devops/cache/scratch/ci-gate/gate-local-run.log`):
`EXIT=1`, `FAIL lint`, 273 problem (271 error) — jumlahnya naik dari 258 karena
`eslint .` memindai lebih banyak file setelah `paths`/`test/**` ikut ter-checkout;
seluruh tambahannya **pre-existing** (`test/modules/ops/*`, `test/modules/school/*`,
dan `no-undef` pada `scripts/*.mjs`), bukan dari file baru task ini.

## Bukti: gate LULUS pada pohon bersih (jalur pass terbukti)

Gate tidak bisa hijau di dev sekarang karena dev memang merah pada lint/format/
test/test:db/openapi-breaking (lihat baseline di bawah). Jadi jalur PASS
dibuktikan pada subset yang memang sudah hijau, plus probe terkontrol:

- `pnpm typecheck` → exit 0 (di runner, `PASS typecheck`).
- `pnpm secret:scan` pada pohon bersih → `secret:scan ok — 571 tracked files, 0 findings.` exit 0.
- Probe terkontrol untuk jalur **gagal** secret-scan: pohon uji
  `/home/hermes/.hermes/profiles/lembar-devops/cache/scratch/ci-gate/broken-probe/`
  berisi 10 kredensial format nyata yang ditanam (private key PEM, `sk-proj-…`,
  `AKIA…`, `ghp_…`, `sk_live_…`, JWT terserialisasi, connection URL berpassword
  ke host produksi, `jwtSecret`, `apiKey`, `ghToken`). Hasil: **10 finding, exit 1**,
  semuanya ter-redaksi. Setelah rule nama diperbaiki (camelCase + `key` hanya bila
  terkuantifikasi), probe ini juga yang membuktikan recall-nya, sementara pohon
  bersih tetap 0 temuan.
- `npx eslint scripts/secret-scan.ts test/scripts/quality-gate.test.ts` → 0 error.
- `npx vitest run test/scripts/quality-gate.test.ts` → 4/4 pass.
- `npx prettier --check` pada seluruh file baru → bersih (kecuali `.allow`/`.sh`
  yang memang di-ignore).

## Baseline pada saat gate diperkenalkan

Diukur pada `3f8dbe0` (= `origin/dev`):

| Langkah          | Hasil                                                                      |
| ---------------- | -------------------------------------------------------------------------- |
| install          | PASS                                                                       |
| typecheck        | PASS                                                                       |
| lint             | FAIL — 260 problem (258 error)                                             |
| format:check     | FAIL — 168 file                                                            |
| test             | FAIL — 1 gagal (`test/plan-catalog.test.ts`, `priceAmount` 49000 → 149000) |
| test:db          | FAIL — 9 gagal                                                             |
| openapi:validate | PASS                                                                       |
| openapi:breaking | FAIL — drift baseline                                                      |
| secret:scan      | PASS                                                                       |

Konsekuensi: sampai perbaikan lint/format/test/test:db/openapi-breaking mendarat
(t_e901a838, t_d28d1ef8, t_ee5e0760), push ke `dev` akan menampilkan job `gate`
merah dan job `deploy` di-skip. Itu perilaku yang benar untuk pohon merah — dan
justru itu inti task ini: sebelumnya pohon merah yang sama auto-deploy ke
produksi.

## Batas / non-scope

- Tidak men-deploy, tidak push ke `dev`. Branch kerja di-push ke branch task
  saja.
- Tidak menambah provider/secret baru ke CI. Gate tidak butuh secret apa pun.
- Tidak memperbaiki lint/format/test/test:db/openapi-breaking — itu task
  terpisah (t_e901a838, t_d28d1ef8, t_ee5e0760, t_ed5e0760-series). Task ini
  hanya memasang gate-nya.
- `AGENTS.md` **tidak bisa** diedit dari sesi ini (file instruksi agen,
  dilindungi — approval prompt timeout). Dokumentasi gate karena itu ditaruh di
  `docs/contracts/CI-QUALITY-GATE.md`, dan AGENTS.md tetap memuat kalimat
  "secret scan" di bagian Quality gates yang sudah ada. Kalau owner ingin
  pointer eksplisit di AGENTS.md, itu edit satu paragraf manual.

## Rollback

Revert commit: hapus `scripts/quality-gate.sh`, `scripts/secret-scan.ts`,
`scripts/secret-scan.allow`, `.github/workflows/quality-gate.yml`,
`test/scripts/quality-gate.test.ts`, `docs/contracts/CI-QUALITY-GATE.md`, buang
script `gate`/`secret:scan` dari `package.json`, dan kembalikan
`deploy-backend.yml` ke bentuk satu-job. Tidak ada perubahan data, skema, atau
state runtime; perubahannya murni konfigurasi CI.

## Hotspot

`.github/workflows/deploy-backend.yml` dan `package.json` kemungkinan besar
disentuh lagi oleh task devops lain (mis. penambahan deploy FE atau script
baru). Perubahan di sini kecil dan terlokalisasi; konflik kalau ada harus
diselesaikan dengan mempertahankan job `gate` + `needs: gate`, karena itu satu-
satunya hal yang memblokir deploy.
