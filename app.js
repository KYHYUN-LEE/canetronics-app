'use strict';
/* =====================================================================
 * Canetronics 보호자 앱
 *
 *  지팡이(ESP32) ──MQTT──▶ 공개 MQTT 서버 ──WebSocket──▶ 이 앱
 *
 *  받는 토픽 (canetronics/<기기 ID>/...)
 *    status   : 1초마다 전체 상태 (JSON)
 *    event    : 낙상/안전구역/GPS 사건 (JSON)
 *    geofence : 지팡이에 저장된 안전구역 (JSON)
 *    track    : 최근 이동 경로 (JSON)
 *    online   : "1" 연결됨 / "0" 끊김
 *  보내는 토픽
 *    cmd      : RESET_FALL / RECALIBRATE / GEOFENCE_CIRCLE,... / GEOFENCE_POLYGON,...
 * ===================================================================== */

// ---------- 기본 설정 (펌웨어 CloudConfig.h와 맞출 것) ----------
const DEFAULTS = {
  name: '어르신',
  deviceId: 'cnu-cane-opphzg',
  broker: 'wss://broker.emqx.io:8084/mqtt',
  ntfyTopic: 'cnu-cane-opphzg-alert',
  phone: '',
  sound: true,
  notify: false,
};
const HOME = { lat: 36.365076, lng: 127.347689 };   // 지도 첫 화면·데모 기준점 (충남대 공과대학 4호관)
const OFFLINE_AFTER_MS = 12000;                      // 상태가 이 시간 넘게 안 오면 '응답 없음'
const MAX_EVENTS = 150;
const MAX_POLYGON_POINTS = 12;

const EVENT_TEXT = {
  BOOT: '지팡이 전원 켜짐',
  FALL_SUSPECTED: '낙상 의심 - 판정 중',
  FALL_CLEARED: '낙상 의심 해제',
  FALL_WARNING: '낙상 의심 - 사용자 확인 대기',
  FALL_CANCELED: '사용자가 경보를 취소함',
  FALL_CONFIRMED: '낙상 발생! 즉시 확인 필요',
  FALL_RESET: '낙상 경보 해제됨',
  GEOFENCE_EXIT: '안전구역 이탈',
  GEOFENCE_ENTER: '안전구역 복귀',
  GPS_FIX: 'GPS 수신 시작',
  GPS_LOST: 'GPS 신호 끊김',
};
const EVENT_LEVEL = {
  FALL_CONFIRMED: 'alarm', FALL_WARNING: 'alarm', FALL_SUSPECTED: 'watch', GEOFENCE_EXIT: 'watch',
  FALL_CANCELED: 'ok', FALL_CLEARED: 'ok', FALL_RESET: 'ok', GEOFENCE_ENTER: 'ok', GPS_FIX: 'ok',
  GPS_LOST: 'off', BOOT: 'off',
};
const FALL_TEXT = {
  CALIBRATING: ['기준 자세 잡는 중', 'off'],
  NORMAL: ['정상 감시 중', 'ok'],
  MONITORING: ['낙상 여부 판정 중', 'watch'],
  CANCEL_WINDOW: ['경보 중, 취소 대기', 'alarm'],
  FALL_CONFIRMED: ['낙상 확정', 'alarm'],
};
const MODE_TEXT = {
  IMPACT_MOTION_CHECK: '충격 후 움직임 확인',
  TILT_SHOCK_ANALYSIS: '기울어짐 전후 충격 분석',
  NONE: '',
};

// 안전표지 그림 (48x48, 흰색으로 그려짐)
const ICONS = {
  ok: '<circle cx="24" cy="24" r="21" fill="none" stroke="currentColor" stroke-width="3.5"/><path d="M14 25l7 7 13-15" fill="none" stroke="currentColor" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>',
  watch: '<path d="M24 4 45 42H3Z" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linejoin="round"/><path d="M24 17v12" stroke="currentColor" stroke-width="4.5" stroke-linecap="round"/><circle cx="24" cy="35.5" r="2.7" fill="currentColor"/>',
  fence: '<circle cx="19" cy="27" r="15" fill="none" stroke="currentColor" stroke-width="3.5" stroke-dasharray="5 4"/><circle cx="19" cy="27" r="3" fill="currentColor"/><path d="M29 17 43 4M33 4h10v10" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  fall: '<circle cx="30" cy="9" r="4.6" fill="currentColor"/><path d="M27 15 19 28M25 19l10 3M24 20l-9-4M19 28l7 9M19 28l-9 5" stroke="currentColor" stroke-width="4" stroke-linecap="round" fill="none"/><path d="M38 40 34 17c-.6-4 5.4-5.6 6.8-1.6" stroke="currentColor" stroke-width="3" stroke-linecap="round" fill="none"/><path d="M4 44h40" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>',
  off: '<circle cx="24" cy="24" r="21" fill="none" stroke="currentColor" stroke-width="3.5"/><path d="M15 24h18" stroke="currentColor" stroke-width="4.5" stroke-linecap="round"/>',
  search: '<circle cx="24" cy="24" r="6" fill="currentColor"/><path d="M12 12a17 17 0 0 0 0 24M36 12a17 17 0 0 1 0 24M6 6a25 25 0 0 0 0 36M42 6a25 25 0 0 1 0 36" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round"/>',
};

// ---------- 저장소 (실패해도 앱은 동작) ----------
const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem('cane.' + key);
      return v === null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('cane.' + key, JSON.stringify(value)); } catch { /* 무시 */ }
  },
};

const settings = Object.assign({}, DEFAULTS, store.get('settings', {}));

// 공유 링크(?device=...&broker=...&topic=...&name=...)로 열면 설정에 반영
(function applyUrlParams() {
  const q = new URLSearchParams(location.search);
  const keys = { device: 'deviceId', broker: 'broker', topic: 'ntfyTopic', name: 'name' };
  let changed = false;
  for (const [param, key] of Object.entries(keys)) {
    const v = q.get(param);
    if (v) { settings[key] = v; changed = true; }
  }
  if (changed) {
    store.set('settings', settings);
    history.replaceState(null, '', location.pathname);
  }
})();

function saveSettings() { store.set('settings', settings); }

// ---------- 앱 상태 ----------
const S = {
  source: 'mqtt',          // 'mqtt' | 'demo'
  conn: 'idle',            // idle | connecting | connected | error
  connError: '',
  connStartedAt: 0,
  online: null,            // 지팡이 연결 여부 (null = 모름)
  status: null,            // 마지막 상태 JSON
  statusAt: 0,             // 받은 시각
  statusRetained: false,
  geofence: null,
  track: [],               // 지팡이가 기억한 경로 [[위도, 경도, 시각]]
  live: [],                // 앱이 열려 있는 동안 받은 경로
  events: store.get('events', []),
  unread: 0,
  tab: 'status',
  follow: true,
  showTrail: store.get('showTrail', true),
  fallSince: 0,
  fallMuted: false,
  takeoverMin: false,
  pendingFence: null,
  emptyDismissed: false,
};

// ---------- 작은 도구들 ----------
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function distanceM(lat1, lng1, lat2, lng2) {
  const R = 6371009;
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLng = (lng2 - lng1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function pointInPolygon(lat, lng, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [ai, bi] = pts[i];
    const [aj, bj] = pts[j];
    if ((ai > lat) !== (aj > lat)) {
      const crossLng = bi + (lat - ai) * (bj - bi) / (aj - ai);
      if (lng < crossLng) inside = !inside;
    }
  }
  return inside;
}

function fmtAgo(ms) {
  if (!Number.isFinite(ms)) return '-';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 5) return '방금';
  if (s < 60) return `${s}초 전`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 전`;
  return `${Math.floor(h / 24)}일 전`;
}
function fmtClock(ms) {
  return new Date(ms).toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
}
function fmtWhen(ms) {
  const d = new Date(ms);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return fmtClock(ms);
  return `${d.getMonth() + 1}월 ${d.getDate()}일 ${fmtClock(ms)}`;
}
function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}시간 ${m}분`;
  if (m > 0) return `${m}분 ${s % 60}초`;
  return `${s}초`;
}
const fmtCoord = (lat, lng) => `${Number(lat).toFixed(6)}, ${Number(lng).toFixed(6)}`;
const kakaoUrl = (lat, lng) =>
  `https://map.kakao.com/link/map/${encodeURIComponent(`${settings.name.replace(/,/g, ' ')} 지팡이`)},${lat},${lng}`;
