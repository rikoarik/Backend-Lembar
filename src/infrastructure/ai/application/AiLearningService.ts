/**
 * AI Feedback + Continuous Learning Service.
 *
 * Flow:
 *   1. User rates generated output → stored in ai_feedback
 *   2. Admin reviews feedback → identifies patterns
 *   3. New prompt version created → tested via eval harness
 *   4. Activate better version → metrics improve
 *
 * Tables:
 *   - ai_feedback: user quality ratings per generation
 *   - ai_learning_signals: aggregated patterns from feedback
 */
import { sql } from 'drizzle-orm';
import type { Database } from '../../../infrastructure/database/db.js';
import { getPool } from '../../../infrastructure/database/db.js';

export interface FeedbackInput {
  workspaceId: string;
  userId: string;
  promptTemplateId: string;
  jobId?: string;
  rating: 1 | 2 | 3 | 4 | 5;
  comment?: string;
  tags?: string[];
}

export interface LearningSignal {
  promptTemplateId: string;
  pattern: string;
  frequency: number;
  avgRating: number;
  suggestedAction: string;
}

export class AiLearningService {
  constructor(private readonly db: Database) {}

  // ── Submit feedback ────────────────────────────────
  async submitFeedback(input: FeedbackInput): Promise<{ id: string; rating: number }> {
    const pool = getPool(this.db);
    if (!pool) throw new Error('Database not available');

    const result = await pool.query(
      `INSERT INTO ai_feedback (workspace_id, user_id, prompt_template_id, job_id, rating, comment, tags)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [input.workspaceId, input.userId, input.promptTemplateId, input.jobId ?? null,
       input.rating, input.comment ?? null, JSON.stringify(input.tags ?? [])],
    );

    return { id: result.rows[0] as any, rating: input.rating };
  }

  // ── Get feedback for a prompt ──────────────────────
  async getFeedbackForPrompt(promptTemplateId: string, limit = 50): Promise<any[]> {
    const pool = getPool(this.db);
    if (!pool) return [];

    const result = await pool.query(
      `SELECT id, rating, comment, tags, created_at
       FROM ai_feedback WHERE prompt_template_id = $1
       ORDER BY created_at DESC LIMIT $2`,
      [promptTemplateId, limit],
    );
    return result.rows;
  }

  // ── Get aggregated metrics from feedback ───────────
  async getFeedbackMetrics(promptTemplateId: string): Promise<{
    totalRatings: number;
    avgRating: number;
    ratingDistribution: Record<number, number>;
    recentTrend: 'improving' | 'declining' | 'stable';
  }> {
    const pool = getPool(this.db);
    if (!pool) return { totalRatings: 0, avgRating: 0, ratingDistribution: {}, recentTrend: 'stable' };

    const result = await pool.query(`
      SELECT
        COUNT(*)::int as total,
        ROUND(AVG(rating), 2)::numeric as avg,
        COUNT(*) FILTER (WHERE rating = 1)::int as r1,
        COUNT(*) FILTER (WHERE rating = 2)::int as r2,
        COUNT(*) FILTER (WHERE rating = 3)::int as r3,
        COUNT(*) FILTER (WHERE rating = 4)::int as r4,
        COUNT(*) FILTER (WHERE rating = 5)::int as r5
      FROM ai_feedback WHERE prompt_template_id = $1
    `, [promptTemplateId]);

    // Trend: compare last 7 days vs previous 7 days
    const trendRes = await pool.query(`
      WITH recent AS (
        SELECT AVG(rating) as avg_r FROM ai_feedback
        WHERE prompt_template_id = $1 AND created_at > now() - interval '7 days'
      ),
      prev AS (
        SELECT AVG(rating) as avg_r FROM ai_feedback
        WHERE prompt_template_id = $1 AND created_at > now() - interval '14 days' AND created_at <= now() - interval '7 days'
      )
      SELECT
        COALESCE((SELECT avg_r FROM recent), 0) as recent_avg,
        COALESCE((SELECT avg_r FROM prev), 0) as prev_avg
    `, [promptTemplateId]);

    const r = result.rows[0] as any;
    const t = trendRes.rows[0] as any;
    const recentAvg = Number(t?.recent_avg ?? 0);
    const prevAvg = Number(t?.prev_avg ?? 0);
    let trend: 'improving' | 'declining' | 'stable' = 'stable';
    if (recentAvg > prevAvg + 0.2) trend = 'improving';
    else if (recentAvg < prevAvg - 0.2) trend = 'declining';

    return {
      totalRatings: r?.total ?? 0,
      avgRating: Number(r?.avg ?? 0),
      ratingDistribution: {
        1: r?.r1 ?? 0, 2: r?.r2 ?? 0, 3: r?.r3 ?? 0,
        4: r?.r4 ?? 0, 5: r?.r5 ?? 0,
      },
      recentTrend: trend,
    };
  }

  // ── Detect learning signals from feedback patterns ─
  async detectLearningSignals(): Promise<LearningSignal[]> {
    const pool = getPool(this.db);
    if (!pool) return [];

    // Find prompts with low ratings + specific comment patterns
    const result = await pool.query(`
      SELECT
        prompt_template_id,
        CASE
          WHEN comment ILIKE '%sulit%' OR comment ILIKE '%susa%' THEN 'difficulty_too_high'
          WHEN comment ILIKE '%mudah%' OR comment ILIKE '%gampang%' THEN 'difficulty_too_low'
          WHEN comment ILIKE '%error%' OR comment ILIKE '%salah%' THEN 'output_errors'
          WHEN comment ILIKE '%tidak%' OR comment ILIKE '%kurang%' THEN 'quality_issues'
          WHEN comment ILIKE '%bagus%' OR comment ILIKE '%baik%' THEN 'positive_pattern'
          ELSE 'general_feedback'
        END as pattern,
        COUNT(*)::int as frequency,
        ROUND(AVG(rating), 2)::numeric as avg_rating
      FROM ai_feedback
      WHERE rating <= 3 AND comment IS NOT NULL AND comment != ''
      GROUP BY prompt_template_id, pattern
      HAVING COUNT(*) >= 2
      ORDER BY avg_rating ASC, frequency DESC
      LIMIT 20
    `);

    return result.rows.map((r: any) => ({
      promptTemplateId: r.prompt_template_id,
      pattern: r.pattern,
      frequency: r.frequency,
      avgRating: Number(r.avg_rating),
      suggestedAction: this.suggestAction(r.pattern, Number(r.avg_rating)),
    }));
  }

  private suggestAction(pattern: string, avgRating: number): string {
    if (avgRating <= 2) {
      switch (pattern) {
        case 'difficulty_too_high': return 'Buat versi baru dengan instruksi lebih sederhana';
        case 'difficulty_too_low': return 'Buat versi baru dengan konteks lebih mendalam';
        case 'output_errors': return 'Perbaiki schema validation + tambah repair prompt';
        case 'quality_issues': return 'Review prompt text, tambah contoh output yang benar';
        default: return 'Review prompt dan buat versi improved';
      }
    }
    return 'Monitor, tidak perlu perubahan segera';
  }
}
