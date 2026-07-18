# Product Requirements Document — lembar

Versi: 1.2-owner-review  
Tanggal: 18 Juli 2026  
Owner: Arik / product owner  
Status: untuk diskusi dan persetujuan; bukan otorisasi build

## 1. Ringkasan

`lembar` adalah workspace untuk membantu guru menyusun paket asesmen yang relevan,
dapat diperiksa, siap dicetak, dan mudah digunakan ulang. AI menghasilkan draft terstruktur;
guru tetap memutuskan isi final.

Visi jangka panjang mencakup PAUD, SD, SMP, SMA, dan SMK. MVP tidak membangun semuanya
sekaligus. Beachhead yang direkomendasikan adalah guru SD kelas 5–6 dengan output utama
paket soal tertulis.

`lembar` bukan chatbot dan bukan sekadar tombol “generate soal”. Produk mencakup alur:

1. Memilih konteks kurikulum, kelas, mata pelajaran, jenis asesmen, dan materi.
2. Menyusun konfigurasi/kisi-kisi.
3. Menghasilkan soal dan kunci dalam format terstruktur.
4. Meninjau, mengedit, mengganti, dan menyetujui soal.
5. Memfinalisasi paket.
6. Mencetak, mengunduh PDF, atau membagikan tautan web terkontrol.
7. Menyimpan hasil ke riwayat, bank privat, atau template.

## 2. Masalah pengguna

Guru berulang kali menyusun latihan, ulangan harian, UTS/STS, UAS/SAS, remedial, pengayaan,
dan tryout. Pekerjaan tersebar antara buku, PDF, soal lama, mesin pencari, AI umum, dan
aplikasi pengolah kata.

Masalah yang harus dibuktikan dan diselesaikan:

- Menyusun isi, opsi, kunci, dan format cetak memakan waktu.
- Hasil AI umum sering terlalu generik atau tidak sesuai materi yang diajarkan.
- Soal dapat ambigu, memiliki lebih dari satu jawaban, atau kunci yang salah.
- Hasil generate belum siap dicetak dan perlu dipindahkan ke Word.
- Soal lama sulit dicari dan digunakan ulang.
- Sekolah membutuhkan akses, kuota, dan bank soal yang dapat dikendalikan.
- Materi dan soal ujian berisiko bocor jika publikasi tidak dikontrol.

## 3. Visi dan positioning

### Visi

Menjadi workspace asesmen pendidik Indonesia dari PAUD sampai SMA/SMK yang menggabungkan
sumber materi, bantuan AI, review guru, dan output siap pakai.

### Positioning MVP

> Susun paket soal SD dari materi yang Anda ajarkan—review, finalisasi, lalu cetak dalam satu
> alur kerja.

### Kategori

Assessment production workflow. Bukan LMS lengkap, CBT siswa, marketplace soal, atau alat
pengganti penilaian profesional guru.

## 4. Strategi pasar

### Urutan ekspansi

| Fase | Segmen       | Fokus                                                  |
| ---- | ------------ | ------------------------------------------------------ |
| 1    | SD kelas 5–6 | Paket asesmen tertulis dan siap cetak                  |
| 2    | SD kelas 1–4 | Bahasa sederhana, visual, dan aktivitas                |
| 3    | SMP          | Variasi tipe soal, literasi, numerasi, HOTS            |
| 4    | SMA          | Kedalaman konsep, analisis, dan persiapan TKA          |
| 5    | SMK          | Ekspansi per program keahlian                          |
| 6    | PAUD         | Aktivitas/observasi; bukan modul ujian yang diperkecil |

Urutan di atas adalah strategi, bukan janji tanggal. Setiap jenjang memerlukan discovery,
content standard, dan evaluasi tersendiri.

### Go-to-market

Teacher-first, school-expand:

- Guru dapat mencoba dan berlangganan secara mandiri.
- Akun yang sama dapat bergabung ke workspace sekolah.
- Sekolah membeli kursi/kuota bersama, admin, branding, dan bank internal.
- Aktivitas personal guru tidak otomatis dapat dibaca admin sekolah.

## 5. Persona

### Guru SD kelas 5–6 — pengguna utama MVP

- Ingin draft berkualitas tanpa belajar prompt engineering.
- Sering bekerja lewat laptop sekolah dan ponsel.
- Membutuhkan hasil A4 yang benar-benar dapat dicetak.
- Memerlukan kontrol untuk mengubah satu soal tanpa mengulang semua.