const googleUrl = (lat, lng) => `https://maps.google.com/?q=${lat},${lng}`;
const chip = (text, level) => `<span class="chip ${level}">${esc(text)}</span>`;

function topic(kind) { return `canetronics/${settings.deviceId}/${kind}`; }

let toastTimer = null;
function toast(text, ms = 3400) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

function vibrate(pattern) {
  try { navigator.vibrate?.(pattern); } catch { /* 무시 */ }
}

// 두 번 눌러야 실행되는 버튼 (실수 방지)
function armButton(btn, action) {
  let timer = null;
  const disarm = () => {
    btn.classList.remove('armed');
    btn.textContent = btn.dataset.label;
    btn.dataset.armed = '';
  };
  btn.addEventListener('click', () => {
    if (btn.dataset.armed === '1') {
      clearTimeout(timer);
      disarm();
      action();
      return;
    }
    btn.dataset.armed = '1';
    btn.classList.add('armed');
    btn.textContent = '한 번 더 누르면 실행';
    timer = setTimeout(disarm, 3500);
  });
}

async function copyText(text, el) {
  try {
    await navigator.clipboard.writeText(text);
    toast('복사했습니다');
  } catch {
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    toast('선택된 글자를 길게 눌러 복사하세요');
  }
}

// ---------- 소리 ----------
const Sound = (() => {
  let ctx = null;
  let sirenTimer = null;

  function unlock() {
    if (!ctx) {
      try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return; }
    }
    if (ctx.state === 'suspended') ctx.resume();
    syncAlarm();
  }
  function tone(freq, start, dur, vol = 0.22) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'square';
    o.frequency.value = freq;
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(vol, start + 0.01);
    g.gain.setValueAtTime(vol, start + dur - 0.03);
    g.gain.linearRampToValueAtTime(0, start + dur);
    o.connect(g).connect(ctx.destination);
    o.start(start);
    o.stop(start + dur + 0.02);
  }
  function beeps(n, freq = 880) {
    if (!settings.sound || !ctx || ctx.state !== 'running') return;
    const t = ctx.currentTime + 0.02;
    for (let i = 0; i < n; i++) tone(freq, t + i * 0.28, 0.18);
  }
  function siren() {
    if (sirenTimer || !settings.sound) return;
    const play = () => {
      if (!ctx || ctx.state !== 'running') return;
      const t = ctx.currentTime + 0.02;
      tone(960, t, 0.38);
      tone(720, t + 0.42, 0.38);
    };
    play();
    sirenTimer = setInterval(play, 1100);
  }
  function stop() {
    clearInterval(sirenTimer);
    sirenTimer = null;
  }
  return { unlock, beeps, siren, stop };
})();
document.addEventListener('pointerdown', Sound.unlock, { passive: true });
document.addEventListener('keydown', Sound.unlock);

// 앱이 백그라운드일 때만 휴대폰 알림
async function notify(title, body) {
  if (!settings.notify || !document.hidden) return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) reg.showNotification(title, { body, tag: 'cane-' + Date.now(), icon: 'icons/icon-192.png' });
    else new Notification(title, { body });
  } catch { /* 무시 */ }
}

// =====================================================================
// 지도 (Leaflet + OpenStreetMap: 무료, API 키 필요 없음)
// =====================================================================
const map = L.map('map', { zoomControl: false }).setView([HOME.lat, HOME.lng], 17);
L.control.zoom({ position: 'topleft', zoomInTitle: '확대', zoomOutTitle: '축소' }).addTo(map);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> 기여자',
}).addTo(map);

const layers = {
  cane: L.marker([HOME.lat, HOME.lng], { keyboard: false, interactive: false, zIndexOffset: 1000 }),
  accuracy: L.circle([HOME.lat, HOME.lng], { radius: 5, className: 'lf-acc', interactive: false }),
  fence: null,
  fenceKey: '',
  trail: L.polyline([], { className: 'lf-trail', interactive: false }),
  draft: L.layerGroup(),
  eventPin: null,
};
let caneIconKey = '';

map.on('dragstart', () => { S.follow = false; scheduleRender(); });

// =====================================================================
// 서버 연결 (MQTT over WebSocket)
// =====================================================================
let client = null;

function disconnectMqtt() {
  if (client) {
    try { client.end(true); } catch { /* 무시 */ }
    client = null;
  }
}

function resetCaneData() {
  S.online = null;
  S.status = null;
  S.statusAt = 0;
  S.geofence = null;
  S.track = [];
  S.live = [];
  S.fallSince = 0;
  S.takeoverMin = false;
  S.fallMuted = false;
  S.pendingFence = null;
  Sound.stop();
}

function connectMqtt() {
  disconnectMqtt();
  S.source = 'mqtt';
  S.conn = 'connecting';
  S.connError = '';
  S.connStartedAt = Date.now();
  scheduleRender();

  if (typeof mqtt === 'undefined') {
    S.conn = 'error';
    S.connError = 'mqtt.min.js를 불러오지 못했습니다';
    return;
  }

  try {
    client = mqtt.connect(settings.broker, {
      clientId: 'guardian-' + Math.random().toString(16).slice(2, 10),
      clean: true,
      keepalive: 30,
      reconnectPeriod: 4000,
      connectTimeout: 10000,
    });
  } catch (err) {
    S.conn = 'error';
    S.connError = err.message;
    scheduleRender();
    return;
  }

  client.on('connect', () => {
    S.conn = 'connected';
    S.connError = '';
    client.subscribe(topic('+'), { qos: 1 });
    scheduleRender();
  });
  client.on('reconnect', () => { if (S.conn !== 'connected') S.conn = 'connecting'; scheduleRender(); });
  client.on('offline', () => { S.conn = 'connecting'; scheduleRender(); });
  client.on('close', () => { if (S.conn === 'connected') S.conn = 'connecting'; scheduleRender(); });
  client.on('error', (err) => { S.connError = err?.message || String(err); if (S.conn !== 'connected') S.conn = 'error'; scheduleRender(); });
  client.on('message', (t, payload, packet) => {
    const kind = t.split('/').pop();
    handleMessage(kind, payload.toString(), !!packet?.retain);
  });
}

function sendCommand(text) {
  if (S.source === 'demo') return Demo.command(text);
  if (!client || !client.connected) {
    toast('서버에 연결되어 있지 않아 명령을 보낼 수 없습니다');
    return false;
  }
  // 명령은 절대 retained로 보내지 않음 (지팡이가 재접속할 때마다 다시 실행되는 것 방지)
  client.publish(topic('cmd'), text, { qos: 1, retain: false });
  return true;
}

function statusAgeMs() {
  if (!S.status) return Infinity;
  const received = Date.now() - S.statusAt;
  if (S.status.ts > 0) return Math.max(received, Date.now() - S.status.ts * 1000);
  return received;
}
function isStale() {
  if (S.source === 'demo') return false;
  return S.online === false || statusAgeMs() > OFFLINE_AFTER_MS;
}
function canReachCane() {
  if (S.source === 'demo') return true;
  return !!client?.connected && !!S.status && !isStale();
}

// =====================================================================
// 받은 메시지 처리 (실제 지팡이와 데모가 같은 경로 사용)
// =====================================================================
function handleMessage(kind, text, retained) {
  if (kind === 'online') {
    S.online = text.trim() === '1';
    scheduleRender();
    return;
  }
  if (!['status', 'event', 'geofence', 'track'].includes(kind)) return;

  let data;
  try { data = JSON.parse(text); } catch {
    console.warn('JSON 해석 실패', kind, text);
    return;
  }

  if (kind === 'status') onStatus(data, retained);
  else if (kind === 'event') onEvent(data, retained);
  else if (kind === 'geofence') onGeofence(data);
  else if (kind === 'track') S.track = Array.isArray(data.pts) ? data.pts : [];

  scheduleRender();
}

function onStatus(st, retained) {
  const prevFall = S.status?.fall?.state;
  S.status = st;
  S.statusAt = Date.now();
  S.statusRetained = retained;
  if (!retained) S.online = true;

  const g = st.gps;
  if (g?.fix && !retained) {
    const last = S.live[S.live.length - 1];
    if (!last || distanceM(last[0], last[1], g.lat, g.lng) >= 3) {
      S.live.push([g.lat, g.lng, Date.now()]);
      if (S.live.length > 600) S.live.shift();
    }
  }

  const fall = st.fall?.state;
  if (fall !== prevFall) onFallTransition(prevFall, fall);
}

