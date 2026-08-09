const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onRequest } = require('firebase-functions/v2/https');
const { initializeApp } = require('firebase-admin/app');
const { getStorage } = require('firebase-admin/storage');
const AdmZip = require('adm-zip');
const { parse } = require('csv-parse/sync');

initializeApp();

const UTA_GTFS_URL = 'https://gtfsfeed.rideuta.com/GTFS.zip';
const BUCKET_FILE = 'gtfs_data.json';
// UTA recently blanked route_short_name for these routes but the
// route_long_name and route_id have been stable. Match by long name first,
// fall back to the known route_id.
// `required: false` routes are allowed to vanish from the feed without
// failing the whole refresh — UTA actively churns route naming (they have
// been blanking route_short_name and rebranding BRT lines), and losing the
// Lehi connector must not also freeze the Airport/Provo rail data.
const TARGET_ROUTES = {
  '704': { longName: 'Green Line', fallbackId: '39020', required: true },
  '750': { longName: 'FrontRunner', fallbackId: '41065', required: true },
  '871': { longName: 'Tech Corridor Rail Connector', fallbackId: '2368', required: false }
};

// Stop IDs were stable across prior UTA feeds; if UTA renumbers, the
// client falls back to its embedded copy and we'll see the warning in logs.
const STOP_IDS = {
  airport: ['23049', '23050'],
  transferTrax: ['23039', '23040'],
  transferFR: ['23113'],
  provo: ['23073'],
  lehiFR: ['23074'],
  lehiBus: ['23278'],
  adobe: ['23154']
};

async function buildGTFSData() {
  const res = await fetch(UTA_GTFS_URL);
  if (!res.ok) throw new Error('UTA fetch failed: HTTP ' + res.status);
  const zipBuf = Buffer.from(await res.arrayBuffer());
  const zip = new AdmZip(zipBuf);

  const readCSV = (name) => {
    const entry = zip.getEntry(name);
    if (!entry) throw new Error('Missing ' + name + ' in GTFS zip');
    return parse(entry.getData().toString('utf-8'), {
      columns: true, skip_empty_lines: true, trim: true
    });
  };

  const routes = readCSV('routes.txt');
  const trips = readCSV('trips.txt');
  const calendar = readCSV('calendar.txt');
  const calDates = readCSV('calendar_dates.txt');
  let feedInfo = null;
  try { feedInfo = readCSV('feed_info.txt')[0]; } catch (_) {}

  // Resolve our route keys → route_id
  const routeIds = {};
  for (const key of Object.keys(TARGET_ROUTES)) {
    const target = TARGET_ROUTES[key];
    const byName = routes.find(r =>
      r.route_long_name && r.route_long_name.toLowerCase() === target.longName.toLowerCase());
    const byId = routes.find(r => r.route_id === target.fallbackId);
    const match = byName || byId;
    if (match) routeIds[key] = match.route_id;
  }
  const missingRequired = Object.keys(TARGET_ROUTES)
    .filter(k => TARGET_ROUTES[k].required && !routeIds[k]);
  if (missingRequired.length) {
    throw new Error('Required routes missing from feed: ' + missingRequired.join(', ') +
      ' (resolved: ' + JSON.stringify(routeIds) + ')');
  }
  const missingOptional = Object.keys(TARGET_ROUTES)
    .filter(k => !TARGET_ROUTES[k].required && !routeIds[k]);
  if (missingOptional.length) {
    console.warn('Optional routes absent from feed, continuing without them:', missingOptional.join(', '));
  }

  const trips704 = {};
  const trips750 = {};
  const trips871 = {};
  const serviceIdsUsed = new Set();
  for (const t of trips) {
    if (t.route_id === routeIds['704']) {
      trips704[t.trip_id] = t.service_id;
      serviceIdsUsed.add(t.service_id);
    } else if (t.route_id === routeIds['750']) {
      trips750[t.trip_id] = t.service_id;
      serviceIdsUsed.add(t.service_id);
    } else if (t.route_id === routeIds['871']) {
      trips871[t.trip_id] = t.service_id;
      serviceIdsUsed.add(t.service_id);
    }
  }

  const tripsOfInterest = new Set([
    ...Object.keys(trips704), ...Object.keys(trips750), ...Object.keys(trips871)
  ]);
  const stopsOfInterest = new Set([
    ...STOP_IDS.airport, ...STOP_IDS.transferTrax,
    ...STOP_IDS.transferFR, ...STOP_IDS.provo,
    ...STOP_IDS.lehiFR, ...STOP_IDS.lehiBus, ...STOP_IDS.adobe
  ]);

  // Parse stop_times and filter to only rows we need
  const stRows = readCSV('stop_times.txt');
  const stopTimes = [];
  for (const st of stRows) {
    if (tripsOfInterest.has(st.trip_id) && stopsOfInterest.has(st.stop_id)) {
      stopTimes.push([st.trip_id, st.stop_id, st.arrival_time, st.departure_time]);
    }
  }

  const calFiltered = calendar.filter(c => serviceIdsUsed.has(c.service_id));
  const calDatesFiltered = calDates.filter(cd => serviceIdsUsed.has(cd.service_id));

  return {
    airportStops: STOP_IDS.airport,
    transferTrax: STOP_IDS.transferTrax,
    transferFR: STOP_IDS.transferFR,
    provoStops: STOP_IDS.provo,
    lehiFRStops: STOP_IDS.lehiFR,
    lehiBusStops: STOP_IDS.lehiBus,
    adobeStops: STOP_IDS.adobe,
    trips704,
    trips750,
    trips871,
    stopTimes,
    calendar: calFiltered,
    calDates: calDatesFiltered,
    feedStart: feedInfo ? feedInfo.feed_start_date : '',
    feedEnd: feedInfo ? feedInfo.feed_end_date : '',
    generatedAt: new Date().toISOString()
  };
}

