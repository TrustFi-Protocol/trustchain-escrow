# Runtime Config Checksum

Runtime config checksums let operators compare backend instances without
exposing secrets. Checksums should include safe config values that affect
behavior and exclude credentials, private keys, tokens, and raw endpoint secrets.

## Included Values

- feature flag versions
- enabled worker names
- public network id
- contract addresses
- queue concurrency settings
- retry policy numbers
- cache TTLs
- webhook timeout and retry windows

## Excluded Values

- private keys and mnemonics
- database URLs
- API tokens
- webhook signing secrets
- provider credentials
- raw DSNs with passwords

## Operator Workflow

1. Fetch the checksum from each backend instance.
2. Compare checksum, config version, and generated timestamp.
3. If checksums differ, request the redacted config diff from the instance.
4. Confirm the diff matches a planned rollout or rollback.
5. Alert when unexpected drift persists longer than one deploy window.

## Drift Response

- Do not restart all instances at once.
- Remove one drifting instance from rotation if user-facing behavior differs.
- Compare deploy sha, environment name, and migration version.
- Record the checksum pair in the incident or change ticket.
