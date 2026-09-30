# Changelog

## Unreleased

### Compatibility

- Declare Pi's host-provided `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `typebox` packages as wildcard peer dependencies, matching Pi 0.99.1's extension packaging requirements and resolving its dependency warnings.
- Keep existing dependency versions in the lockfile while updating their declared ranges.
