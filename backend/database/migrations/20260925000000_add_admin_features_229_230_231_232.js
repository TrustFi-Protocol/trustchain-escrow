/**
 * Migration: Add KYC History, Export Jobs, and Incidents support
 * Version:   20260925000000_add_admin_features_229_230_231_232
 *
 * Implements:
 * - Issue #229: KYC history timeline (who changed status, why, when)
 * - Issue #230: Export job tracking (queued/running/completed/failed/cancelled)
 * - Issue #231: Incident tracking with affected escrows
 * - Issue #232: Feature flag evaluation preview (depends on existing FeatureFlag model)
 */

/**
 * @param {import('@prisma/client').PrismaClient} prisma
 */
export async function up(prisma) {
  // Create KycHistory table for #229
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS kyc_history (
      id             SERIAL PRIMARY KEY,
      tenant_id      TEXT NOT NULL,
      address        TEXT NOT NULL,
      old_status     VARCHAR(50) NOT NULL,
      new_status     VARCHAR(50) NOT NULL,
      actor          TEXT NOT NULL,
      reason         TEXT DEFAULT '',
      metadata       JSONB DEFAULT '{}',
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      
      CONSTRAINT fk_kyc_history_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
    )
  `);

  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS kyc_history_tenant_address_idx 
    ON kyc_history(tenant_id, address)
  `);

  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS kyc_history_tenant_created_idx 
    ON kyc_history(tenant_id, created_at DESC)
  `);

  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS kyc_history_address_created_idx 
    ON kyc_history(address, created_at DESC)
  `);

  // Create ExportJob table for #230
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS export_jobs (
      id               TEXT PRIMARY KEY,
      tenant_id        TEXT NOT NULL,
      request_by       TEXT NOT NULL,
      type             VARCHAR(100) NOT NULL,
      status           VARCHAR(50) DEFAULT 'queued',
      file_url         TEXT,
      file_key         TEXT,
      error_msg        TEXT,
      progress         INTEGER DEFAULT 0,
      total_items      INTEGER,
      items_processed  INTEGER,
      params           JSONB DEFAULT '{}',
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at       TIMESTAMPTZ,
      
      CONSTRAINT fk_export_job_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
    )
  `);

  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS export_jobs_tenant_status_idx 
    ON export_jobs(tenant_id, status)
  `);

  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS export_jobs_tenant_created_idx 
    ON export_jobs(tenant_id, created_at DESC)
  `);

  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS export_jobs_request_by_idx 
    ON export_jobs(request_by)
  `);

  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS export_jobs_status_idx 
    ON export_jobs(status)
  `);

  // Create Incident table for #231
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS incidents (
      id            TEXT PRIMARY KEY,
      tenant_id     TEXT NOT NULL,
      title         TEXT NOT NULL,
      description   TEXT NOT NULL,
      severity      VARCHAR(50) NOT NULL,
      status        VARCHAR(50) DEFAULT 'open',
      start_time    TIMESTAMPTZ NOT NULL,
      end_time      TIMESTAMPTZ,
      created_by    TEXT NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      
      CONSTRAINT fk_incident_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
    )
  `);

  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS incidents_tenant_status_idx 
    ON incidents(tenant_id, status)
  `);

  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS incidents_tenant_created_idx 
    ON incidents(tenant_id, created_at DESC)
  `);

  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS incidents_severity_idx 
    ON incidents(severity)
  `);

  // Create IncidentEscrow join table for #231
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS incident_escrows (
      id            TEXT PRIMARY KEY,
      tenant_id     TEXT NOT NULL,
      incident_id   TEXT NOT NULL,
      escrow_id     BIGINT NOT NULL,
      reason        TEXT DEFAULT '',
      
      CONSTRAINT fk_incident_escrow_incident FOREIGN KEY (incident_id) REFERENCES incidents(id) ON DELETE CASCADE,
      CONSTRAINT fk_incident_escrow_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
      CONSTRAINT uq_incident_escrow UNIQUE (incident_id, escrow_id)
    )
  `);

  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS incident_escrows_tenant_escrow_idx 
    ON incident_escrows(tenant_id, escrow_id)
  `);

  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS incident_escrows_incident_idx 
    ON incident_escrows(incident_id)
  `);
}

/**
 * @param {import('@prisma/client').PrismaClient} prisma
 */
export async function down(prisma) {
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS incident_escrows`);
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS incidents`);
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS export_jobs`);
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS kyc_history`);
}
