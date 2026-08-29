# Notification service empty state

**Issue:** `backend/services/notificationService.js` returned nothing (empty
array) when a user had zero notifications, leaving the UI blank with no
explanation.

## What was implemented

- Created `backend/services/notificationService.js` exporting
  `buildNotificationFeed(notifications, options)`, which wraps a raw list of
  notification records and, when the list is empty, attaches a friendly
  `emptyState` payload (`title`, `message`, `actionLabel`, `actionHref`)
  instead of just an empty array.
- Added `getEmptyStateForFilter(filter)` so filtered views (`unread`,
  `archived`, `all`) get contextual copy rather than one generic message.
- Added `formatNotification(notification)` to normalize raw records before
  they reach the feed response.
- Copy matches the existing empty-state tone used in
  `frontend/components/notifications/NotificationCenter.jsx` ("You're all
  caught up") and includes an actionable next step (link back to
  `/escrows` or the unfiltered notification list).

## Acceptance criteria mapping

- Empty state renders when the list is empty — `isEmpty`/`emptyState` fields
  are always present on the response, so calling code no longer has to guess.
- Copy is clear and actionable — each empty state includes a title, message,
  and (where relevant) an action label/href.
- Matches existing empty-state styling — copy tone mirrors
  `NotificationCenter.jsx`'s existing "you're all caught up" empty state.
