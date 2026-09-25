/**
 * Tests for Incident Service (Issue #231)
 */

import incidentService from '../services/incidentService.js';
import prisma from '../lib/prisma.js';

describe('incidentService', () => {
  const tenantId = 'test-tenant';
  const createdBy = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH5C4A';

  beforeEach(async () => {
    await prisma.incidentEscrow.deleteMany({ where: { tenantId } });
    await prisma.incident.deleteMany({ where: { tenantId } });
  });

  describe('createIncident', () => {
    it('should create an incident with OPEN status', async () => {
      const incident = await incidentService.createIncident(
        tenantId,
        'Database outage',
        'PostgreSQL master unavailable',
        'critical',
        createdBy,
      );

      expect(incident).toBeDefined();
      expect(incident.tenantId).toBe(tenantId);
      expect(incident.title).toBe('Database outage');
      expect(incident.severity).toBe('critical');
      expect(incident.status).toBe(incidentService.IncidentStatus.OPEN);
      expect(incident.startTime).toBeDefined();
      expect(incident.createdBy).toBe(createdBy);
    });

    it('should reject invalid severity', async () => {
      await expect(
        incidentService.createIncident(
          tenantId,
          'Test',
          'Description',
          'invalid_severity',
          createdBy,
        ),
      ).rejects.toThrow('Invalid severity level');
    });
  });

  describe('getIncident', () => {
    it('should retrieve incident with escrows count', async () => {
      const created = await incidentService.createIncident(
        tenantId,
        'API slowness',
        'Response times >5s',
        'high',
        createdBy,
      );

      const retrieved = await incidentService.getIncident(created.id, tenantId);

      expect(retrieved.id).toBe(created.id);
      expect(retrieved.escrows).toBeDefined();
    });

    it('should return null for non-existent incident', async () => {
      const incident = await incidentService.getIncident('nonexistent', tenantId);
      expect(incident).toBeNull();
    });

    it('should return null for incident in different tenant', async () => {
      const incident = await incidentService.createIncident(
        'other-tenant',
        'Test',
        'Test',
        'low',
        createdBy,
      );

      const retrieved = await incidentService.getIncident(incident.id, tenantId);
      expect(retrieved).toBeNull();
    });
  });

  describe('listIncidents', () => {
    it('should list incidents for tenant paginated', async () => {
      await incidentService.createIncident(tenantId, 'Issue 1', 'Desc', 'low', createdBy);
      await incidentService.createIncident(tenantId, 'Issue 2', 'Desc', 'high', createdBy);
      await incidentService.createIncident('other-tenant', 'Issue 3', 'Desc', 'medium', createdBy);

      const { incidents, total } = await incidentService.listIncidents(tenantId, {
        skip: 0,
        take: 10,
      });

      expect(total).toBe(2);
      expect(incidents).toHaveLength(2);
    });

    it('should filter by status if provided', async () => {
      const open = await incidentService.createIncident(
        tenantId,
        'Open incident',
        'Desc',
        'high',
        createdBy,
      );
      const resolved = await incidentService.createIncident(
        tenantId,
        'Resolved incident',
        'Desc',
        'low',
        createdBy,
      );

      await incidentService.updateStatus(resolved.id, tenantId, 'resolved');

      const { incidents, total } = await incidentService.listIncidents(
        tenantId,
        { status: 'open', skip: 0, take: 10 },
      );

      expect(total).toBe(1);
      expect(incidents[0].status).toBe('open');
    });
  });

  describe('updateStatus', () => {
    it('should update incident status from open to resolved', async () => {
      const incident = await incidentService.createIncident(
        tenantId,
        'Test',
        'Desc',
        'high',
        createdBy,
      );

      const updated = await incidentService.updateStatus(
        incident.id,
        tenantId,
        incidentService.IncidentStatus.RESOLVED,
      );

      expect(updated.status).toBe('resolved');
      expect(updated.endTime).toBeDefined();
    });

    it('should reject invalid status', async () => {
      const incident = await incidentService.createIncident(
        tenantId,
        'Test',
        'Desc',
        'high',
        createdBy,
      );

      await expect(
        incidentService.updateStatus(incident.id, tenantId, 'invalid_status'),
      ).rejects.toThrow('Invalid status');
    });
  });

  describe('addEscrow and removeEscrow', () => {
    it('should link and unlink escrow to incident', async () => {
      const incident = await incidentService.createIncident(
        tenantId,
        'Test',
        'Desc',
        'high',
        createdBy,
      );

      const link = await incidentService.addEscrow(
        incident.id,
        tenantId,
        BigInt(12345),
        'Milestone approval delayed',
      );

      expect(link.incidentId).toBe(incident.id);
      expect(link.escrowId).toBe(BigInt(12345));
      expect(link.reason).toBe('Milestone approval delayed');

      // Remove it
      await incidentService.removeEscrow(incident.id, BigInt(12345));

      const retrieved = await incidentService.getIncident(incident.id, tenantId);
      expect(retrieved.escrows).toHaveLength(0);
    });

    it('should upsert (update) escrow link if already exists', async () => {
      const incident = await incidentService.createIncident(
        tenantId,
        'Test',
        'Desc',
        'high',
        createdBy,
      );

      await incidentService.addEscrow(incident.id, tenantId, BigInt(12345), 'Old reason');
      const updated = await incidentService.addEscrow(
        incident.id,
        tenantId,
        BigInt(12345),
        'New reason',
      );

      expect(updated.reason).toBe('New reason');

      const retrieved = await incidentService.getIncident(incident.id, tenantId);
      expect(retrieved.escrows).toHaveLength(1);
    });
  });

  describe('getAffectedEscrows', () => {
    it('should return paginated list of linked escrows', async () => {
      const incident = await incidentService.createIncident(
        tenantId,
        'Test',
        'Desc',
        'high',
        createdBy,
      );

      await incidentService.addEscrow(incident.id, tenantId, BigInt(100), 'Reason 1');
      await incidentService.addEscrow(incident.id, tenantId, BigInt(101), 'Reason 2');
      await incidentService.addEscrow(incident.id, tenantId, BigInt(102), 'Reason 3');

      const { escrows, total } = await incidentService.getAffectedEscrows(
        incident.id,
        tenantId,
        { skip: 0, take: 2 },
      );

      expect(total).toBe(3);
      expect(escrows).toHaveLength(2);
    });

    it('should return empty list if no escrows linked', async () => {
      const incident = await incidentService.createIncident(
        tenantId,
        'Test',
        'Desc',
        'high',
        createdBy,
      );

      const { escrows, total } = await incidentService.getAffectedEscrows(
        incident.id,
        tenantId,
        { skip: 0, take: 10 },
      );

      expect(total).toBe(0);
      expect(escrows).toHaveLength(0);
    });
  });
});
