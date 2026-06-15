-- Meeting privacy: per-meeting is_private flag + team-facing limited view.
-- Applied via Management API 2026-06-15 (recorded here for history).
--
-- Model: master (service_role / secret key) bypasses RLS = sees everything.
--        team (anon / publishable key "team_transcripts") sees only is_private=false.
-- NOTE: Ada/Piper use the service key (bypass RLS), so the Slack-agent path is
--       NOT limited by this migration — that requires the per-requester tool
--       filter + extractor skip in app code (separate change, eval-gated).

alter table meetings add column if not exists is_private boolean not null default false;
alter table meetings add column if not exists privacy_source text;  -- 'heuristic' | 'manual'

-- Heuristic backfill. PRIVATE = Anja present (finance), OR no client/partner AND
-- no teammate other than Dan/Franzi (i.e. Dan-only, Dan+Franzi, or Dan+external).
-- Signals: participant email domains where present, else speaker names + title.
with base as (
  select m.id,
    coalesce(lower(array_to_string(m.speakers,'|')),'') spk,
    coalesce(lower(m.title),'') ttl,
    coalesce((select array_agg(lower(trim(split_part(tok,'@',1))))
       from unnest(m.participant_emails) e, lateral regexp_split_to_table(e,',') tok
       where position('@' in tok)>0 and tok ilike '%@adsontap.io'),'{}') team_locals,
    coalesce((select array_agg(lower(trim(split_part(tok,'@',2))))
       from unnest(m.participant_emails) e, lateral regexp_split_to_table(e,',') tok
       where position('@' in tok)>0),'{}') domains
  from meetings m
),
calc as (
  select id,
    (spk ~ 'anja' or ttl ~ 'anja' or 'anja'=any(team_locals)) has_anja,
    (domains && array['audibene.de','brain.fm','forpeople-skincare.de','jvacademy.net','451fc.com','laoridrinks.com','ninepine.com','press-healthfoods.com','slumbercbn.com','teethlovers.de','strayz.de','hausmed.de','ur-vi.com','vi-lifestyle.com','4peoplewhocare.de','gillrath.net','my-growth-squad.com','roasgirls.com','traffic-builders.com','leadgenerationgroup.com','odt.net','famousbrands.de','gamersonly.com']
     or ttl ~ '(audibene|teethlovers|nine ?pine|laori|jva|jv academy|brainfm|brain\.fm|brain fm|strayz|for ?people|4 ?people|ur[ -]?vi|v[ -]?lifestyle|hausmed|slumber|sweetspot|gamers|growth squad|famous|roasgirls|press london|press health)'
     or spk ~ '(steven roberts|alexandra petrikat|stella strüfing|adam de jong|jack oles|benjamin lau|ben lau|johnny viola|john viola|jva|charlie thoumire|manuel stegmann|imogen shaw|adam stankiewicz|rebecka jonsson|kousha torabi|sydney schuetze|denise schneider|mothes)') client_partner,
    (exists (select 1 from unnest(team_locals) l where l not in ('daniel','franzi','anja'))
     or spk ~ '(pavlin|vanessa|straub|loreta|reide|glaira|valido|zyra|bambico|chua|cutts|cyrus|tabor|mikel|karim|jewel|juliette|weiss|gerald ferrer|schlüter|shekhar|singh|blessing|george|galal|seipel|madeline|metzsch|damaris|schönewolf|castello|falconieri|jack|zigmars|valters|marinin|federico|parravicini|christiaan|lucas|luke|evita|nina)'
     or ttl ~ '(\mnina\M|vanessa|loreta|glaira|zyra|\myra\M|cyrus|mikel|jewel|juliette|\mrae\M|michelle|shekhar|blessing|\mamr\M|\mmarc\M|madeline|damaris|manuel|fabio|jack|zigmars|boris|federico|vincent)') team_other
  from base
)
update meetings m
set is_private = (c.has_anja or (not c.client_partner and not c.team_other)),
    privacy_source = 'heuristic'
from calc c
where c.id = m.id and (m.privacy_source is distinct from 'manual');

-- RLS: team roles see only public; service_role bypasses (Ada/Piper/sync unaffected).
alter table meetings enable row level security;
alter table meeting_sentences enable row level security;

drop policy if exists meetings_team_public_select on meetings;
create policy meetings_team_public_select on meetings
  for select to anon, authenticated using (not is_private);

drop policy if exists sentences_team_public_select on meeting_sentences;
create policy sentences_team_public_select on meeting_sentences
  for select to anon, authenticated
  using (exists (select 1 from meetings mm where mm.id = meeting_sentences.meeting_id and not mm.is_private));

revoke insert, update, delete, truncate on meetings from anon, authenticated;
revoke insert, update, delete, truncate on meeting_sentences from anon, authenticated;