function onFallTransition(prev, next) {
  if (next === 'FALL_CONFIRMED') {
    S.fallSince = Date.now();
    S.fallMuted = false;
    S.takeoverMin = false;
    Sound.siren();
    vibrate([600, 200, 600, 200, 1200]);
  } else if (next === 'CANCEL_WINDOW') {
    Sound.beeps(3, 880);
    vibrate([300, 150, 300]);
  }
  if (prev === 'FALL_CONFIRMED' && next !== 'FALL_CONFIRMED') {
    Sound.stop();
    S.takeoverMin = false;
  }
}

function onEvent(ev, retained) {
  if (!ev || !ev.id || S.events.some((e) => e.id === ev.id)) return;
  const at = ev.ts > 0 ? ev.ts * 1000 : Date.now();
  const item = {
    id: ev.id,
    type: ev.type,
    title: ev.title || EVENT_TEXT[ev.type] || ev.type,
    msg: ev.msg || '',
    loc: ev.loc || 'none',
    lat: ev.lat,
    lng: ev.lng,
    at,
  };
  S.events.unshift(item);
  if (S.events.length > MAX_EVENTS) S.events.length = MAX_EVENTS;
  if (S.source === 'mqtt') store.set('events', S.events);
  if (S.tab !== 'log' && EVENT_LEVEL[item.type] !== 'off') S.unread++;

  const fresh = !retained && Date.now() - at < 120000;
  if (!fresh) return;

  if (item.type === 'GEOFENCE_EXIT') {
    Sound.beeps(2, 740);
    vibrate([250, 120, 250]);
  } else if (item.type === 'GEOFENCE_ENTER') {
    toast('안전구역으로 돌아왔습니다');
  } else if (item.type === 'FALL_CANCELED') {
    toast('지팡이 사용자가 경보를 취소했습니다');
  }
  if (['FALL_CONFIRMED', 'FALL_WARNING', 'GEOFENCE_EXIT'].includes(item.type)) {
    notify(item.title, item.msg);
  }
}

function fenceMatches(a, b) {
  if (!a || !b || a.type !== b.type) return false;
  const near = (x, y, tol) => Math.abs(x - y) < tol;
  if (a.type === 'circle') return near(a.lat, b.lat, 2e-6) && near(a.lng, b.lng, 2e-6) && near(a.r, b.r, 0.6);
  return a.pts.length === b.pts.length &&
    a.pts.every((p, i) => near(p[0], b.pts[i][0], 2e-6) && near(p[1], b.pts[i][1], 2e-6));
}

function onGeofence(g) {
  S.geofence = g;
  if (S.pendingFence && fenceMatches(g, S.pendingFence.fence)) {
    S.pendingFence = null;
    toast('안전구역을 지팡이에 적용했습니다');
    Draft.reset();
  } else if (!Draft.dirty) {
    Draft.reset();
  }
}

// =====================================================================
// 상태 판단 → 상태 띠
// =====================================================================
function computeLevel() {
  const st = S.status;
  const who = `${settings.name} 지팡이${S.source === 'demo' ? ' (데모)' : ''}`;

  if (!st) {
    if (S.source === 'mqtt' && S.conn === 'error') {
      return { level: 'off', icon: 'off', who, word: '서버 연결 실패', detail: '설정에서 서버 주소를 확인하세요' };
    }
    if (S.conn !== 'connected' && S.source === 'mqtt') {
      return { level: 'off', icon: 'search', who, word: '연결 중', detail: '서버에 연결하고 있습니다' };
    }
    return { level: 'off', icon: 'search', who, word: '기다리는 중', detail: '지팡이에서 아직 상태가 오지 않았습니다' };
  }

  const fall = st.fall?.state;
  const gps = st.gps || {};
  const geo = st.geo || {};

  if (fall === 'FALL_CONFIRMED') {
    return {
      level: 'alarm', icon: 'fall', who, word: '낙상 발생',
      detail: S.takeoverMin ? '여기를 눌러 경보 화면 다시 보기' : '지금 바로 확인이 필요합니다',
    };
  }
  if (fall === 'CANCEL_WINDOW') {
    const left = Math.max(0, Math.ceil((st.fall.cancelLeft || 0) / 1000));
    return {
      level: 'alarm', icon: 'fall', who, word: '낙상 의심',
      detail: `취소가 없으면 ${left}초 뒤 확정됩니다`,
      ring: { left, frac: Math.min(1, (st.fall.cancelLeft || 0) / 10000) },
    };
  }
  if (fall === 'MONITORING') {
    const dur = st.fall.duration || 10000;
    return {
      level: 'watch', icon: 'watch', who, word: '확인 중',
      detail: `${MODE_TEXT[st.fall.mode] || '낙상 여부 판정'} (${Math.round((st.fall.elapsed || 0) / 1000)}/${Math.round(dur / 1000)}초)`,
      progress: Math.min(1, (st.fall.elapsed || 0) / dur),
    };
  }
  if (isStale()) {
    return {
      level: 'off', icon: 'off', who, word: '연결 끊김',
      detail: `마지막 수신 ${fmtAgo(statusAgeMs())}. 지팡이 전원과 핫스팟을 확인하세요`,
    };
  }
  if (geo.state === 'OUTSIDE') {
    const where = geo.dist >= 0 ? `기준점에서 ${Math.round(geo.dist)} m 떨어져 있습니다` : '설정한 구역 밖에 있습니다';
    return { level: 'watch', icon: 'fence', who, word: '구역 이탈', detail: where };
  }
  if (fall === 'CALIBRATING') {
    return { level: 'ok', icon: 'ok', who, word: '준비 중', detail: '지팡이가 기준 자세를 잡고 있습니다' };
  }
  if (!gps.fix) {
    return {
      level: 'ok', icon: 'ok', who, word: '정상',
      detail: gps.ever ? `GPS 신호 없음, 실내일 수 있습니다 (마지막 위치 ${fmtAgo(gps.age + (Date.now() - S.statusAt))})` : 'GPS 위성을 찾는 중입니다',
    };
  }
  const inside = geo.state === 'INSIDE'
    ? (geo.dist >= 0 ? `안전구역 안, 기준점에서 ${Math.round(geo.dist)} m` : '안전구역 안')
    : '안전구역 판정 대기';
  return { level: 'ok', icon: 'ok', who, word: '정상', detail: inside };
}

const RING_C = 2 * Math.PI * 25;
let lastThemeColor = '';

function renderBand(L0) {
  const app = $('app');
  app.dataset.level = L0.level;
  if ($('bandIcon').dataset.icon !== L0.icon) {
    $('bandIcon').innerHTML = ICONS[L0.icon];
    $('bandIcon').dataset.icon = L0.icon;
  }
  $('bandWho').textContent = L0.who;
  $('bandWord').textContent = L0.word;
  $('bandDetail').textContent = L0.detail;

  $('bandRing').hidden = !L0.ring;
  if (L0.ring) {
    $('bandRingText').textContent = L0.ring.left;
    $('bandRingFill').setAttribute('stroke-dashoffset', String(RING_C * (1 - L0.ring.frac)));
  }
  $('bandProgress').hidden = L0.progress == null;
  if (L0.progress != null) $('bandProgressFill').style.width = `${(L0.progress * 100).toFixed(1)}%`;

  const color = getComputedStyle(app).getPropertyValue('--state').trim();
  if (color && color !== lastThemeColor) {
    lastThemeColor = color;
    document.querySelector('meta[name="theme-color"]').setAttribute('content', color);
  }
}

// =====================================================================
// 낙상 전체 화면
// =====================================================================
function syncAlarm() {
  const confirmed = S.status?.fall?.state === 'FALL_CONFIRMED';
  if (confirmed && !S.fallMuted && settings.sound) Sound.siren();
  else Sound.stop();
}

