-- Migration: 0022_fix_id_grades_phase_constraint
-- Allow Kurikulum Merdeka phases A-F, then correct SMA phases to E/F.
-- Rollback: restore A-D only and (optionally) map SMA phases back to D.

ALTER TABLE id_grades DROP CONSTRAINT IF EXISTS id_grades_phase_check;

UPDATE id_grades
SET phase = 'E',
    description = 'Fase E: SMA Kelas 10, penguatan konsep dan literasi saintifik'
WHERE code = 10;

UPDATE id_grades
SET phase = 'F',
    description = 'Fase F: SMA Kelas 11-12, pendalaman dan kemandirian belajar'
WHERE code IN (11, 12);

ALTER TABLE id_grades
  ADD CONSTRAINT id_grades_phase_check
  CHECK (phase = ANY (ARRAY['A'::text, 'B'::text, 'C'::text, 'D'::text, 'E'::text, 'F'::text]));
