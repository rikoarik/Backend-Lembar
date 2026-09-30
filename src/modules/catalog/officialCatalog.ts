import snapshot from './data/kemendikdasmen-cp-2026-07-29.json' with { type: 'json' };

export type OfficialLevel = 'paud' | 'sd-mi' | 'smp-mts' | 'sma-ma' | 'smk' | 'slb';

type SnapshotRecord = (typeof snapshot.records)[number];

const PHASE_CLASSES = {
  paud: { Fondasi: ['PAUD'] },
  'sd-mi': { A: ['1', '2'], B: ['3', '4'], C: ['5', '6'] },
  'smp-mts': { D: ['7', '8', '9'] },
  'sma-ma': { E: ['10'], F: ['11', '12'] },
  smk: { E: ['10'], F: ['11', '12'] },
  slb: {
    A: ['1', '2'],
    B: ['3', '4'],
    C: ['5', '6'],
    D: ['7', '8', '9'],
    E: ['10'],
    F: ['11', '12'],
  },
} as const;

const LEVEL_LABELS: Record<OfficialLevel, string> = {
  paud: 'PAUD/sederajat',
  'sd-mi': 'SD/MI',
  'smp-mts': 'SMP/MTs',
  'sma-ma': 'SMA/MA',
  smk: 'SMK',
  slb: 'SLB',
};

function slug(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export const OFFICIAL_CATALOG_PROVENANCE = {
  ...snapshot.provenance,
  note: 'Jenjang MI/MTs/MA dipetakan sebagai padanan kelas umum SD/SMP/SMA; API resmi menamai kelompoknya Umum, bukan madrasah.',
};

export const OFFICIAL_GRADES = Object.entries(PHASE_CLASSES).flatMap(([level, phases]) =>
  Object.entries(phases).flatMap(([phase, classes]) =>
    (classes as readonly string[]).map((className) => ({
      id: `official-grade-${level}-${slug(className)}`,
      label:
        className === 'PAUD'
          ? 'PAUD — Fase Fondasi'
          : `Kelas ${className} ${LEVEL_LABELS[level as OfficialLevel]} — Fase ${phase}`,
      level: level as OfficialLevel,
      phase,
      status: 'active' as const,
      provenance: OFFICIAL_CATALOG_PROVENANCE,
    })),
  ),
);

export const OFFICIAL_PHASES = Object.entries(PHASE_CLASSES).flatMap(([level, phases]) =>
  Object.entries(phases).map(([phase, classes]) => ({
    id: `official-phase-${level}-${slug(phase)}`,
    label: phase === 'Fondasi' ? 'Fase Fondasi' : `Fase ${phase}`,
    level: level as OfficialLevel,
    gradeIds: (classes as readonly string[]).map(
      (className) => `official-grade-${level}-${slug(className)}`,
    ),
    status: 'active' as const,
    provenance: OFFICIAL_CATALOG_PROVENANCE,
  })),
);

function recordSubjectId(record: SnapshotRecord): string {
  return `official-subject-${record.level}-${record.phase.toLowerCase()}-${slug(record.subject)}`;
}

export function listOfficialSubjects(gradeId: string) {
  const grade = OFFICIAL_GRADES.find((item) => item.id === gradeId);
  if (!grade) return [];

  const seen = new Set<string>();
  return snapshot.records
    .filter((record) => record.level === grade.level && record.phase === grade.phase)
    .filter((record) => !seen.has(recordSubjectId(record)) && seen.add(recordSubjectId(record)))
    .map((record) => ({
      id: recordSubjectId(record),
      label: record.label,
      gradeId,
      phase: record.phase,
      status: 'active' as const,
      provenance: OFFICIAL_CATALOG_PROVENANCE,
    }));
}

export function listOfficialMaterials(gradeId: string, subjectId: string) {
  const grade = OFFICIAL_GRADES.find((item) => item.id === gradeId);
  const record = grade
    ? snapshot.records.find(
        (item) =>
          item.level === grade.level &&
          item.phase === grade.phase &&
          recordSubjectId(item) === subjectId,
      )
    : undefined;
  if (!record) return [];

  const topics = record.topics.filter(Boolean).map((topic, index) => ({
    id: `${subjectId}-topic-${index + 1}`,
    label: topic,
    kind: 'topic' as const,
    // Topics belong to the subject's single learning outcome; expose it so
    // consumers do not have to reverse-engineer the id shape.
    outcomeId: `${subjectId}-cp`,
    status: 'active' as const,
    provenance: OFFICIAL_CATALOG_PROVENANCE,
  }));
  const cp = record.description
    ? [
        {
          id: `${subjectId}-cp`,
          label: record.description,
          kind: 'learning_outcome' as const,
          outcomeId: `${subjectId}-cp`,
          learningAchievements: record.learningAchievements.filter(Boolean),
          status: 'active' as const,
          provenance: OFFICIAL_CATALOG_PROVENANCE,
        },
      ]
    : [];
  return [...cp, ...topics];
}

/**
 * Snapshot topics for a materialized official subject. Once a material exists
 * for the official CP the CP row itself comes from the DB, but the snapshot
 * topics have no DB rows at all — without these the admin materials list would
 * silently drop every topic the moment the first material was created.
 */
export function materializedOfficialTopicMaterials(gradeId: string, subjectId: string) {
  return listOfficialMaterials(gradeId, subjectId).filter((item) => item.kind === 'topic');
}

export interface OfficialSubjectRef {
  subjectId: string;
  grade: (typeof OFFICIAL_GRADES)[number];
  record: SnapshotRecord;
  /** Curriculum outcome id used by the admin catalog (`<subjectId>-cp`). */
  cpId: string;
  /** Human label for the CP; never empty, even when the snapshot has no description. */
  cpLabel: string;
}

/**
 * Resolve an official subject id (the deterministic slug emitted by
 * `listOfficialSubjects`) back to its snapshot record and grade. Returns null for
 * unknown ids so callers can fall back to the DB branch instead of erroring.
 */
export function resolveOfficialSubject(subjectId: string): OfficialSubjectRef | null {
  for (const record of snapshot.records) {
    const id = recordSubjectId(record);
    if (id !== subjectId) continue;
    const grade = OFFICIAL_GRADES.find(
      (item) => item.level === record.level && item.phase === record.phase,
    );
    if (!grade) continue;
    return {
      subjectId: id,
      grade,
      record,
      cpId: `${id}-cp`,
      cpLabel: record.description?.trim() || `CP ${record.label}`,
    };
  }
  return null;
}

export function officialCatalogCoverage() {
  return Object.fromEntries(
    (Object.keys(PHASE_CLASSES) as OfficialLevel[]).map((level) => {
      const records = snapshot.records.filter((record) => record.level === level);
      return [
        level,
        {
          grades: OFFICIAL_GRADES.filter((grade) => grade.level === level).length,
          phases: OFFICIAL_PHASES.filter((phase) => phase.level === level).length,
          subjects: new Set(records.map(recordSubjectId)).size,
          topics: records.reduce(
            (total, record) => total + record.topics.filter(Boolean).length,
            0,
          ),
          learningOutcomes: records.filter((record) => Boolean(record.description)).length,
        },
      ];
    }),
  );
}