### School admin/kepala sekolah — buyer organisasi

- Mengelola akun guru, kursi, kuota, template, dan administrasi pembayaran.
- Memerlukan visibilitas penggunaan, bukan akses tanpa batas ke ruang pribadi guru.
- Memerlukan bank internal dan kontrol keamanan soal.

### Superadmin — operator platform

- Mengelola tenant, pengguna, kurikulum, paket, entitlement, kuota, prompt/model registry,
  biaya, support, audit, insiden, dan konten marketing publik.

## 6. Prinsip produk

1. Guru adalah pengambil keputusan; AI hanya menghasilkan draft.
2. Privat secara default; publikasi selalu eksplisit.
3. Sumber materi dan versi kurikulum dapat ditelusuri.
4. Perbaiki per soal/per bagian, tidak harus regenerate satu paket.
5. UI memakai bahasa guru, bukan bahasa model/token.
6. Output siap pakai adalah nilai utama.
7. Tidak menyimpan data siswa pada MVP.
8. Web responsif lebih dahulu; mobile setelah kebutuhannya terbukti.
9. Kualitas diukur dari error dan tingkat edit, bukan sekadar generation success.
10. Harga dan klaim pemasaran tidak boleh diisi agent tanpa keputusan owner.

## 7. Scope MVP

### P0 — harus ada untuk pilot guru

- Landing page publik dan jalur daftar/masuk.
- Structured marketing CMS untuk CTA, navigasi, footer, copy, FAQ, SEO, dan media yang
  dikelola superadmin melalui draft, preview, publish, dan rollback.
- Personal workspace otomatis.
- Dashboard guru.
- Katalog versi kurikulum, kelas, mapel, dan materi/bab untuk scope awal.
- Form generate lengkap.
- Sumber: katalog materi yang telah disetujui dan PDF milik pengguna.
- Default 20 soal pilihan ganda; jumlah dapat dikonfigurasi dalam batas paket.
- Jenis lembar: Latihan, Ulangan Harian, UTS/STS, UAS/SAS, dan TKA apabila konten siap.
- Mode review Cepat dan Detail; keduanya menghasilkan draft, bukan final otomatis.
- Edit/regenerate satu soal.
- Finalisasi eksplisit oleh guru.
- Print A4, unduh PDF, dan tautan web terkontrol.
- Riwayat lembar, bank soal privat, dan template konfigurasi.
- Subscription/entitlement minimal dan pencatatan kuota.
- Superadmin minimum untuk support dan konfigurasi.
- Audit dasar, observability, dan pelaporan soal bermasalah.

### P1 — school pilot

- School workspace.
- Undangan dan pengelolaan anggota.
- Role school admin dan teacher.
- Kuota bersama, branding, template sekolah, dan bank soal internal.
- Laporan penggunaan agregat.
- Billing/invoice sekolah sesuai kebutuhan pilot.

### Di luar MVP

- CBT dan akun siswa.
- Nilai, rapor, absensi, Dapodik, dan LMS lengkap.
- Native Android/iOS.
- Marketplace/bank soal publik.
- Auto-publish hasil AI.
- Auto-finalisasi tanpa aksi guru.
- Semua jenjang/mapel sekaligus.
- Fine-tuning model sendiri.
- Web search sebagai sumber default.
- Drag-and-drop page builder, custom HTML/CSS dari CMS, dan plugin CMS pihak ketiga.

## 7A. Structured marketing CMS

- Layout, section type, komponen, design token, dan responsive behavior dimiliki kode frontend.
- CMS hanya menyimpan konten yang lolos schema: page metadata, copy, CTA, navigation, footer,
  FAQ, SEO, dan referensi media.
- CTA minimal memiliki id, label, href, variant, placement, audience, trackingKey, dan enabled.
- Hanya superadmin yang dapat membuat draft, preview, publish, unpublish, atau memulihkan
  versi. School admin dan teacher hanya melihat konten yang telah dipublikasikan.
- Publish tidak boleh melewati keputusan owner tentang harga, entitlement, klaim, kebijakan,
  atau tujuan CTA. Schema dan permission backend tetap authoritative.
- Figma/seed lokal menjadi fallback awal; frontend tidak boleh menjadi kosong ketika CMS
  belum tersedia. Setelah konten published tersedia, API menjadi sumber konten runtime.
