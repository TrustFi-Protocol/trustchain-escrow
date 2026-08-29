/**
 * notificationService.js
 *
 * Fetches and formats notification feeds for a user. When the underlying
 * data source (DB / cache) returns zero results, callers previously
 * received an empty array with no explanation, which rendered as a blank
 * panel on the frontend. This service now attaches a friendly, actionable
 * empty-state payload so every consumer (API response, websocket push,
 * digest email) can render consistent copy without re-deriving it.
 */

const EMPTY_STATE = Object.freeze({
  isEmpty: true,
  title: "You're all caught up",
  message: 'New updates about your escrows will show up here as they happen.',
  actionLabel: 'Browse your escrows',
  actionHref: '/escrows',
});

/**
 * Wraps a list of raw notification records with pagination + empty-state
 * metadata so the frontend never has to guess why a list is blank.
 *
 * @param {Array<object>} notifications - Raw notification records from the store.
 * @param {object} [options]
 * @param {number} [options.page=1] - Current page number (1-indexed).
 * @param {number} [options.pageSize=20] - Number of records per page.
 * @param {number} [options.totalCount] - Total records available across all pages.
 * @returns {{
 *   items: Array<object>,
 *   isEmpty: boolean,
 *   emptyState: object|null,
 *   page: number,
 *   pageSize: number,
 *   totalCount: number,
 * }}
 */
function buildNotificationFeed(notifications = [], options = {}) {
  const { page = 1, pageSize = 20, totalCount = notifications.length } = options;
  const items = Array.isArray(notifications) ? notifications : [];

  if (items.length === 0) {
    return {
      items: [],
      isEmpty: true,
      emptyState: { ...EMPTY_STATE },
      page,
      pageSize,
      totalCount: 0,
    };
  }

  return {
    items: items.map(formatNotification),
    isEmpty: false,
    emptyState: null,
    page,
    pageSize,
    totalCount,
  };
}

/**
 * Normalizes a single raw notification record into the shape the API/UI expects.
 *
 * @param {object} notification - Raw notification record.
 * @returns {object} Normalized notification.
 */
function formatNotification(notification) {
  return {
    id: notification.id,
    type: notification.type,
    title: notification.title ?? 'Notification',
    message: notification.message ?? '',
    read: Boolean(notification.read),
    createdAt: notification.createdAt ?? new Date().toISOString(),
  };
}

/**
 * Produces an empty-state specific to a filtered view (e.g. "unread only")
 * so the copy stays contextual instead of always showing the generic message.
 *
 * @param {string} filter - The active filter, e.g. 'unread', 'archived', 'all'.
 * @returns {object} Empty-state payload tailored to the filter.
 */
function getEmptyStateForFilter(filter) {
  switch (filter) {
    case 'unread':
      return {
        isEmpty: true,
        title: 'No unread notifications',
        message: 'Nice work — you have read everything. Check back later for updates.',
        actionLabel: 'View all notifications',
        actionHref: '/notifications?filter=all',
      };
    case 'archived':
      return {
        isEmpty: true,
        title: 'Nothing archived yet',
        message: 'Notifications you archive will be stored here for reference.',
        actionLabel: null,
        actionHref: null,
      };
    default:
      return { ...EMPTY_STATE };
  }
}

export { buildNotificationFeed, formatNotification, getEmptyStateForFilter, EMPTY_STATE };

export default {
  buildNotificationFeed,
  formatNotification,
  getEmptyStateForFilter,
  EMPTY_STATE,
};
