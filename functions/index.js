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
const TARGET_ROUTES = {
  '704': { longName: 'Green Line', fallbackId: '39020' },
  '750': { longName: 'FrontRunner', fallbackId: '41065' }
};

// Stop IDs were stable across prior UTA feeds; if UTA renumbers, the
// client falls back to its embedded copy and we'll see the warning in logs.
const STOP_IDS = {
  airport: ['23049', '23050'],
  transferTrax: ['23039', '23040'],
  transferFR: ['23113'],
  provo: ['23073']
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

  const tripsOfInterest = new Set([
    ...Object.keys(trips704), ...Object.keys(trips750)
  ]);
  const stopsOfInterest = new Set([
    ...STOP_IDS.airport, ...STOP_IDS.transferTrax,
    ...STOP_IDS.transferFR, ...STOP_IDS.provo
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
    trips704,
    trips750,
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

exports.refreshSchedule = onSchedule({
  schedule: 'every 4 hours',
  timeZone: 'America/Denver',
  memory: '512MiB',
  timeoutSeconds: 300,
  region: 'us-central1'
}, async () => {
  const data = await buildGTFSData();
  await saveToBucket(data);
  console.log('Refreshed schedule.',
    'stopTimes:', data.stopTimes.length,
    'trips704:', Object.keys(data.trips704).length,
    'trips750:', Object.keys(data.trips750).length,
    'feed:', data.feedStart + '–' + data.feedEnd);
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
      await saveToBucket(data);
      res.set('Cache-Control', 'public, max-age=300, must-revalidate');
      res.set('Content-Type', 'application/json');
      res.send(JSON.stringify(data));
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
