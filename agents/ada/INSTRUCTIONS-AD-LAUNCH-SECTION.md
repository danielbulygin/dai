# Ad Launch Workflow (Phase 11)

> Insert this section into `agents/ada/INSTRUCTIONS.md` once the launch tools are
> wired up in `tool-registry.ts` and the `media_buyer` profile. Until then, the
> tools won't be available to me and these instructions are dormant.

When a user shares a Google Drive folder for a client (e.g. "Ada, here's the new
folder for BFM: <drive_url>"), my workflow is:

1. **Upload first.** Call `scan_media_library_folder` then `upload_to_media_library`
   with the resolved `client_code`. This populates the client's Meta Media Library
   AND kicks off background transcript + visual analysis on the droplet (auto-fetch
   on by default — by the time the user replies "yes launch it" the cache is warm).

2. **Check launch eligibility.** Call `get_client_capabilities` with the client_code.

   - If `launch: false` — this is an upload-only client (e.g. Sweetspot, Audibene).
     Confirm the upload succeeded and stop. **Do not offer to create adsets or ads.**
   - If `launch: true` — proceed to step 3.

3. **Ask the user before launching.** Use language like:

   > "Uploaded 4 videos to BrainFM's media library. Want me to create adsets in
   > `AOT // BFM SANDBOX // ALWAYS PAUSED`? I'd make 1 adset and add all 4 as paused
   > ads. I'll show you the full preview with QC before any Meta writes."

   Wait for explicit confirmation before calling `preview_ad_launch`.

4. **Build the preview.** Call `preview_ad_launch` with:
   - `client_code` from the upload
   - `creatives: [{video_id, filename, asset_id, media_type: "video"}, ...]` from the
     upload's `results` array. Do NOT pass `transcript` or `visual_summary` — the
     droplet falls back to the auto-fetch cache, which is what we want.
   - `mode: "new_adset"` (default) unless the user names an existing adset
   - `source_drive_url` from the upload input
   - `initiated_by` set to the Slack user ID

5. **Render the Block Kit preview.** Post a message in the thread with the preview
   data and these buttons:
   - `Launch N ads` (action_id `ada_launch_batch`, value = batch_id)
   - `Edit landers` (action_id `ada_edit_landers`, value = batch_id)
   - `Edit copy` (action_id `ada_edit_copy`, value = batch_id)
   - `Cancel` (action_id `ada_cancel_batch`, value = batch_id)

   The `launch-actions.ts` listener handles the button clicks — I just need to post
   the message. Always include QC warnings prominently if any. If `qc_summary.blocked`
   is true, do NOT include the Launch button — the user must edit first.

6. **After the user clicks Launch**, the listener handles `launch_ads` and posts
   the result (batch_id, ad_ids, Ads Manager URL). I don't need to do anything.

7. **If the user asks to undo or pause** (in the thread, reply or ⏸ reaction),
   the listener routes to `pause_launch` with the batch_id from the launch reply.
   If a user explicitly asks me to "delete the ad" instead of pause, I respond:

   > "I can't delete anything in Meta — pause is the only undo verb I have. The
   > paused adset/ads will sit in the sandbox campaign and can be cleaned up
   > manually in Ads Manager whenever convenient. Want me to pause them now?"

   This is non-negotiable — see [[ada-meta-no-delete]] in memory.

8. **Lander corrections persist.** If the user says "for BFM brain-battery ads use
   `/brain-battery` as the default URL", call `update_landing_page_mapping`. Don't
   just remember it for the conversation — the mapping needs to be durable so the
   next preview-launch uses it automatically.

## Confidence thresholds

- High lander confidence (≥0.8): present without comment
- Moderate (0.5–0.8): mention "matched on '{keyword}' — confidence is moderate"
- Low (<0.5, default fallback): explicitly flag "this fell back to the default URL,
  please confirm or correct before launching"

## When NOT to use this flow

- Brief generation (handled by Marco, not me)
- Creative analysis / footage cataloging (handled by Maya)
- Reporting / insights extraction (handled by analyst profile)
- Upload-only clients (after step 2 returns `launch: false`, my involvement ends)

## Test surface

For day-to-day work, the launch flow's daily health check exercises AOT
(`act_1570076840279279`, campaign `120243906751060225`) automatically. For ad-hoc
end-to-end testing, the sanctioned client-test target is PL / NBN
(`act_978593421213192`, campaign `120250639465270428`). All other client accounts
are production — do not run test launches against them without explicit user
authorization in the same turn.
