# Functional Requirements Document — MVP

Versi: 1.2-owner-review  
Prioritas: `P0` pilot wajib, `P1` school pilot, `P2` lanjutan

## Format acceptance

Setiap requirement mempunyai ID stabil. Implementasi tidak dianggap selesai hanya karena UI
terlihat; acceptance harus mencakup permission, state gagal, analytics, dan test yang relevan.

## 1. Public & acquisition

### FR-PUB-001 Landing page `P0`

- Menjelaskan outcome: materi → draft → review → print/PDF/link.
- Memisahkan jalur guru individu dan sekolah.
- Tidak menampilkan harga final sebelum keputusan harga diterima.
- CTA primer menuju trial/daftar; CTA sekolah menuju lead/demo.
- Memiliki halaman kebijakan minimum sebelum menerima file pengguna.

### FR-PUB-002 Lead sekolah `P0`

- Form mencatat nama, kontak, sekolah, jumlah guru, dan consent.
- Anti-spam, rate limit, dan delivery failure state tersedia.

### FR-CMS-001 Public marketing content `P0`

- Public API hanya mengembalikan versi published untuk slug/locale yang diminta.
- Payload mencakup version, page metadata, blok terstruktur, global navigation/footer, dan
  ETag; draft, audit metadata internal, dan identitas editor tidak pernah ikut.
- Frontend menyediakan seed/fallback tervalidasi agar landing tidak kosong ketika API belum
  tersedia, timeout, atau mengirim schema yang tidak didukung.
- Unknown block gagal secara aman per section dan tidak membuat seluruh halaman blank.

### FR-CMS-002 Superadmin authoring `P0`

- Hanya superadmin dapat membuat/mengubah draft, melihat preview, publish, unpublish, dan
  membuat draft pemulihan dari versi lama.
- Edit memakai revision/ETag agar dua editor tidak saling menimpa secara diam-diam.
- Publish memvalidasi schema, URL CTA, asset, required slot, dan aturan keputusan produk.
- Semua aksi authoring/publish dicatat pada audit log.

### FR-CMS-003 Fixed block system `P0`

- Daftar block/section di-whitelist dan versioned; CMS tidak menerima arbitrary HTML,
  JavaScript, CSS, atau nama komponen runtime.
- CTA menyimpan id, label, href, variant, placement, audience, tracking key, dan enabled.
- Layout, typography, motion, dan responsive behavior tetap berada di frontend.
- Perubahan schema mengikuti kontrak OpenAPI dan aturan compatibility lintas repo.

## 2. Identity & workspace

### FR-ID-001 Register/login/logout/recovery `P0`

- Mendukung metode yang diputuskan dalam auth spike.
- Session dapat dicabut dan logout menghapus akses aktif.
- Error tidak membocorkan apakah akun tertentu terdaftar.

### FR-WS-001 Personal workspace `P0`

- Dibuat otomatis untuk teacher baru.
- Account yang sama dapat memiliki lebih dari satu membership.

### FR-WS-002 Active workspace `P0/P1`

- Semua request tenant-bound memakai workspace aktif eksplisit.
- Switching workspace mengubah data, permission, entitlement, dan branding.
- Tidak boleh ada data workspace sebelumnya tertinggal di cache UI.

### FR-WS-003 School membership `P1`

- School admin dapat mengundang, menonaktifkan, dan mengubah role anggota sesuai policy.
- Undangan single-use dan kedaluwarsa.
- Admin tidak dapat membaca personal workspace guru.

## 3. Catalog & curriculum

### FR-CAT-001 Catalog dependency `P0`

- Kelas memfilter mapel.
- Versi kurikulum + kelas + mapel memfilter materi.
- Empty, loading, archived, dan unavailable state jelas.

### FR-CAT-002 Curriculum versioning `P0`

- Data menyimpan sumber, versi, tanggal berlaku, status, dan histori.
- Assessment final menunjuk versi immutable yang digunakan.

## 4. Source material

### FR-SRC-001 Catalog source `P0`

- Guru dapat memilih materi yang telah tersedia untuk kombinasi kelas/mapel.
- Sistem menunjukkan asal/versi materi secara ringkas.

### FR-SRC-002 PDF upload `P0`

- Validasi MIME sebenarnya, ukuran, jumlah halaman, malware, dan akses workspace.
- Upload langsung ke private object storage melalui mekanisme terkontrol.
- Extraction job memiliki status queued/processing/ready/failed.
- Guru dapat menghapus source sesuai retention policy.

### FR-SRC-003 Source insufficiency `P0`

- Sistem memberi tahu jika sumber tidak cukup untuk jumlah/jenis soal.
- Guru dapat mengubah materi atau jumlah soal; sistem tidak diam-diam mengarang di luar sumber
  pada strict mode.

## 5. Generate configuration

### FR-GEN-001 Form fields `P0`

- Source strategy, kelas, kurikulum, mapel, materi, jenis lembar, kesulitan, jumlah,
  komposisi, mode review, fokus guru, dan contoh soal.
- Validasi frontend dan backend konsisten; backend tetap authoritative.

### FR-GEN-002 Summary & submission `P0`

- Ringkasan memperlihatkan seluruh konfigurasi sebelum submit.
- Submit berulang dengan idempotency key tidak membuat job/kuota ganda.

### FR-GEN-003 Async job `P0`

