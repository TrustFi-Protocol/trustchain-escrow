# JSDoc for escrow routes

**Issue:** Route handlers wired up in `backend/api/routes/escrowRoutes.js`
lacked `@param`/`@returns` JSDoc blocks, so IDE hover hints and generated
API docs were incomplete.

## What was implemented

- Extended the existing `@route`/`@desc` comment blocks in
  `backend/api/routes/escrowRoutes.js` with `@param` tags documenting the
  Express `req`/`res` objects and a `@returns` tag describing the JSON
  response for every route registered on the router:
  - `GET /` (list escrows)
  - `GET /search` (v1 search)
  - `POST /broadcast`
  - `GET /:id/milestones`
  - `GET /:id/milestones/:milestoneId`
  - `GET /:id`
- Added a JSDoc block above `export default router` documenting the return
  type of the module.
- No logic, route paths, or middleware ordering were changed — comments
  only.

## Acceptance criteria mapping

- Every exported function/route in the file has a JSDoc block — done for
  all six route registrations plus the default export.
- No behavior change — comments only, verified by diff (no non-comment
  lines touched).
- `npm run lint` should pass with no new warnings since only comments were
  added.
