# Domain Glossary

| Istilah            | Definisi canonical                                        |
| ------------------ | --------------------------------------------------------- |
| Account            | Identitas login seseorang                                 |
| Workspace          | Batas tenant dan kepemilikan data                         |
| Personal workspace | Workspace otomatis untuk teacher individual               |
| School workspace   | Workspace organisasi milik sekolah                        |
| Membership         | Hubungan account, workspace, role, dan status             |
| Assessment         | Aggregate paket asesmen dari konfigurasi sampai final     |
| Assessment version | Snapshot versioned; final version immutable               |
| Blueprint          | Rencana distribusi indikator/topik/kesulitan sebelum soal |
| Question           | Soal terstruktur di dalam assessment version              |
| Source             | Materi yang tersedia untuk retrieval/generation           |
| Source reference   | Hubungan hasil dengan bagian/halaman sumber               |
| Catalog            | Master kurikulum, kelas, mapel, materi, dan versinya      |
| Generation job     | Proses asinkron membuat blueprint/soal                    |
| Export job         | Proses asinkron membuat PDF/artifact                      |
| Artifact           | File output privat seperti PDF                            |
| Share link         | Akses read-only terkontrol ke final version               |
| Template           | Konfigurasi generate yang dapat digunakan ulang           |
| Question bank      | Koleksi soal untuk reuse; private by default              |
| Entitlement        | Hak fitur/limit dari plan                                 |
| Quota reservation  | Unit sementara saat job dimulai                           |
| Quota commit       | Unit yang benar-benar dikonsumsi setelah sukses           |
| Teacher review     | Aksi manusia menilai/mengubah hasil AI                    |
| Finalization       | Aksi eksplisit menghasilkan immutable final version       |
| Quick review       | Review massal draft; bukan auto-final                     |
| Detail review      | Review satu per satu dengan metadata/warning              |

## Naming rules

- UI Indonesia boleh memakai “Lembar” atau “Paket soal”; kode domain memakai `assessment`.
- Jangan memakai `exam` untuk semua kasus karena Latihan bukan ujian formal.
- `user` hanya istilah generik; domain identity memakai `account` dan `membership`.
- `admin` harus dibedakan `school_admin` dan `superadmin`.

## Marketing CMS

- `marketing page`: platform-global public page identified by slug + locale.
- `page version`: immutable published or editable draft structured content snapshot.
- `global content set`: versioned navigation, footer, global CTA, and default SEO.
- `block`: whitelisted structured content shape rendered by a code-owned frontend component.
- `restore`: copying an old immutable version into a new draft; never editing history.
- `seed fallback`: Figma-approved typed content bundled in frontend for safe availability.
- “Public bank” tidak ada di MVP.
