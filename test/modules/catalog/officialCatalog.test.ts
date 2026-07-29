import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';

import {
  OFFICIAL_CATALOG_PROVENANCE,
  OFFICIAL_GRADES,
  OFFICIAL_PHASES,
  listOfficialMaterials,
  listOfficialSubjects,
  officialCatalogCoverage,
} from '../../../src/modules/catalog/officialCatalog.js';
import { registerCatalogRoutes } from '../../../src/modules/catalog/adapters/http/catalogRoutes.js';

describe('official Kemendikdasmen catalog snapshot', () => {
  it('exposes formal-school levels, phases, official subjects, topics and CP with provenance', () => {
    expect(new Set(OFFICIAL_GRADES.map((grade) => grade.level))).toEqual(
      new Set(['paud', 'sd-mi', 'smp-mts', 'sma-ma', 'smk', 'slb']),
    );
    expect(OFFICIAL_PHASES.length).toBe(15);
    expect(OFFICIAL_CATALOG_PROVENANCE.sourceUrl).toBe(
      'https://api.pendidikan.go.id/curriculums/v2/public/subjects',
    );

    const grade = OFFICIAL_GRADES.find((item) => item.id === 'official-grade-sd-mi-1');
    expect(grade?.phase).toBe('A');
    const subjects = listOfficialSubjects(grade!.id);
    expect(subjects.length).toBeGreaterThan(0);
    const materials = subjects.flatMap((subject) => listOfficialMaterials(grade!.id, subject.id));
    expect(materials.some((material) => material.kind === 'learning_outcome')).toBe(true);
    expect(materials.some((material) => material.kind === 'topic')).toBe(true);
    expect(materials.every((material) => material.provenance.accessedAt === '2026-07-29')).toBe(
      true,
    );
  });

  it('reports deterministic snapshot coverage', () => {
    expect(officialCatalogCoverage()).toEqual({
      paud: { grades: 1, phases: 1, subjects: 0, topics: 0, learningOutcomes: 0 },
      'sd-mi': { grades: 6, phases: 3, subjects: 71, topics: 704, learningOutcomes: 50 },
      'smp-mts': { grades: 3, phases: 1, subjects: 30, topics: 423, learningOutcomes: 23 },
      'sma-ma': { grades: 3, phases: 2, subjects: 77, topics: 359, learningOutcomes: 61 },
      smk: { grades: 3, phases: 2, subjects: 218, topics: 246, learningOutcomes: 215 },
      slb: { grades: 12, phases: 6, subjects: 207, topics: 9, learningOutcomes: 193 },
    });
  });

  it('serves grade → phase → subject → CP/topic through catalog routes', async () => {
    const app = Fastify();
    await registerCatalogRoutes(app);

    const grades = await app.inject({ method: 'GET', url: '/v1/catalog/grades' });
    const grade = grades.json().data.find((item: { id: string }) => item.id === 'official-grade-sd-mi-1');
    const phases = await app.inject({ method: 'GET', url: `/v1/catalog/phases?gradeId=${grade.id}` });
    const subjects = await app.inject({ method: 'GET', url: `/v1/catalog/subjects?gradeId=${grade.id}` });
    const subject = subjects.json().data[0];
    const materials = await app.inject({
      method: 'GET',
      url: `/v1/catalog/materials?gradeId=${grade.id}&subjectId=${encodeURIComponent(subject.id)}&curriculumVersionId=11111111-1111-1111-1111-111111111111`,
    });

    expect(phases.json().data[0].label).toBe('Fase A');
    expect(subjects.json().data.length).toBeGreaterThan(0);
    expect(materials.json().data.length).toBeGreaterThan(0);
    await app.close();
  });
});