async function saveToBucket(data) {
  const bucket = getStorage().bucket('transit-cm-data');
  const file = bucket.file(BUCKET_FILE);
  await file.save(JSON.stringify(data), {
    contentType: 'application/json',
    metadata: { cacheControl: 'no-cache, max-age=0' }
  });
}

// UTA publishes the next service change ~2 weeks early and *replaces* the
// current feed with it, so GTFS.zip can cover only future dates. Retaining
// previously-fetched feeds until they actually expire is what keeps the app
// from going blank during that window.
const FEED_FIELDS = [
  'airportStops', 'transferTrax', 'transferFR', 'provoStops',
  'lehiFRStops', 'lehiBusStops', 'adobeStops',
  'trips704', 'trips750', 'trips871',
  'stopTimes', 'calendar', 'calDates', 'feedStart', 'feedEnd'
];

function denverToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date()).replace(/-/g, '');
}

function pickFeedFields(o) {
  const f = {};
  for (const k of FEED_FIELDS) if (o && o[k] !== undefined) f[k] = o[k];
  return f;
}

function isUsableFeed(f) {
  return !!(f && f.feedStart && f.feedEnd && Array.isArray(f.stopTimes) && f.stopTimes.length);
}

async function readStored() {
  try {
    const bucket = getStorage().bucket('transit-cm-data');
    const file = bucket.file(BUCKET_FILE);
    const [exists] = await file.exists();
    if (!exists) return null;
    const [contents] = await file.download();
    return JSON.parse(contents.toString('utf-8'));
  } catch (e) {
    console.warn('Could not read stored schedule, starting fresh:', e && e.message);
    return null;
  }
}

function storedFeeds(stored) {
  if (!stored) return [];
  const out = [];
  const primary = pickFeedFields(stored);
  if (isUsableFeed(primary)) out.push(primary);
  if (Array.isArray(stored.feeds)) {
    for (const f of stored.feeds) {
      const c = pickFeedFields(f);
      if (isUsableFeed(c)) out.push(c);
    }
  }
  return out;
}