function renderTakeover() {
  const st = S.status;
  const confirmed = st?.fall?.state === 'FALL_CONFIRMED';
  const show = confirmed && !S.takeoverMin;
  $('takeover').hidden = !show;
  if (!show) return;

  if ($('toIcon').dataset.icon !== 'fall') {
    $('toIcon').innerHTML = ICONS.fall;
    $('toIcon').dataset.icon = 'fall';
  }
  const ev = S.events.find((e) => e.type === 'FALL_CONFIRMED');
  const since = ev ? ev.at : S.fallSince;
  $('toWhen').textContent = since ? `${fmtWhen(since)} (${fmtAgo(Date.now() - since)})` : '';

  const g = st.gps || {};
  if (g.ever) {
    const where = g.fix ? '실시간 GPS 위치' : `마지막 확인 위치, ${fmtAgo(g.age + (Date.now() - S.statusAt))}`;
    $('toWhere').innerHTML = `<strong>${esc(fmtCoord(g.lat, g.lng))}</strong><span>${esc(where)}</span>`;
    $('toKakao').href = kakaoUrl(g.lat, g.lng);
    $('toKakao').hidden = false;
  } else {
    $('toWhere').textContent = 'GPS 위치 없음. 실내일 수 있으니 지팡이 경보음을 따라 찾아 주세요';
    $('toKakao').hidden = true;
  }
  const phone = settings.phone.replace(/[^0-9+]/g, '');
  $('toCallPerson').hidden = !phone;
  if (phone) $('toCallPerson').href = `tel:${phone}`;
  $('toMute').textContent = S.fallMuted || !settings.sound ? '경보음 꺼짐' : '경보음 끄기';
  $('toMute').disabled = S.fallMuted || !settings.sound;
}

// =====================================================================
// 상태 탭
// =====================================================================
function renderStatus() {
  const st = S.status;
  const set = (id, html) => { const el = $(id); if (el.innerHTML !== html) el.innerHTML = html; };

  if (!st) {
    ['sGps', 'sCoord', 'sAcc', 'sFence', 'sFall', 'sLastEvent', 'sImu', 'sBat', 'sRssi',
      'dShock', 'dTilt', 'dSats', 'dHdop', 'dTtff', 'dChars', 'dFw', 'dUp'].forEach((id) => set(id, '-'));
    set('sOnline', S.source === 'mqtt' && S.conn === 'connected' ? chip('지팡이 응답 없음', 'off') : chip('서버 연결 전', 'off'));
    setMapLinks(null);
    return;
  }

  const g = st.gps || {};
  const geo = st.geo || {};
  const sinceStatus = Date.now() - S.statusAt;

  if (g.fix) set('sGps', `${chip('수신 중', 'ok')} <span class="sub">위성 ${g.sats}개</span>`);
  else if (g.ever) set('sGps', `${chip('신호 끊김', 'watch')} <span class="sub">마지막 위치 ${fmtAgo(g.age + sinceStatus)}</span>`);
  else set('sGps', `${chip('위성 찾는 중', 'off')} <span class="sub">위성 ${g.sats}개</span>`);

  set('sCoord', g.ever ? esc(fmtCoord(g.lat, g.lng)) : '-');

  if (g.fix && g.hdop < 50) {
    const quality = g.hdop <= 1 ? '매우 좋음' : g.hdop <= 2 ? '좋음' : g.hdop <= 5 ? '보통' : '나쁨';
    set('sAcc', `${esc(quality)} <span class="sub">약 ±${Math.max(2, Math.round(g.hdop * 3))} m 추정 (HDOP ${g.hdop.toFixed(1)})</span>`);
  } else set('sAcc', '-');

  const fenceDesc = geo.type === 'polygon' ? '다각형 구역' : `반경 ${Math.round(geo.r)} m`;
  if (geo.state === 'INSIDE') {
    set('sFence', `${chip('구역 안', 'ok')} <span class="sub">${geo.dist >= 0 ? `기준점에서 ${Math.round(geo.dist)} m, ` : ''}${esc(fenceDesc)}</span>`);
  } else if (geo.state === 'OUTSIDE') {
    set('sFence', `${chip('이탈', 'watch')} <span class="sub">${geo.dist >= 0 ? `기준점에서 ${Math.round(geo.dist)} m, ` : ''}${esc(fenceDesc)}</span>`);
  } else {
    set('sFence', `${chip('판정 대기', 'off')} <span class="sub">${esc(fenceDesc)}</span>`);
  }

  if (S.source === 'demo') set('sOnline', `${chip('데모 실행 중', 'ok')} <span class="sub">가상 지팡이</span>`);
  else if (isStale()) set('sOnline', `${chip('응답 없음', 'off')} <span class="sub">마지막 수신 ${fmtAgo(statusAgeMs())}</span>`);
  else set('sOnline', `${chip('연결됨', 'ok')} <span class="sub">${fmtAgo(statusAgeMs())} 갱신</span>`);

  const [fallText, fallLevel] = FALL_TEXT[st.fall?.state] || [st.fall?.state || '-', 'off'];
  const modeText = st.fall?.state === 'MONITORING' ? MODE_TEXT[st.fall.mode] : '';
  set('sFall', `${chip(fallText, fallLevel)}${modeText ? ` <span class="sub">${esc(modeText)}</span>` : ''}`);
  set('sLastEvent', esc(st.fall?.event || '-'));

  if (!st.imu?.ok) set('sImu', chip('연결 안 됨', 'alarm'));
  else if (!st.imu?.data) set('sImu', chip('데이터 없음', 'watch'));
  else set('sImu', chip('정상', 'ok'));

  if (st.bat && st.bat.pct >= 0) {
    const lvl = st.bat.pct <= 15 ? 'alarm' : st.bat.pct <= 30 ? 'watch' : 'ok';
    set('sBat', `${chip(`${st.bat.pct}%`, lvl)} <span class="sub">${st.bat.v.toFixed(2)} V</span>`);
  } else {
    set('sBat', '<span class="sub">측정 회로 연결 전</span>');
  }

  const rssi = st.rssi;
  if (rssi && rssi < 0) {
    const [t, l] = rssi >= -60 ? ['강함', 'ok'] : rssi >= -70 ? ['보통', 'ok'] : rssi >= -80 ? ['약함', 'watch'] : ['매우 약함', 'alarm'];
    set('sRssi', `${chip(t, l)} <span class="sub">${rssi} dBm</span>`);
  } else set('sRssi', '-');

  set('dShock', (st.fall?.shock ?? 0).toFixed(3));
  set('dTilt', `${(st.fall?.tilt ?? 0).toFixed(1)}° (최대 ${(st.fall?.maxTilt ?? 0).toFixed(1)}°)`);
  set('dSats', String(g.sats ?? '-'));
  set('dHdop', g.hdop >= 50 ? '측정 전' : (g.hdop ?? 0).toFixed(2));
  set('dTtff', g.ever ? `${g.ttff}초` : '아직 수신 전');
  set('dChars', `${g.chars ?? 0} <span class="sub">체크섬 오류 ${g.bad ?? 0}</span>`);
  set('dFw', esc(st.fw || '-'));
  set('dUp', fmtDuration(st.up || 0));

  setMapLinks(g.ever ? g : null);
}

function setMapLinks(g) {
  for (const [id, fn] of [['lnkKakao', kakaoUrl], ['lnkGoogle', googleUrl]]) {
    const a = $(id);
    if (g) {
      a.href = fn(g.lat, g.lng);
      a.removeAttribute('aria-disabled');
      a.style.pointerEvents = '';
      a.style.opacity = '';
    } else {
      a.href = '#';
      a.setAttribute('aria-disabled', 'true');
      a.style.pointerEvents = 'none';
      a.style.opacity = '.45';
    }
  }
}

// =====================================================================
// 기록 탭
// =====================================================================
let lastLogKey = '';
function renderLog() {
  $('setTrail').checked = S.showTrail;
  const badge = $('logBadge');
  badge.hidden = S.unread === 0;
  badge.textContent = S.unread > 99 ? '99+' : String(S.unread);

  const key = S.events.length + ':' + (S.events[0]?.id || '') + ':' + Math.floor(Date.now() / 30000);
  if (key === lastLogKey) return;
  lastLogKey = key;

  $('logEmpty').hidden = S.events.length > 0;
  $('logList').innerHTML = S.events.map((e, i) => {
    const level = EVENT_LEVEL[e.type] || 'off';
    const hasLoc = e.loc !== 'none' && e.lat && e.lng;
    return `<li>
      <span class="mark ${level}" aria-hidden="true"></span>
      <div>
        <div class="title">${esc(e.title)}</div>
        ${e.msg ? `<div class="msg">${esc(e.msg)}</div>` : ''}
        <div class="when num">${esc(fmtWhen(e.at))}, ${esc(fmtAgo(Date.now() - e.at))}${e.loc === 'last' ? ', 마지막 확인 위치 기준' : ''}</div>
      </div>
      ${hasLoc ? `<button class="btn go" type="button" data-i="${i}">지도</button>` : '<span></span>'}
    </li>`;
  }).join('');
}

