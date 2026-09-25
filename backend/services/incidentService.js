/**
 * Incident Service — Issue #231: Add Incident Impact Links to Escrows
 *
 * Tracks major system incidents and affected escrows.
 * Admins can link escrows to incidents for visibility.
 * Supports incident resolution workflow and timeline.
 */

import { nanoid } from 'nanoid';
import prisma from '../lib/prisma.js';

export const SeverityLevel = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical',
};

export const IncidentStatus = {
  OPEN: 'open',
  INVESTIGATING: 'investigating',
  RESOLVED: 'resolved',
};

/** Create a new incident. */
async function createIncident(tenantId, title, description, severity, createdBy) {
  if (!Object.values(SeverityLevel).includes(severity)) {
    throw new Error(`Invalid severity level: ${severity}`);
  }

  return prisma.incident.create({
    data: {
      id: nanoid(),
      tenantId,
      title,
      description,
      severity,
      status: IncidentStatus.OPEN,
      startTime: new Date(),
      createdBy,
    },
  });
}

/** Get incident by ID. */
async function getIncident(id, tenantId) {
  return prisma.incident.findFirst({
    where: { id, tenantId },
    include: { escrows: true },
  });
}

/** List incidents for a tenant (paginated). */
async function listIncidents(tenantId, { skip = 0, take = 20, status = null } = {}) {
  const where = { tenantId, ...(status ? { status } : {}) };

  const [incidents, total] = await prisma.$transaction([
    prisma.incident.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take,
      include: {
        _count: { select: { escrows: true } },
      },
    }),
    prisma.incident.count({ where }),
  ]);

  return { incidents, total };
}

/** Update incident status. */
async function updateStatus(id, tenantId, status) {
  if (!Object.values(IncidentStatus).includes(status)) {
    throw new Error(`Invalid status: ${status}`);
  }

  const updateData = { status };
  if (status === IncidentStatus.RESOLVED) {
    updateData.endTime = new Date();
  }

  return prisma.incident.update({
    where: { id },
    data: updateData,
  });
}

/** Link an escrow to an incident. */
async function addEscrow(incidentId, tenantId, escrowId, reason = '') {
  return prisma.incidentEscrow.upsert({
    where: { incidentId_escrowId: { incidentId, escrowId } },
    update: { reason },
    create: {
      id: nanoid(),
      tenantId,
      incidentId,
      escrowId,
      reason,
    },
  });
}

/** Unlink an escrow from an incident. */
async function removeEscrow(incidentId, escrowId) {
  return prisma.incidentEscrow.deleteMany({
    where: { incidentId, escrowId },
  });
}

/** Get paginated list of escrows linked to an incident. */
async function getAffectedEscrows(incidentId, tenantId, { skip = 0, take = 20 } = {}) {
  const [escrows, total] = await prisma.$transaction([
    prisma.incidentEscrow.findMany({
      where: { incidentId, tenantId },
      orderBy: { id: 'desc' },
      skip,
      take,
    }),
    prisma.incidentEscrow.count({ where: { incidentId, tenantId } }),
  ]);

  return { escrows, total };
}

export default {
  createIncident,
  getIncident,
  listIncidents,
  updateStatus,
  addEscrow,
  removeEscrow,
  getAffectedEscrows,
  SeverityLevel,
  IncidentStatus,
};