- Status: queued, preparing, generating, validating, completed, partially_failed, failed,
  cancelled.
- Pengguna dapat meninggalkan halaman dan kembali.
- Gagal tidak mengonsumsi kuota yang belum berhasil.

## 6. Blueprint & AI generation

### FR-AI-001 Blueprint `P0`

- Sistem menghasilkan distribusi indikator/topik/kesulitan sebelum atau sebagai bagian
  generation sesuai mode produk yang disetujui.
- Blueprint tersimpan dan setiap soal menunjuk item blueprint.

### FR-AI-002 Structured question `P0`

- Output mengikuti schema versioned.
- Pilihan ganda minimal memiliki stem, opsi, answer key, explanation, difficulty,
  curriculum/topic references, dan source references.

### FR-AI-003 Quality checks `P0`

- Deterministic validation wajib sebelum hasil ditampilkan.
- Hasil yang gagal diperbaiki atau ditandai, bukan disamarkan sebagai sukses.

## 7. Review & editing

### FR-REV-001 Quick review `P0`

- Memungkinkan menerima banyak soal sebagai draft review.
- Tidak pernah mengubah assessment menjadi final secara otomatis.

### FR-REV-002 Detail review `P0`

- Menampilkan satu soal beserta opsi, kunci, pembahasan, indikator, kesulitan, sumber,
  dan quality warning.

### FR-REV-003 Edit/regenerate `P0`

- Guru dapat mengedit field yang diizinkan, menghapus, mengurutkan, atau regenerate satu soal.
- Riwayat versi/audit minimum disimpan.
- Regenerate satu soal tidak mengubah soal lain.

### FR-REV-004 Autosave/conflict `P0`

- Draft tersimpan otomatis.
- Konflik versi tidak boleh diam-diam menimpa perubahan terbaru.

## 8. Finalization & output

### FR-FIN-001 Finalize `P0`

- Hanya pemilik permission yang dapat finalisasi.
- Konfirmasi menjelaskan bahwa guru bertanggung jawab meninjau hasil.
- Versi final immutable; perubahan membuat versi/draft baru.

### FR-OUT-001 Print preview `P0`

- Preview A4 menyamai hasil PDF dalam toleransi visual yang disepakati.
- Opsi layout dan inclusion tidak mengubah konten final.

### FR-OUT-002 PDF `P0`

- Export asinkron, idempotent, private, dan dapat diunduh dengan URL sementara.
- Kunci/pembahasan dapat dibuat sebagai bagian terpisah.

### FR-OUT-003 Share link `P0`

- Read-only, revocable, optional expiry, no-index.
- Akses dicatat tanpa menyimpan data pribadi pengunjung yang tidak diperlukan.

### FR-OUT-004 DOCX `P1/Open`

- Hanya dibuat jika kebutuhan pilot membenarkan biaya mempertahankan layout editable.

## 9. Library

### FR-LIB-001 History `P0`

- Filter berdasarkan kelas, mapel, jenis, status, workspace, dan tanggal.
- Aksi: buka, duplikat, cetak ulang, archive sesuai permission.

### FR-LIB-002 Private question bank `P0`

- Soal hasil generate tersimpan privat.
- Tidak otomatis masuk bank publik atau bank sekolah.
- Guru dapat menandai soal untuk reuse.

### FR-LIB-003 Templates `P0`

- Menyimpan konfigurasi, bukan secret atau snapshot materi tanpa izin.
- Menjalankan template tetap memvalidasi catalog/version terbaru.

## 10. Commerce & quota

### FR-COM-001 Entitlement `P0`

- Backend menentukan fitur dan limit; frontend hanya merepresentasikan.
- Perubahan paket tidak memodifikasi data historis.

### FR-COM-002 Quota ledger `P0`

- Reservation, commit, release, adjustment, dan refund dapat diaudit.
- Retry/idempotency tidak melakukan double charge.

### FR-COM-003 School seats `P1`

- Seat limit dan shared quota ditegakkan di backend.

## 11. Admin

### FR-ADM-001 Superadmin minimum `P0`

- Cari tenant/account, lihat status job, adjustment kuota dengan alasan, feature flag,
  audit log, serta kelola konten marketing publik.
- Support access dibatasi, dicatat, dan tidak memakai impersonation tersembunyi.

### FR-ADM-002 School admin `P1`

- Kelola profil, anggota, role, seat, quota view, template, dan bank internal.
- Tidak dapat membuka personal workspace teacher.

## 12. Cross-cutting

### FR-X-001 Authorization `P0`

- Setiap endpoint tenant-bound memverifikasi session, membership, role, dan workspace.
- ID acak bukan kontrol authorization.

### FR-X-002 Audit `P0`

- Login sensitif, perubahan role, finalisasi, share link, quota adjustment, dan support action
  dicatat.
- CMS draft, preview token, publish, unpublish, restore, dan perubahan media dicatat.

### FR-X-003 Analytics `P0`

- Event tidak mengandung teks soal, materi, token share, atau data sensitif.

### FR-X-004 Localization `P0`

- UI MVP berbahasa Indonesia; tanggal/waktu mengikuti locale dan timezone pengguna.

### FR-X-005 Deletion/retention `P0`

- Penghapusan account/workspace/source mengikuti policy dan dependency.
- Backup expiry serta artifact cleanup didokumentasikan.
