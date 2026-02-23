// Supabase Edge Function: sync-fireflies
// Runs on a 15-minute cron to sync new Fireflies meetings into DAI Supabase.
//
// Deploy:
//   supabase functions deploy sync-fireflies
// Schedule (run in SQL Editor):
//   SELECT cron.schedule('sync-fireflies', '*/15 * * * *',
//     $$SELECT net.http_post(
//       url := '<SUPABASE_URL>/functions/v1/sync-fireflies',
//       headers := '{"Authorization": "Bearer <ANON_KEY>"}'::jsonb
//     )$$
//   );

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const FIREFLIES_API = "https://api.fireflies.ai/graphql";

interface FirefliesSentence {
  index: number;
  speaker_name: string;
  text: string;
  raw_text: string;
  start_time: number;
  end_time: number;
}

interface FirefliesMeetingDetail {
  id: string;
  title: string;
  date: string;
  duration: number;
  organizer_email: string;
  participants: string[];
  speakers: Array<{ name: string }>;
  summary: {
    keywords: string[];
    action_items: string;
    overview: string;
    shorthand_bullet: string;
    gist: string;
    short_summary: string;
  };
  sentences: FirefliesSentence[];
}

async function firefliesQuery(
  apiKey: string,
  query: string,
  variables?: Record<string, unknown>,
) {
  const res = await fetch(FIREFLIES_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    throw new Error(`Fireflies API ${res.status}: ${await res.text()}`);
  }

  const json = await res.json();
  if (json.errors?.length) {
    throw new Error(`Fireflies GraphQL: ${json.errors[0].message}`);
  }
  return json.data;
}

Deno.serve(async (req) => {
  try {
    const firefliesKey = Deno.env.get("FIREFLIES_API_KEY");
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!firefliesKey || !supabaseUrl || !supabaseKey) {
      return new Response(
        JSON.stringify({ error: "Missing required env vars" }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    // 1. Read sync state
    const { data: syncState } = await supabase
      .from("sync_state")
      .select("*")
      .eq("id", 1)
      .single();

    // Default to 24h ago if never synced
    const since = syncState?.last_synced_at
      ? new Date(syncState.last_synced_at)
      : new Date(Date.now() - 24 * 60 * 60 * 1000);

    // 2. List recent meetings from Fireflies
    const data = await firefliesQuery(
      firefliesKey,
      `query($limit: Int, $skip: Int) {
        transcripts(limit: $limit, skip: $skip) {
          id
          title
          date
        }
      }`,
      { limit: 50, skip: 0 },
    );

    const transcripts = (data?.transcripts ?? []) as Array<{
      id: string;
      title: string;
      date: string;
    }>;

    // Filter to meetings after our last sync
    const sinceTs = since.getTime();
    const newMeetings = transcripts.filter(
      (t) => parseInt(t.date) > sinceTs,
    );

    if (newMeetings.length === 0) {
      await supabase
        .from("sync_state")
        .update({ last_sync_run: new Date().toISOString(), last_error: null })
        .eq("id", 1);

      return new Response(
        JSON.stringify({ synced: 0, message: "No new meetings" }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    // 3. Deduplicate against existing
    const { data: existing } = await supabase
      .from("meetings")
      .select("id");
    const existingIds = new Set(
      (existing ?? []).map((r: { id: string }) => r.id),
    );
    const toSync = newMeetings.filter((m) => !existingIds.has(m.id));

    let synced = 0;
    let lastError: string | null = null;

    // 4. Fetch and upsert each new meeting
    for (const m of toSync) {
      try {
        const detail = (await firefliesQuery(
          firefliesKey,
          `query($id: String!) {
            transcript(id: $id) {
              id title date duration organizer_email participants
              speakers { name }
              summary { keywords action_items overview shorthand_bullet gist short_summary }
              sentences { index speaker_name text raw_text start_time end_time }
            }
          }`,
          { id: m.id },
        )) as { transcript: FirefliesMeetingDetail };

        const meeting = detail.transcript;
        const speakers = meeting.speakers?.map((s) => s.name) ?? [];
        const summary = meeting.summary ?? {};
        const fullTranscript = (meeting.sentences ?? [])
          .map((s) => `${s.speaker_name}: ${s.text}`)
          .join("\n");

        await supabase.from("meetings").upsert({
          id: meeting.id,
          title: meeting.title,
          date: meeting.date
            ? new Date(parseInt(meeting.date)).toISOString()
            : null,
          duration: meeting.duration,
          organizer_email: meeting.organizer_email,
          speakers,
          participant_emails: meeting.participants ?? [],
          short_summary: summary.short_summary ?? null,
          keywords: summary.keywords ?? [],
          action_items: summary.action_items ?? null,
          overview: summary.overview ?? null,
          notes: summary.shorthand_bullet ?? null,
          gist: summary.gist ?? null,
          full_transcript: fullTranscript || null,
        });

        // Delete + reinsert sentences
        await supabase
          .from("meeting_sentences")
          .delete()
          .eq("meeting_id", meeting.id);

        const sentences = (meeting.sentences ?? []).map((s) => ({
          meeting_id: meeting.id,
          sentence_index: s.index,
          speaker_name: s.speaker_name,
          text: s.text,
          raw_text: s.raw_text,
          start_time: s.start_time,
          end_time: s.end_time,
        }));

        // Insert in chunks
        for (let i = 0; i < sentences.length; i += 100) {
          await supabase
            .from("meeting_sentences")
            .insert(sentences.slice(i, i + 100));
        }

        synced++;

        // Rate limit
        await new Promise((r) => setTimeout(r, 1200));
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        console.error(`Error syncing ${m.id}: ${lastError}`);
      }
    }

    // 5. Update sync state
    await supabase
      .from("sync_state")
      .update({
        last_synced_at: new Date().toISOString(),
        last_sync_run: new Date().toISOString(),
        total_synced: (syncState?.total_synced ?? 0) + synced,
        last_error: lastError,
      })
      .eq("id", 1);

    return new Response(
      JSON.stringify({
        synced,
        errors: lastError ? 1 : 0,
        total: (syncState?.total_synced ?? 0) + synced,
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("sync-fireflies error:", msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
