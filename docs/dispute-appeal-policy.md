# Dispute Appeal Policy

Appeals provide a bounded path to challenge a dispute resolution when new
evidence or procedural errors are identified.

## Eligibility

A dispute may be appealed when:

- the dispute was resolved within the appealable window
- the appellant is a participant, assigned arbiter, or authorized admin
- the appeal includes new evidence or a concrete process objection
- the dispute has not already exhausted its appeal limit

## Appeal Window

The appeal deadline starts when the dispute resolution is recorded. Clients
should show the exact deadline, the user's eligibility, and the consequences of
missing the window.

## Required Evidence

- appeal reason
- evidence references or IPFS CIDs
- original dispute id
- requested outcome
- appellant signature or authenticated user id

## After the Deadline

Once the deadline passes:

- new appeal requests are rejected
- payout execution can proceed
- stale appeal drafts should become read-only
- support can still record notes but cannot reopen the appeal without a formal
  admin override

## Admin Overrides

Overrides require an incident or compliance reason, reviewer identity, previous
state, new state, and correlation id.
