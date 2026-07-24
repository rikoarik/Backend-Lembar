/**
 * Seed script for superadmin ops data.
 * Usage: node scripts/seed-ops-data.mjs
 * Idempotent: uses ON CONFLICT DO NOTHING / DO UPDATE.
 */
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const envPath = path.resolve(process.cwd(), '.env');
const envContent = readFileSync(envPath, 'utf-8');
const env = {};
for (const line of envContent.split('\n')) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const eqIdx = trimmed.indexOf('=');
  if (eqIdx === -1) continue;
  env[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
}

const pool = new pg.Pool({ connectionString: env.DATABASE_URL });

async function seed() {
  console.log('🌱 Seeding superadmin ops data...\n');

  // ── Accounts (jwt_users already has data from register, add extra) ──
  console.log('👤 Accounts...');
  const accounts = [
    { email: 'ops@lembar.id', name: 'Ops Superadmin', username: 'ops_superadmin', roles: '{superadmin}', phone: '6281000000001' },
    { email: 'admin@sdncontoh.sch.id', name: 'Admin SDN Contoh', username: 'admin_sdncontoh', roles: '{school_admin}', phone: '6281000000002' },
    { email: 'guru@sdncontoh.sch.id', name: 'Guru SDN Contoh', username: 'guru_sdncontoh', roles: '{teacher}', phone: '6281000000003' },
    { email: 'guru2@sdncontoh.sch.id', name: 'Guru 2 SDN Contoh', username: 'guru2_sdncontoh', roles: '{teacher}', phone: '6281000000004' },
    { email: 'admin@smparaya.sch.id', name: 'Admin SMP A', username: 'admin_smparaya', roles: '{school_admin}', phone: '6281000000005' },
    { email: 'guru@smparaya.sch.id', name: 'Guru SMP A', username: 'guru_smparaya', roles: '{teacher}', phone: '6281000000006' },
    { email: 'guru2@smparaya.sch.id', name: 'Guru 2 SMP A', username: 'guru2_smparaya', roles: '{teacher}', phone: '6281000000007' },
    { email: 'subscriber@demo.com', name: 'Demo Subscriber', username: 'demo_subscriber', roles: '{subscriber}', phone: '6281000000008' },
    { email: 'teacher@demo.com', name: 'Demo Teacher', username: 'demo_teacher', roles: '{teacher}', phone: '6281000000009' },
    { email: 'ops2@lembar.id', name: 'Ops Support', username: 'ops_support', roles: '{superadmin}', phone: '6281000000010' },
  ];

  for (const acct of accounts) {
    try {
      // Insert tenant first
      const tenantRes = await pool.query(
        `INSERT INTO tenants (slug, name) VALUES ($1, $2) ON CONFLICT (slug) DO NOTHING RETURNING id`,
        [`tenant-${acct.username}`, `${acct.name} Workspace`],
      );
      const tenantId = tenantRes.rows[0]?.id;

      // Check if user exists
      const existing = await pool.query('SELECT id FROM jwt_users WHERE email = $1', [acct.email]);
      if (existing.rows.length > 0) {
        // Update roles if different
        await pool.query(
          'UPDATE jwt_users SET roles = $1::text[] WHERE email = $2',
          [acct.roles, acct.email],
        );
        console.log(`  ✓ ${acct.email} (roles updated)`);
      } else {
        await pool.query(
          `INSERT INTO jwt_users (email, username, name, phone, password_hash, roles, workspace_id)
           VALUES ($1, $2, $3, $4, '$2b$10$dummyhash', $5::text[], $6)`,
          [acct.email, acct.username, acct.name, acct.phone, acct.roles, tenantId],
        );
        console.log(`  ✓ ${acct.email} (created)`);
      }
    } catch (e) {
      console.log(`  ⚠ ${acct.email}: ${e.message?.slice(0, 80)}`);
    }
  }

  // ── Schools (tenants) ──
  console.log('\n🏫 Schools...');
  const schools = [
    { slug: 'sdn-contoh-01', name: 'SDN Contoh 01' },
    { slug: 'sdn-contoh-02', name: 'SDN Contoh 02' },
    { slug: 'smp-araya', name: 'SMP Araya' },
    { slug: 'sma-nusantara', name: 'SMA Nusantara' },
    { slug: 'sd-mawar', name: 'SD Mawar' },
    { slug: 'smp-harapan', name: 'SMP Harapan' },
  ];

  for (const school of schools) {
    try {
      await pool.query(
        'INSERT INTO tenants (slug, name) VALUES ($1, $2) ON CONFLICT (slug) DO NOTHING',
        [school.slug, school.name],
      );
      console.log(`  ✓ ${school.name}`);
    } catch (e) {
      console.log(`  ⚠ ${school.name}: ${e.message?.slice(0, 60)}`);
    }
  }

  // ── Feature Flags ──
  console.log('\n🚩 Feature flags...');
  const flags = [
    { key: 'share.links', description: 'Controlled share links', enabled: 'true', scope: 'global' },
    { key: 'cms.marketing', description: 'Structured marketing CMS', enabled: 'true', scope: 'global' },
    { key: 'analytics.creator', description: 'Creator analytics screen', enabled: 'true', scope: 'pilot' },
    { key: 'ops.bulk_actions', description: 'Bulk tenant actions', enabled: 'false', scope: 'pilot' },
    { key: 'ai.generate.v2', description: 'AI generate v2 engine', enabled: 'false', scope: 'global' },
    { key: 'school.parent_portal', description: 'Parent portal access', enabled: 'false', scope: 'pilot' },
  ];

  for (const flag of flags) {
    try {
      await pool.query(
        `INSERT INTO admin_flags (key, description, enabled, scope)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description, scope = EXCLUDED.scope`,
        [flag.key, flag.description, flag.enabled, flag.scope],
      );
      console.log(`  ✓ ${flag.key} (${flag.enabled})`);
    } catch (e) {
      console.log(`  ⚠ ${flag.key}: ${e.message?.slice(0, 60)}`);
    }
  }

  // ── Prompt Library ──
  console.log('\n📝 Prompts...');
  const prompts = [
    {
      name: 'generate.v3',
      slug: 'generate-v3',
      description: 'Main assessment generation prompt',
      promptText: 'You are an expert Indonesian curriculum assessment designer...',
      version: 'v3',
      status: 'active',
      createdBy: 'ops@lembar.id',
    },
    {
      name: 'repair.schema',
      slug: 'repair-schema',
      description: 'Schema repair for generated outputs',
      promptText: 'Analyze and repair JSON schema issues in the following assessment...',
      version: 'v2',
      status: 'active',
      createdBy: 'ops@lembar.id',
    },
    {
      name: 'quality.guard',
      slug: 'quality-guard',
      description: 'Quality guard for output validation',
      promptText: 'Review this assessment for quality issues...',
      version: 'v1',
      status: 'draft',
      createdBy: 'ops@lembar.id',
    },
  ];

  for (const prompt of prompts) {
    try {
      await pool.query(
        `INSERT INTO admin_prompts (name, slug, description, prompt_text, version, status, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (slug) DO UPDATE SET
           description = EXCLUDED.description,
           prompt_text = EXCLUDED.prompt_text,
           version = EXCLUDED.version,
           status = EXCLUDED.status`,
        [prompt.name, prompt.slug, prompt.description, prompt.promptText, prompt.version, prompt.status, prompt.createdBy],
      );
      console.log(`  ✓ ${prompt.name} (${prompt.status})`);
    } catch (e) {
      console.log(`  ⚠ ${prompt.name}: ${e.message?.slice(0, 60)}`);
    }
  }

  // ── Quality Reports ──
  console.log('\n📊 Quality reports...');
  const qualityReports = [
    { workspaceId: 'sdn-contoh-01', reporter: 'guru.siti', reason: 'kualitas_soal', status: 'open', notes: 'Soal no. 5 kurang jelas' },
    { workspaceId: 'sdn-contoh-01', reporter: 'guru.rina', reason: 'kunci_salah', status: 'open', notes: 'Kunci jawaban no. 12 salah' },
    { workspaceId: 'smp-araya', reporter: 'guru.budi', reason: 'privasi', status: 'triaged', notes: 'Data siswa terpapar' },
    { workspaceId: 'sma-nusantara', reporter: 'guru.dewi', reason: 'kualitas_soal', status: 'triaged', notes: 'Soal terlalu mudah' },
    { workspaceId: 'sd-mawar', reporter: 'guru.andi', reason: 'kunci_salah', status: 'closed', notes: 'Sudah diperbaiki' },
    { workspaceId: 'smp-harapan', reporter: 'guru.maya', reason: 'format_soal', status: 'open', notes: 'Format tidak konsisten' },
  ];

  for (const report of qualityReports) {
    try {
      await pool.query(
        `INSERT INTO admin_quality_reports (workspace_id, reporter, reason, status, notes)
         VALUES ($1, $2, $3, $4, $5)`,
        [report.workspaceId, report.reporter, report.reason, report.status, report.notes],
      );
      console.log(`  ✓ ${report.reason} (${report.status})`);
    } catch (e) {
      console.log(`  ⚠ ${report.reason}: ${e.message?.slice(0, 60)}`);
    }
  }

  // ── Billing Data ──
  console.log('\n💰 Billing...');
  const billingData = [
    { tenantId: 'tenant-admin_sdncontoh', schoolName: 'SDN Contoh 01', state: 'active', seats: '30', plan: 'pilot', renewsAt: '2026-08-24' },
    { tenantId: 'tenant-admin_smparaya', schoolName: 'SMP Araya', state: 'active', seats: '25', plan: 'pilot', renewsAt: '2026-09-01' },
    { tenantId: 'tenant-guru', schoolName: 'SMA Nusantara', state: 'grace', seats: '60', plan: 'free', renewsAt: '2026-07-28' },
    { tenantId: 'tenant-guru2', schoolName: 'SD Mawar', state: 'active', seats: '18', plan: 'free', renewsAt: '2026-09-01' },
    { tenantId: 'tenant-subscriber', schoolName: 'SMP Harapan', state: 'blocked', seats: '40', plan: 'free', renewsAt: '2026-07-10' },
  ];

  for (const bill of billingData) {
    try {
      await pool.query(
        `INSERT INTO admin_billing (tenant_id, school_name, state, seats, plan, renews_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT DO NOTHING
           school_name = EXCLUDED.school_name, state = EXCLUDED.state,
           seats = EXCLUDED.seats, plan = EXCLUDED.plan, renews_at = EXCLUDED.renews_at`,
        [bill.tenantId, bill.schoolName, bill.state, bill.seats, bill.plan, bill.renewsAt],
      );
      console.log(`  ✓ ${bill.schoolName} (${bill.state})`);
    } catch (e) {
      console.log(`  ⚠ ${bill.schoolName}: ${e.message?.slice(0, 60)}`);
    }
  }

  // ── Audit Trail (seed some entries) ──
  console.log('\n📋 Audit trail...');
  const auditEntries = [
    { actorId: 'ops@lembar.id', actorEmail: 'ops@lembar.id', action: 'role.update', targetType: 'user', targetId: 'guru@sdncontoh.sch.id', metadata: { from: 'subscriber', to: 'teacher' } },
    { actorId: 'ops@lembar.id', actorEmail: 'ops@lembar.id', action: 'tenant.plan_change', targetType: 'tenant', targetId: 'sdn-contoh-01', metadata: { from: 'free', to: 'pilot' } },
    { actorId: 'ops@lembar.id', actorEmail: 'ops@lembar.id', action: 'flag.toggle', targetType: 'flag', targetId: 'ops.bulk_actions', metadata: { enabled: false } },
    { actorId: 'ops2@lembar.id', actorEmail: 'ops2@lembar.id', action: 'quality.triage', targetType: 'report', targetId: 'quality-report-1', metadata: { status: 'triaged' } },
  ];

  for (const entry of auditEntries) {
    try {
      await pool.query(
        `INSERT INTO admin_audit (actor_id, actor_email, action, target_type, target_id, metadata)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [entry.actorId, entry.actorEmail, entry.action, entry.targetType, entry.targetId, JSON.stringify(entry.metadata)],
      );
      console.log(`  ✓ ${entry.action} on ${entry.targetId}`);
    } catch (e) {
      console.log(`  ⚠ ${entry.action}: ${e.message?.slice(0, 60)}`);
    }
  }

  // ── Summary ──
  console.log('\n📊 Summary:');
  const counts = await pool.query(`
    SELECT
      (SELECT count(*) FROM jwt_users) as users,
      (SELECT count(*) FROM tenants) as schools,
      (SELECT count(*) FROM admin_flags) as flags,
      (SELECT count(*) FROM admin_prompts) as prompts,
      (SELECT count(*) FROM admin_quality_reports) as quality_reports,
      (SELECT count(*) FROM admin_billing) as billing,
      (SELECT count(*) FROM admin_audit) as audit_entries
  `);
  const c = counts.rows[0];
  console.log(`  Users: ${c.users}`);
  console.log(`  Schools: ${c.schools}`);
  console.log(`  Flags: ${c.flags}`);
  console.log(`  Prompts: ${c.prompts}`);
  console.log(`  Quality Reports: ${c.quality_reports}`);
  console.log(`  Billing: ${c.billing}`);
  console.log(`  Audit Entries: ${c.audit_entries}`);

  await pool.end();
  console.log('\n✅ Seed complete!');
}

seed().catch((e) => { console.error('❌ Seed failed:', e); process.exit(1); });
