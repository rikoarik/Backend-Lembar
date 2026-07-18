# Business Model, Workspace, Roles & Permissions

## Model bisnis

### Personal

- Teacher mendaftar sendiri.
- Sistem membuat personal workspace.
- Subscription dan kuota dimiliki workspace tersebut.
- Role tetap `teacher`; “individual user” bukan role baru.

### School

- School workspace memiliki subscription, seat, shared quota, branding, dan bank internal.
- Satu account dapat menjadi teacher di beberapa workspace dan admin pada salah satunya.
- Ownership konten mengikuti workspace tempat konten dibuat.

### Harga

Harga adalah keputusan owner yang masih terbuka. Sampai diputuskan:

- landing memakai `Coba gratis` untuk guru;
- jalur sekolah memakai `Diskusikan kebutuhan sekolah`;
- tidak ada nominal hipotesis pada UI produksi;
- agent tidak boleh mengubah placeholder menjadi angka.

## Entitas bisnis

| Entitas      | Makna                                       |
| ------------ | ------------------------------------------- |
| Account      | Identitas seseorang                         |
| Workspace    | Batas kepemilikan dan tenant                |
| Membership   | Hubungan account dengan workspace           |
| Role         | Kumpulan permission dalam scope tertentu    |
| Subscription | Paket komersial milik workspace             |
| Entitlement  | Fitur/limit yang diberikan paket            |
| Quota ledger | Catatan reservation dan konsumsi penggunaan |

## Role

### Teacher

- Membuat, meninjau, finalisasi, dan mengekspor assessment.
- Mengelola source miliknya dalam workspace aktif.
- Menggunakan bank privat dan template.

### School admin

- Mengelola profil sekolah, membership, seat, shared quota, branding, template sekolah,
  dan bank internal.
- Dapat memiliki permission teacher.
- Tidak otomatis melihat personal workspace atau konten privat teacher.

### Superadmin

- Role tingkat platform, bukan membership sekolah.
- Mengelola tenant state, plan/entitlement, catalog, feature flag, job operations,
  support, audit, incident response, dan konten marketing publik.
- Akses isi materi/soal hanya melalui support workflow yang sah, minimum privilege,
  reason code, dan audit.

## Matriks permission awal

| Aksi                                     |          Teacher          |         School admin          |        Superadmin         |
| ---------------------------------------- | :-----------------------: | :---------------------------: | :-----------------------: |
| Mengelola account sendiri                |             ✓             |               ✓               |             ✓             |
| Membuat assessment pada workspace aktif  |             ✓             | Jika punya teacher permission |       Support-only        |
| Finalisasi/export assessment sendiri     |             ✓             | Jika punya teacher permission |       Tidak default       |
| Melihat bank privat teacher lain         |             —             |               —               |   Support-only audited    |
| Melihat bank sekolah                     | Anggota yang diberi akses |               ✓               |   Support-only audited    |
| Mengundang/menonaktifkan anggota sekolah |             —             |               ✓               | Emergency/support policy  |
| Mengubah role sekolah                    |             —             |      ✓, dibatasi policy       | Emergency/support policy  |
| Melihat penggunaan agregat sekolah       |       Diri sendiri        |               ✓               |             ✓             |
| Mengubah plan/entitlement                |             —             |       Request/purchase        |         ✓ audited         |
| Adjustment kuota                         |             —             |               —               |      ✓ dengan alasan      |
| Mengubah catalog kurikulum               |             —             |               —               | ✓ dengan workflow publish |
| Mengelola model/prompt aktif             |             —             |               —               |     ✓, gated rollout      |
| Melihat konten marketing published       |             ✓             |               ✓               |             ✓             |
| Melihat preview/draft marketing           |             —             |               —               |         ✓ audited         |
| Membuat/mengubah draft marketing          |             —             |               —               |         ✓ audited         |
| Publish/unpublish/restore marketing       |             —             |               —               | ✓ step-up + audit trail   |

## Batas permission CMS

- CMS marketing adalah scope platform, bukan resource tenant; request ops tidak menerima
  workspace ID sebagai pengganti authorization superadmin.
- School admin tidak dapat mengubah landing global, CTA, harga, footer, atau navigation.
- Teacher dan pengunjung hanya menerima snapshot published yang sama.
- Preview memakai session superadmin dan token pendek/single-purpose; URL preview tidak
  boleh menjadi public share link.
- Publish tidak memberi superadmin hak mengubah keputusan owner yang masih terbuka.

## Aturan membership

- Semua tenant-bound record memiliki `workspace_id`.
- Request membawa workspace context eksplisit dan backend memverifikasi membership.
- Cache frontend di-key berdasarkan account + workspace.
- Menonaktifkan membership mencabut akses baru dan session/permission cache segera diperbarui.
- School admin tidak boleh mengeluarkan owner/admin terakhir tanpa transfer yang valid.

## Credential sekolah

Pilihan onboarding sekolah harus ditentukan melalui auth spike. Apabila sekolah perlu membuat
akses bagi guru tanpa email aktif:

- admin tidak pernah melihat password permanen;
- credential sementara single-use atau wajib diganti;
- reset menghasilkan token/credential baru, bukan membaca password lama;
- pengiriman/print credential mengikuti prosedur aman;
- semua aksi dicatat.

## Kuota

- Generate penuh memakai reservation sebelum job.
- Unit berhasil di-commit; kegagalan me-release reservation.
- Regenerate satu soal menggunakan unit lebih kecil daripada paket penuh.
- Retry idempotent tidak menggandakan konsumsi.
- School quota adalah shared pool dengan laporan per anggota yang proporsional dan tidak
  membuka isi assessment.
