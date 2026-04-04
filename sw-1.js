// ND2 Timetable — Service Worker v4.0
// Background alarm: fires even when phone screen is off and app is closed
// Fetches live timetable from data.json every sync cycle

const CACHE_NAME = 'nd2-v4';
const ASSETS = ['./', './index.html', './manifest.json', './icon.png', './sw.js', './data.json'];

// ══════════════════════════════════════════════
//  INSTALL — cache all files for offline use
// ══════════════════════════════════════════════
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(ASSETS).catch(() => {})));
  self.skipWaiting();
});

// ══════════════════════════════════════════════
//  ACTIVATE — remove old caches, claim clients
// ══════════════════════════════════════════════
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME && k !== SW_STORE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
  startAlarmLoop();
});

// ══════════════════════════════════════════════
//  FETCH — serve from cache, update in background
//  Network-first for data.json so changes are live
// ══════════════════════════════════════════════
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // data.json: network first so admin changes show instantly
  if (url.pathname.endsWith('data.json')) {
    e.respondWith(
      fetch(e.request).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => caches.match(e.request))
    );
    return;
  }
  // Everything else: cache first
  e.respondWith(
    caches.match(e.request).then(cached =>
      cached || fetch(e.request).catch(() =>
        e.request.destination === 'document' ? caches.match('./index.html') : undefined
      )
    )
  );
});

// ══════════════════════════════════════════════
//  MESSAGES from the page
// ══════════════════════════════════════════════
self.addEventListener('message', e => {
  if (!e.data) return;
  if (e.data.type === 'SYNC_DATA') {
    // Page sends current timetable + settings + fired list
    storeSW('tt',        JSON.stringify(e.data.tt));
    storeSW('remind',    String(e.data.remindBefore || 10));
    storeSW('fired',     JSON.stringify(e.data.fired || []));
    storeSW('firedDay',  e.data.firedDay || '');
  }
  if (e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

// ══════════════════════════════════════════════
//  PERIODIC BACKGROUND SYNC (Chrome Android)
//  Registered from page — wakes SW from dead state
// ══════════════════════════════════════════════
self.addEventListener('periodicsync', e => {
  if (e.tag === 'nd2-alarm') e.waitUntil(checkAlarms());
});

// ══════════════════════════════════════════════
//  NOTIFICATION CLICK
// ══════════════════════════════════════════════
self.addEventListener('notificationclick', e => {
  e.notification.close();
  if (e.action === 'dismiss') return;
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) { if ('focus' in c) return c.focus(); }
      return clients.openWindow('./index.html');
    })
  );
});

// ══════════════════════════════════════════════
//  ALARM LOOP
//  Runs every 60 seconds inside SW — even when
//  the app tab is closed. This is what makes it
//  work like a prayer alarm app.
// ══════════════════════════════════════════════
let loopTimer = null;

function startAlarmLoop() {
  if (loopTimer) clearTimeout(loopTimer);
  loopTimer = setTimeout(async () => {
    await checkAlarms();
    startAlarmLoop(); // keep looping forever
  }, 60 * 1000);
}

async function checkAlarms() {
  try {
    // Try to get fresh data.json from network first
    let tt = null;
    try {
      const res = await fetch('./data.json?sw=' + Date.now());
      if (res.ok) {
        const json = await res.json();
        tt = json.timetable;
        await storeSW('tt', JSON.stringify(tt));
      }
    } catch (_) {}

    // Fall back to stored timetable if no network
    if (!tt) {
      const stored = await getSW('tt');
      if (!stored) return;
      tt = JSON.parse(stored);
    }

    const remind = parseInt((await getSW('remind')) || '10');
    const now    = new Date();
    const nowM   = now.getHours() * 60 + now.getMinutes();
    const todayStr = now.toDateString();
    const DAYNAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const day = DAYNAMES[now.getDay()];

    // Reset fired list each new day
    let firedDay = await getSW('firedDay') || '';
    let fired    = JSON.parse((await getSW('fired')) || '[]');
    if (firedDay !== todayStr) {
      fired = [];
      firedDay = todayStr;
      await storeSW('fired', '[]');
      await storeSW('firedDay', todayStr);
    }

    const schedule = tt[day] || [];
    for (const item of schedule) {
      const startM   = toMins(item.start);
      const key      = `${day}-${item.start}`;
      const winStart = startM - remind;
      const winEnd   = startM + 1; // 1 min grace window

      if (nowM >= winStart && nowM <= winEnd && !fired.includes(key)) {
        fired.push(key);
        await storeSW('fired', JSON.stringify(fired));

        const minsLeft  = startM - nowM;
        const timeLabel = minsLeft <= 0 ? 'Starting NOW!' : `In ${minsLeft} min`;
        const venueIcon = item.type === 'Practical' ? '🧪' : '🏛';

        // Show the notification — stays on screen until user dismisses
        await self.registration.showNotification(`🔔 ${item.course}`, {
          body:               `${timeLabel} · ${venueIcon} ${item.venue}\n${item.start} – ${item.end}`,
          icon:               './icon.png',
          badge:              './icon.png',
          tag:                `nd2-${key}`,
          renotify:           true,
          requireInteraction: true,   // ← stays on screen like prayer alarm
          silent:             false,
          vibrate:            [600, 200, 600, 200, 600, 400, 800, 200, 600],
          data:               { item },
          actions: [
            { action: 'open',    title: '📖 Open App' },
            { action: 'dismiss', title: '✕ Dismiss'  }
          ]
        });

        // Wake up the app page if it's open in background
        const allClients = await clients.matchAll({ includeUncontrolled: true, type: 'window' });
        for (const c of allClients) {
          try { c.postMessage({ type: 'SW_ALARM', item }); } catch (_) {}
        }
      }
    }
  } catch (err) {
    console.warn('[ND2-SW] checkAlarms error:', err);
  }
}

// ══════════════════════════════════════════════
//  KEY-VALUE STORAGE inside SW using CacheStorage
// ══════════════════════════════════════════════
const SW_STORE = 'nd2-swkv-v1';

async function storeSW(key, val) {
  const cache = await caches.open(SW_STORE);
  await cache.put(
    new Request(`/_kv/${key}`),
    new Response(val, { headers: { 'Content-Type': 'text/plain' } })
  );
}

async function getSW(key) {
  try {
    const cache = await caches.open(SW_STORE);
    const res   = await cache.match(new Request(`/_kv/${key}`));
    return res ? res.text() : null;
  } catch { return null; }
}

function toMins(t) {
  const [h, m] = (t || '00:00').split(':').map(Number);
  return h * 60 + m;
}
