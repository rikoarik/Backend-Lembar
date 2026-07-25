/**
 * Seed script: Indonesian Education Training Data
 * Populates Kurikulum Merdeka prompts, eval cases, and fixtures.
 * Usage: node scripts/seed-indonesian-education.mjs
 */
import pg from 'pg';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const envPath = path.resolve(process.cwd(), '.env');
const envContent = readFileSync(envPath, 'utf-8');
const env = {};
for (const line of envContent.split('\n')) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('=');
  if (i === -1) continue;
  env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
}

const pool = new pg.Pool({ connectionString: env.DATABASE_URL });

async function seed() {
  console.log('🇮🇩 Seeding Indonesian Education Training Data...\n');

  // ── 1. Run migration ──────────────────────────────
  console.log('📋 Running migration...');
  const migrationSQL = readFileSync(
    path.resolve('src/infrastructure/database/migrations/0019_indonesian_education_training.sql'),
    'utf-8',
  );
  await pool.query(migrationSQL);
  console.log('  ✅ Migration applied\n');

  // ── 2. Education-specific prompt templates ────────
  console.log('📝 Creating Indonesian Education prompts...');

  const educationPrompts = [
    // ── MATHEMATIKA ──
    {
      name: 'id.math.generate',
      slug: 'id-math-generate',
      description: 'Generate Matematika assessment (Kurikulum Merdeka)',
      description_long: 'Membuat soal Matematika sesuai Kurikulum Merdeka untuk berbagai fase dan jenjang',
      prompt_text: `Anda adalah ahli pembuatan soal Matematika untuk pendidikan Indonesia.

KONTEKS:
- Kurikulum Merdeka (Fase {phase})
- Mata pelajaran: Matematika
- Jenjang: {grade}
- Topik: {topic}
- Jumlah soal: {question_count}
- Tipe soal: {question_type}
- Tingkat kesulitan: {difficulty}

ATURAN PEMBUATAN SOAL:
1. Gunakan bahasa Indonesia yang baku dan jelas
2. Sesuaikan dengan capaian pembelajaran Kurikulum Merdeka
3. Setiap soal harus memiliki opsi jawaban yang plausible
4. Sertakan penjelasan (explanation) untuk setiap soal
5. Gunakan konteks kehidupan sehari-hari siswa Indonesia
6. Variasikan tingkat kesulitan: 40% mudah, 40% sedang, 20% sulit
7. Hindari soal yang ambigu atau memiliki lebih dari satu jawaban benar

FORMAT OUTPUT (JSON):
{
  "title": "Judul Soal",
  "metadata": {
    "subject": "Matematika",
    "grade": "Kelas X",
    "phase": "D",
    "topic": "...",
    "question_count": N
  },
  "questions": [
    {
      "question": "Teks soal",
      "options": ["A. ...", "B. ...", "C. ...", "D. ..."],
      "answer": "A",
      "explanation": "Penjelasan mengapa jawaban benar",
      "difficulty": "easy|medium|hard",
      "curriculum_standard": "CP Kurikulum Merdeka yang relevan"
    }
  ]
}`,
      version: 'v1',
      contextWindow: 'default',
    },

    // ── BAHASA INDONESIA ──
    {
      name: 'id.indonesian.generate',
      slug: 'id-indonesian-generate',
      description: 'Generate Bahasa Indonesia assessment',
      description_long: 'Membuat soal Bahasa Indonesia sesuai Kurikulum Merdeka',
      prompt_text: `Anda adalah ahli pembuatan soal Bahasa Indonesia untuk pendidikan Indonesia.

KONTEKS:
- Kurikulum Merdeka (Fase {phase})
- Mata pelajaran: Bahasa Indonesia
- Jenjang: {grade}
- Topik: {topic}
- Jumlah soal: {question_count}
- Tipe soal: {question_type}

ATURAN PEMBUATAN SOAL:
1. Gunakan bahasa Indonesia yang baku
2. Sertakan teks/bacaan untuk soal reading comprehension
3. Gunakan kaidah kebahasaan Indonesia yang benar
4. Sesuaikan kosakata dengan jenjang siswa
5. Sertakan analisis struktur teks untuk soal analisis
6. Variasikan tipe: pilihan ganda, isian singkat, uraian

FORMAT OUTPUT (JSON):
{
  "title": "Judul Soal",
  "metadata": {
    "subject": "Bahasa Indonesia",
    "grade": "...",
    "phase": "...",
    "topic": "..."
  },
  "questions": [...]
}`,
      version: 'v1',
      contextWindow: 'default',
    },

    // ── IPA (Ilmu Pengetahuan Alam) ──
    {
      name: 'id.science.generate',
      slug: 'id-science-generate',
      description: 'Generate IPA assessment (Kurikulum Merdeka)',
      description_long: 'Membuat soal Ilmu Pengetahuan Alam sesuai Kurikulum Merdeka',
      prompt_text: `Anda adalah ahli pembuatan soal IPA untuk pendidikan Indonesia.

KONTEKS:
- Kurikulum Merdeka (Fase {phase})
- Mata pelajaran: IPA
- Jenjang: {grade}
- Topik: {topic}
- Jumlah soal: {question_count}

ATURAN PEMBUATAN SOAL:
1. Gunakan terminologi sains yang benar dalam bahasa Indonesia
2. Sertakan gambar/deskripsi eksperimen untuk soal praktikum
3. Hubungkan konsep dengan fenomena alam Indonesia
4. Sertakan data observasi untuk soal analisis data
5. Gunakan metode ilmiah dalam penjelasan
6. Sesuaikan dengan capaian pembelajaran IPA Kurikulum Merdeka

FORMAT OUTPUT (JSON):
{
  "title": "Judul Soal",
  "metadata": {
    "subject": "IPA",
    "grade": "...",
    "phase": "...",
    "topic": "..."
  },
  "questions": [...]
}`,
      version: 'v1',
      contextWindow: 'default',
    },

    // ── IPS (Ilmu Pengetahuan Sosial) ──
    {
      name: 'id.social.generate',
      slug: 'id-social-generate',
      description: 'Generate IPS assessment (Kurikulum Merdeka)',
      description_long: 'Membuat soal Ilmu Pengetahuan Sosial sesuai Kurikulum Merdeka',
      prompt_text: `Anda adalah ahli pembuatan soal IPS untuk pendidikan Indonesia.

KONTEKS:
- Kurikulum Merdeka (Fase {phase})
- Mata pelajaran: IPS (Geografi, Sejarah, Sosiologi, Ekonomi)
- Jenjang: {grade}
- Topik: {topic}
- Jumlah soal: {question_count}

ATURAN PEMBUATAN SOAL:
1. Gunakan data statistik Indonesia yang relevan
2. Sertakan peta atau deskripsi wilayah Indonesia
3. Hubungkan sejarah dengan peristiwa kontemporer
4. Gunakan studi kasus lokal Indonesia
5. Sertakan analisis grafik/data untuk soal ekonomi
6. Sesuaikan dengan capaian pembelajaran IPS Kurikulum Merdeka

FORMAT OUTPUT (JSON):
{
  "title": "Judul Soal",
  "metadata": {
    "subject": "IPS",
    "grade": "...",
    "phase": "...",
    "topic": "..."
  },
  "questions": [...]
}`,
      version: 'v1',
      contextWindow: 'default',
    },

    // ── BAHASA INGGRIS ──
    {
      name: 'id.english.generate',
      slug: 'id-english-generate',
      description: 'Generate Bahasa Inggris assessment',
      description_long: 'Membuat soal Bahasa Inggris sesuai Kurikulum Merdeka',
      prompt_text: `Anda adalah ahli pembuatan soal Bahasa Inggris untuk pendidikan Indonesia.

KONTEKS:
- Kurikulum Merdeka (Fase {phase})
- Mata pelajaran: Bahasa Inggris
- Jenjang: {grade}
- Topik: {topic}
- Jumlah soal: {question_count}

ATURAN PEMBUATAN SOAL:
1. Gunakan bahasa Inggris yang natural dan sesuai jenjang
2. Sertakan reading passage untuk soal reading comprehension
3. Gunakan grammar rules sesuai Kurikulum Merdeka
4. Variasikan tipe: multiple choice, fill-in-the-blank, essay
5. Sertakan scoring rubric untuk soal produktif
6. Sesuaikan dengan KD Bahasa Inggris Kurikulum Merdeka

FORMAT OUTPUT (JSON):
{
  "title": "Judul Soal",
  "metadata": {
    "subject": "Bahasa Inggris",
    "grade": "...",
    "phase": "...",
    "topic": "..."
  },
  "questions": [...]
}`,
      version: 'v1',
      contextWindow: 'default',
    },

    // ── REPAIR (perbaiki output AI) ──
    {
      name: 'id.repair.generate',
      slug: 'id-repair-generate',
      description: 'Repair broken assessment output',
      description_long: 'Memperbaiki output AI yang tidak sesuai schema atau kualitas rendah',
      prompt_text: `Anda adalah ahli perbaikan output soal ujian untuk pendidikan Indonesia.

TUGAS:
Perbaiki output soal ujian yang rusak/tidak valid berikut:

INPUT YANG RUSAK:
{broken_output}

JENIS MASALAH:
{issue_type}

ATURAN PERBAIKAN:
1. Perbaiki format JSON agar valid
2. Pastikan semua field wajib terisi
3. Perbaiki grammar bahasa Indonesia jika ada kesalahan
4. Pastikan jawaban benar secara akademis
5. Pertahankan tingkat kesulitan yang sama
6. Jika ada soal yang terlalu ambigu, buat alternatif yang lebih jelas

FORMAT OUTPUT (JSON):
{
  "fixed_payload": { ... },
  "issues_found": [
    { "field": "questions[0].answer", "severity": "high", "description": "..." }
  ],
  "summary": "Ringkasan perbaikan yang dilakukan"
}`,
      version: 'v1',
      contextWindow: 'default',
    },

    // ── QUALITY CHECK ──
    {
      name: 'id.quality.generate',
      slug: 'id-quality-generate',
      description: 'Quality check for assessment output',
      description_long: 'Validasi kualitas output soal ujian sebelum disimpan',
      prompt_text: `Anda adalah validator kualitas soal ujian untuk pendidikan Indonesia.

TUGAS:
Evaluasi kualitas soal ujian berikut:

INPUT SOAL:
{assessment_output}

KRITERIA PENILAIAN:
1. Akurasi Akademis (0-25): Apakah jawaban benar secara akademis?
2. Kecocokan Kurikulum (0-25): Sesuai dengan Kurikulum Merdeka?
3. Kejelasan Bahasa (0-25): Bahasa Indonesia yang baku dan jelas?
4. Keterampilan Berpikir (0-25): Mengukur keterampilan berpikir tingkat tinggi?

ATURAN:
1. Berikan skor 0-100 untuk setiap kriteria
2. Identifikasi masalah spesifik jika ada
3. Berikan rekomendasi perbaikan
4. Pastikan soal tidak ambigu
5. Cek konsistensi tingkat kesulitan

FORMAT OUTPUT (JSON):
{
  "valid": true/false,
  "score": 0-100,
  "criteria": {
    "academic_accuracy": { "score": 0-25, "notes": "..." },
    "curriculum_alignment": { "score": 0-25, "notes": "..." },
    "language_clarity": { "score": 0-25, "notes": "..." },
    "thinking_skills": { "score": 0-25, "notes": "..." }
  },
  "issues": [
    { "severity": "high|medium|low", "message": "...", "field": "..." }
  ],
  "recommendations": ["..."]
}`,
      version: 'v1',
      contextWindow: 'default',
    },
  ];

  for (const prompt of educationPrompts) {
    try {
      // Check if exists
      const existing = await pool.query('SELECT id FROM admin_prompts WHERE slug = $1', [prompt.slug]);
      let promptId;

      if (existing.rows.length > 0) {
        promptId = existing.rows[0].id;
        await pool.query(
          'UPDATE admin_prompts SET description = $1, description_long = $2, context_window = $3 WHERE id = $4',
          [prompt.description, prompt.description_long, prompt.contextWindow, promptId],
        );
        console.log(`  ✓ ${prompt.name} (updated)`);
      } else {
        const res = await pool.query(
          `INSERT INTO admin_prompts (name, slug, description, description_long, status, version, created_by, context_window)
           VALUES ($1, $2, $3, $4, 'active', $5, 'ops@lembar.id', $6) RETURNING id`,
          [prompt.name, prompt.slug, prompt.description, prompt.description_long, prompt.version, prompt.contextWindow],
        );
        promptId = res.rows[0]?.id;
        console.log(`  ✓ ${prompt.name} (created)`);
      }

      // Add prompt version
      if (promptId) {
        await pool.query(
          `INSERT INTO ai_prompt_versions (prompt_id, version, prompt_text, schema_version, status, notes)
           VALUES ($1, 1, $2, 1, 'active', $3)
           ON CONFLICT (prompt_id, version) DO UPDATE SET prompt_text = EXCLUDED.prompt_text, notes = EXCLUDED.notes`,
          [promptId, prompt.prompt_text, `Indonesian Education v1 - ${prompt.name}`],
        );
      }
    } catch (e) {
      console.log(`  ⚠ ${prompt.name}: ${e.message?.slice(0, 80)}`);
    }
  }

  // ── 3. Eval cases for each subject+grade ──────────
  console.log('\n🧪 Creating eval cases...');

  const evalCases = [
    { slug: 'id-math-generate', label: 'Persamaan Linear Kelas 7', signals: { phase: 'D', grade: 'Kelas 7 SMP', topic: 'Persamaan Linear', question_count: 5, question_type: 'pilihan_ganda', difficulty: 'easy' } },
    { slug: 'id-math-generate', label: 'Limit Fungsi Kelas 9 (Olimpiade)', signals: { phase: 'D', grade: 'Kelas 9 SMP', topic: 'Limit Fungsi Trigonometri', question_count: 3, question_type: 'uraian', difficulty: 'hard' } },
    { slug: 'id-math-generate', label: 'Turunan Fungsi UTBK', signals: { phase: 'D', grade: 'Kelas 12 SMA', topic: 'Turunan Fungsi Aljabar', question_count: 5, question_type: 'pilihan_ganda', difficulty: 'medium' } },
    { slug: 'id-science-generate', label: 'Peredaran Darah Kelas 7', signals: { phase: 'D', grade: 'Kelas 7 SMP', topic: 'Sistem Peredaran Darah', question_count: 5, question_type: 'pilihan_ganda', difficulty: 'easy' } },
    { slug: 'id-science-generate', label: 'Hukum Newton Kelas 10', signals: { phase: 'D', grade: 'Kelas 10 SMA', topic: 'Hukum Newton', question_count: 4, question_type: 'uraian', difficulty: 'medium' } },
    { slug: 'id-indonesian-generate', label: 'Teks Eksposisi Kelas 8', signals: { phase: 'D', grade: 'Kelas 8 SMP', topic: 'Teks Eksposisi', question_count: 5, question_type: 'pilihan_ganda', difficulty: 'medium' } },
    { slug: 'id-social-generate', label: 'Proklamasi 1945 Kelas 10', signals: { phase: 'D', grade: 'Kelas 10 SMA', topic: 'Peristiwa Proklamasi', question_count: 5, question_type: 'pilihan_ganda', difficulty: 'medium' } },
    { slug: 'id-english-generate', label: 'Environmental Issues Kelas 9', signals: { phase: 'D', grade: 'Kelas 9 SMP', topic: 'Environmental Issues', question_count: 5, question_type: 'reading_comprehension', difficulty: 'medium' } },
    { slug: 'id-repair-generate', label: 'Repair: Missing Question Field', signals: { issue_type: 'missing_field', broken_output: '{"title":"Test","questions":[{"options":["A","B"]}]}' } },
    { slug: 'id-quality-generate', label: 'Quality: Valid Assessment Check', signals: { assessment_output: '{"title":"Soal MTK","questions":[{"question":"2+2=?","options":["3","4","5","6"],"answer":"4"}]}' } },
  ];

  for (const evalCase of evalCases) {
    try {
      const promptRes = await pool.query('SELECT id FROM admin_prompts WHERE slug = $1', [evalCase.slug]);
      if (!promptRes.rows[0]) { console.log(`  ⚠ Skip ${evalCase.label} (prompt not found)`); continue; }

      await pool.query(
        `INSERT INTO ai_prompt_eval_cases (prompt_id, prompt_version, label, input_signals)
         VALUES ($1, 1, $2, $3)`,
        [promptRes.rows[0].id, evalCase.label, JSON.stringify(evalCase.signals)],
      );
      console.log(`  ✓ ${evalCase.label}`);
    } catch (e) {
      console.log(`  ⚠ ${evalCase.label}: ${e.message?.slice(0, 60)}`);
    }
  }

  // ── 4. Summary ────────────────────────────────────
  console.log('\n📊 Summary:');
  const counts = await pool.query(`
    SELECT
      (SELECT count(*) FROM admin_prompts) as prompts,
      (SELECT count(*) FROM ai_prompt_versions) as versions,
      (SELECT count(*) FROM ai_prompt_eval_cases) as eval_cases,
      (SELECT count(*) FROM ai_prompt_schemas) as schemas,
      (SELECT count(*) FROM id_subjects) as subjects,
      (SELECT count(*) FROM id_grades) as grades,
      (SELECT count(*) FROM id_eval_fixtures) as fixtures
  `);
  const c = counts.rows[0];
  console.log(`  Prompts: ${c.prompts}`);
  console.log(`  Versions: ${c.versions}`);
  console.log(`  Eval Cases: ${c.eval_cases}`);
  console.log(`  Schemas: ${c.schemas}`);
  console.log(`  Subjects: ${c.subjects}`);
  console.log(`  Grades: ${c.grades}`);
  console.log(`  Eval Fixtures: ${c.fixtures}`);

  await pool.end();
  console.log('\n✅ Indonesian Education Training Data seeded!');
}

seed().catch((e) => { console.error('❌ Seed failed:', e); process.exit(1); });