$('logList').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-i]');
  if (!btn) return;
  const ev = S.events[Number(btn.dataset.i)];
  if (!ev) return;
  if (layers.eventPin) layers.eventPin.remove();
  layers.eventPin = L.marker([ev.lat, ev.lng], {
    icon: L.divIcon({ className: '', html: '<div class="event-pin"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }),
    title: ev.title,
  }).addTo(map).bindTooltip(`${ev.title}, ${fmtWhen(ev.at)}`, { direction: 'top', offset: [0, -10] }).openTooltip();
  S.follow = false;
  map.setView([ev.lat, ev.lng], Math.max(map.getZoom(), 18));
  scheduleRender();
});

// =====================================================================
// 안전구역 편집
// =====================================================================
const Draft = {
  type: 'circle', lat: HOME.lat, lng: HOME.lng, r: 30, pts: [], dirty: false,

  reset() {
    const f = S.geofence;
    if (f?.type === 'polygon' && Array.isArray(f.pts)) {
      this.type = 'polygon';
      this.pts = f.pts.map((p) => [p[0], p[1]]);
    } else if (f?.type === 'circle') {
      this.type = 'circle';
      this.lat = f.lat; this.lng = f.lng; this.r = f.r;
      this.pts = [];
    }
    this.dirty = false;
  },

  toFence() {
    if (this.type === 'circle') {
      return { type: 'circle', lat: +this.lat.toFixed(6), lng: +this.lng.toFixed(6), r: Math.round(this.r) };
    }
    return { type: 'polygon', pts: this.pts.map((p) => [+p[0].toFixed(6), +p[1].toFixed(6)]) };
  },
};

function fenceToCommand(f) {
  if (f.type === 'circle') return `GEOFENCE_CIRCLE,${f.lat.toFixed(6)},${f.lng.toFixed(6)},${f.r}`;
  return `GEOFENCE_POLYGON,${f.pts.map((p) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`).join(',')}`;
}

const vertexIcon = () => L.divIcon({ className: '', html: '<div class="vertex-pin"></div>', iconSize: [16, 16], iconAnchor: [8, 8] });

function renderDraft() {
  layers.draft.clearLayers();
  if (S.tab !== 'fence') {
    layers.draft.remove();
    return;
  }
  layers.draft.addTo(map);

  if (Draft.type === 'circle') {
    const circle = L.circle([Draft.lat, Draft.lng], { radius: Draft.r, className: 'lf-draft', interactive: false });
    const center = L.marker([Draft.lat, Draft.lng], { icon: vertexIcon(), draggable: true, title: '끌어서 중심 옮기기' });
    center.on('drag', (e) => {
      const p = e.target.getLatLng();
      Draft.lat = p.lat; Draft.lng = p.lng; Draft.dirty = true;
      circle.setLatLng(p);
    });
    layers.draft.addLayer(circle).addLayer(center);
  } else {
    if (Draft.pts.length >= 2) {
      layers.draft.addLayer(L.polygon(Draft.pts, { className: 'lf-draft', interactive: false }));
    }
    Draft.pts.forEach((p, i) => {
      const m = L.marker(p, { icon: vertexIcon(), draggable: true, title: `꼭짓점 ${i + 1}` });
      m.on('dragend', (e) => {
        const ll = e.target.getLatLng();
        Draft.pts[i] = [ll.lat, ll.lng];
        Draft.dirty = true;
        renderFencePanel();
        renderDraft();
      });
      layers.draft.addLayer(m);
    });
  }
}

function renderFencePanel() {
  const isCircle = Draft.type === 'circle';
  $('fenceCircle').setAttribute('aria-checked', String(isCircle));
  $('fencePolygon').setAttribute('aria-checked', String(!isCircle));
  $('circleTools').hidden = !isCircle;
  $('polygonTools').hidden = isCircle;

  if (document.activeElement !== $('fenceRadiusNum')) $('fenceRadiusNum').value = Math.round(Draft.r);
  $('fenceRadius').value = Math.min(500, Math.max(10, Draft.r));
  $('polyCount').textContent = `꼭짓점 ${Draft.pts.length}개${Draft.pts.length < 3 ? ' (3개 이상 필요)' : ''}`;
  $('btnCenterHere').disabled = !S.status?.gps?.ever;

  const f = S.geofence;
  let current = '아직 받지 못했습니다';
  if (f?.type === 'circle') current = `원형, 반경 ${Math.round(f.r)} m (${fmtCoord(f.lat, f.lng)})`;
  else if (f?.type === 'polygon') current = `다각형, 꼭짓점 ${f.pts.length}개`;
  $('fenceCurrent').textContent = `지팡이에 저장된 안전구역: ${current}${S.pendingFence ? ' (변경 적용 중)' : ''}`;
  $('btnApplyFence').disabled = !!S.pendingFence;
}

map.on('click', (e) => {
  if (S.tab !== 'fence') return;
  if (Draft.type === 'circle') {
    Draft.lat = e.latlng.lat;
    Draft.lng = e.latlng.lng;
  } else {
    if (Draft.pts.length >= MAX_POLYGON_POINTS) {
      toast(`꼭짓점은 최대 ${MAX_POLYGON_POINTS}개까지 찍을 수 있습니다`);
      return;
    }
    Draft.pts.push([e.latlng.lat, e.latlng.lng]);
  }
  Draft.dirty = true;
  renderFencePanel();
  renderDraft();
});

function setDraftType(type) {
  if (Draft.type === type) return;
  Draft.type = type;
  if (type === 'polygon' && Draft.pts.length === 0 && S.geofence?.type === 'polygon') {
    Draft.pts = S.geofence.pts.map((p) => [p[0], p[1]]);
  }
  Draft.dirty = true;
  renderFencePanel();
  renderDraft();
  updateMapHint();
}
$('fenceCircle').addEventListener('click', () => setDraftType('circle'));
$('fencePolygon').addEventListener('click', () => setDraftType('polygon'));

function setRadius(v) {
  const r = Math.min(5000, Math.max(5, Number(v) || 0));
  Draft.r = r;
  Draft.dirty = true;
  renderFencePanel();
  renderDraft();
}
$('fenceRadius').addEventListener('input', (e) => setRadius(e.target.value));
$('fenceRadiusNum').addEventListener('change', (e) => setRadius(e.target.value));

$('btnCenterHere').addEventListener('click', () => {
  const g = S.status?.gps;
  if (!g?.ever) return;
  Draft.lat = g.lat;
  Draft.lng = g.lng;
  Draft.dirty = true;
  map.setView([g.lat, g.lng], Math.max(map.getZoom(), 17));
  renderFencePanel();
  renderDraft();
});
$('btnPolyUndo').addEventListener('click', () => { Draft.pts.pop(); Draft.dirty = true; renderFencePanel(); renderDraft(); });
$('btnPolyClear').addEventListener('click', () => { Draft.pts = []; Draft.dirty = true; renderFencePanel(); renderDraft(); });
$('btnRevertFence').addEventListener('click', () => {
  Draft.reset();
  renderFencePanel();
  renderDraft();
  toast('지팡이에 저장된 설정으로 되돌렸습니다');
});

$('btnApplyFence').addEventListener('click', () => {
  if (Draft.type === 'polygon' && Draft.pts.length < 3) {
    toast('지도를 눌러 꼭짓점을 3개 이상 찍어 주세요');
    return;
  }
  if (!canReachCane()) {
    toast('지팡이가 연결되어 있지 않아 적용할 수 없습니다. 지팡이 전원과 핫스팟을 확인하세요.', 5000);
    return;
  }
  const fence = Draft.toFence();
  if (!sendCommand(fenceToCommand(fence))) return;

  const pending = { fence, at: Date.now() };
  S.pendingFence = pending;
  toast('지팡이에 보내는 중입니다');
  renderFencePanel();
  setTimeout(() => {
    if (S.pendingFence === pending) {
      S.pendingFence = null;
      toast('지팡이가 응답하지 않습니다. 연결 상태를 확인하고 다시 시도하세요.', 5000);
      renderFencePanel();
    }
  }, 9000);
});

$('btnFitFence').addEventListener('click', () => {
  const f = S.geofence;
  if (!f) { toast('아직 안전구역 정보를 받지 못했습니다'); return; }
  S.follow = false;
  if (f.type === 'circle') map.fitBounds(L.latLng(f.lat, f.lng).toBounds(f.r * 2.4));
  else map.fitBounds(L.latLngBounds(f.pts).pad(0.2));
  scheduleRender();
});

// =====================================================================
// 지도 그리기
// =====================================================================
function renderMap(level) {
  const st = S.status;
  const g = st?.gps;

  if (g?.ever) {
    const ll = [g.lat, g.lng];
    const stale = !g.fix || isStale();
    const key = `${level}|${stale}`;
    if (key !== caneIconKey) {
      caneIconKey = key;
      layers.cane.setIcon(L.divIcon({
        className: '',
        html: `<div class="cane-pin" data-level="${level}" data-stale="${stale}"><i></i></div>`,
        iconSize: [26, 26],
        iconAnchor: [13, 13],
      }));
    }
    layers.cane.setLatLng(ll);
    if (!map.hasLayer(layers.cane)) {
      layers.cane.addTo(map);
      if (S.follow) map.setView(ll, 18);
    }

    if (g.fix && g.hdop < 50) {
      layers.accuracy.setLatLng(ll).setRadius(Math.max(2, g.hdop * 3));
      if (!map.hasLayer(layers.accuracy)) layers.accuracy.addTo(map);
    } else if (map.hasLayer(layers.accuracy)) {
      layers.accuracy.remove();
    }

    if (S.follow && !map.getBounds().pad(-0.3).contains(ll)) map.panTo(ll);
  } else {
    layers.cane.remove();
    layers.accuracy.remove();
  }

  // 안전구역
  const f = S.geofence;
  const outside = st?.geo?.state === 'OUTSIDE';
  const fenceKey = f ? JSON.stringify(f) + outside : '';
  if (fenceKey !== layers.fenceKey) {
    layers.fenceKey = fenceKey;
    if (layers.fence) layers.fence.remove();
    layers.fence = null;
    const cls = `lf-fence${outside ? ' out' : ''}`;
    if (f?.type === 'circle') layers.fence = L.circle([f.lat, f.lng], { radius: f.r, className: cls, interactive: false });
    else if (f?.type === 'polygon' && f.pts?.length >= 3) layers.fence = L.polygon(f.pts, { className: cls, interactive: false });
    if (layers.fence) layers.fence.addTo(map);
  }

  // 이동 경로: 지팡이가 기억한 경로 중 앱을 켜기 전 부분 + 앱이 켜진 뒤 받은 촘촘한 경로
  if (S.showTrail) {
    const liveStart = S.live.length ? S.live[0][2] : Infinity;
    const older = S.track.filter((p) => (S.live.length === 0) || (p[2] > 0 && p[2] * 1000 < liveStart));
    const pts = older.map((p) => [p[0], p[1]]).concat(S.live.map((p) => [p[0], p[1]]));
    layers.trail.setLatLngs(pts);
    if (!map.hasLayer(layers.trail)) layers.trail.addTo(map);
  } else {
    layers.trail.remove();
  }

  $('btnFollow').setAttribute('aria-pressed', String(S.follow));
}

function updateMapHint() {
  const hint = $('mapHint');
  if (S.tab === 'fence') {
    hint.textContent = Draft.type === 'circle' ? '지도를 눌러 중심 정하기' : '지도를 눌러 꼭짓점 찍기';
    hint.hidden = false;
  } else {
    hint.hidden = true;
  }
}

function renderEmpty() {
  const show = S.source === 'mqtt' && !S.status && !S.emptyDismissed &&
    (S.conn === 'error' || Date.now() - S.connStartedAt > 4000);
  $('emptyState').hidden = !show;
  if (!show) return;
  if (S.conn === 'error' || S.conn === 'connecting') {
    $('emptyTitle').textContent = '서버에 연결하지 못했습니다';
    $('emptyText').textContent = `서버 주소(${settings.broker})와 인터넷 연결을 확인하세요.${S.connError ? ` 오류: ${S.connError}` : ''}`;
  } else {
    $('emptyTitle').textContent = '지팡이 위치를 기다리고 있습니다';
    $('emptyText').textContent = `서버에는 연결되었습니다. 지팡이(기기 ID ${settings.deviceId})가 켜져 있고 휴대폰 핫스팟에 연결되면 이곳에 위치가 나타납니다.`;
  }
}

// =====================================================================
// 설정 탭
// =====================================================================
function shareUrl() {
  const q = new URLSearchParams({ device: settings.deviceId, broker: settings.broker, topic: settings.ntfyTopic, name: settings.name });
  return `${location.origin}${location.pathname}?${q}`;
}

function fillSettingsForm() {
  $('setName').value = settings.name;
  $('setDevice').value = settings.deviceId;
  $('setBroker').value = settings.broker;
  $('setPhone').value = settings.phone;
  $('setTopic').value = settings.ntfyTopic;
  $('setSound').checked = settings.sound;
  $('setNotify').checked = settings.notify && 'Notification' in window && Notification.permission === 'granted';
}

function renderSettings() {
  const text = {
    idle: '대기',
    connecting: '연결 중',
    connected: '연결됨',
    error: `연결 실패${S.connError ? ` (${S.connError})` : ''}`,
  }[S.conn];
  const line = S.source === 'demo' ? '데모 실행 중, 서버 연결 쉼' : `서버 ${text}, 기기 ${settings.deviceId}`;
  if ($('connLine').textContent !== line) $('connLine').textContent = line;
  $('ntfyTopicText').textContent = settings.ntfyTopic;
  $('lnkNtfy').href = `https://ntfy.sh/${encodeURIComponent(settings.ntfyTopic)}`;
  $('shareLink').textContent = shareUrl();
  $('btnDemo').textContent = S.source === 'demo' ? '데모 끝내고 실제 지팡이 연결' : '데모 시작';
}

