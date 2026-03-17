// Supabase Edge Function: fireflies-webhook
// Receives Fireflies webhook POSTs when a transcript is completed,
// fetches the full meeting, upserts it, and deduplicates.
//
// Deploy:
//   supabase functions deploy fireflies-webhook
//
// Set your Fireflies webhook URL to:
//   https://fgwzscafqolpjtmcnxhn.supabase.co/functions/v1/fireflies-webhook
//
// Fireflies sends: { meetingId, eventType, clientReferenceId }

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
  // Only accept POST
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

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

    // Parse webhook payload
    const body = await req.json();
    const { meetingId, eventType } = body as {
      meetingId?: string;
      eventType?: string;
    };

    console.log(`Webhook received: eventType=${eventType}, meetingId=${meetingId}`);

    if (!meetingId) {
      return new Response(
        JSON.stringify({ error: "Missing meetingId" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    // Only process transcription completions
    if (eventType && eventType !== "Transcription completed") {
      return new Response(
        JSON.stringify({ skipped: true, reason: `Ignored event: ${eventType}` }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    // Fetch full meeting details from Fireflies
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
      { id: meetingId },
    )) as { transcript: FirefliesMeetingDetail };

    if (!detail?.transcript) {
      return new Response(
        JSON.stringify({ error: "Meeting not found in Fireflies" }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      );
    }

    const meeting = detail.transcript;
    const speakers = meeting.speakers?.map((s) => s.name) ?? [];
    const summary = meeting.summary ?? {};
    const fullTranscript = (meeting.sentences ?? [])
      .map((s) => `${s.speaker_name}: ${s.text}`)
      .join("\n");

    // Upsert meeting
    const { error: upsertError } = await supabase.from("meetings").upsert({
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

    if (upsertError) {
      throw new Error(`Upsert failed: ${upsertError.message}`);
    }

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

    for (let i = 0; i < sentences.length; i += 100) {
      await supabase
        .from("meeting_sentences")
        .insert(sentences.slice(i, i + 100));
    }

    // Deduplicate (keeps Daniel's copy, deletes inferior duplicates)
    const { data: dedupResult } = await supabase.rpc("dedup_meetings");
    const deduped =
      dedupResult?.[0]?.deleted_count ?? dedupResult?.deleted_count ?? 0;

    if (deduped > 0) {
      console.log(`Dedup removed ${deduped} duplicate(s) after webhook sync`);
    }

    // Update sync state
    await supabase
      .from("sync_state")
      .update({
        last_synced_at: new Date().toISOString(),
        last_sync_run: new Date().toISOString(),
        last_error: null,
      })
      .eq("id", 1);

    console.log(
      `Synced meeting "${meeting.title}" (${meeting.organizer_email}), deduped: ${deduped}`,
    );

    // Fire-and-forget: notify DAI API to trigger pipeline processing
    const daiApiUrl = Deno.env.get("DAI_API_URL");
    const daiApiKey = Deno.env.get("DAI_API_KEY");
    if (daiApiUrl && daiApiKey) {
      fetch(`${daiApiUrl}/api/process-meeting`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": daiApiKey,
        },
        body: JSON.stringify({ meetingId: meeting.id }),
      }).catch((err) =>
        console.error("Failed to notify DAI pipeline:", err),
      );
    }

    return new Response(
      JSON.stringify({
        synced: 1,
        meetingId: meeting.id,
        title: meeting.title,
        organizer: meeting.organizer_email,
        deduped,
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("fireflies-webhook error:", msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
