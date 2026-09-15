# Landing-page recovery

The Tinkers bridge previously timed out a full creative scan and converted it to an empty URL map. The API now serves `creatives?view=destinations` as one live page without media, with effective delivery state and safe continuation. Deploy the API first.

The bridge reads up to 40 pages within 180 seconds, with each request bounded by the remaining budget and 60 seconds. A later failure preserves earlier results and marks coverage partial. The read overlaps daily-result collection. The map retains functional query parameters and excludes unsafe addresses; active-ad qualification requires live effective status.

The tokenless landing check deduplicates URLs, ranks by historical spend, checks at most 50 at concurrency three within 60 seconds, and reports blocked/unreadable checks as inconclusive. Stored or historical values never prove current delivery or savings. Work-log wording carries the same limits. The top resolved page is actually read and its quoted text grounds the message-match section. German offers, buttons and customer-proof labels are recognized.

Local verification: 206 focused tests passed across bridge, page walker, tokenless checks, landing reports, row mirror, section hygiene and seam tests. A real public bestseller-page fetch returned HTTP 200 with 8,519 readable characters. An independent source review found two scope-wording/query-key issues; both were fixed before release. Preserve production's unrelated changes while building and deploying. Release and affected-audit correction receipts are recorded in Tinkers decision 0138's factory folder.

Rollback order: roll back DAI before removing the additive API view. Do not reset shared server work or replace a customer's audit with an incomplete rerun.
