// Rebuilds gtfs_data.json from the UTA GTFS feed and re-injects the embedded
// fallback snapshot into index.html and timetable.html.
//
// This is a port of functions/index.js buildGTFSData(), run from GitHub
// Actions (which has open internet) instead of Cloud Functions — see
// .github/workflows/refresh-schedule.yml.
//
// Usage:
//   node scripts/build-gtfs.mjs                 # download from UTA
//   node scripts/build-gtfs.mjs --zip path.zip  # use a local zip (tests)
//   node scripts/build-gtfs.mjs --dir DIR       # operate on copies in DIR (tests)
//
// Deps (install with: npm i --no-save adm-zip@0.5.16 csv-parse@5.5.6)
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import { parse } from 'csv-parse/sync';

const UTA_GTFS_URL = process.env.UTA_GTFS_URL || 'https://gtfsfeed.rideuta.com/GTFS.zip';

// Kept in sync with functions/index.js — route_short_name is blank in recent
// UTA feeds, so match by long name first, then the historically stable id.
const TARGET_ROUTES = {
  704: { longName: 'Green Line', fallbackId: '39020' },
  750: { longName: 'FrontRunner', fallbackId: '41065' },
};
const STOP_IDS = {
  airport: ['23049', '23050'],
  transferTrax: ['23039', '23040'],
  transferFR: ['23113'],
  provo: ['23073'],
};

// Sanity floors: ~25% of the March 2026 feed's sizes. A result below these
// means UTA renumbered something — fail loudly rather than ship an empty app.
const MIN_TRIPS_704 = 90;
const MIN_TRIPS_750 = 25;
const MIN_STOP_TIMES = 230;

function argVal(flag) {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : null;
}

async function loadZip() {
  const local = argVal('--zip');
  if (local) return new AdmZip(local);
  console.log('Downloading', UTA_GTFS_URL);
  const res = await fetch(UTA_GTFS_URL);
  if (!res.ok) throw new Error('UTA fetch failed: HTTP ' + res.status);
  return new AdmZip(Buffer.from(await res.arrayBuffer()));
}

function buildGTFSData(zip) {
  const readCSV = (name) => {
    const entry = zip.getEntry(name);
    if (!entry) throw new Error('Missing ' + name + ' in GTFS zip');
    return parse(entry.getData().toString('utf-8'), {
      columns: true, skip_empty_lines: true, trim: true,
    });
  };

  const routes = readCSV('routes.txt');
  const trips = readCSV('trips.txt');
  const calendar = readCSV('calendar.txt');
  const calDates = readCSV('calendar_dates.txt');
  let feedInfo = null;
  try { feedInfo = readCSV('feed_info.txt')[0]; } catch { /* optional file */ }

  const routeIds = {};
  for (const key of Object.keys(TARGET_ROUTES)) {
    const target = TARGET_ROUTES[key];
    const byName = routes.find((r) =>
      r.route_long_name && r.route_long_name.toLowerCase() === target.longName.toLowerCase());
    const byId = routes.find((r) => r.route_id === target.fallbackId);
    const match = byName || byId;
    if (match) routeIds[key] = match.route_id;
  }
  if (!routeIds['704'] || !routeIds['750']) {
    throw new Error('Target routes missing from feed: ' + JSON.stringify(routeIds));
  }

  const trips704 = {};
  const trips750 = {};
  const serviceIdsUsed = new Set();
  for (const t of trips) {
    if (t.route_id === routeIds['704']) {
      trips704[t.trip_id] = t.service_id;
      serviceIdsUsed.add(t.service_id);
    } else if (t.route_id === routeIds['750']) {
      trips750[t.trip_id] = t.service_id;
      serviceIdsUsed.add(t.service_id);
    }
  }

  const tripsOfInterest = new Set([...Object.keys(trips704), ...Object.keys(trips750)]);
  const stopsOfInterest = new Set([
    ...STOP_IDS.airport, ...STOP_IDS.transferTrax, ...STOP_IDS.transferFR, ...STOP_IDS.provo,
  ]);

  const stopTimes = [];
  for (const st of readCSV('stop_times.txt')) {
    if (tripsOfInterest.has(st.trip_id) && stopsOfInterest.has(st.stop_id)) {
      stopTimes.push([st.trip_id, st.stop_id, st.arrival_time, st.departure_time]);
    }
  }

  return {
    airportStops: STOP_IDS.airport,
    transferTrax: STOP_IDS.transferTrax,
    transferFR: STOP_IDS.transferFR,
    provoStops: STOP_IDS.provo,
    trips704,
    trips750,
    stopTimes,
    calendar: calendar.filter((c) => serviceIdsUsed.has(c.service_id)),
    calDates: calDates.filter((cd) => serviceIdsUsed.has(cd.service_id)),
    feedStart: feedInfo ? feedInfo.feed_start_date : '',
    feedEnd: feedInfo ? feedInfo.feed_end_date : '',
    generatedAt: new Date().toISOString(),
  };
}

function sanityCheck(data) {
  const n704 = Object.keys(data.trips704).length;
  const n750 = Object.keys(data.trips750).length;
  const errs = [];
  if (n704 < MIN_TRIPS_704) errs.push(`trips704 ${n704} < ${MIN_TRIPS_704}`);
  if (n750 < MIN_TRIPS_750) errs.push(`trips750 ${n750} < ${MIN_TRIPS_750}`);
  if (data.stopTimes.length < MIN_STOP_TIMES) errs.push(`stopTimes ${data.stopTimes.length} < ${MIN_STOP_TIMES}`);
  if (data.calendar.length + data.calDates.length === 0) errs.push('no calendar rows');
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  if (data.feedEnd && data.feedEnd < today) errs.push(`feed already expired (${data.feedEnd})`);
  if (errs.length) throw new Error('Sanity check failed: ' + errs.join('; '));
  console.log(`OK: trips704=${n704} trips750=${n750} stopTimes=${data.stopTimes.length} feed=${data.feedStart}-${data.feedEnd}`);
}

function injectSnapshot(file, json, iso) {
  let html = readFileSync(file, 'utf8');
  const before = html;
  html = html.replace(/^(\s*var GTFS = )\{.*\};$/m, (_, p) => p + json + ';');
  html = html.replace(/^(\s*GTFS\.generatedAt=')[^']*(';)$/m, (_, p, s) => p + iso + s);
  if (html === before) throw new Error('No snapshot found to replace in ' + file);
  writeFileSync(file, html);
  console.log('Injected snapshot into', file);
}

const dir = argVal('--dir') || '.';
const zip = await loadZip();
const data = buildGTFSData(zip);
sanityCheck(data);
const json = JSON.stringify(data);
writeFileSync(join(dir, 'gtfs_data.json'), json);
console.log('Wrote gtfs_data.json (' + json.length + ' bytes)');
injectSnapshot(join(dir, 'index.html'), json, data.generatedAt);
injectSnapshot(join(dir, 'timetable.html'), json, data.generatedAt);
