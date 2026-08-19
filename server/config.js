'use strict';

/**
 * Static configuration: what we watch, and where we read it from.
 *
 * A note on `baseline`: it is a structural watch level for a region — how much
 * standing attention the theater warrants — NOT a claim about today's
 * situation. Live status in the UI is derived from observed reporting volume
 * and tone, never from this number alone.
 */

const PORT = Number(process.env.PORT) || 8080;

// ---------------------------------------------------------------------------
// Watch theaters
// ---------------------------------------------------------------------------
// `countries` are ISO 3166-1 numeric codes as they appear in the world-atlas
// TopoJSON: three digits, zero-padded. A few entries in that dataset are
// disputed territories that carry no ISO id (Kosovo, Somaliland, N. Cyprus);
// those are referenced by name instead, which the map renderer also indexes.

const THEATERS = [
  {
    id: 'ukraine',
    name: 'Ukraine — Russia',
    short: 'Ukraine',
    region: 'Eastern Europe',
    lat: 48.4,
    lon: 35.0,
    countries: ['804', '643'],
    baseline: 5,
    query: 'Ukraine Russia war',
    keywords: ['ukraine', 'russia', 'kyiv', 'kharkiv', 'donetsk', 'crimea', 'zaporizhzhia', 'kherson', 'moscow', 'putin', 'zelensky', 'donbas'],
    context: 'Full-scale interstate war since 2022; largest land conflict in Europe since 1945.',
  },
  {
    id: 'levant',
    name: 'Israel — Gaza — Lebanon',
    short: 'Levant',
    region: 'Middle East',
    lat: 31.8,
    lon: 35.0,
    countries: ['376', '275', '422'],
    baseline: 5,
    query: 'Israel Gaza Lebanon Hezbollah',
    keywords: ['israel', 'gaza', 'hamas', 'hezbollah', 'lebanon', 'idf', 'west bank', 'rafah', 'beirut', 'netanyahu'],
    context: 'Active hostilities and humanitarian emergency with repeated regional escalation.',
  },
  {
    id: 'iran',
    name: 'Iran — Persian Gulf',
    short: 'Iran',
    region: 'Middle East',
    lat: 32.0,
    lon: 53.0,
    countries: ['364'],
    baseline: 4,
    query: 'Iran nuclear strike Persian Gulf',
    keywords: ['iran', 'tehran', 'irgc', 'hormuz', 'khamenei', 'enrichment'],
    context: 'Nuclear program, proxy networks and periodic direct exchanges with Israel and the US.',
  },
  {
    id: 'redsea',
    name: 'Red Sea — Yemen',
    short: 'Red Sea',
    region: 'Middle East',
    lat: 15.0,
    lon: 43.5,
    countries: ['887'],
    baseline: 4,
    query: 'Houthi Red Sea shipping attack',
    keywords: ['houthi', 'red sea', 'yemen', 'sanaa', 'bab el-mandeb', 'aden'],
    context: 'Attacks on commercial shipping disrupting a primary Europe–Asia trade artery.',
  },
  {
    id: 'taiwan',
    name: 'Taiwan Strait',
    short: 'Taiwan',
    region: 'East Asia',
    lat: 24.0,
    lon: 120.5,
    countries: ['158'],
    baseline: 4,
    query: 'Taiwan Strait China military',
    keywords: ['taiwan', 'taipei', 'taiwan strait', 'pla', 'adiz'],
    context: 'Sustained military pressure and airspace incursions; a primary great-power flashpoint.',
  },
  {
    id: 'southchinasea',
    name: 'South China Sea',
    short: 'S. China Sea',
    region: 'East Asia',
    lat: 13.0,
    lon: 114.0,
    countries: ['608', '704'],
    baseline: 3,
    query: 'South China Sea Philippines China vessel',
    keywords: ['south china sea', 'spratly', 'scarborough', 'philippines', 'coast guard', 'second thomas'],
    context: 'Overlapping maritime claims with recurring coast-guard confrontations.',
  },
  {
    id: 'korea',
    name: 'Korean Peninsula',
    short: 'Korea',
    region: 'East Asia',
    lat: 38.3,
    lon: 127.0,
    countries: ['408', '410'],
    baseline: 3,
    query: 'North Korea missile launch',
    keywords: ['north korea', 'pyongyang', 'dprk', 'kim jong', 'missile launch', 'dmz', 'seoul'],
    context: 'Nuclear-armed state with routine missile testing across a fortified armistice line.',
  },
  {
    id: 'kashmir',
    name: 'India — Pakistan',
    short: 'Kashmir',
    region: 'South Asia',
    lat: 34.0,
    lon: 76.0,
    countries: ['356', '586'],
    baseline: 3,
    query: 'India Pakistan Kashmir military',
    keywords: ['kashmir', 'india', 'pakistan', 'line of control', 'islamabad', 'new delhi'],
    context: 'Two nuclear-armed states in a disputed territory with periodic armed exchanges.',
  },
  {
    id: 'sudan',
    name: 'Sudan',
    short: 'Sudan',
    region: 'Africa',
    lat: 15.5,
    lon: 30.5,
    countries: ['729', '728'],
    baseline: 4,
    query: 'Sudan RSF army Darfur',
    keywords: ['sudan', 'rsf', 'khartoum', 'darfur', 'el fasher', 'omdurman'],
    context: 'Civil war between rival military factions driving one of the largest displacement crises.',
  },
  {
    id: 'sahel',
    name: 'Sahel',
    short: 'Sahel',
    region: 'Africa',
    lat: 14.5,
    lon: 0.5,
    countries: ['466', '854', '562'],
    baseline: 4,
    query: 'Sahel Mali Burkina Faso Niger insurgency',
    keywords: ['sahel', 'mali', 'burkina faso', 'niger', 'jnim', 'bamako', 'ouagadougou'],
    context: 'Jihadist insurgency across a belt of post-coup military governments.',
  },
  {
    id: 'drc',
    name: 'DR Congo — Great Lakes',
    short: 'DR Congo',
    region: 'Africa',
    lat: -1.7,
    lon: 29.2,
    countries: ['180', '646'],
    baseline: 4,
    query: 'DR Congo M23 Rwanda Goma',
    keywords: ['congo', 'm23', 'goma', 'kivu', 'rwanda', 'kinshasa', 'drc'],
    context: 'Armed-group conflict in the eastern provinces with cross-border involvement.',
  },
  {
    id: 'horn',
    name: 'Horn of Africa',
    short: 'Horn',
    region: 'Africa',
    lat: 8.0,
    lon: 42.0,
    countries: ['231', '706'],
    baseline: 3,
    query: 'Ethiopia Somalia al-Shabaab conflict',
    keywords: ['ethiopia', 'somalia', 'al-shabaab', 'tigray', 'mogadishu', 'addis ababa', 'somaliland'],
    context: 'Insurgency, internal armed conflict and contested maritime access agreements.',
  },
  {
    id: 'syria',
    name: 'Syria',
    short: 'Syria',
    region: 'Middle East',
    lat: 35.0,
    lon: 38.5,
    countries: ['760'],
    baseline: 3,
    query: 'Syria strike militants',
    keywords: ['syria', 'damascus', 'idlib', 'aleppo', 'sdf', 'kurdish'],
    context: 'Post-civil-war fragmentation with multiple external actors and periodic strikes.',
  },
  {
    id: 'iraq',
    name: 'Iraq',
    short: 'Iraq',
    region: 'Middle East',
    lat: 33.3,
    lon: 43.7,
    countries: ['368'],
    baseline: 2,
    query: 'Iraq militia strike base',
    keywords: ['iraq', 'baghdad', 'erbil', 'kurdistan'],
    context: 'Militia activity and periodic strikes on installations hosting foreign forces.',
  },
  {
    id: 'myanmar',
    name: 'Myanmar',
    short: 'Myanmar',
    region: 'Southeast Asia',
    lat: 21.0,
    lon: 96.0,
    countries: ['104'],
    baseline: 3,
    query: 'Myanmar junta resistance offensive',
    keywords: ['myanmar', 'burma', 'junta', 'tatmadaw', 'rakhine', 'shan', 'naypyidaw'],
    context: 'Multi-front civil war between the military government and resistance coalitions.',
  },
  {
    id: 'caucasus',
    name: 'South Caucasus',
    short: 'Caucasus',
    region: 'Eurasia',
    lat: 40.3,
    lon: 45.5,
    countries: ['051', '031'],
    baseline: 2,
    query: 'Armenia Azerbaijan border',
    keywords: ['armenia', 'azerbaijan', 'karabakh', 'yerevan', 'baku', 'zangezur'],
    context: 'Unresolved border demarcation following the Nagorno-Karabakh conflicts.',
  },
  {
    id: 'balticflank',
    name: 'NATO Eastern Flank',
    short: 'NATO Flank',
    region: 'Eastern Europe',
    lat: 55.0,
    lon: 24.5,
    countries: ['440', '428', '233', '616', '112'],
    baseline: 3,
    query: 'NATO eastern flank airspace Baltic',
    keywords: ['nato', 'baltic', 'poland', 'lithuania', 'latvia', 'estonia', 'belarus', 'kaliningrad'],
    context: 'Airspace violations, sabotage incidents and reinforcement along the alliance border.',
  },
  {
    id: 'balkans',
    name: 'Western Balkans',
    short: 'Balkans',
    region: 'Europe',
    lat: 42.7,
    lon: 20.9,
    countries: ['688', 'Kosovo'],
    baseline: 2,
    query: 'Serbia Kosovo tension',
    keywords: ['serbia', 'kosovo', 'belgrade', 'pristina', 'republika srpska', 'bosnia'],
    context: 'Frozen disputes with recurring flashpoints and an international peacekeeping presence.',
  },
  {
    id: 'venezuela',
    name: 'Venezuela — Guyana',
    short: 'Venezuela',
    region: 'South America',
    lat: 6.5,
    lon: -63.0,
    countries: ['862', '328'],
    baseline: 2,
    query: 'Venezuela Guyana Essequibo',
    keywords: ['venezuela', 'guyana', 'essequibo', 'caracas', 'maduro'],
    context: 'Territorial claim over the Essequibo region alongside internal political crisis.',
  },
  {
    id: 'sahelcoast',
    name: 'Lake Chad — Nigeria',
    short: 'Lake Chad',
    region: 'Africa',
    lat: 11.5,
    lon: 13.5,
    countries: ['566', '148'],
    baseline: 3,
    query: 'Nigeria Boko Haram bandits attack',
    keywords: ['nigeria', 'boko haram', 'iswap', 'chad', 'borno', 'abuja'],
    context: 'Jihadist insurgency and mass-abduction criminality across the Lake Chad basin.',
  },
  {
    id: 'libya',
    name: 'Libya',
    short: 'Libya',
    region: 'Africa',
    lat: 27.0,
    lon: 17.0,
    countries: ['434'],
    baseline: 2,
    query: 'Libya militia clashes Tripoli',
    keywords: ['libya', 'tripoli', 'benghazi', 'haftar'],
    context: 'Rival governments and militia competition over territory and energy infrastructure.',
  },
  {
    id: 'afpak',
    name: 'Afghanistan — Pakistan',
    short: 'Af-Pak',
    region: 'South Asia',
    lat: 33.5,
    lon: 69.5,
    countries: ['004'],
    baseline: 3,
    query: 'Afghanistan Pakistan Taliban TTP border',
    keywords: ['afghanistan', 'taliban', 'kabul', 'ttp', 'durand', 'peshawar', 'islamabad'],
    context: 'Cross-border militancy and periodic strikes along a contested frontier.',
  },
  {
    id: 'haiti',
    name: 'Haiti',
    short: 'Haiti',
    region: 'Caribbean',
    lat: 18.9,
    lon: -72.4,
    countries: ['332'],
    baseline: 3,
    query: 'Haiti gang violence mission',
    keywords: ['haiti', 'port-au-prince', 'gang', 'kenya police'],
    context: 'State collapse under armed gang control with an international support mission deployed.',
  },
  {
    id: 'sahara',
    name: 'Mozambique — Cabo Delgado',
    short: 'Cabo Delgado',
    region: 'Africa',
    lat: -12.5,
    lon: 39.5,
    countries: ['508'],
    baseline: 2,
    query: 'Mozambique Cabo Delgado insurgency',
    keywords: ['mozambique', 'cabo delgado', 'palma', 'insurgent'],
    context: 'Islamist insurgency near major offshore liquefied natural gas developments.',
  },
];