- Konten published immutable per versi. Rollback membuat publikasi baru dari versi lama dan
  tetap menghasilkan audit trail.
- MVP berbahasa id-ID; locale tambahan dapat ditambahkan tanpa mengubah layout contract.
- Target propagasi publish MVP maksimal 60 detik melalui ETag/HTTP cache dan frontend
  revalidation. CMS tidak membutuhkan worker atau Redis.

## 8. Alur utama guru

1. Guru masuk dan memilih personal atau school workspace.
2. Guru membuka Generate.
3. Guru memilih sumber materi, kelas, kurikulum, mapel, dan minimal satu materi.
4. Guru memilih jenis lembar, kesulitan, jumlah soal, komposisi, dan mode review.
5. Guru dapat memberi fokus, konteks, atau contoh soal.
6. Sistem memvalidasi konfigurasi dan menampilkan ringkasan.
7. Backend membuat generation job idempotent.
8. Guru melihat progres dan boleh meninggalkan halaman.
9. Hasil masuk sebagai draft untuk ditinjau.
10. Guru mengedit, menerima, menolak, atau regenerate per soal.
11. Guru mengonfirmasi finalisasi.
12. Guru mencetak, mengunduh PDF, atau membuat share link.

## 9. Pengalaman Generate Lembar

Form minimal memuat:

- Sumber materi: Buku/katalog yang tersedia, PDF saya, atau gabungan.
- Kelas.
- Kurikulum/versi.
- Mata pelajaran.
- Materi/bab minimal satu.
- Jenis lembar.
- Tingkat kesulitan.
- Jumlah soal.
- Komposisi opsional.
- Mode review: Cepat atau Detail.
- Fokus/tujuan guru maksimal 500 karakter.
- Contoh soal opsional.
- Ringkasan konfigurasi dan indikator kelengkapan.

Dependency field wajib: kelas menentukan pilihan mapel; mapel dan versi kurikulum menentukan
materi. Empty, loading, invalid, insufficient-source, job-failed, dan retry state harus dirancang.

## 10. Output

### Print langsung

- Preview A4 sebelum print.
- Soal, identitas lembar, dan tata letak konsisten.
- Opsi menyertakan lembar jawaban, kunci, dan pembahasan sesuai izin.

### PDF

- Berasal dari versi final immutable.
- Nama file aman dan mudah dikenali.
- Download menggunakan akses sementara; file tidak menjadi publik permanen.

### Tautan web

- Read-only.
- Token sulit ditebak, dapat dicabut, dan dapat kedaluwarsa.
- Tidak terindeks mesin pencari.
- Kunci/pembahasan tidak tampil kecuali dipilih secara eksplisit.

DOCX adalah kandidat P1 dan memerlukan keputusan terpisah berdasarkan kebutuhan pilot.

## 11. Model akun dan role

Seseorang memiliki satu account dan dapat mempunyai beberapa membership. Pelanggan individu
tetap memakai role `teacher`; perbedaannya adalah personal workspace serta subscription.

Role utama:

- `superadmin`: platform-level.
- `school_admin`: workspace-level.
- `teacher`: workspace-level.

Permission lengkap berada di `BUSINESS-ROLES-PERMISSIONS.md`.

## 12. Sumber dan kurikulum

- Master kurikulum harus versioned dan menyimpan sumber resmi.
- Dokumen final mempertahankan versi kurikulum saat dibuat.
- Materi unggahan bersifat privat dan diperlakukan sebagai input tidak tepercaya.
- PDF harus melalui pemeriksaan tipe/ukuran/malware dan ekstraksi terkontrol.
- Web/URL source tidak aktif secara default dan ditunda sampai kontrol SSRF serta provenance siap.
- Agent tidak boleh mengarang status regulasi. Setiap perubahan master kurikulum memerlukan
  verifikasi sumber resmi dan review konten.

## 13. Persyaratan AI

- Candidate provider awal: direct OpenAI melalui backend-only adapter; final choice remains D-019.
- API key tidak pernah tersedia di browser.
- Generation requires schema-constrained structured output. If D-019 selects direct OpenAI,
  proposed implementation uses Responses API and Structured Outputs.
