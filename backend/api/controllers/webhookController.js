import { validationResult, query } from 'express-validator';
import webhookService from '../../services/webhookService.js';

const MAX_EVENT_TYPES = 20;
const ALLOWED_SCHEMES = ['https:'];

function isValidWebhookUrl(raw) {
  try {
    const parsed = new URL(raw);
    return ALLOWED_SCHEMES.includes(parsed.protocol);
  } catch {
    return false;
  }
}

const subscribe = async (req, res) => {
  try {
    const { url, eventTypes } = req.body;

    if (!url || !isValidWebhookUrl(url)) {
      return res.status(400).json({ error: 'url must be a valid HTTPS URL' });
    }

    if (!Array.isArray(eventTypes) || eventTypes.length === 0) {
      return res.status(400).json({ error: 'eventTypes must be a non-empty array' });
    }

    if (eventTypes.length > MAX_EVENT_TYPES) {
      return res
        .status(400)
        .json({ error: `eventTypes may not exceed ${MAX_EVENT_TYPES} entries` });
    }

    const result = await webhookService.createSubscription({
      url,
      eventTypes: eventTypes.slice(0, MAX_EVENT_TYPES),
      createdBy: req.user?.address || null,
    });

    res.status(201).json({ data: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const listSubscriptions = async (req, res) => {
  try {
    const subscriptions = await webhookService.listSubscriptions({
      createdBy: req.user?.address || null,
    });
    res.json({ data: subscriptions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const deleteSubscription = async (req, res) => {
  try {
    const deleted = await webhookService.deleteSubscription({
      id: req.params.id,
      createdBy: req.user?.address || null,
    });

    if (!deleted) {
      return res.status(404).json({ error: 'Webhook subscription not found' });
    }

    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

/**
 * Validation chains for GET /:id/deliveries query parameters.
 * Exported so webhookRoutes.js can apply them before the handler runs.
 */
export const deliveriesQueryRules = [
  query('page')
    .optional({ values: 'falsy' })
    .isInt({ min: 1 })
    .withMessage('page must be an integer >= 1'),
  query('limit')
    .optional({ values: 'falsy' })
    .isInt({ min: 1, max: 100 })
    .withMessage('limit must be an integer between 1 and 100'),
];

const getDeliveries = async (req, res) => {
  try {
    // Surface any validation errors produced by deliveriesQueryRules middleware.
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      const details = errors.array({ onlyFirstError: false }).map((e) => ({
        field: e.path,
        message: e.msg,
        location: e.location,
      }));
      return res.status(400).json({ error: 'Validation failed', details });
    }

    const page = Number(req.query.page || 1);
    const limit = Math.min(Number(req.query.limit || 30), 100);

    const result = await webhookService.getDeliveryHistory({
      subscriptionId: req.params.id,
      createdBy: req.user?.address || null,
      page,
      limit,
    });

    // result shape from service: { page, limit, total, deliveries, summary }
    res.json({ data: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export default {
  subscribe,
  listSubscriptions,
  deleteSubscription,
  getDeliveries,
};