// ---------------------------------------------------------------------------
// News feeds
// ---------------------------------------------------------------------------
// `lane` groups a source for the UI filter. `weight` nudges ranking — wires and
// primary official sources outrank aggregators.

const FEEDS = [
  // Global wires
  { id: 'aljazeera', name: 'Al Jazeera', lane: 'wire', weight: 1.0, url: 'https://www.aljazeera.com/xml/rss/all.xml' },
  { id: 'bbc-world', name: 'BBC World', lane: 'wire', weight: 1.0, url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
  { id: 'guardian-world', name: 'Guardian World', lane: 'wire', weight: 0.9, url: 'https://www.theguardian.com/world/rss' },
  { id: 'france24', name: 'France 24', lane: 'wire', weight: 0.9, url: 'https://www.france24.com/en/rss' },
  { id: 'dw-world', name: 'Deutsche Welle', lane: 'wire', weight: 0.9, url: 'https://rss.dw.com/rdf/rss-en-world' },
  { id: 'npr-world', name: 'NPR World', lane: 'wire', weight: 0.8, url: 'https://feeds.npr.org/1004/rss.xml' },
  { id: 'cna', name: 'Channel News Asia', lane: 'wire', weight: 0.8, url: 'https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml' },

  // Defense and security trade press
  { id: 'defensenews', name: 'Defense News', lane: 'defense', weight: 0.9, url: 'https://www.defensenews.com/arc/outboundfeeds/rss/?outputType=xml' },
  { id: 'breakingdefense', name: 'Breaking Defense', lane: 'defense', weight: 0.85, url: 'https://breakingdefense.com/feed/' },
  { id: 'twz', name: 'The War Zone', lane: 'defense', weight: 0.8, url: 'https://www.twz.com/feed' },
  { id: 'militarytimes', name: 'Military Times', lane: 'defense', weight: 0.75, url: 'https://www.militarytimes.com/arc/outboundfeeds/rss/?outputType=xml' },

  // Official and institutional
  { id: 'un-news', name: 'UN News', lane: 'official', weight: 1.0, url: 'https://news.un.org/feed/subscribe/en/news/all/rss.xml' },
  { id: 'nato', name: 'NATO', lane: 'official', weight: 1.0, url: 'https://www.nato.int/cps/en/natohq/news.rss' },
  { id: 'isw', name: 'Inst. for the Study of War', lane: 'official', weight: 0.95, url: 'https://www.understandingwar.org/feeds.xml' },
  { id: 'reliefweb-headlines', name: 'ReliefWeb', lane: 'official', weight: 0.85, url: 'https://reliefweb.int/headlines/rss.xml' },

  // Regional desks close to specific theaters
  { id: 'kyivindependent', name: 'Kyiv Independent', lane: 'regional', weight: 0.85, url: 'https://kyivindependent.com/feed/' },
  { id: 'timesofisrael', name: 'Times of Israel', lane: 'regional', weight: 0.8, url: 'https://www.timesofisrael.com/feed/' },
  { id: 'moscowtimes', name: 'The Moscow Times', lane: 'regional', weight: 0.75, url: 'https://www.themoscowtimes.com/rss/news' },
  { id: 'scmp-china', name: 'South China Morning Post', lane: 'regional', weight: 0.8, url: 'https://www.scmp.com/rss/91/feed' },
  { id: 'arabnews', name: 'Arab News', lane: 'regional', weight: 0.75, url: 'https://www.arabnews.com/rss.xml' },
];

/** Google News RSS query feed for a given theater — used for per-theater drilldown. */
function googleNewsUrl(query) {
  return (
    'https://news.google.com/rss/search?q=' +
    encodeURIComponent(query + ' when:2d') +
    '&hl=en-US&gl=US&ceid=US:en'
  );
}

// ---------------------------------------------------------------------------
// Markets
// ---------------------------------------------------------------------------
// Stooq accepts a '+'-joined symbol list in one request, so the whole board is
// a single upstream call.

const INSTRUMENTS = [
  { symbol: 'cl.f', name: 'WTI Crude', group: 'energy', unit: 'USD/bbl', invert: false },
  { symbol: 'cb.f', name: 'Brent Crude', group: 'energy', unit: 'USD/bbl', invert: false },
  { symbol: 'ng.f', name: 'Natural Gas', group: 'energy', unit: 'USD/MMBtu', invert: false },
  { symbol: 'gc.f', name: 'Gold', group: 'metals', unit: 'USD/oz', invert: false },
  { symbol: 'si.f', name: 'Silver', group: 'metals', unit: 'USD/oz', invert: false },
  { symbol: 'hg.f', name: 'Copper', group: 'metals', unit: 'USD/lb', invert: false },
  { symbol: 'zw.f', name: 'Wheat', group: 'agriculture', unit: 'USc/bu', invert: false },
  { symbol: 'zc.f', name: 'Corn', group: 'agriculture', unit: 'USc/bu', invert: false },
  { symbol: '^spx', name: 'S&P 500', group: 'equities', unit: 'idx', invert: false },
  { symbol: '^ndq', name: 'Nasdaq 100', group: 'equities', unit: 'idx', invert: false },
  { symbol: '^dax', name: 'DAX', group: 'equities', unit: 'idx', invert: false },
  { symbol: '^nkx', name: 'Nikkei 225', group: 'equities', unit: 'idx', invert: false },
  { symbol: '^hsi', name: 'Hang Seng', group: 'equities', unit: 'idx', invert: false },
  { symbol: '^vix', name: 'VIX', group: 'risk', unit: 'idx', invert: true },
  { symbol: 'eurusd', name: 'EUR/USD', group: 'fx', unit: '', invert: false },
  { symbol: 'usdjpy', name: 'USD/JPY', group: 'fx', unit: '', invert: false },
  { symbol: 'usdchf', name: 'USD/CHF', group: 'fx', unit: '', invert: false },
  { symbol: 'gbpusd', name: 'GBP/USD', group: 'fx', unit: '', invert: false },
];

/**
 * Instruments treated as risk-sensitive when computing the market stress
 * component of the composite index. `dir` is the sign of a "risk-off" move.
 */
const STRESS_WEIGHTS = [
  { symbol: '^vix', dir: +1, weight: 0.3 },
  { symbol: 'gc.f', dir: +1, weight: 0.2 },
  { symbol: 'cb.f', dir: +1, weight: 0.2 },
  { symbol: 'ng.f', dir: +1, weight: 0.1 },
  { symbol: '^spx', dir: -1, weight: 0.2 },
];

// ---------------------------------------------------------------------------
// Cache windows (ms)
// ---------------------------------------------------------------------------

const TTL = {
  news: 4 * 60_000,
  newsGrace: 60 * 60_000,
  markets: 5 * 60_000,
  marketsGrace: 6 * 60 * 60_000,
  gdelt: 10 * 60_000,
  gdeltGrace: 3 * 60 * 60_000,
  reliefweb: 30 * 60_000,
  reliefwebGrace: 12 * 60 * 60_000,
  seismic: 10 * 60_000,
  seismicGrace: 3 * 60 * 60_000,
  theater: 8 * 60_000,
  theaterGrace: 2 * 60 * 60_000,
};

module.exports = {
  PORT,
  THEATERS,
  FEEDS,
  INSTRUMENTS,
  STRESS_WEIGHTS,
  TTL,
  googleNewsUrl,
};