- Nama model, reasoning level, timeout, dan fallback berada di konfigurasi backend/model registry.
- “Realtime” bukan persyaratan generator soal; Realtime API ditujukan untuk interaksi
  berlatensi rendah seperti suara, bukan menjamin informasi terbaru.
- Informasi terkini berasal dari sumber yang diperbarui dan di-versioning, bukan dari nama model.
- Model baru harus melewati eval sebelum menjadi default.
- Setiap soal menyimpan hubungan ke blueprint dan source reference bila tersedia.
- Pipeline wajib memiliki schema validation, deterministic checks, dan human review.

## 14. Quality guardrails

Setiap soal minimal diperiksa untuk:

- satu jawaban benar;
- opsi tidak duplikat;
- kunci termasuk dalam opsi;
- bahasa sesuai kelas;
- tidak ambigu;
- kesesuaian materi dan indikator;
- tingkat kesulitan masuk akal;
- tidak menduplikasi soal lain;
- tidak mengandung instruksi sistem/prompt injection dari dokumen;
- keamanan dan sensitivitas konten anak.

Generation gagal tidak boleh mengurangi kuota. Finalisasi selalu membutuhkan aksi guru.

## 15. Non-functional requirements

### Performa dan reliabilitas

- Landing page berfungsi baik pada koneksi seluler.
- Kegagalan API CMS tidak membuat landing kosong; renderer memakai last-known/build fallback
  yang tervalidasi dan mencatat error tanpa membocorkan draft.
- Core Web Vitals menjadi release gate frontend.
- Generation dan export berjalan asinkron.
- Job idempotent dan dapat dilanjutkan/dicoba ulang secara aman.
- Draft auto-save dan tidak hilang saat refresh.
- Target availability MVP: 99,5% di luar maintenance terjadwal.

### Keamanan dan privasi

- Tenant isolation pada setiap akses data.
- Password tidak disimpan plaintext.
- Secure session, CSRF protection, rate limiting, dan audit untuk aksi sensitif.
- Private object storage serta signed access.
- Secret hanya berada pada runtime yang membutuhkan.
- Tidak meminta nama/data siswa di MVP.
- Retensi dan penghapusan materi harus terdokumentasi.
- Perlu review legal Indonesia sebelum paid launch dan sebelum memproses data anak.

### Aksesibilitas

- Target WCAG 2.2 AA untuk alur utama.
- Keyboard, focus state, label, error association, contrast, dan reduced motion diuji.
- Preview cetak konsisten di A4.

## 16. Model bisnis hipotesis

- Trial memberi kesempatan menyelesaikan setidaknya satu outcome nyata.
- Teacher Pro memakai kuota paket/soal, bukan token.
- School plan memakai kursi dan shared quota.
- Harga belum diputuskan. UI hanya boleh memakai “Coba gratis” atau “Hubungi kami” sampai
  keputusan harga diterima.
- Tidak menjanjikan unlimited AI.

## 17. Metrik

North Star awal: jumlah paket final yang berhasil diekspor oleh guru aktif per minggu.

Metrik pendukung:

- activation: pengguna menyelesaikan paket pertama;
- time-to-first-final;
- generation success rate;
- persentase soal yang diedit/regenerate/dihapus;
- key-error rate dari review internal dan laporan guru;
- export rate setelah generation;
- weekly returning teachers;
- trial-to-paid conversion;
- biaya AI per paket final;
- school seat activation.

Vanity metric seperti jumlah prompt atau jumlah soal generated tidak menjadi ukuran utama.

## 18. Release gates

MVP belum boleh dibuka luas sebelum:

- teacher usability test membuktikan alur generate→review→print dapat diselesaikan;
- eval konten lolos threshold per mapel/kelas;
- tenant isolation dan share-link security diuji;
- restore database dan job retry diuji;
- biaya per paket dipahami;
- kebijakan privasi, syarat penggunaan, retensi, serta pemrosesan pihak ketiga direview;
- owner menerima seluruh keputusan blocker.

## 19. Pertanyaan terbuka

- Harga Teacher Pro dan paket sekolah.
- Auth library/provider final setelah spike.
- Hosting, storage, email, dan payment provider.
- Apakah DOCX masuk P0 atau P1.
- Apakah URL source dibutuhkan saat pilot.
- Mapel dan konten tepat untuk cohort pilot pertama.
- Threshold kualitas per mapel/kelas.
- Kapan school admin masuk release pertama.
