# ADR-0011: No recorded contract for the tern CLI or the fake Tern

Status: Accepted

## Decision

The tests have no recorded contract for the `tern` CLI, and no type check of the fake Tern in `test/luau/stub.luau` against `types/tern.d.luau`. They also have no guard for the three environment lists that isolate the tests, and no tests for `scripts/ci-summary.ts`.

## Why

The test-seam scout of #80 found these near misses and rated them Speculative. None comes with a change to a module (#80, Out of scope). The contract fixtures in `test/fixtures/contract/` cover the seam between the plugin and `tern-wt`, where the two sides of this repository meet. docs/README.md lists the behaviors of Tern that the fake copies and that no test on a live Tern examined.

## Reopen when

- A Tern update breaks the plugin, and the fake Tern hid the break.
- A pass changes a module at the seam with Tern, and the change needs one of these guards.
