# Milestone 4b — Wallet-to-Wallet Transfers (Design)

**Date:** 2026-07-22
**Status:** approved, ready for planning
**Implements:** the second phase of the M4 family.

---

## 0. Milestone-family context

M4 was split into phases ordered by dependency:

| Phase | Scope | Status |
|---|---|---|
| **4a** | Core wallet + ledger; deposit/withdrawal requests; finance settlement under row locks | ✅ complete (`a7b0096`→`aad2cd0`) |
| **4b** | **Wallet-to-wallet transfers, same currency** | ← this spec |
| **4c** | Currency conversion (a transfer with a rate) | later |
| *KYC* | `unverified → pending → verified`, gating the money routes | optional, deferred |

**KYC was resequenced out of this slot on 2026-07-22.** Its original justification — "it reuses the request→review→approve shape you just built" — argues that it is *easy*, not that it is *urgent*, making it the weakest slot on learning-per-hour. Nothing depends on it: KYC only *adds a gate* in front of deposit/withdrawal, so reordering costs no rework. Transfers moved up because they are the first place the fixed lock order stops being theoretical.

---

## 1. Goal

A customer moves money from a wallet they own into any other wallet in the same currency. The transfer settles immediately and atomically: both balances change, two linked ledger rows are written, and concurrent transfers can neither deadlock nor overdraw.

---

## 2. Scope

**In:**
- `POST /wallets/:id/transfers` — instant, same-currency, customer-initiated.
- Two linked `Transaction` rows per transfer, sharing a `transferId`.
- Deterministic two-wallet locking.

**Out:** cross-currency (4c), reversals/disputes, recipient lookup by email, transfer limits, fraud rules, threshold-based approval, staff-initiated transfers.

---

## 3. Design decisions

### 3.1 Instant settlement, not pending → approval

*Chosen with the user.* Real e-wallets settle customer-to-customer transfers instantly; the funds are already inside the system and were verified on the way in, so a reviewer has nothing to check. Approval is reserved for money **entering or leaving** the system.

