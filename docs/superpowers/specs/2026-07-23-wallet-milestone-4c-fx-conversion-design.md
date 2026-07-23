# Milestone 4c — Cross-Currency Transfers / FX Conversion (Design)

**Date:** 2026-07-23
**Status:** approved, ready for planning
**Implements:** the third phase of the M4 family.

---

## 0. Milestone-family context

| Phase | Scope | Status |
|---|---|---|
| **4a** | Core wallet + ledger; deposit/withdrawal requests; finance settlement under row locks | ✅ complete |
| **4b** | Wallet-to-wallet transfers, same currency | ✅ complete |
| **4c** | **Cross-currency transfers (FX conversion)** | ← this spec |
| *KYC* | `unverified → pending → verified`, gating the money routes | optional, deferred |

4b deliberately **rejected** cross-currency transfers with a `400`. 4c lifts exactly that restriction: the same two-wallet locked transfer, but the credited amount differs from the debited amount by an exchange rate fetched from a live external feed.

---

## 1. Goal

A customer moves money from a wallet they own into any other wallet, **including one in a different currency**. When the currencies differ, the system fetches a live mid-market rate, converts the amount, and settles atomically — debiting the source in its currency and crediting the destination in its currency, with the rate recorded on the ledger for audit.

---

## 2. The one big idea

**A cross-currency transfer is an M4b transfer plus a rate.** The two wallets, the sorted-id locking, the linked-pair ledger, the response-privacy rule — all reused unchanged. 4c inserts exactly two things:

