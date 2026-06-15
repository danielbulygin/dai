-- Ingestion-time privacy classification: same heuristic as the backfill, as a
-- trigger so EVERY sync path (app, edge functions, webhook) classifies new
-- meetings automatically. Never clobbers a manual override.
create or replace function classify_meeting_privacy(
  p_title text, p_speakers text[], p_participants text[]
) returns boolean language plpgsql immutable as $$
declare
  spk text := coalesce(lower(array_to_string(p_speakers,'|')),'');
  ttl text := coalesce(lower(p_title),'');
  team_locals text[];
  domains text[];
  has_anja boolean;
  client_partner boolean;
  team_other boolean;
begin
  select
    coalesce(array_agg(lower(trim(split_part(tok,'@',1)))) filter (where tok ilike '%@adsontap.io'),'{}'),
    coalesce(array_agg(lower(trim(split_part(tok,'@',2)))) filter (where position('@' in tok)>0),'{}')
  into team_locals, domains
  from unnest(coalesce(p_participants,'{}')) e, lateral regexp_split_to_table(e,',') tok;

  has_anja := spk ~ 'anja' or ttl ~ 'anja' or 'anja' = any(team_locals);

  client_partner :=
    (domains && array['audibene.de','brain.fm','forpeople-skincare.de','jvacademy.net','451fc.com','laoridrinks.com','ninepine.com','press-healthfoods.com','slumbercbn.com','teethlovers.de','strayz.de','hausmed.de','ur-vi.com','vi-lifestyle.com','4peoplewhocare.de','gillrath.net','my-growth-squad.com','roasgirls.com','traffic-builders.com','leadgenerationgroup.com','odt.net','famousbrands.de','gamersonly.com'])
    or ttl ~ '(audibene|teethlovers|nine ?pine|laori|jva|jv academy|brainfm|brain\.fm|brain fm|strayz|for ?people|4 ?people|ur[ -]?vi|v[ -]?lifestyle|hausmed|slumber|sweetspot|gamers|growth squad|famous|roasgirls|press london|press health)'
    or spk ~ '(steven roberts|alexandra petrikat|stella strüfing|adam de jong|jack oles|benjamin lau|ben lau|johnny viola|john viola|jva|charlie thoumire|manuel stegmann|imogen shaw|adam stankiewicz|rebecka jonsson|kousha torabi|sydney schuetze|denise schneider|mothes)';

  team_other :=
    (exists (select 1 from unnest(team_locals) l where l not in ('daniel','franzi','anja')))
    or spk ~ '(pavlin|vanessa|straub|loreta|reide|glaira|valido|zyra|bambico|chua|cutts|cyrus|tabor|mikel|karim|jewel|juliette|weiss|gerald ferrer|schlüter|shekhar|singh|blessing|george|galal|seipel|madeline|metzsch|damaris|schönewolf|castello|falconieri|jack|zigmars|valters|marinin|federico|parravicini|christiaan|lucas|luke|evita|nina)'
    or ttl ~ '(\mnina\M|vanessa|loreta|glaira|zyra|\myra\M|cyrus|mikel|jewel|juliette|\mrae\M|michelle|shekhar|blessing|\mamr\M|\mmarc\M|madeline|damaris|manuel|fabio|jack|zigmars|boris|federico|vincent)';

  return has_anja or (not client_partner and not team_other);
end;
$$;

create or replace function trg_classify_meeting_privacy() returns trigger language plpgsql as $$
begin
  -- never override a human decision
  if new.privacy_source is distinct from 'manual' then
    new.is_private := classify_meeting_privacy(new.title, new.speakers, new.participant_emails);
    new.privacy_source := 'heuristic';
  end if;
  return new;
end;
$$;

drop trigger if exists meetings_classify_privacy on meetings;
create trigger meetings_classify_privacy
  before insert or update of title, speakers, participant_emails on meetings
  for each row execute function trg_classify_meeting_privacy();
