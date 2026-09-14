# Signup audit recovery — 2026-09-14

Daniel authorised fixing the failed Tinkers signup and deploying both services. Source was taken from the running droplet at 87dbf94, not a stale local checkout. Existing unrelated dirty scripts and tests must be preserved.

The failed account act_1081986158860433 returned 300 partial daily rows in 43.743 s for 31 days, 39.012 s for 15 days, and 35.272 s for seven days. A one-day read finished 37 rows in 4.892 s. The original bridge discarded each partial and halved it against a fixed 180-second total.

The additive Tinkers API supplies safe opaque continuation with a 500-row page-size hint. This bridge asks for one page per request, retains successful pages across retries, runs at most three independent windows at once, and bounds each window to 64 pages and the whole pull to 150,000 rows. Each request has a 60-second timeout and at most two attempts. No new credentials, model or billing settings are introduced.

A failed required comparison window stops before synthesis. Older history can stop only after a complete contiguous recent window of at least 91 inclusive days, with actual start/end dates carried into recognition, prompts and wording. Gaps are unknown, never zero; six-month claims and lifetime/launch inference are unavailable for shortened history. Dormant-window checks remain intact. Factual read progress reaches the existing signed update path.

Owner context is read immediately before synthesis, after data and media reads. All current interview fields and customer facts survive the seam. Goals are cited only when explicitly present; absent goals remain absent. Customer statements cannot replace measured account facts or override system instructions.

Verification: 116 focused audit tests pass across bridge, owner context, anchored windows, cold rows and coverage. The untouched source and changed tree produce the same 17 pre-existing TypeScript errors, with none in the changed audit files. The runtime bundle builds with the existing tsup settings and declaration generation disabled; a full clean typecheck is not claimed. Deploy Tinkers first, then this consumer, retaining the prior runtime bundle for rollback. Run three read-only golden questions and rerun only the named failed audit for production acceptance.
