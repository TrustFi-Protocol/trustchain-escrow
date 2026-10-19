/**
 * Incident Routes — all protected by adminAuth
 */

import express from 'express';
import adminAuth from '../middleware/adminAuth.js';
import incidentController from '../controllers/incidentController.js';
import { idempotencyMiddleware } from '../../lib/idempotency.js';

const router = express.Router();
router.use(adminAuth);

/** GET  /api/incidents           — list all incidents */
router.get('/', incidentController.listIncidents);

/** GET  /api/incidents/oncall    — current on-call engineer */
router.get('/oncall', incidentController.getOnCall);

/** POST /api/incidents           — create a new incident */
router.post('/', idempotencyMiddleware, incidentController.createIncident);

/** GET  /api/incidents/:id       — get incident detail */
router.get('/:id', incidentController.getIncident);

/** PATCH /api/incidents/:id/status — transition status */
router.patch('/:id/status', idempotencyMiddleware, incidentController.updateStatus);

/** POST /api/incidents/:id/post-mortem — attach post-mortem */
router.post('/:id/post-mortem', incidentController.attachPostMortem);

/** POST /api/incidents/:id/link-escrows — link affected escrows to incident */
router.post('/:id/link-escrows', idempotencyMiddleware, incidentController.linkEscrows);
router.post('/:id/escrows', idempotencyMiddleware, incidentController.linkEscrows);

export default router;
