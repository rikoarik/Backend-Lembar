-- Migration: 0019_indonesian_education_training
-- Kurikulum Merdeka prompts, subjects, eval cases for continuous learning
-- Rollback: DROP TABLE IF EXISTS id_subjects, id_grades, id_eval_fixtures;

-- ── Indonesian Education Subjects ───────────────────
CREATE TABLE IF NOT EXISTS id_subjects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  name_en text NOT NULL DEFAULT '',
  category text NOT NULL DEFAULT 'umum' CHECK (category IN ('wajib', 'pilihan', 'muatan_lokal', 'umum')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ── Grade Levels (Kurikulum Merdeka) ───────────────
CREATE TABLE IF NOT EXISTS id_grades (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code integer NOT NULL UNIQUE,
  name text NOT NULL,
  phase text NOT NULL CHECK (phase IN ('A', 'B', 'C', 'D')),
  description text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ── Eval Fixtures (test prompts per subject+grade) ─
CREATE TABLE IF NOT EXISTS id_eval_fixtures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_code text NOT NULL REFERENCES id_subjects(code),
  grade_code integer NOT NULL REFERENCES id_grades(code),
  prompt_template text NOT NULL,
  expected_output_schema jsonb NOT NULL DEFAULT '{}',
  difficulty text NOT NULL DEFAULT 'medium' CHECK (difficulty IN ('easy', 'medium', 'hard')),
  tags jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ── Seed Subjects ───────────────────────────────────
INSERT INTO id_subjects (code, name, name_en, category) VALUES
  ('MTK', 'Matematika', 'Mathematics', 'wajib'),
  ('IPA', 'Ilmu Pengetahuan Alam', 'Natural Sciences', 'wajib'),
  ('IPS', 'Ilmu Pengetahuan Sosial', 'Social Sciences', 'wajib'),
  ('BID', 'Bahasa Indonesia', 'Indonesian Language', 'wajib'),
  ('BIG', 'Bahasa Inggris', 'English', 'wajib'),
  ('PKN', 'Pendidikan Pancasila dan Kewarganegaraan', 'Civics', 'wajib'),
  ('PJOK', 'Pendidikan Jasmani, Olahraga, dan Kesehatan', 'Physical Education', 'wajib'),
  ('SBdN', 'Seni Budaya dan Prakarya', 'Arts and Culture', 'wajib'),
  ('TIK', 'Teknologi Informasi dan Komunikasi', 'ICT', 'pilihan'),
  ('AKL', 'Akuntansi dan Keuangan', 'Accounting', 'pilihan'),
  ('BIS', 'Kewirausahaan', 'Entrepreneurship', 'pilihan'),
  ('DKV', 'Desain Komunikasi Visual', 'Visual Communication Design', 'pilihan'),
  ('JPT', 'Bahasa Jepang', 'Japanese', 'pilihan'),
  ('JER', 'Bahasa Jerman', 'German', 'pilihan'),
  ('FRM', 'Bahasa Mandarin', 'Chinese', 'pilihan')
ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, name_en = EXCLUDED.name_en;

-- ── Seed Grades (Kurikulum Merdeka Phases) ──────────
INSERT INTO id_grades (code, name, phase, description) VALUES
  (1, 'Kelas 1 SD', 'A', 'Fase A: SD Kelas 1-2, literasi dasar dan numerasi'),
  (2, 'Kelas 2 SD', 'A', 'Fase A: SD Kelas 1-2, literasi dasar dan numerasi'),
  (3, 'Kelas 3 SD', 'B', 'Fase B: SD Kelas 3-4, pengembangan literasi dan numerasi'),
  (4, 'Kelas 4 SD', 'B', 'Fase B: SD Kelas 3-4, pengembangan literasi dan numerasi'),
  (5, 'Kelas 5 SD', 'C', 'Fase C: SD Kelas 5-6, kesiapan transisi ke SMP'),
  (6, 'Kelas 6 SD', 'C', 'Fase C: SD Kelas 5-6, kesiapan transisi ke SMP'),
  (7, 'Kelas 7 SMP', 'D', 'Fase D: SMP, pembelajaran mendalam'),
  (8, 'Kelas 8 SMP', 'D', 'Fase D: SMP, pembelajaran mendalam'),
  (9, 'Kelas 9 SMP', 'D', 'Fase D: SMP, kesiapan transisi ke SMA'),
  (10, 'Kelas 10 SMA', 'D', 'Fase D: SMA, peminatan awal'),
  (11, 'Kelas 11 SMA', 'D', 'Fase D: SMA, peminatan mendalam'),
  (12, 'Kelas 12 SMA', 'D', 'Fase D: SMA, persiapan ujian dan kuliah')
ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, phase = EXCLUDED.phase;

-- ── Seed Eval Fixtures ──────────────────────────────
-- Math eval (various difficulties)
INSERT INTO id_eval_fixtures (subject_code, grade_code, prompt_template, expected_output_schema, difficulty, tags) VALUES
  ('MTK', 7, 'Buatkan 5 soal pilihan ganda tentang persamaan linear satu variabel untuk kelas 7 SMP', '{"type":"object","required":["title","questions"],"properties":{"title":{"type":"string"},"questions":{"type":"array","items":{"type":"object","required":["question","options","answer"]}}}}', 'easy', '["persamaan_linear","smp"]'),
  ('MTK', 9, 'Buatkan 3 soal uraian tentang limit fungsi trigonometri untuk kelas 9 SMP (level olimpiade)', '{"type":"object","required":["title","questions"],"properties":{"title":{"type":"string"},"questions":{"type":"array","items":{"type":"object","required":["question","answer","explanation"]}}}}', 'hard', '["limit","trigonometri","olimpiade"]'),
  ('MTK', 12, 'Buatkan soal UTBK SBMPTN tentang turunan fungsi aljabar dengan tingkat kesulitan sedang', '{"type":"object","required":["title","questions"],"properties":{"title":{"type":"string"},"questions":{"type":"array","items":{"type":"object","required":["question","options","answer","explanation"]}}}}', 'medium', '["turunan","utbk","sma"]'),
  ('IPA', 7, 'Buatkan 5 soal pilihan ganda tentang sistem peredaran darah manusia untuk kelas 7 SMP', '{"type":"object","required":["title","questions"],"properties":{"title":{"type":"string"},"questions":{"type":"array","items":{"type":"object","required":["question","options","answer"]}}}}', 'easy', '["biologi","peredaran_darah","smp"]'),
  ('IPA', 10, 'Buatkan soal analisis tentang hukum Newton untuk kelas 10 SMA dengan konteks kehidupan sehari-hari', '{"type":"object","required":["title","questions"],"properties":{"title":{"type":"string"},"questions":{"type":"array","items":{"type":"object","required":["question","answer","explanation"]}}}}', 'medium', '["fisika","newton","sma"]'),
  ('BID', 8, 'Buatkan soal tentang teks eksposisi untuk kelas 8 SMP: identifikasi struktur dan argumen', '{"type":"object","required":["title","questions"],"properties":{"title":{"type":"string"},"questions":{"type":"array","items":{"type":"object","required":["question","answer","explanation"]}}}}', 'medium', '["teks_eksposisi","bahasa_indonesia"]'),
  ('IPS', 10, 'Buatkan soal tentang peristiwa proklamasi kemerdekaan Indonesia 1945 untuk kelas 10 SMA', '{"type":"object","required":["title","questions"],"properties":{"title":{"type":"string"},"questions":{"type":"array","items":{"type":"object","required":["question","options","answer","explanation"]}}}}', 'medium', '["sejarah","proklamasi","sma"]'),
  ('BIG', 9, 'Buatkan reading comprehension tentang environmental issues untuk kelas 9 SMP', '{"type":"object","required":["title","passage","questions"],"properties":{"title":{"type":"string"},"passage":{"type":"string"},"questions":{"type":"array","items":{"type":"object","required":["question","options","answer"]}}}}', 'medium', '["reading","environment","smp"]')
ON CONFLICT DO NOTHING;