$('formConn').addEventListener('submit', (e) => {
  e.preventDefault();
  const deviceId = $('setDevice').value.trim();
  const broker = $('setBroker').value.trim();
  if (!/^wss?:\/\//.test(broker)) {
    toast('서버 주소는 wss:// 로 시작해야 합니다');
    return;
  }
  const deviceChanged = deviceId !== settings.deviceId;
  settings.name = $('setName').value.trim() || DEFAULTS.name;
  settings.deviceId = deviceId;
  settings.broker = broker;
  settings.phone = $('setPhone').value.trim();
  saveSettings();
  if (deviceChanged) {
    S.events = [];
    store.set('events', []);
  }
  if (S.source === 'demo') Demo.stop();
  resetCaneData();
  S.emptyDismissed = false;
  connectMqtt();
  toast('저장했습니다. 다시 연결합니다');
});

$('setTopic').addEventListener('change', (e) => {
  settings.ntfyTopic = e.target.value.trim() || DEFAULTS.ntfyTopic;
  saveSettings();
  scheduleRender();
});
$('setSound').addEventListener('change', (e) => {
  settings.sound = e.target.checked;
  saveSettings();
  Sound.unlock();
  syncAlarm();
});
$('setNotify').addEventListener('change', async (e) => {
  if (e.target.checked) {
    if (!('Notification' in window)) {
      toast('이 브라우저는 알림을 지원하지 않습니다');
      e.target.checked = false;
      return;
    }
    const p = await Notification.requestPermission();
    if (p !== 'granted') {
      toast('알림 권한이 거부되었습니다. 브라우저 설정에서 허용해 주세요');
      e.target.checked = false;
    }
  }
  settings.notify = e.target.checked;
  saveSettings();
});
$('btnTestSound').addEventListener('click', () => {
  Sound.unlock();
  if (!settings.sound) { toast('경보음이 꺼져 있습니다'); return; }
  Sound.beeps(3, 880);
  vibrate([200, 100, 200]);
});
$('btnCopyTopic').addEventListener('click', () => copyText(settings.ntfyTopic, $('ntfyTopicText')));
$('btnCopyShare').addEventListener('click', () => copyText(shareUrl(), $('shareLink')));
$('btnDemo').addEventListener('click', () => {
  if (S.source === 'demo') {
    Demo.stop();
    resetCaneData();
    connectMqtt();
  } else {
    Demo.start();
    switchTab('status');
  }
});
$('btnEmptyDemo').addEventListener('click', () => Demo.start());
$('btnEmptySettings').addEventListener('click', () => { S.emptyDismissed = true; switchTab('settings'); });

