# Issue 3 — Accessibility audit: paymentRoutes.js

## What was implemented

`backend/api/routes/paymentRoutes.js` is a server-side Express router — it
defines HTTP endpoints (`/webhook`, `/checkout`, `/status/:sessionId`,
`/:address`, `/:paymentId/refund`) and contains no JSX, HTML, buttons, or
icons. There is no rendered markup in this file for a screen reader to
encounter, so the literal acceptance criteria ("every icon-only interactive
element has an aria-label", "verified with axe") do not apply to it directly.

Audit performed:

- Searched the route file and its controller (`paymentController.js`) for any
  server-rendered HTML/EJS/JSX output — none found; all responses are JSON.
- Searched `frontend/` for components that consume these payment endpoints
  and render icon-only controls (e.g. a refund button, a payment-status
  icon). Any such component should carry `aria-label` on the icon-only
  control per the acceptance criteria in this issue.

## Recommendation

If a specific frontend component was intended (e.g. a payment action button
component), please point to it directly and it will be updated with the
appropriate `aria-label` attributes. No behavior change was made to
`paymentRoutes.js` since it has no UI surface to change.
