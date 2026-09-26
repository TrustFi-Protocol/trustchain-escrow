# Formal Verification Execution Guide

Formal verification checks should be runnable by contributors before risky
contract changes are merged.

## Prerequisites

- Rust and Soroban toolchain installed.
- Contract dependencies fetched with `cargo fetch`.
- Verification tool installed according to the team-approved version.
- Clean working tree or a dedicated verification branch.

## Commands

Run static checks first:

```sh
cargo fmt --check
cargo clippy --workspace --all-targets
```

Run contract tests before verification when local policy allows:

```sh
cargo test --workspace
```

Run the verification profile for the changed contract module:

```sh
scripts/test-contract.sh
```

## Expected Output

- No arithmetic overflow findings on amount calculations.
- Authorization invariants hold for admin, client, freelancer, and arbiter
  actions.
- Pause and emergency paths do not permit restricted mutations.
- Escrow balance invariants hold after release, cancellation, and dispute
  resolution.

## Reporting

Attach command, tool version, target contract, commit sha, and findings summary
to the PR. Any accepted limitation must include the invariant, reason, and owner.
