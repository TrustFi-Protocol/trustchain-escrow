# Issue 4 — Keyboard accessibility audit: useEscrow.js

## What was implemented

`frontend/hooks/useEscrow.js` exports three data-fetching hooks
(`useEscrow`, `useUserEscrows`, `useEscrowList`) built on `useSWR`. It
returns plain data (`{ escrow, isLoading, error, mutate }`) and renders no
JSX, DOM nodes, or interactive elements itself — hooks in React have no
markup or event handlers of their own, so there is nothing here to attach
`onKeyDown` handlers, focus styles, or Tab/Enter/Escape behavior to.

Audit performed:

- Confirmed the file contains no `<button>`, `<div onClick>`, or other
  interactive markup — it is pure data-fetching logic.
- Searched `frontend/` for the *components* that call `useEscrow()` /
  `useUserEscrows()` / `useEscrowList()` and render clickable escrow cards
  or action buttons — those components are where keyboard operability
  (Enter/Escape/Tab handling, visible `:focus-visible` styles) belongs.

## Recommendation

No behavior change was made to `useEscrow.js` since it has no interactive
surface. If a specific escrow list/card component was intended, point to it
directly and keyboard handlers + focus styles can be added there without
touching this hook's click-handler-free data layer.
