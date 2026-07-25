/**
 * Seed script: Realistic Indonesian teacher/school_admin accounts
 * Seeds 20 teachers/admins across 5 schools + 2 superadmins
 * Usage: node scripts/seed-accounts.mjs
 * Idempotent: uses ON CONFLICT (email) DO NOTHING
 */
import pg from 'pg';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
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
  console.log('🇮🇩 Seeding realistic Indonesian school accounts...\n');

  // Pre-hash password once (bcrypt is slow by design)
  console.log('🔐 Generating bcrypt hash for Lembar123!...');
  const passwordHash = await bcrypt.hash('Lembar123!', 12);
  console.log('  ✅ Hash ready\n');

  // ── Fetch real school tenant IDs ──────────────────
  console.log('🏫 Looking up school tenants...');
  const tenantSlugs = ['sdn-contoh-01', 'sdn-contoh-02', 'sd-mawar', 'smp-araya', 'smp-harapan', 'sma-nusantara'];
  const tenantRes = await pool.query(
    `SELECT id, slug, name FROM tenants WHERE slug = ANY($1)`,
    [tenantSlugs],
  );
  const tenants = {};
  for (const row of tenantRes.rows) {
    tenants[row.slug] = { id: row.id, name: row.name };
    console.log(`  ✓ ${row.slug} → ${row.id} (${row.name})`);
  }
  console.log();

  // ── Account definitions ───────────────────────────
  // 2 superadmins + 20 school accounts (4 per school: 1 admin + 3 teachers)
  const accounts = [
    // ── Superadmins ──
    {
      email: 'ops@lembar.id',
      name: 'Budi Santoso',
      username: 'ops_lembar',
      roles: ['superadmin'],
      workspaceTenant: null,
    },
    {
      email: 'admin@lembar.id',
      name: 'Sari Dewi Rahayu',
      username: 'admin_lembar',
      roles: ['superadmin'],
      workspaceTenant: null,
    },

    // ── SDN Contoh 01 ──
    {
      email: 'kepala@sdncontoh.sch.id',
      name: 'Drs. Ahmad Fauzi',
      username: 'ahmad_fauzi_sdn1',
      roles: ['school_admin'],
      workspaceTenant: 'sdn-contoh-01',
    },
    {
      email: 'siti.nurhaliza@sdncontoh.sch.id',
      name: 'Siti Nurhaliza',
      username: 'siti_nurhaliza',
      roles: ['teacher'],
      workspaceTenant: 'sdn-contoh-01',
    },
    {
      email: 'rizki.pratama@sdncontoh.sch.id',
      name: 'Rizki Pratama',
      username: 'rizki_pratama',
      roles: ['teacher'],
      workspaceTenant: 'sdn-contoh-01',
    },
    {
      email: 'maya.anggraini@sdncontoh.sch.id',
      name: 'Maya Anggraini',
      username: 'maya_anggraini',
      roles: ['teacher'],
      workspaceTenant: 'sdn-contoh-01',
    },

    // ── SDN Contoh 02 ──
    {
      email: 'kepala@sdncontoh2.sch.id',
      name: 'Hj. Ratna Wulandari',
      username: 'ratna_wulandari_sdn2',
      roles: ['school_admin'],
      workspaceTenant: 'sdn-contoh-02',
    },
    {
      email: 'eko.susanto@sdncontoh2.sch.id',
      name: 'Eko Susanto',
      username: 'eko_susanto',
      roles: ['teacher'],
      workspaceTenant: 'sdn-contoh-02',
    },
    {
      email: 'fitri.handayani@sdncontoh2.sch.id',
      name: 'Fitri Handayani',
      username: 'fitri_handayani',
      roles: ['teacher'],
      workspaceTenant: 'sdn-contoh-02',
    },
    {
      email: 'andika.putra@sdncontoh2.sch.id',
      name: 'Andika Putra',
      username: 'andika_putra',
      roles: ['teacher'],
      workspaceTenant: 'sdn-contoh-02',
    },

    // ── SD Mawar ──
    {
      email: 'kepala@sdmawar.sch.id',
      name: 'Bambang Suryadi',
      username: 'bambang_suryadi_sdm',
      roles: ['school_admin'],
      workspaceTenant: 'sd-mawar',
    },
    {
      email: 'rina.astuti@sdmawar.sch.id',
      name: 'Rina Astuti',
      username: 'rina_astuti',
      roles: ['teacher'],
      workspaceTenant: 'sd-mawar',
    },
    {
      email: 'hendra.wijaya@sdmawar.sch.id',
      name: 'Hendra Wijaya',
      username: 'hendra_wijaya',
      roles: ['teacher'],
      workspaceTenant: 'sd-mawar',
    },

    // ── SMP Araya ──
    {
      email: 'kepala@smparaya.sch.id',
      name: 'Dra. Nurul Hidayah, M.Pd.',
      username: 'nurul_hidayah_smp',
      roles: ['school_admin'],
      workspaceTenant: 'smp-araya',
    },
    {
      email: 'budi.kurniawan@smparaya.sch.id',
      name: 'Budi Kurniawan',
      username: 'budi_kurniawan',
      roles: ['teacher'],
      workspaceTenant: 'smp-araya',
    },
    {
      email: 'dewi.lestari@smparaya.sch.id',
      name: 'Dewi Lestari',
      username: 'dewi_lestari',
      roles: ['teacher'],
      workspaceTenant: 'smp-araya',
    },
    {
      email: 'agus.setiawan@smparaya.sch.id',
      name: 'Agus Setiawan',
      username: 'agus_setiawan',
      roles: ['teacher'],
      workspaceTenant: 'smp-araya',
    },

    // ── SMP Harapan ──
    {
      email: 'kepala@smpharapan.sch.id',
      name: 'H. Soeprapto, S.Pd.',
      username: 'soeprapto_smph',
      roles: ['school_admin'],
      workspaceTenant: 'smp-harapan',
    },
    {
      email: 'indah.permata@smpharapan.sch.id',
      name: 'Indah Permatasari',
      username: 'indah_permatasari',
      roles: ['teacher'],
      workspaceTenant: 'smp-harapan',
    },
    {
      email: 'wahyu.hidayat@smpharapan.sch.id',
      name: 'Wahyu Hidayat',
      username: 'wahyu_hidayat',
      roles: ['teacher'],
      workspaceTenant: 'smp-harapan',
    },
    {
      email: 'yuni.safitri@smpharapan.sch.id',
      name: 'Yuni Safitri',
      username: 'yuni_safitri',
      roles: ['teacher'],
      workspaceTenant: 'smp-harapan',
    },

    // ── SMA Nusantara (bonus — in tenants list too) ──
    {
      email: 'kepala@smanusantara.sch.id',
      name: 'Dr. Sukarno Hadiwiyoto, M.M.',
      username: 'sukarno_hadiwiyoto',
      roles: ['school_admin'],
      workspaceTenant: 'sma-nusantara',
    },
    {
      email: 'kartini.wahyuni@smanusantara.sch.id',
      name: 'Kartini Wahyuni',
      username: 'kartini_wahyuni',
      roles: ['teacher'],
      workspaceTenant: 'sma-nusantara',
    },
  ];

  // ── Insert accounts ───────────────────────────────
  console.log('👤 Inserting accounts...');
  let inserted = 0;
  let skipped = 0;

  for (const acct of accounts) {
    try {
      const workspaceId = acct.workspaceTenant
        ? tenants[acct.workspaceTenant]?.id ?? null
        : null;

      const res = await pool.query(
        `INSERT INTO jwt_users (id, email, name, username, password_hash, roles, workspace_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
         ON CONFLICT (email) DO NOTHING`,
        [
          randomUUID(),
          acct.email,
          acct.name,
          acct.username,
          passwordHash,
          acct.roles,
          workspaceId,
        ],
      );

      if (res.rowCount > 0) {
        console.log(`  ✓ ${acct.email} (${acct.roles[0]})`);
        inserted++;
      } else {
        console.log(`  - ${acct.email} (already exists, skipped)`);
        skipped++;
      }
    } catch (e) {
      console.log(`  ⚠ ${acct.email}: ${e.message?.slice(0, 100)}`);
    }
  }

  // ── Summary ───────────────────────────────────────
  const counts = await pool.query(`
    SELECT
      (SELECT count(*) FROM jwt_users) as total_users,
      (SELECT count(*) FROM jwt_users WHERE email NOT LIKE '%test%' AND email NOT LIKE '%example%') as clean_users,
      (SELECT count(*) FROM jwt_users WHERE 'superadmin' = ANY(roles)) as superadmins,
      (SELECT count(*) FROM jwt_users WHERE 'school_admin' = ANY(roles)) as school_admins,
      (SELECT count(*) FROM jwt_users WHERE 'teacher' = ANY(roles)) as teachers
  `);
  const c = counts.rows[0];

  console.log('\n📊 Summary:');
  console.log(`  Inserted this run: ${inserted}`);
  console.log(`  Skipped (already exist): ${skipped}`);
  console.log(`  Total users in DB: ${c.total_users}`);
  console.log(`  Non-test/example users: ${c.clean_users}`);
  console.log(`  Superadmins: ${c.superadmins}`);
  console.log(`  School admins: ${c.school_admins}`);
  console.log(`  Teachers: ${c.teachers}`);

  await pool.end();
  console.log('\n✅ Account seed complete!');
}

seed().catch((e) => { console.error('❌ Seed failed:', e); process.exit(1); });