// 원격 조작
armButton($('btnRecal'), () => {
  if (!canReachCane()) { toast('지팡이가 연결되어 있지 않습니다'); return; }
  if (sendCommand('RECALIBRATE')) toast('기준 자세를 다시 잡도록 보냈습니다');
});
armButton($('btnReset'), () => {
  if (!canReachCane()) { toast('지팡이가 연결되어 있지 않습니다'); return; }
  if (sendCommand('RESET_FALL')) toast('낙상 판정 초기화를 보냈습니다');
});
armButton($('btnClearLog'), () => {
  S.events = [];
  S.unread = 0;
  if (S.source === 'mqtt') store.set('events', []);
  if (layers.eventPin) { layers.eventPin.remove(); layers.eventPin = null; }
  lastLogKey = '';
  scheduleRender();
});
$('setTrail').addEventListener('change', (e) => {
  S.showTrail = e.target.checked;
  store.set('showTrail', S.showTrail);
  scheduleRender();
});

// 낙상 화면 버튼
$('toMute').addEventListener('click', () => { S.fallMuted = true; Sound.stop(); renderTakeover(); });
$('toMap').addEventListener('click', () => { S.takeoverMin = true; S.follow = true; scheduleRender(); });
armButton($('toResolve'), () => {
  S.fallMuted = true;
  Sound.stop();
  if (canReachCane() && sendCommand('RESET_FALL')) {
    toast('지팡이 경보를 해제했습니다');
  } else {
    S.takeoverMin = true;
    toast('지팡이와 연결되지 않아 원격 해제를 못 했습니다. 현장에서 지팡이 버튼으로 해제하세요.', 6000);
  }
  scheduleRender();
});
$('band').addEventListener('click', () => {
  if (S.status?.fall?.state === 'FALL_CONFIRMED' && S.takeoverMin) {
    S.takeoverMin = false;
    scheduleRender();
  }
});
$('btnFollow').addEventListener('click', () => {
  S.follow = true;
  const g = S.status?.gps;
  if (g?.ever) map.setView([g.lat, g.lng], Math.max(map.getZoom(), 17));
  else toast('아직 지팡이 위치를 받지 못했습니다');
  scheduleRender();
});

// =====================================================================
// 탭 전환
// =====================================================================
function switchTab(tab) {
  if (S.tab === tab) return;
  S.tab = tab;
  document.querySelectorAll('.tabs [role="tab"]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  ['status', 'log', 'fence', 'settings'].forEach((t) => { $(`panel-${t}`).hidden = t !== tab; });
  $('sheet').scrollTop = 0;
  if (tab === 'log') S.unread = 0;
  if (tab === 'fence' && !Draft.dirty) Draft.reset();
  if (tab === 'settings') fillSettingsForm();
  renderFencePanel();
  renderDraft();
  updateMapHint();
  scheduleRender();
  requestAnimationFrame(() => map.invalidateSize());
}
document.querySelectorAll('.tabs [role="tab"]').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));

// =====================================================================
// 전체 그리기
// =====================================================================
let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}
function render() {
  const level = computeLevel();
  renderBand(level);
  renderStatus();
  renderLog();
  renderMap(level.level);
  renderTakeover();
  renderEmpty();
  if (S.tab === 'fence') renderFencePanel();
  if (S.tab === 'settings') renderSettings();
  syncAlarm();
}
setInterval(scheduleRender, 1000);
window.addEventListener('resize', () => map.invalidateSize());

