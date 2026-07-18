# Decision Register

Status: `Accepted`, `Open`, `Rejected`, `Superseded`.

## Accepted — product

| ID    | Keputusan                                  | Konsekuensi                                   |
| ----- | ------------------------------------------ | --------------------------------------------- |
| P-001 | Nama kerja produk lowercase `lembar`       | Clearance merek/domain tetap gate paid launch |
| P-002 | Visi PAUD–SMA/SMK; MVP SD kelas 5–6        | Tidak membangun seluruh jenjang bersamaan     |
| P-003 | Teacher-first, school-expand               | Personal workspace P0; school workspace P1    |
| P-004 | Role: superadmin, school admin, teacher    | Individual subscriber bukan role              |
| P-005 | Web responsif sebelum mobile               | Mobile repo ditunda sampai kebutuhan terbukti |
| P-006 | AI menghasilkan draft; guru finalisasi     | Tidak ada auto-final                          |
| P-007 | Konten private by default                  | Tidak ada auto-public bank                    |
| P-008 | Output P0: print, PDF, controlled web link | Output center bagian inti MVP                 |
| P-009 | Default generate 20 pilihan ganda          | Tetap configurable sesuai entitlement         |
| P-010 | Tidak ada akun/data siswa di MVP           | Share page read-only tanpa student tracking   |
| P-011 | Konten marketing publik dikelola superadmin | CTA/copy/nav/footer dapat diubah tanpa deploy |
| P-012 | CMS memakai schema blok terstruktur         | Layout tetap code-owned; tidak ada page builder bebas |

## Accepted — engineering direction

| ID    | Keputusan                                     | Konsekuensi                             |
| ----- | --------------------------------------------- | --------------------------------------- |
| T-001 | Dua repo: `Frontend-Lembar` dan `Backend-Lembar` | CI, env, deploy, dan docs dipisah    |
| T-002 | Backend modular monolith, bukan microservices | Satu backend repo/domain/database       |
| T-003 | PostgreSQL sebagai system of record           | Relational integrity dan transaksi      |
| T-004 | Backend memakai ekosistem Node.js/JavaScript  | Runtime/tooling mengikuti kemampuan tim |
| T-005 | CMS adalah modul dalam backend monolith       | Tanpa service/vendor CMS terpisah        |
| T-006 | CMS publik tidak membutuhkan queue/Redis      | PostgreSQL + HTTP cache cukup untuk MVP   |
| D-014 | TypeScript strict untuk kedua repo            | Kontrak/type safety konsisten lintas FE/BE |
| D-015 | Next.js App Router sebagai frontend           | Route group marketing/app/ops code-owned  |

## Open — harus diputuskan sesuai gate

| ID    | Keputusan                                       | Owner            | Deadline/gate                 | Bukti                                                  |
| ----- | ----------------------------------------------- | ---------------- | ----------------------------- | ------------------------------------------------------ |
| D-001 | Clearance merek/domain `lembar`                 | Owner            | Paid launch                   | Search/legal/domain evidence                           |
| D-002 | Auth library/provider final                     | BE/Security      | B0 spike                      | Session, revocation, username/school flow, mobile path |
| D-003 | ORM final: Prisma atau alternatif               | BE               | B0                            | Migration DX, query control, deploy footprint          |
| D-004 | Queue: BullMQ/Redis atau PostgreSQL-backed      | BE/Ops           | B0                            | Reliability, VPS footprint, retry/idempotency PoC      |
| D-005 | Hosting topology/vendor                         | Ops              | Before staging                | Region, cost, backup, scaling                          |
| D-006 | Object storage vendor                           | BE/Ops           | Before source upload          | Private access, malware flow, egress                   |
| D-007 | Email provider                                  | BE/Ops           | Before recovery/invite        | Deliverability and data processing                     |
| D-008 | Payment provider                                | Owner/BE         | Paid pilot                    | Indonesian methods, webhook, settlement                |
| D-009 | Teacher Pro/school pricing                      | Owner            | Landing price/pilot           | Interview, CTA, willingness-to-pay                     |
| D-010 | DOCX P0 atau P1                                 | Owner            | Output sprint                 | Pilot demand vs maintenance                            |
| D-011 | URL/web source P0 atau deferred                 | Product/Security | Source sprint                 | Demand + SSRF protections                              |
| D-012 | Mapel/cohort pilot tepat                        | Product/Content  | Before AI eval                | Content readiness and teacher access                   |
| D-013 | AI model routing dan thresholds                 | AI/Product       | AI sprint                     | Eval quality, latency, cost                            |
| D-016 | HTTP framework: direct Fastify atau NestJS+Fastify | BE/Owner      | Before B0-01                  | Struktur reusable, footprint VPS, DX, benchmark        |
| D-017 | REST/OpenAPI dan backend-owned generated client | FE/BE            | Before integration foundation | Codegen and compatibility PoC                          |
| D-018 | API + worker entrypoints dalam repo backend     | BE/Ops           | Before B0-01                  | Long-job reliability without microservices             |
| D-019 | OpenAI sebagai provider awal backend            | Owner/AI         | Before AI spike               | Data terms, quality, cost, structured output           |
| D-020 | HTML/CSS + Playwright untuk PDF                 | FE/BE            | Before output spike           | A4 fidelity, memory, font, performance PoC             |

## Rejected/deferred

| ID    | Keputusan                                | Alasan                                                         |
| ----- | ---------------------------------------- | -------------------------------------------------------------- |
| R-001 | Microservices pada awal                  | Kompleksitas tidak sebanding dengan skala/tim                  |
| R-002 | FE dan BE dalam satu repo                | Tim memilih repository terpisah                                |
| R-003 | Native mobile sebagai MVP                | Validasi web lebih dahulu                                      |
| R-004 | Gemini atau 9Router tanpa ADR            | Agent-tool routing bukan product provider; setiap provider perlu D-019/ADR |
| R-005 | Auto-publish dan public bank             | Risiko privasi, kualitas, dan kebocoran ujian                  |
| R-006 | Semua secret diwajibkan di semua runtime | Tiap app/process hanya menerima secret yang dibutuhkan         |
| R-007 | Drag-and-drop page builder pada MVP       | Kompleks, sulit dijaga, dan tidak dibutuhkan untuk CTA/copy    |
| R-008 | CMS marketing sebagai microservice/vendor | Menambah biaya dan operasi tanpa kebutuhan terukur             |

## Cara mengubah keputusan

Accepted decision tidak diedit diam-diam. Buat ADR baru yang menjelaskan context, options,
decision, consequences, validation, dan rollback; lalu tandai keputusan lama `Superseded`.
Agent tidak boleh menerima ADR atas namanya sendiri.
