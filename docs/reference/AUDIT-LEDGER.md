# Audit ledger (issue #241)

> **Status:** standing rule for future audits. This document is not a live
> inventory. Closed tracker #139 is historical only.

This document and `scripts/audit-ledger.ts` are the only ledger owner.
Do not add a parallel inventory in `AGENTS.md`.

## Why this document exists

Audit ledgers drift off-by-N when file counts, finding counts, or batch
counts disagree across reports. Two traps cause the drift:

1. **Deterministically-unknown items** — neither confirmed nor refuted —
   are carried forward with no owner.
2. **Single-batch closures** — one pass is cited to close a whole class
   of more than one item.

The 2026-09-13 tracker (#139) reconciled its own scope in issue text.
`OUTSTANDING.md` never landed on `main`. #139 is closed. Do not treat
it as an open deferred set. Do not rewrite or “fix” that closed tracker.
The trap rules below apply to **future** audits.

## Ledger rule

A ledger is valid only when all of these hold:

- Every in-scope path appears **exactly once**.
- The walk count, the inventory count, and the matched count are equal.
- Every `unknown` item names an owner.
- A class with more than one item is not marked `closed` by a single
  batch id.

The checker fails closed. A missing owner, a duplicate path, a missing
path, an extra path, or a single-batch class close is a failed ledger.

## Reconciliation command

Copy and run from the repository root:

```bash
node --experimental-strip-types --no-warnings scripts/audit-ledger.ts tests/fixtures/audit-ledger/inventory.json
```

The command walks `root` from the inventory file with `node:fs` only.
It does not spawn `git`. It does not read `docs/audits/` (that tree is
not on `main`). Output is deterministic JSON: sorted keys, sorted
paths, sorted errors, no timestamps, no absolute paths.

Exit status is `0` when the ledger is valid and `1` when it is not.

To check any other inventory, pass that file as the only argument:

```bash
node --experimental-strip-types --no-warnings scripts/audit-ledger.ts <inventory.json>
```

## Trap 1 — deterministically-unknown

An item that is neither confirmed nor refuted is `unknown`. It must
carry a non-empty `owner` string (a named person, team, or module
owner). A missing or blank owner fails the ledger. Silent
carry-forward is not allowed.

`confirmed` and `refuted` items may omit `owner`.

## Trap 2 — single-batch class close

A **class** is a named group of ledger items (findings, tickets, or
other ids). A class with **one** item may close with one batch id. A
class with **more than one** item cannot be marked `closed` when the
set of distinct `batchIds` has size 1 (or 0). Duplicate batch ids
count as one id. The checker fails closed.

This rule applies to future audits. It does not reconstruct #139
deferred-scope entries. Those entries were never published on `main`
and are not an open set.

## Inventory format

Version `1` JSON. `root` is a directory relative to the inventory
file. Paths are POSIX, relative to `root`, with no `..` segments.

```json
{
  "version": 1,
  "root": "tree",
  "entries": [
    { "path": "alpha.txt", "status": "confirmed" },
    { "path": "nested/beta.txt", "status": "refuted" },
    { "path": "nested/gamma.txt", "status": "unknown", "owner": "audit-ledger" }
  ],
  "classes": [
    {
      "id": "future-multi-item",
      "items": ["finding-a", "finding-b"],
      "status": "open",
      "batchIds": ["batch-example"]
    },
    {
      "id": "future-single-item",
      "items": ["finding-c"],
      "status": "closed",
      "batchIds": ["batch-example"]
    }
  ]
}
```

The checked-in example is `tests/fixtures/audit-ledger/inventory.json`.
`tests/unit/scripts/audit-ledger.test.ts` pins that fixture and the
fail-closed traps.

## Counts

The report prints three path counts. They must be equal:

| Field | Meaning |
|---|---|
| `walked` | Regular files found under `root` |
| `inventory` | `entries.length` |
| `matched` | Paths present in both the walk and the inventory |

Status counts (`confirmed`, `refuted`, `unknown`) and class counts
(`open`, `closed`) must sum to the inventory entry count and the
class list length.

## Historical note — #139

#139 closed on 2026-09-14 as a historical tracker. Its children
(#126–#138, #140–#163, #166–#227) were completed. The unpublished
`docs/audits/2026-09-13/` tree, including `remaining/OUTSTANDING.md`,
is not a source for this rule and must not be imported. Future audits
start a new inventory and run the command above.
