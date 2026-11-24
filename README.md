# wf-hostplus-exporter
Custom Chrome extension that fetches Hostplus transaction history via Link Group's `/search` API and exports it as Wealthfolio-compatible CSV, raw combined JSON, or both (CSV + JSON backup).

## Chrome Extension Features
1. **Website login launcher:** Button to navigate to the Hostplus portal (`https://mol.hostplus.com.au/`).
2. **Date range selector:** Auto-populated based on:
   - **From date:** 7 days prior to the last export for the active member, or `YYYY-01-01` for `currentYear - 5` on first run.
   - **To date:** Today's date (`YYYY-MM-DD`).
3. **Output format selector:** Supports **Both (CSV + JSON Backup)**, **CSV for Wealthfolio (.csv)**, or **JSON Backup (.json)**.
   - **JSON content:** Combined `items`, `totalCount`, and `fetchedPages` in a single JSON file.
   - **CSV content:** Transformed according to the rules below.
   - **Filename format:** `[export date]-Hostplus-[member ID]-transactions-[from]-[to].[json|csv]` using compact `YYYYMMDD` dates.
4. **Extract launcher:** Button to fetch transactions, generate download(s), update per-member last export metadata, and display an export summary (saved files, date range, unique items and pages fetched, CSV row count, contribution and fee match counts, and any unhandled transaction types).
5. **Traffic sniffer:** Sniffs Link Group `/members/(memberId)/search` requests in the `MAIN` world to capture `memberId`, request URL/method, and required headers (`ocp-apim-subscription-key`, `authorization`).
6. **Multi-member support:** Remembers the last export date per `memberId` in local extension storage.

## Transaction History API & Pagination
1. **HTTP method:** `GET`.
2. **Endpoint:** `https://api-prd1.linkgroup.com/rss/mcx/web/superannuation/plans/HC/members/{memberId}/search`.
3. **Pagination behavior:** `Offset` acts as a record/item index rather than a page number. Requests use `Size=100` (with a `MAX_PAGES` safety cap) and advance `offset += items.length` while deduplicating by `transactionId`, stopping early once `mergedItems.length >= totalCount` (since `totalCount` reflects the full search date range) or no new items are added.
4. **Required headers:** `ocp-apim-subscription-key`, `authorization`.
5. **Response format:** JSON (`items`, `totalCount`, etc.).

## Transaction Transformation Rules (CSV)
1. **CSV columns** (`description` column omitted; linked rows from a single item share the same `transactionId` and `transactionType`):
   - `date` -> Paired ISO timestamp (see timing rules below).
   - `account` -> `[memberId]`.
   - `activityType` -> `DEPOSIT`, `BUY`, `SELL`, or `FEE`.
   - `symbol` -> Active `investmentOptions[].id` for unit rows (`BUY`/`SELL`); empty for cash/fee rows (`DEPOSIT`/`FEE`).
   - `quantity` -> `Math.abs(investmentOptions[].units)` for unit rows (`BUY`/`SELL`); empty for `DEPOSIT`/`FEE`.
   - `unitPrice` -> `Math.abs(investmentOptions[].unitPrice)` for unit rows (`BUY`/`SELL`); empty for `DEPOSIT`/`FEE`.
   - `amount` -> `Math.abs(amount)` (account cash amount for `DEPOSIT`/`FEE`, or option/allocation amount for `BUY`/`SELL`).
   - `currency` -> `nativeCurrency` (defaults to `AUD`).
   - `comment` -> `"{description}" ref:"{transactionId}"`.
   - `transactionId` -> `item.transactionId` (shared across linked rows from the same item).
   - `transactionType` -> `item.transactionType` (shared across linked rows from the same item).
2. **Transaction kind resolution (strict mapping, no heuristic/description fee guessing):**
   - **Contributions IN:** `transactionGroupCode === "*TFI"`, `transactionType.startsWith("*TFI")`, or explicit `*TFI-MEMBER`, `*TFI-SPOUSE`, `*TFI-ROLLOVER` -> emits **1 `DEPOSIT`** row for the account cash contribution followed by **1 or more `BUY`** rows for active `investmentOptions` allocations.
   - **Admin fees:** Explicit `transactionType === "*FEE-ADMIN"` -> emits **1 or more `SELL`** rows for active `investmentOptions` unit redemptions first, followed by **1 `FEE`** row for the fee cash amount.
   - **Unhandled types:** Any unmapped `transactionType` / `transactionGroupCode` is skipped from CSV output and reported in the popup summary for manual review.

## Notes & Timing Rules
1. **Contribution timing (`DEPOSIT` -> `BUY`):** `DEPOSIT` occurs 1 minute earlier than `BUY` so cash is available before buying units. If the source timestamp is midnight (`00:00:00 UTC`), `DEPOSIT` stays at `00:00:00` and `BUY` shifts `+1 minute` (`00:01:00`) so both remain on the same calendar day.
2. **Fee timing (`SELL` -> `FEE`):** Timed in reverse to avoid negative cash balance warnings in Wealthfolio—`SELL` occurs 1 minute earlier (`earlierTimeStr`) to realize cash, and `FEE` occurs 1 minute later (`laterTimeStr`), keeping midnight items on the same day (`00:00:00` for `SELL`, `00:01:00` for `FEE`).
3. **Existing balance switches:** Hostplus does not emit switch transactions in this feed, so manual `BUY`/`SELL` entries are still required for switches.