// =====================================================================
// 데모: 가상 지팡이 (실제 펌웨어와 같은 형식의 메시지를 만들어 냄)
// =====================================================================
const Demo = (() => {
  // [동쪽 m, 북쪽 m] - 기준점(4호관)을 한 바퀴 돌며 30 m 안전구역을 잠깐 벗어남
  const ROUTE = [[-6, -4], [12, -10], [24, -2], [34, 10], [46, 22], [36, 36], [16, 30], [4, 14], [-4, 2]];
  const STEP_M = 2.4;
  const mPerLat = 111320;
  const mPerLng = 111320 * Math.cos(HOME.lat * Math.PI / 180);
  const toLL = ([e, n]) => [HOME.lat + n / mPerLat, HOME.lng + e / mPerLng];

  let timer = null;
  let d;  // 데모 상태

  function fresh() {
    return {
      tick: 0, phase: 'boot', phaseTick: 0, seg: 0, segPos: 0,
      pos: toLL(ROUTE[0]), fix: false, ever: false, ttff: 0, sats: 0, hdop: 99.9,
      fence: { type: 'circle', lat: HOME.lat, lng: HOME.lng, r: 30 }, fenceVer: 1,
      geoState: 'UNKNOWN', cand: 'UNKNOWN', candCount: 0, dist: -1,
      fall: 'CALIBRATING', mode: 'NONE', lastEvent: '기준 자세 설정 시작', elapsed: 0, cancelLeft: 0,
      shock: 0.02, tilt: 2, maxTilt: 0, seq: 0, boot: Math.random().toString(16).slice(2, 6),
      track: [], calibLeft: 3,
    };
  }

  const emit = (kind, obj) => handleMessage(kind, typeof obj === 'string' ? obj : JSON.stringify(obj), false);

  function event(type, msg) {
    d.seq += 1;
    emit('event', {
      id: `demo-${d.boot}-${d.seq}`, type, title: EVENT_TEXT[type], msg,
      loc: d.ever ? (d.fix ? 'fresh' : 'last') : 'none',
      lat: d.ever ? +d.pos[0].toFixed(6) : 0, lng: d.ever ? +d.pos[1].toFixed(6) : 0,
      ts: Math.floor(Date.now() / 1000), up: d.tick * 1000,
    });
  }

  function setFall(next) {
    const prev = d.fall;
    d.fall = next;
    // 펌웨어 reportStateChanges()와 같은 규칙
    if (next === 'MONITORING') event('FALL_SUSPECTED', d.lastEvent);
    else if (next === 'CANCEL_WINDOW') event('FALL_WARNING', d.lastEvent);
    else if (next === 'FALL_CONFIRMED') event('FALL_CONFIRMED', '지팡이 사용자가 넘어진 뒤 움직임이 없고 경보도 취소되지 않았습니다.');
    else if (next === 'NORMAL' && prev === 'CANCEL_WINDOW') event('FALL_CANCELED', d.lastEvent);
    else if (next === 'NORMAL' && prev === 'FALL_CONFIRMED') event('FALL_RESET', d.lastEvent);
    else if (next === 'NORMAL' && prev === 'MONITORING') event('FALL_CLEARED', d.lastEvent);
  }

  // 펌웨어 GPSManager와 같은 지오펜싱 판정 (히스테리시스 5 m + 3회 연속 확인)
  function evaluateFence() {
    const f = d.fence;
    const [lat, lng] = d.pos;
    let raw;
    if (f.type === 'circle') {
      d.dist = distanceM(f.lat, f.lng, lat, lng);
      if (d.geoState === 'OUTSIDE') raw = d.dist < Math.max(f.r - 5, f.r * 0.5) ? 'INSIDE' : 'OUTSIDE';
      else raw = d.dist > f.r ? 'OUTSIDE' : 'INSIDE';
    } else {
      d.dist = -1;
      raw = pointInPolygon(lat, lng, f.pts) ? 'INSIDE' : 'OUTSIDE';
    }
    if (raw === d.geoState) { d.candCount = 0; return; }
    if (raw !== d.cand) { d.cand = raw; d.candCount = 1; } else d.candCount += 1;
    if (d.geoState === 'UNKNOWN' || d.candCount >= 3) {
      const prev = d.geoState;
      d.geoState = raw;
      d.candCount = 0;
      if (raw === 'OUTSIDE') {
        event('GEOFENCE_EXIT', d.dist >= 0 ? `안전구역을 벗어났습니다 (기준점에서 ${Math.round(d.dist)} m)` : '설정한 안전구역(다각형)을 벗어났습니다');
      } else if (raw === 'INSIDE' && prev === 'OUTSIDE') {
        event('GEOFENCE_ENTER', '안전구역으로 돌아왔습니다');
      }
    }
  }

  function walk() {
    let remaining = STEP_M;
    while (remaining > 0 && d.seg < ROUTE.length - 1) {
      const a = ROUTE[d.seg];
      const b = ROUTE[d.seg + 1];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const left = len - d.segPos;
      if (remaining < left) { d.segPos += remaining; remaining = 0; } else { remaining -= left; d.seg += 1; d.segPos = 0; }
    }
    const a = ROUTE[d.seg];
    const b = ROUTE[Math.min(d.seg + 1, ROUTE.length - 1)];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const t = d.segPos / len;
    const noise = () => (Math.random() - 0.5) * 2.4;
    d.pos = toLL([a[0] + (b[0] - a[0]) * t + noise(), a[1] + (b[1] - a[1]) * t + noise()]);
    return d.seg >= ROUTE.length - 1;
  }

  function step() {
    d.tick += 1;
    d.phaseTick += 1;
    d.shock = 0.03 + Math.random() * 0.12;
    d.tilt = 4 + Math.random() * 10;

    // GPS: 처음 4초는 위성 탐색
    if (!d.ever) {
      d.sats = Math.min(7, d.tick * 2);
      if (d.tick >= 4) {
        d.ever = true; d.fix = true; d.ttff = d.tick; d.sats = 9; d.hdop = 1.1;
        event('GPS_FIX', 'GPS 위치 수신 중');
      }
    } else {
      d.sats = 8 + Math.floor(Math.random() * 4);
      d.hdop = 0.9 + Math.random() * 0.5;
    }

    // 기준 자세 보정
    if (d.fall === 'CALIBRATING') {
      d.calibLeft -= 1;
      if (d.calibLeft <= 0) { d.lastEvent = '기준 자세 설정 완료'; setFall('NORMAL'); }
    }

    if (d.phase === 'boot' && d.ever && d.fall === 'NORMAL') { d.phase = 'walk'; d.phaseTick = 0; }

    if (d.phase === 'walk' && d.fall === 'NORMAL') {
      if (walk()) { d.phase = 'pause'; d.phaseTick = 0; }
    } else if (d.phase === 'pause' && d.phaseTick >= 2) {
      // 넘어짐: 강한 충격 + 큰 기울기, 이후 움직임 없음
      d.phase = 'fall'; d.phaseTick = 0;
      d.shock = 1.38; d.tilt = 84; d.maxTilt = 84;
      d.mode = 'IMPACT_MOTION_CHECK'; d.elapsed = 0; d.lastEvent = '충격 감지';
      setFall('MONITORING');
    } else if (d.phase === 'fall') {
      d.tilt = 82 + Math.random() * 3;
      d.shock = 0.02 + Math.random() * 0.02;
      if (d.fall === 'MONITORING') {
        d.elapsed = d.phaseTick * 1000;
        if (d.elapsed >= 10000) {
          d.mode = 'NONE'; d.elapsed = 0; d.cancelLeft = 10000;
          d.lastEvent = '10초간 움직임 없음 - 낙상 경고 시작';
          setFall('CANCEL_WINDOW');
        }
      } else if (d.fall === 'CANCEL_WINDOW') {
        d.cancelLeft = Math.max(0, d.cancelLeft - 1000);
        if (d.cancelLeft === 0) { d.lastEvent = '낙상 확정'; setFall('FALL_CONFIRMED'); }
      }
    }

    if (d.ever && d.fix) evaluateFence();

    // 이동 경로 (5초마다, 5 m 이상 움직였을 때)
    if (d.ever && d.tick % 5 === 0) {
      const last = d.track[d.track.length - 1];
      if (!last || distanceM(last[0], last[1], d.pos[0], d.pos[1]) >= 5) {
        d.track.push([+d.pos[0].toFixed(6), +d.pos[1].toFixed(6), Math.floor(Date.now() / 1000)]);
        if (d.track.length > 60) d.track.shift();
        emit('track', { pts: d.track });
      }
    }

    emit('status', {
      fw: 'demo', up: d.tick * 1000, ts: Math.floor(Date.now() / 1000), rssi: -58 - Math.floor(Math.random() * 8),
      imu: { ok: true, data: true },
      fall: {
        state: d.fall, mode: d.fall === 'MONITORING' ? d.mode : 'NONE', event: d.lastEvent,
        shock: d.shock, tilt: d.tilt, maxTilt: d.maxTilt,
        elapsed: d.fall === 'MONITORING' ? d.elapsed : 0, duration: d.fall === 'MONITORING' ? 10000 : 0,
        cancelLeft: d.fall === 'CANCEL_WINDOW' ? d.cancelLeft : 0,
      },
      gps: {
        fix: d.fix, ever: d.ever, lat: +d.pos[0].toFixed(6), lng: +d.pos[1].toFixed(6), alt: 62.4,
        spd: d.phase === 'walk' ? 3.2 : 0, sats: d.sats, hdop: d.ever ? +d.hdop.toFixed(2) : 99.9,
        age: d.ever ? 300 + Math.floor(Math.random() * 600) : 0, ttff: d.ttff, chars: d.tick * 520, bad: 0,
      },
      geo: { type: d.fence.type, state: d.geoState, dist: +d.dist.toFixed(1), r: d.fence.r || 0, ver: d.fenceVer },
      bat: { v: 3.92, pct: 74 },
    });
  }

  function publishFence() {
    const f = d.fence;
    emit('geofence', f.type === 'circle'
      ? { ver: d.fenceVer, type: 'circle', lat: f.lat, lng: f.lng, r: f.r }
      : { ver: d.fenceVer, type: 'polygon', pts: f.pts });
  }

  function command(text) {
    if (!d) return false;
    const parts = text.split(',');
    const name = parts[0];
    setTimeout(() => {   // 실제 통신처럼 약간 늦게 반영
      if (!d) return;
      if (name === 'RESET_FALL') {
        d.lastEvent = '낙상 판정 초기화 - 보호자 앱에서 초기화';
        d.mode = 'NONE'; d.maxTilt = 0;
        setFall('NORMAL');
        d.phase = 'walk'; d.seg = 0; d.segPos = 0; d.phaseTick = 0;
      } else if (name === 'RECALIBRATE') {
        d.lastEvent = '기준 자세 설정 시작';
        d.calibLeft = 3;
        d.fall = 'CALIBRATING';
      } else if (name === 'GEOFENCE_CIRCLE') {
        const [lat, lng, r] = parts.slice(1).map(Number);
        d.fence = { type: 'circle', lat, lng, r };
        d.fenceVer += 1; d.geoState = 'UNKNOWN'; d.candCount = 0;
        publishFence();
      } else if (name === 'GEOFENCE_POLYGON') {
        const nums = parts.slice(1).map(Number);
        const pts = [];
        for (let i = 0; i + 1 < nums.length; i += 2) pts.push([nums[i], nums[i + 1]]);
        d.fence = { type: 'polygon', pts };
        d.fenceVer += 1; d.geoState = 'UNKNOWN'; d.candCount = 0;
        publishFence();
      }
    }, 600);
    return true;
  }

  function start() {
    disconnectMqtt();
    stop();
    resetCaneData();
    S.source = 'demo';
    S.conn = 'idle';
    S.events = [];
    S.unread = 0;
    S.follow = true;
    lastLogKey = '';
    d = fresh();
    emit('online', '1');
    publishFence();
    event('BOOT', '지팡이 전원이 켜졌습니다');
    step();
    timer = setInterval(step, 1000);
    toast('데모를 시작했습니다. 실제보다 빠르게 걷습니다');
  }

  function stop() {
    clearInterval(timer);
    timer = null;
    if (S.source === 'demo') {
      d = null;
      S.source = 'mqtt';
      S.events = store.get('events', []);
      S.unread = 0;
      lastLogKey = '';
    }
  }

  return { start, stop, command };
})();

// =====================================================================
// 시작
// =====================================================================
fillSettingsForm();
Draft.reset();
renderFencePanel();
connectMqtt();
render();

if ('serviceWorker' in navigator &&
    (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* 오프라인 캐시 없이도 동작 */ });
}

// 테스트/디버깅용
window.caneApp = { S, settings, Demo, handleMessage };