1. a **rate lookup** (external, before the lock), and
2. a **conversion** (`credit = round(debit × rate)`, banker's rounding), with the rate stamped on both ledger rows.

Nothing about the concurrency model changes.

---

## 3. Scope

**In:**
- `POST /wallets/:id/transfers` now accepts a destination in a **different** currency and converts.
- Live rate from an external feed (Frankfurter, keyless), behind a swappable `RatesService`.
- `exchangeRate` recorded on both transfer rows.
- Same-currency transfers keep behaving exactly as in 4b (no rate call).

**Out:** fees/spread and a platform treasury account; rate caching/TTL; keyed providers; historical-rate backfill; multi-hop (A→B→C) conversion; letting the caller supply a rate.

---

## 4. Design decisions

### 4.1 Rate source: live external API (Frankfurter), fail-closed

*Chosen with the user.* The rate comes from a real feed — [Frankfurter](https://frankfurter.dev) (`api.frankfurter.app`, ECB reference data), which needs **no API key**. Chosen over a hardcoded table (frozen at deploy, unrealistic), an admin-managed DB table (realistic but not "live"), and a keyed provider (adds secret-management ceremony orthogonal to the FX lesson).

**Fail-closed:** if the rate lookup fails for any reason — network error, non-200, currency pair absent from the response — the transfer fails with `503` and **no money moves**. A money movement never happens at an unknown or guessed rate. Caching / stale-rate fallback is a deliberate non-goal (§10).

A keyed provider or a cache can be swapped in later with **no change to wallet logic**, because the feed lives behind a single seam (§6).

### 4.2 The customer specifies the *source* (debit) amount

*Chosen with the user.* `amount` continues to mean **what leaves the source wallet** — identical to deposits, withdrawals, and same-currency transfers. The credit is the computed side: `credit = round(amount × rate)`. Rejected: specifying the destination (credit) amount, which would flip the meaning of `amount` versus every other route and leave the sender unsure of their exact cost until settlement.

Consequence: the **rounding lands on the credited side**, and is handled per §4.4.

### 4.3 Rate fetched *before* the lock; currency read *before* the lock

The load-bearing architectural rule. The external HTTP call is exactly the "unrelated I/O under a lock" the M4a/M4b work established as forbidden — and worse, it can hang for seconds while holding **two** wallet locks. So the rate is fetched **before** the transaction opens.

That creates an apparent chicken-and-egg: we only know a rate is *needed* once we know both wallets' currencies, and wallet data is normally read under the lock. It is resolved by the **same insight as M4a's `type`**: `currency` is **immutable per wallet** (`// fixed per wallet`, already in the schema), so it is safe to read early. Immutable data (currency) and external I/O (the rate) happen before the lock; only the **mutable balances** are read under it.

Because `amount` is caller-supplied and the rate is fetched pre-lock, the **entire conversion is determined before any lock is taken** — the transaction body does pure arithmetic and two writes.

### 4.4 Banker's rounding via Prisma's `Decimal`

*Chosen with the user.* `credit = amount × rate` almost never lands on a whole minor unit. The credited side is rounded to whole minor units using **round-half-to-even (banker's rounding)** — the accounting/IEEE-754 standard, which cancels the systematic upward bias that round-half-up accumulates over volume.

The rate and the arithmetic use Prisma's `Decimal` type (backed by Decimal.js), which provides **exact** decimal math and a built-in `ROUND_HALF_EVEN` mode — so no hand-rolled rounding helper is needed. JavaScript's native `Math.round` is half-up and is **not** used for the conversion. The tie cases are unit-tested directly (§9).

> Note: with multi-decimal FX rates an exact `.5` minor-unit tie is rare, so the practical difference from half-up is small here. Banker's rounding is chosen as the *correct default*, not for a large numeric effect.

### 4.5 No fee / spread this milestone

*Chosen with the user.* Conversion is at the exact mid-market rate; cross-currency is "free." A spread (rate markup) or an explicit fee row both require a **platform treasury/revenue account** — a genuine separate subsystem (whose account, who withdraws, how it reconciles) that would roughly double this milestone. Deferred to the post-M7 enhancement phase, where an **explicit fee row + revenue account** (auditable) is preferred over a hidden-in-the-rate spread.

---

## 5. Data model

One new field on the existing `Transaction` model — no new tables:

| Field | Type | Notes |
|---|---|---|
| `exchangeRate` | `Decimal?` | the rate applied; `null` for same-currency transfers and all non-transfer rows; stamped on **both** rows of a cross-currency pair so each is self-describing |

The two transfer rows already share a `transferId` and carry each other's `counterpartyWalletId` (from 4b). Each row's `amount` is in its **own** wallet's currency: the `transfer_out` row's amount is the debit (source currency), the `transfer_in` row's amount is the credit (destination currency). `exchangeRate` ties them: `in.amount = round(out.amount × exchangeRate)`.

`Wallet` is unchanged.

---

## 6. New component — `RatesService`

A new **`RatesModule`** exporting **`RatesService`**, imported by `WalletsModule`. It is the **sole owner of the external HTTP call**.

```typescript
// The only place the app talks to an FX provider.
getRate(from: string, to: string): Promise<Decimal>
```

- Calls Frankfurter `GET /latest?base=<from>&symbols=<to>`, returns `rates[to]` as a `Decimal`.
- Any failure (network throw, non-2xx, missing pair) → `ServiceUnavailableException` (`503`).
- `from === to` is never asked of it (the service short-circuits same-currency before calling), but returning `1` is a reasonable guard.

Isolating the provider behind this seam is what makes §4.1's "swap to a keyed provider or add caching later" a one-file change. The HTTP call is wrapped so it is mockable in unit tests.

---

## 7. Transfer flow (extends 4b)

`WalletsService.transfer` is extended. The same route (`POST /wallets/:id/transfers`) and DTO serve both same- and cross-currency; the difference is detected from the wallets' currencies, not from the request.

**Before the transaction opens (no lock held):**
1. Reject self-transfer → `400`.
2. `getOwnedWallet(source)` → ownership (`403` / `404`).
3. Read both wallets for **existence + currency** (immutable). Destination missing → `404`.
4. If `from.currency !== to.currency`: `rate = await rates.getRate(from.currency, to.currency)` (fail → `503`); `credit = decimal(amount).times(rate).toDP(0, ROUND_HALF_EVEN)`. Else: `rate = null`, `credit = amount`.

**Under the locks (4b, unchanged):**
5. Lock both wallets in **sorted-id order** (two `FOR UPDATE` statements); re-read the **mutable balances**.
6. `from.balance < amount` → `400`.
7. `fromAfter = from.balance − amount`; `toAfter = to.balance + credit`.
8. Update both balances; write the linked pair — `transfer_out` (amount = `amount`, `balanceBefore/After` on the source) and `transfer_in` (amount = `credit`, `balanceBefore/After` on the destination) — sharing `transferId`, each stamped with `exchangeRate` (the rate, or `null` when same-currency).
9. Return the sender's `transfer_out` row **only** (response-privacy rule from 4b).

Currency is **not** re-validated under the lock: it is immutable, exactly like `type` in M4a. Only the balances are re-read.

---

## 8. Concurrency

Unchanged from 4b, and that is the point. Both wallets are locked in sorted-id order with two separate `FOR UPDATE` statements, so opposite-direction transfers cannot deadlock; the never-negative invariant (`400`) still catches a concurrent drain, and there is still no shared pending row so `409` does not apply. The only addition — the rate fetch — happens **outside** the transaction, so it adds no I/O under the locks and cannot extend lock hold time.

---

## 9. Testing

**Unit (mocked `tx` as in 4b; mocked `RatesService`):**
- cross-currency: credit = `round(amount × rate)`, both rows stamped with the rate, source debited by `amount` and destination credited by `credit`.
- **banker's-rounding tie cases** asserted directly (e.g. amounts that land on `x.5` minor units round to even).
- same-currency path: `RatesService.getRate` is **not** called; behaves exactly as 4b (`exchangeRate` null).
- provider failure → `503`, no balances updated, no rows written.
- all 4b invariants still hold (ownership `403`, missing `404`, self-transfer `400`, insufficient funds `400`).

**`RatesService` unit:** happy path parses `rates[to]`; network throw / non-200 / missing pair → `503`. `fetch` mocked.

**Live proof on real Postgres + real Frankfurter:**
1. A USD→EUR transfer: show the debit in USD, the converted+banker's-rounded credit in EUR, and `exchangeRate` recorded on both ledger rows (same `transferId`).
2. Provider-unreachable simulation → `503`, balances unchanged.
3. A same-currency transfer still works (regression check that 4b behaviour is intact).

**Known gap (carried):** the live rate makes the happy-path amount non-deterministic (the rate moves), so the curl demo asserts *shape and invariants* (debit exact, credit = round(debit×rate) at the returned rate, rate recorded), not a fixed number. The integration-test harness against a test DB remains the outstanding follow-up.

---

## 10. Non-goals

- **Fees / spread + treasury account** — post-M7; explicit fee row preferred over hidden spread.
- **Rate caching / TTL** — fail-closed instead; caching is a clean later enhancement behind the same seam.
- **Keyed providers / historical rates** — Frankfurter keyless is sufficient for the lesson.
- **Multi-hop conversion** (A→B→C) — single pair only.
- **Caller-supplied rates** — a security anti-pattern; the rate is always server-fetched.
- **Blocking transfers to suspended recipients; pagination** — carried over from 4b.

---

## 11. Task breakdown (for the implementation plan)

1. **Schema + migration** — `exchangeRate Decimal?` on `Transaction`. No new tables.
2. **`RatesModule` / `RatesService` — TDD** — Frankfurter fetch, parse, `503` on any failure; mocked `fetch`.
3. **Extend `WalletsService.transfer` — TDD** — pre-lock currency read + rate fetch + banker's-rounded conversion; rate stamped on both rows; same-currency path unchanged (~5–6 new tests).
4. **Wire + live proofs** — import `RatesModule`, run the USD→EUR live demo, the `503` demo, and the same-currency regression.
5. **Review, learning notes, memory** — boundary check, fresh-eyes diff, notes on: rate-before-the-lock (immutable-currency read), banker's rounding, the swappable provider seam, and fail-closed.

---

## 12. Self-review checklist (run before starting the next milestone)

- [ ] The rate is fetched **before** `$transaction` opens; no external I/O under the locks.
- [ ] Currency is read pre-lock (immutable); only balances are re-read under the lock.
- [ ] Both wallets are still locked in sorted-id order (4b property intact).
- [ ] The credited side uses **round-half-to-even**, and tie cases are unit-tested.
- [ ] `exchangeRate` is recorded on both cross-currency rows; `null` for same-currency.
- [ ] Provider failure yields `503` with **no** balance change and **no** rows written.
- [ ] The response still discloses only the sender's row.
- [ ] `RatesService` is the only place the app makes the FX HTTP call.
- [ ] **You can explain:** why the rate is fetched before the lock (and why reading `currency` early is safe); why banker's rounding; why fail-closed beats a stale-rate fallback for money; and how the provider seam keeps a future swap to one file.
