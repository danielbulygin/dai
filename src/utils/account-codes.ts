/**
 * Account code normalization — shared between the bulk extraction script
 * and the live monitoring pipeline.
 *
 * LLMs extract account names phonetically from audio transcripts, producing
 * variant spellings. This map normalizes them to canonical lowercase codes
 * that match BMAD Supabase `clients.code` (lowercased).
 */

export const ACCOUNT_CODE_ALIASES: Record<string, string> = {
  // Audibene (BMAD: AB)
  audibena: "audibene",
  audibina: "audibene",
  audibana: "audibene",
  audibane: "audibene",
  audiben: "audibene",
  audi_bayonet: "audibene",
  // Laori (BMAD: LA)
  lowry: "laori",
  laurie: "laori",
  lori: "laori",
  lauri: "laori",
  loris: "laori",
  lahori: "laori",
  lowe: "laori",
  lower: "laori",
  lowri: "laori",
  // URVI (BMAD: URV)
  irvy: "urvi",
  irvie: "urvi",
  irvi: "urvi",
  orvi: "urvi",
  // Teethlovers (BMAD: TL)
  tea_lovers: "teethlovers",
  teeth_lovers: "teethlovers",
  tape_lovers: "teethlovers",
  loli_lovers: "teethlovers",
  luke_teeth: "teethlovers",
  // Vi Lifestyle (BMAD: VL)
  v_lifestyle: "vi_lifestyle",
  vlifestyle: "vi_lifestyle",
  vlive: "vi_lifestyle",
  v: "vi_lifestyle",
  v_health: "vi_lifestyle",
  // JV Academy (BMAD: JVA)
  jv: "jva",
  jv_academy: "jva",
  my_it_academy: "jva",
  // Strayz (BMAD: meow)
  strays: "strayz",
  stray: "strayz",
  // Ninepine (BMAD: NP)
  nine_pine: "ninepine",
  // Slumber (BMAD: SLB)
  slumber_pod: "slumber",
  slumber_night_lights: "slumber",
  // Press London (BMAD: PL)
  press: "press_london",
  // Nothings Something (BMAD: NOSO)
  nothings_something: "noso",
  // Hausmed (former client, phonetic variants)
  housemade: "hausmed",
  housemate: "hausmed",
  hausmat: "hausmed",
  housemaid: "hausmed",
  house_med_live: "hausmed",
  // Stella = Laori founder, insights belong to Laori
  stella: "laori",
  stella_ecomm: "laori",
  // Tillman = URVI founder, insights belong to URVI
  tillman: "urvi",
  // AOT / Ads on Tap
  aot_academy: "aot_academy",
  online_course: "aot_academy",
  ads_on_tap: "aot_academy",
  adsontap: "aot_academy",
  // Kid Lovers → Teethlovers (phonetic confusion in transcript)
  kid_lovers: "teethlovers",
  // GermaniKüre (German skincare client)
  germanikure: "germanikure",
  germankure: "germanikure",
  germanica: "germanikure",
  germanic: "germanikure",
  germanicure: "germanikure",
  // Lifeseeds (supplement brand)
  lifeseed: "lifeseeds",
  liveseeds: "lifeseeds",
  liveseed: "lifeseeds",
  lifeseats: "lifeseeds",
  live_seeds: "lifeseeds",
  live_sits: "lifeseeds",
  // Sunwarrior (vegan protein)
  sun_warrior: "sunwarrior",
  // Zodiac
  zodiaque: "zodiac",
  // Tebalou (children's products)
  tableau: "tebalou",
  // Pip Decks
  pipdex: "pip_decks",
  piptex: "pip_decks",
  // Power Sprout / Power Spotter (phonetic variants)
  power_spotter: "powersprout",
  powertrain: "powersprout",
  // Prime Routes/Roots
  prime_routes: "prime_roots",
};

/** Normalize an account code to its canonical form */
export function normalizeAccountCode(code: string): string {
  const normalized = code.toLowerCase().replace(/\s+/g, "_").trim();
  return ACCOUNT_CODE_ALIASES[normalized] ?? normalized;
}
