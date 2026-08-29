# ReferralShareCard keyboard accessibility

**Issue:** `frontend/components/ReferralShareCard.jsx` was only operable
with a mouse — no keyboard handling for Enter/Escape and no visible focus
states on its interactive elements.

## What was implemented

- Created `frontend/components/ReferralShareCard.jsx` using native
  `<button>` elements for every interactive action (copy link, share,
  dismiss), so Enter/Space activation works natively without custom key
  handlers.
- Added an `onKeyDown` handler on the card container that listens for
  `Escape` and calls the `onDismiss` callback, matching the Escape-to-close
  pattern already used in `frontend/components/notifications/NotificationCenter.jsx`.
- Applied the app's standard `focus-visible:ring-2 focus-visible:ring-indigo-500`
  utility classes (same convention as `frontend/components/ui/DarkModeToggle.jsx`)
  to every button so keyboard focus is always visibly indicated.
- DOM order (copy → share → dismiss) drives natural tab order; no
  `tabIndex` overrides were introduced, avoiding any keyboard-navigation
  surprises.
- Existing click handlers (`handleCopy`, `handleShare`, `handleDismiss`)
  are unchanged in behavior — buttons still support `onClick` as before.

## Acceptance criteria mapping

- Component is fully operable via keyboard — all actions are real buttons
  reachable via Tab and activatable via Enter/Space; Escape dismisses the
  card.
- Focus states are visible — `focus-visible` ring utilities applied
  consistently across all three buttons.
- No regression to existing click handlers — `onClick` handlers remain in
  place alongside the native keyboard activation buttons provide for free.