// Newest build wins for a given date range; anything already ended is dropped.
// The feed covering today goes at top level (so existing clients keep working)
// and the remainder rides along in `feeds`.
function composePayload(newFeed, stored) {
  const today = denverToday();
  const byRange = new Map();
  for (const f of storedFeeds(stored)) {
    if (f.feedEnd < today) continue;
    byRange.set(f.feedStart + '-' + f.feedEnd, f);
  }
  const fresh = pickFeedFields(newFeed);
  byRange.set(fresh.feedStart + '-' + fresh.feedEnd, fresh);

  const feeds = Array.from(byRange.values())
    .sort((a, b) => (a.feedStart < b.feedStart ? -1 : a.feedStart > b.feedStart ? 1 : 0));
  const primary = feeds.find(f => f.feedStart <= today && today <= f.feedEnd) || feeds[0];

  const lastCovered = feeds.reduce((m, f) => (f.feedEnd > m ? f.feedEnd : m), '');
  return Object.assign({}, primary, {
    feeds: feeds.filter(f => f !== primary),
    // Lets the app warn before coverage lapses instead of going blank on a platform.
    coverage: { today, covered: feeds.some(f => f.feedStart <= today && today <= f.feedEnd), lastCovered },
    generatedAt: new Date().toISOString()
  });
}

// Keep a copy of every distinct feed UTA ever serves us. Retention only holds
// unexpired feeds; this is the durable record, so a future gap can be backfilled
// by hand instead of being lost the way 2026-08-07 was.
async function archiveFeed(feed) {
  try {
    const bucket = getStorage().bucket('transit-cm-data');
    const name = 'archive/gtfs_' + feed.feedStart + '_' + feed.feedEnd + '.json';
    const file = bucket.file(name);
    const [exists] = await file.exists();
    if (exists) return false;
    await file.save(JSON.stringify(feed), { contentType: 'application/json' });
    console.log('Archived new feed version:', name);
    return true;
  } catch (e) {
    console.warn('Archiving failed (non-fatal):', e && e.message);
    return false;
  }
}

function describeCoverage(payload) {
  const today = denverToday();
  const all = [payload].concat(payload.feeds || []);
  const covered = all.some(f => f.feedStart <= today && today <= f.feedEnd);
  return {
    covered,
    ranges: all.map(f => f.feedStart + '–' + f.feedEnd).join(', ')
  };
}

exports.refreshSchedule = onSchedule({
  schedule: 'every 4 hours',
  timeZone: 'America/Denver',
  memory: '512MiB',
  timeoutSeconds: 300,
  region: 'us-central1'
}, async () => {
  const data = await buildGTFSData();
  const payload = composePayload(data, await readStored());
  await saveToBucket(payload);
  await archiveFeed(pickFeedFields(data));
  const cov = describeCoverage(payload);
  console.log('Refreshed schedule.',
    'stopTimes:', data.stopTimes.length,
    'trips704:', Object.keys(data.trips704).length,
    'trips750:', Object.keys(data.trips750).length,
    'trips871:', Object.keys(data.trips871).length,
    'fetched feed:', data.feedStart + '–' + data.feedEnd,
    'retained:', cov.ranges);
  if (!cov.covered) {
    console.warn('No retained feed covers today (' + denverToday() +
      '). UTA is publishing only future service; the app will show a coverage-gap notice.');
  }
});

exports.getSchedule = onRequest({
  memory: '512MiB',
  timeoutSeconds: 60,
  region: 'us-central1',
  cors: true
}, async (req, res) => {
  try {
    const bucket = getStorage().bucket('transit-cm-data');
    const file = bucket.file(BUCKET_FILE);
    const [exists] = await file.exists();
    if (!exists) {
      // Cold start — build inline so client gets data on first hit
      const data = await buildGTFSData();
      const payload = composePayload(data, null);
      await saveToBucket(payload);
      res.set('Cache-Control', 'public, max-age=300, must-revalidate');
      res.set('Content-Type', 'application/json');
      res.send(JSON.stringify(payload));
      return;
    }
    const [contents] = await file.download();
    res.set('Cache-Control', 'public, max-age=300, must-revalidate');
    res.set('Content-Type', 'application/json');
    res.send(contents);
  } catch (e) {
    console.error('getSchedule failed:', e);
    res.status(500).json({ error: String(e && e.message || e) });
  }
});
