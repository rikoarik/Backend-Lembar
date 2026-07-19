/**
 * B1-04 — Versioned curriculum catalog persistence schema (D-012).
 *
 * Five mutable head tables (curricula, grades, phases, subjects, outcomes,
 * materials) plus six immutable version tables (`*_versions`). Each head row
 * carries a `current_version` pointer (mutable draft) and a `published_version`
 * pointer (last published snapshot). The unique `(parent_id, version)` index on
 * each version table is the serialization point that makes publishes atomic.
 *
 * No new packages were added — we reuse Drizzle + Postgres from the B0-04 spike.
 * Imports from `../database/schema.ts` are intentionally avoided so this module
 * can be loaded in isolation for tests/smoke.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const CURRICULUM_LEVELS = ['sd', 'smp', 'sma', 'smk', 'other'] as const;
export type CurriculumLevel = (typeof CURRICULUM_LEVELS)[number];

export const BLOOM_LEVELS = [
  'remember',
  'understand',
  'apply',
  'analyze',
  'evaluate',
  'create',
] as const;
export type BloomLevel = (typeof BLOOM_LEVELS)[number];

export const MATERIAL_KINDS = [
  'lesson',
  'exercise',
  'reading',
  'video',
  'assessment',
  'reference',
] as const;
export type MaterialKind = (typeof MATERIAL_KINDS)[number];

export const SOURCE_RIGHTS_VALUES = [
  'license:internal',
  'license:cc-by',
  'license:cc-by-sa',
  'license:cc-by-nc',
  'license:cc-by-nd',
  'license:unknown',
] as const;
export type SourceRightsValue = (typeof SOURCE_RIGHTS_VALUES)[number];

export const APPROVED_SOURCE_RIGHTS: readonly SourceRightsValue[] = [
  'license:internal',
  'license:cc-by',
  'license:cc-by-sa',
];

export const curricula = pgTable(
  'curricula',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    slug: text('slug').notNull(),
    code: text('code').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    level: text('level').$type<CurriculumLevel>().notNull(),
    active: boolean('active').notNull().default(true),
    currentVersion: integer('current_version').notNull().default(1),
    publishedVersion: integer('published_version'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    tenantSlugUnique: uniqueIndex('curricula_tenant_slug_unique').on(t.tenantId, t.slug),
    tenantCodeUnique: uniqueIndex('curricula_tenant_code_unique').on(t.tenantId, t.code),
  }),
);

export const curriculumVersions = pgTable(
  'curriculum_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    curriculumId: uuid('curriculum_id').notNull(),
    version: integer('version').notNull(),
    payload: jsonb('payload').notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    publishedBy: text('published_by'),
  },
  (t) => ({
    curriculumVersionUnique: uniqueIndex('curriculum_versions_curriculum_version_unique').on(
      t.curriculumId,
      t.version,
    ),
    versionCheck: check('curriculum_versions_version_check', sql`${t.version} >= 1`),
  }),
);

export const grades = pgTable(
  'grades',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    curriculumId: uuid('curriculum_id').notNull(),
    tenantId: uuid('tenant_id').notNull(),
    code: text('code').notNull(),
    label: text('label').notNull(),
    ordering: integer('ordering').notNull().default(0),
    currentVersion: integer('current_version').notNull().default(1),
    publishedVersion: integer('published_version'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    curriculumCodeUnique: uniqueIndex('grades_curriculum_code_unique').on(t.curriculumId, t.code),
    tenantIdx: index('grades_tenant_idx').on(t.tenantId),
  }),
);

export const gradeVersions = pgTable(
  'grade_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    gradeId: uuid('grade_id').notNull(),
    version: integer('version').notNull(),
    payload: jsonb('payload').notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    publishedBy: text('published_by'),
  },
  (t) => ({
    gradeVersionUnique: uniqueIndex('grade_versions_grade_version_unique').on(t.gradeId, t.version),
    versionCheck: check('grade_versions_version_check', sql`${t.version} >= 1`),
  }),
);

export const phases = pgTable(
  'phases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    gradeId: uuid('grade_id').notNull(),
    curriculumId: uuid('curriculum_id').notNull(),
    tenantId: uuid('tenant_id').notNull(),
    code: text('code').notNull(),
    label: text('label').notNull(),
    ordering: integer('ordering').notNull().default(0),
    currentVersion: integer('current_version').notNull().default(1),
    publishedVersion: integer('published_version'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    gradeCodeUnique: uniqueIndex('phases_grade_code_unique').on(t.gradeId, t.code),
    tenantIdx: index('phases_tenant_idx').on(t.tenantId),
  }),
);

export const phaseVersions = pgTable(
  'phase_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    phaseId: uuid('phase_id').notNull(),
    version: integer('version').notNull(),
    payload: jsonb('payload').notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    publishedBy: text('published_by'),
  },
  (t) => ({
    phaseVersionUnique: uniqueIndex('phase_versions_phase_version_unique').on(t.phaseId, t.version),
    versionCheck: check('phase_versions_version_check', sql`${t.version} >= 1`),
  }),
);

export const subjects = pgTable(
  'subjects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    phaseId: uuid('phase_id').notNull(),
    gradeId: uuid('grade_id').notNull(),
    curriculumId: uuid('curriculum_id').notNull(),
    tenantId: uuid('tenant_id').notNull(),
    code: text('code').notNull(),
    title: text('title').notNull(),
    ordering: integer('ordering').notNull().default(0),
    currentVersion: integer('current_version').notNull().default(1),
    publishedVersion: integer('published_version'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    phaseCodeUnique: uniqueIndex('subjects_phase_code_unique').on(t.phaseId, t.code),
    tenantIdx: index('subjects_tenant_idx').on(t.tenantId),
  }),
);

export const subjectVersions = pgTable(
  'subject_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    subjectId: uuid('subject_id').notNull(),
    version: integer('version').notNull(),
    payload: jsonb('payload').notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    publishedBy: text('published_by'),
  },
  (t) => ({
    subjectVersionUnique: uniqueIndex('subject_versions_subject_version_unique').on(
      t.subjectId,
      t.version,
    ),
    versionCheck: check('subject_versions_version_check', sql`${t.version} >= 1`),
  }),
);

export const outcomes = pgTable(
  'outcomes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    subjectId: uuid('subject_id').notNull(),
    phaseId: uuid('phase_id').notNull(),
    gradeId: uuid('grade_id').notNull(),
    curriculumId: uuid('curriculum_id').notNull(),
    tenantId: uuid('tenant_id').notNull(),
    code: text('code').notNull(),
    text: text('text').notNull(),
    bloomLevel: text('bloom_level').$type<BloomLevel>().notNull(),
    ordering: integer('ordering').notNull().default(0),
    currentVersion: integer('current_version').notNull().default(1),
    publishedVersion: integer('published_version'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    subjectCodeUnique: uniqueIndex('outcomes_subject_code_unique').on(t.subjectId, t.code),
    tenantIdx: index('outcomes_tenant_idx').on(t.tenantId),
  }),
);

export const outcomeVersions = pgTable(
  'outcome_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    outcomeId: uuid('outcome_id').notNull(),
    version: integer('version').notNull(),
    payload: jsonb('payload').notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    publishedBy: text('published_by'),
  },
  (t) => ({
    outcomeVersionUnique: uniqueIndex('outcome_versions_outcome_version_unique').on(
      t.outcomeId,
      t.version,
    ),
    versionCheck: check('outcome_versions_version_check', sql`${t.version} >= 1`),
  }),
);

export const materials = pgTable(
  'materials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    outcomeId: uuid('outcome_id').notNull(),
    subjectId: uuid('subject_id').notNull(),
    phaseId: uuid('phase_id').notNull(),
    gradeId: uuid('grade_id').notNull(),
    curriculumId: uuid('curriculum_id').notNull(),
    tenantId: uuid('tenant_id').notNull(),
    code: text('code').notNull(),
    kind: text('kind').$type<MaterialKind>().notNull(),
    title: text('title').notNull(),
    sourceRights: text('source_rights').$type<SourceRightsValue>().notNull(),
    ordering: integer('ordering').notNull().default(0),
    currentVersion: integer('current_version').notNull().default(1),
    publishedVersion: integer('published_version'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    outcomeCodeUnique: uniqueIndex('materials_outcome_code_unique').on(t.outcomeId, t.code),
    tenantIdx: index('materials_tenant_idx').on(t.tenantId),
    sourceRightsCheck: check(
      'materials_source_rights_check',
      sql`${t.sourceRights} in ('license:internal','license:cc-by','license:cc-by-sa','license:cc-by-nc','license:cc-by-nd','license:unknown')`,
    ),
  }),
);

export const materialVersions = pgTable(
  'material_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    materialId: uuid('material_id').notNull(),
    version: integer('version').notNull(),
    payload: jsonb('payload').notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    publishedBy: text('published_by'),
  },
  (t) => ({
    materialVersionUnique: uniqueIndex('material_versions_material_version_unique').on(
      t.materialId,
      t.version,
    ),
    versionCheck: check('material_versions_version_check', sql`${t.version} >= 1`),
  }),
);

export type Curriculum = typeof curricula.$inferSelect;
export type NewCurriculum = typeof curricula.$inferInsert;
export type CurriculumVersionRow = typeof curriculumVersions.$inferSelect;
export type Grade = typeof grades.$inferSelect;
export type NewGrade = typeof grades.$inferInsert;
export type GradeVersionRow = typeof gradeVersions.$inferSelect;
export type Phase = typeof phases.$inferSelect;
export type NewPhase = typeof phases.$inferInsert;
export type PhaseVersionRow = typeof phaseVersions.$inferSelect;
export type Subject = typeof subjects.$inferSelect;
export type NewSubject = typeof subjects.$inferInsert;
export type SubjectVersionRow = typeof subjectVersions.$inferSelect;
export type Outcome = typeof outcomes.$inferSelect;
export type NewOutcome = typeof outcomes.$inferInsert;
export type OutcomeVersionRow = typeof outcomeVersions.$inferSelect;
export type Material = typeof materials.$inferSelect;
export type NewMaterial = typeof materials.$inferInsert;
export type MaterialVersionRow = typeof materialVersions.$inferSelect;
