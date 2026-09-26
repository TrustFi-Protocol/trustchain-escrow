# Contract Module Registration Guide

Contract modules should be registered through an explicit lifecycle so upgrades
remain auditable and off-chain services can detect compatibility changes.

## Module Fields

Each registered module should record:

- module id and semantic version
- contract address
- enabled state
- replacement module id when superseded
- required permissions
- ABI or schema version
- registered by, registered at, and activation ledger

## Lifecycle

| State | Description |
| --- | --- |
| `pending` | Registered but not active for routing. |
| `active` | Used by backend, indexer, and frontend clients. |
| `disabled` | No new calls should route to this module. |
| `replaced` | Superseded by another compatible module. |
| `retired` | Historical only; reads may still be supported. |

## Replacement Rules

- Replacement must declare the previous module id.
- ABI-breaking replacements require a compatibility note and client rollout plan.
- Backend indexers must support both modules during migration windows.
- Disabled modules should still expose safe read paths when possible.

## Permissions

Only governance or an authorized admin module should register, replace, disable,
or retire modules. Emergency disable actions must include incident id and reason.

## Upgrade Checklist

- Verify module address and network.
- Compare ABI/schema version with generated client types.
- Confirm indexer event mappings are deployed.
- Update OpenAPI and webhook payload docs when emitted data changes.
- Record rollback instructions before activation.