Rejected: **approval-required** (mostly a repeat of M4a's machinery, and unrealistic); **threshold-based** (instant below a limit, approval above — the most realistic for a regulated operator and a good later enhancement, but it means building both paths at once).

### 3.2 Two linked ledger rows, not one row with a counterparty

*Chosen with the user.* A `transfer_out` row on the sender's wallet, a `transfer_in` row on the receiver's, both stamped with a shared `transferId`.

This preserves M4a's core property: **every `Transaction` row belongs to exactly one wallet**, so each wallet's `balanceBefore`/`balanceAfter` chain stays unbroken and its balance remains recomputable from its own ledger.

```
sender   wallet A:  transfer_out  amt=2000  before=5000  after=3000  transferId=T1
receiver wallet B:  transfer_in   amt=2000  before=100   after=2100  transferId=T1
```

A single row is physically incapable of recording before/after for two wallets — the receiver's balance would change with no chain entry, breaking recomputability. Rejected on that ground.

### 3.3 Destination identified by wallet id

*Chosen with the user.* `{ toWalletId }`, not `{ toEmail }`.

The system is deliberately **generic multi-wallet**, so a user may own several wallets and an email cannot say which to credit. Resolving that needs a primary-wallet flag or a saved-payee feature; an email lookup endpoint also introduces an account-enumeration channel needing rate limiting and careful error design. Both are separate problems. Using an id keeps this milestone on the actual hard part — two-wallet locking. Accepted cost: unrealistic UX (a real client would resolve a contact to an id first).

### 3.4 No `Transfer` table

`transferId String?` and `counterpartyWalletId String?` on `Transaction`, rather than a normalized `Transfer` model with FKs.

Consistent with the precedent set in M4a, where `requestedBy`/`reviewedBy` are plain id strings because nothing queries across them. A shared `transferId` provides the same linkage at zero schema cost. If a later phase needs transfer-level metadata (reversals, disputes), promoting it to a table is a small migration.

---

## 4. Data model

Changes to the existing `Transaction` model — no new tables:

| Field | Type | Notes |
|---|---|---|
| `type` | `String` | gains two values: `transfer_out`, `transfer_in` |
| `transferId` | `String?` | shared by the pair; `null` for all non-transfer rows; **indexed** |
| `counterpartyWalletId` | `String?` | the other wallet in the pair; makes a row self-describing without a second query |

Both transfer rows are written `status: 'approved'` with `balanceBefore`/`balanceAfter` populated and `reviewedAt` stamped — they are settled at creation, like `adjustment` rows. `requestedBy` and `reviewedBy` are both the **sender's** id on both rows: the sender initiated the movement, and the receiver did not review anything.

The optional `note` is copied to **both** rows, so each party sees the same reason in their own history. `counterpartyWalletId` points the opposite way on each row — the sender's row names the destination, the receiver's names the source.

`Wallet` is unchanged.

---

## 5. Concurrency

One `prisma.$transaction(async (tx) => …)`. **Both wallet rows are locked before anything is read**, in an order determined by sorting the ids:

```typescript
const [first, second] = [fromWalletId, toWalletId].sort();
await tx.$queryRaw`SELECT id FROM "Wallet" WHERE id = ${first} FOR UPDATE`;
await tx.$queryRaw`SELECT id FROM "Wallet" WHERE id = ${second} FOR UPDATE`;
```

**Sorting is the whole mechanism, and the order must not be sender-then-receiver.** If it were, Alice→Bob and Bob→Alice running concurrently would each hold what the other needs:

```
Alice→Bob:  locks A ✓  … waits for B
Bob→Alice:  locks B ✓  … waits for A     → deadlock; Postgres kills a victim (40P01)
```

Sorted, both lock the same wallet first regardless of direction, so one simply queues. Deadlock becomes impossible rather than unlikely.

Two implementation constraints:

- **Two separate statements**, not `WHERE id IN (a, b) ORDER BY id FOR UPDATE`. Postgres locks rows in the order the plan yields them, which is not guaranteed to follow an `ORDER BY`. Sequential statements are provably ordered.
- **Self-transfer to the same wallet is rejected (`400`) before the transaction opens.** Locking one row twice is meaningless and the arithmetic would be nonsense.

Everything mutable — both balances, both currencies, the destination's existence — is read **under** the locks. Only immutable or caller-supplied data is validated outside.

---

## 6. Invariants

| Invariant | Enforced by | Failure |
|---|---|---|
| Sender's balance never goes negative | `from.balance < amount` under the lock | `400` |
| The pair is atomic — never one row without the other | both writes inside one `$transaction` | rollback |
| Both wallets share a currency | `from.currency !== to.currency` under the lock | `400` |

**M4a's settle-at-most-once (`409`) invariant does not apply here.** There is no shared pending row to settle twice; each transfer is an independent event. Two concurrent transfers draining one wallet is not "settling one thing twice" — it is "spending money that isn't there", so the never-negative invariant catches it with a `400`. The two invariants being independent is exactly why this case behaves differently.

---

## 7. Authorization

Asymmetric, and deliberately so:

| Wallet | Check | Reasoning |
|---|---|---|
| **Source** | ownership (`getOwnedWallet`) | you may only send your own money |
| **Destination** | existence only — **no ownership check** | it belongs to someone else; that is what a transfer is |

**No new permission.** A customer moving their own money needs no privilege beyond owning the source wallet, which is why the seed carries no `transfer.*` code and needs none. This is ownership-gating only — the mechanism introduced in M4a.

**Response privacy rule:** the endpoint returns **only the sender's `transfer_out` row**. Returning the receiver's row would disclose their `balanceBefore`/`balanceAfter` — their account balance — to anyone able to send them money. You may send someone funds; you may not learn what they hold. Same principle as `toSafeUser`: control what leaves in the response, not only what is stored.

---

## 8. Endpoint and error semantics

`POST /wallets/:id/transfers` → `201`, body `{ toWalletId, amount, note? }`.

`201` is correct here (unlike the settle routes, corrected to `200` in M4a): a transfer genuinely creates new ledger rows.

| Condition | Code | Where checked |
|---|---|---|
| `amount` not a positive integer | `400` | DTO (`@IsInt`, `@Min(1)`) |
| `toWalletId` malformed | `400` | DTO (`@IsUUID`) |
| `toWalletId === :id` | `400` | before the transaction |
| source wallet not found | `404` | before the transaction |
| source wallet not owned | `403` | before the transaction |
| destination wallet not found | `404` | **under the lock** |
| currencies differ | `400` | **under the lock** |
| insufficient funds | `400` | **under the lock** |

Existing reads need no changes: `GET /wallets/:id/transactions` already returns whichever side of the pair belongs to the caller's wallet.

**Deliberate non-check:** a transfer to a wallet whose owner is `suspended` is **allowed**. Refusing it would leak the recipient's account status to the sender, and a frozen account still holds inbound funds rather than bouncing them — which matches how real platforms behave. Noted, not built.

---

## 9. Testing

**Unit (~8, mocked `tx` as in M4a):** happy path writes both rows with a shared `transferId` and correct chains; debits sender and credits receiver by the same amount; rejects self-transfer; rejects currency mismatch; rejects insufficient funds; rejects an unowned source (`403`) before any write; `404` on a missing source; `404` on a missing destination.

**Live proofs on real Postgres** (the parts unit tests structurally cannot cover, since the mocked `$queryRaw` is a no-op):

1. **No deadlock.** Alice→Bob and Bob→Alice fired simultaneously, looped ~20 times to widen the race window. Expected: every request `201`, no `500`, no deadlock in the Postgres log. The buggy sender-first ordering would surface as `40P01 deadlock_detected` → `500`.
2. **No double-spend.** One wallet holding 5000; two concurrent transfers of 5000 to different recipients. Expected: exactly one `201` and one `400`, final balance `0` — never `-5000`.

**Known gap, carried from M4a:** these are manual curl demos, not automated tests. `npm test` mocks `$queryRaw` as a no-op, so it would not catch removal of the `FOR UPDATE` statements or a change to the lock ordering. An integration harness against a dedicated test database remains the outstanding follow-up.

---

## 10. Non-goals

- **Cross-currency transfers** — M4c. This milestone rejects them with `400` rather than silently converting at 1:1.
- **Reversals and disputes** — the ledger is append-only; a reversal is a new opposing pair, which needs its own design (who may authorize it, and against which original).
- **Recipient lookup by email** — needs a primary-wallet rule plus enumeration hardening.
- **Transfer limits, velocity checks, fraud rules** — real risk controls, but a separate subsystem.
- **Threshold-based approval** — good later enhancement; would double this milestone's scope.
- **Blocking transfers to suspended recipients** — see §8.
- **Pagination on wallet history** — still unbounded, carried over from M4a.

---

## 11. Task breakdown (for the implementation plan)

1. **Schema + migration** — `transferId`, `counterpartyWalletId`, index on `transferId`. No new tables.
2. **`WalletsService.transfer` — TDD** — sorted two-wallet locking, all validation, both ledger rows written atomically (~8 tests).
3. **DTO + route + live proofs** — `TransferDto`, `POST /wallets/:id/transfers`, then the no-deadlock and no-double-spend demos.
4. **Review, learning notes, memory** — boundary check, fresh-eyes diff review, notes on deterministic lock ordering and why this race yields `400` rather than `409`.

---

## 12. Self-review checklist (run before starting M4c)

- [ ] No `prisma.wallet` / `prisma.transaction` access outside `WalletsModule`.
- [ ] Both wallets are locked, in sorted-id order, before any balance is read.
- [ ] The response never discloses the recipient's balance.
- [ ] Both ledger rows always share a `transferId` and are written in one transaction.
- [ ] Each wallet's `balanceBefore`/`balanceAfter` chain remains unbroken after a transfer.
- [ ] A cross-currency transfer is refused, not silently converted.
- [ ] **You can explain:** why sorting the ids prevents deadlock where sender-first does not; why this race produces `400` and not `409`; why the destination is not ownership-checked; and why the receiver's row is withheld from the response.
