/**
 * Migration: Add persistent webhook replay guard
 * Version:   20260929000000_webhook_event_replay_guard
 */

/**
 * @param {import('@prisma/client').PrismaClient} prisma
 */
export async function up(prisma) {
  await prisma.$executeRawUnsafe(`
    ALTER TABLE webhook_deliveries
    ADD COLUMN IF NOT EXISTS event_key TEXT
  `);

  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS webhook_deliveries_subscription_event_key_key
    ON webhook_deliveries(subscription_id, event_key)
    WHERE event_key IS NOT NULL
  `);
}

/**
 * @param {import('@prisma/client').PrismaClient} prisma
 */
export async function down(prisma) {
  await prisma.$executeRawUnsafe(`
    DROP INDEX IF EXISTS webhook_deliveries_subscription_event_key_key
  `);

  await prisma.$executeRawUnsafe(`
    ALTER TABLE webhook_deliveries
    DROP COLUMN IF EXISTS event_key
  `);
}
