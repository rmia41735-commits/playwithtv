(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const video = $('video');
  const screen = $('screen');
  const overlay = $('overlay');
  const overlayText = $('overlayText');
  const overlayActions = $('overlayActions');
  const grid = $('grid');
  const cats = $('cats');
  const chips = $('chips');
  const search = $('search');
  const quality = $('quality');
  const signal = $('signal');

  const FAV_KEY = 'pwtv:favorites';
  const RECENT_KEY = 'pwtv:recent';
  const LAST_KEY = 'pwtv:last';
  const VIEW_KEY = 'pwtv:view';
  const VOL_KEY = 'pwtv:volume';
  const THEATER_KEY = 'pwtv:theater';

  const store = {
    get(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } },
    set(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch {} },
  };

  const state = {
    channels: [],
    byId: new Map(),
    byNum: new Map(),
    category: 'all',
    query: '',
    current: null,
    favorites: new Set(store.get(FAV_KEY, [])),
    recent: store.get(RECENT_KEY, []),
    visible: [],
    view: store.get(VIEW_KEY, 'grid'),
  };

  let hls = null;
  let stallTimer = null;
  const secure = location.protocol === 'https:';

  // Category ordering: most useful first, the rest alphabetically
  const PRIORITY = ['BDIX Live', 'Bangla', 'Bangladesh', 'Sports', 'Cricket', 'Football', 'News', 'Indian Bangla', 'Hindi', 'English', 'Kids', 'Music'];

  /* ---------- Utilities ---------- */
  function initials(name) {
    return name.replace(/\[[^\]]*\]/g, '').trim().split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase() || 'TV';
  }
  const pad = (n) => String(n).padStart(3, '0');

  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove('show'), 2200);
  }

  function setSignal(kind, text) {
    signal.className = 'signal mono ' + kind;
    signal.querySelector('span').textContent = text;
  }

  function setOverlay(mode, text) {
    overlay.classList.remove('hide', 'error');
    overlayActions.hidden = true;
    if (mode === 'hide') { overlay.classList.add('hide'); return; }
    if (mode === 'error') { overlay.classList.add('error'); overlayActions.hidden = false; setSignal('bad', 'No signal'); }
    else setSignal('wait', 'Tuning');
    overlayText.textContent = text || '';
  }

  function logoNode(ch, cls) {
    if (ch.logo) {
      const img = document.createElement('img');
      img.src = ch.logo;
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      img.onerror = () => { const s = document.createElement('span'); s.className = cls; s.textContent = initials(ch.name); img.replaceWith(s); };
      return img;
    }
    const s = document.createElement('span');
    s.className = cls;
    s.textContent = initials(ch.name);
    return s;
  }

  let osdTimer;
  function osd(text, ms = 1400) {
    const el = $('osd');
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(osdTimer);
    osdTimer = setTimeout(() => el.classList.remove('show'), ms);
  }

  /* ---------- Categories ---------- */
  function categoryList() {
    const counts = new Map();
    for (const ch of state.channels) counts.set(ch.group, (counts.get(ch.group) || 0) + 1);
    const groups = [...counts.keys()].sort((a, b) => {
      const pa = PRIORITY.indexOf(a), pb = PRIORITY.indexOf(b);
      if (pa !== -1 || pb !== -1) return (pa === -1 ? 99 : pa) - (pb === -1 ? 99 : pb);
      return a.localeCompare(b);
    });
    return [
      { key: 'all', label: 'All channels', count: state.channels.length },
      { key: 'fav', label: '★ Favorites', count: [...state.favorites].filter((id) => state.byId.has(id)).length },
      { key: 'recent', label: 'Recently watched', count: state.recent.filter((id) => state.byId.has(id)).length },
      { key: 'sep' },
      ...groups.map((g) => ({ key: 'g:' + g, label: g, count: counts.get(g) })),
    ];
  }

  function renderCategories() {
    const list = categoryList();
    cats.textContent = '';
    chips.textContent = '';
    for (const c of list) {
      if (c.key === 'sep') { const li = document.createElement('li'); li.className = 'cat-sep'; cats.appendChild(li); continue; }
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.className = 'cat' + (state.category === c.key ? ' on' : '');
      const l = document.createElement('span'); l.textContent = c.label;
      const n = document.createElement('span'); n.textContent = c.count;
      b.append(l, n);
      b.onclick = () => setCategory(c.key);
      li.appendChild(b);
      cats.appendChild(li);

      const chip = document.createElement('button');
      chip.className = 'chip' + (state.category === c.key ? ' on' : '');
      chip.textContent = c.label;
      chip.onclick = () => setCategory(c.key);
      chips.appendChild(chip);
    }
  }

  function setCategory(key) {
    state.category = key;
    renderCategories();
    renderGrid();
    const on = chips.querySelector('.chip.on');
    if (on) on.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  }

  /* ---------- Grid ---------- */
  function filtered() {
    let list = state.channels;
    const c = state.category;
    if (c === 'fav') list = list.filter((ch) => state.favorites.has(ch.id));
    else if (c === 'recent') list = state.recent.map((id) => state.byId.get(id)).filter(Boolean);
    else if (c.startsWith('g:')) list = list.filter((ch) => ch.group === c.slice(2));
    const q = state.query.trim().toLowerCase();
    if (q) list = list.filter((ch) => ch.name.toLowerCase().includes(q) || ch.group.toLowerCase().includes(q) || String(ch.num) === q);
    return list;
  }

  function titleFor(key) {
    if (key === 'all') return 'All channels';
    if (key === 'fav') return 'Favorites';
    if (key === 'recent') return 'Recently watched';
    return key.slice(2);
  }

  function renderGrid() {
    const list = filtered();
    state.visible = list;
    $('gridTitle').textContent = state.query ? `Results for “${state.query.trim()}”` : titleFor(state.category);
    $('gridCount').textContent = `${list.length} channel${list.length === 1 ? '' : 's'}`;
    grid.textContent = '';
    grid.classList.toggle('list', state.view === 'list');
    const empty = $('empty');
    empty.hidden = list.length > 0;
    if (!list.length) {
      empty.textContent = state.category === 'fav' && !state.query
        ? 'No favorites yet. Tap the star under the player to save a channel here.'
        : state.category === 'recent' && !state.query ? 'Channels you watch will show up here.' : 'No channels match your search.';
      return;
    }
    const frag = document.createDocumentFragment();
    for (const ch of list) {
      const b = document.createElement('button');
      b.className = 'card' + (state.current?.id === ch.id ? ' on' : '') + (secure && ch.url.startsWith('http://') ? ' insecure' : '');
      b.dataset.id = ch.id;
      b.setAttribute('role', 'listitem');
      b.title = `${ch.num}. ${ch.name}`;
      const thumb = document.createElement('div');
      thumb.className = 'thumb';
      thumb.appendChild(logoNode(ch, 'initials'));
      const body = document.createElement('div');
      body.className = 'card-body';
      const name = document.createElement('div'); name.className = 'card-name'; name.textContent = ch.name;
      const group = document.createElement('div'); group.className = 'card-group'; group.textContent = ch.group;
      body.append(name, group);
      const num = document.createElement('span'); num.className = 'card-num'; num.textContent = pad(ch.num);
      if (state.view === 'list') b.append(thumb, body, num);
      else { thumb.appendChild(num); b.append(thumb, body); }
      if (state.favorites.has(ch.id)) {
        b.insertAdjacentHTML('beforeend', '<svg class="star" viewBox="0 0 24 24"><path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/></svg>');
      }
      frag.appendChild(b);
    }
    grid.appendChild(frag);
  }

  grid.addEventListener('click', (e) => {
    const card = e.target.closest('.card');
    if (!card) return;
    play(state.byId.get(card.dataset.id));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  // Cursor-following glow on cards
  grid.addEventListener('pointermove', (e) => {
    const card = e.target.closest('.card');
    if (!card) return;
    const r = card.getBoundingClientRect();
    card.style.setProperty('--mx', `${e.clientX - r.left}px`);
    card.style.setProperty('--my', `${e.clientY - r.top}px`);
  });

  function markActiveCard() {
    grid.querySelectorAll('.card.on').forEach((c) => c.classList.remove('on'));
    if (state.current) grid.querySelector(`.card[data-id="${state.current.id}"]`)?.classList.add('on');
  }

  /* ---------- Quality / stats ---------- */
  function fillQuality() {
    quality.textContent = '';
    const auto = new Option('Auto', '-1');
    quality.add(auto);
    if (hls && hls.levels && hls.levels.length > 1) {
      hls.levels
        .map((l, i) => ({ i, h: l.height, b: l.bitrate }))
        .sort((a, b) => (b.h || 0) - (a.h || 0) || b.b - a.b)
        .forEach((l) => quality.add(new Option(l.h ? `${l.h}p` : `${Math.round(l.b / 1000)} kbps`, String(l.i))));
      quality.disabled = false;
    } else {
      quality.disabled = true;
    }
    quality.value = '-1';
  }
  quality.addEventListener('change', () => {
    if (!hls) return;
    hls.currentLevel = Number(quality.value);
    toast(quality.value === '-1' ? 'Quality: Auto' : `Quality: ${quality.selectedOptions[0].textContent}`);
  });

  function updateStats() {
    const el = $('hudStats');
    const w = video.videoWidth, h = video.videoHeight;
    if (!w) { el.hidden = true; return; }
    let txt = `${h}P`;
    if (hls && hls.currentLevel >= 0 && hls.levels[hls.currentLevel]) txt += ` · ${(hls.levels[hls.currentLevel].bitrate / 1e6).toFixed(1)} MBPS`;
    el.textContent = txt;
    el.hidden = false;
  }
  video.addEventListener('resize', updateStats);

  /* ---------- Playback ---------- */
  function teardown() {
    clearTimeout(stallTimer);
    if (hls) { hls.destroy(); hls = null; }
    video.removeAttribute('src');
    video.load();
    $('hudStats').hidden = true;
  }

  function fail(msg) {
    clearTimeout(stallTimer);
    setOverlay('error', msg || 'This channel is not broadcasting right now. Try again or switch to another channel.');
  }

  function play(ch) {
    if (!ch) return;
    teardown();
    state.current = ch;
    store.set(LAST_KEY, ch.id);
    state.recent = [ch.id, ...state.recent.filter((id) => id !== ch.id)].slice(0, 30);
    store.set(RECENT_KEY, state.recent);
    if (location.hash !== '#' + ch.id) history.replaceState(null, '', '#' + ch.id);
    document.title = `${ch.name} — PlayWithTV`;

    $('nowName').textContent = ch.name;
    $('nowGroup').textContent = ch.group;
    $('nowNum').textContent = pad(ch.num);
    $('hudNum').textContent = `CH ${pad(ch.num)}`;
    const logo = $('nowLogo');
    logo.textContent = '';
    logo.appendChild(logoNode(ch, ''));
    updateFavButton();
    markActiveCard();
    if (state.category === 'recent') renderGrid();
    renderCategories();
    updateMediaSession(ch);
    fillQuality();

    // Browsers block plain-http streams on an https page (mixed content)
    if (secure && ch.url.startsWith('http://')) {
      fail('This channel only offers an insecure (http) stream, which browsers block on secure sites. Open it in a player app like VLC, or pick another channel.');
      return;
    }

    setOverlay('loading', `Tuning in to ${ch.name}…`);
    stallTimer = setTimeout(() => fail(), 20000);

    const isHls = /\.m3u8(\?|$)/i.test(ch.url) || /playlist|master|index/i.test(ch.url) && !/\.(mp3|aac|ts|mp4)(\?|$)/i.test(ch.url);
    if (isHls && window.Hls && Hls.isSupported()) {
      hls = new Hls({ enableWorker: true, lowLatencyMode: true, manifestLoadingMaxRetry: 2, levelLoadingMaxRetry: 2 });
      let mediaRecoveries = 0;
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRecoveries++ < 2) { hls.recoverMediaError(); return; }
        fail();
      });
      hls.loadSource(ch.url);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => { fillQuality(); video.play().catch(() => {}); });
      hls.on(Hls.Events.LEVEL_SWITCHED, updateStats);
    } else {
      video.src = ch.url;
      video.play().catch(() => {});
    }
  }

  video.addEventListener('playing', () => { clearTimeout(stallTimer); setOverlay('hide'); setSignal('ok', 'On air'); updateStats(); requestWakeLock(); });
  video.addEventListener('waiting', () => { if (!overlay.classList.contains('error')) setOverlay('loading', 'Buffering…'); });
  video.addEventListener('pause', () => { if (!overlay.classList.contains('error')) setSignal('', 'Paused'); releaseWakeLock(); });
  video.addEventListener('error', () => { if (!hls && state.current) fail(); });

  function step(dir) {
    const list = state.visible.length ? state.visible : state.channels;
    if (!list.length) return;
    const i = list.findIndex((c) => c.id === state.current?.id);
    const next = list[(i + dir + list.length) % list.length];
    play(next);
    osd(pad(next.num), 900);
  }

  function randomChannel() {
    const pool = (state.visible.length ? state.visible : state.channels).filter((c) => !(secure && c.url.startsWith('http://')) && c.id !== state.current?.id);
    if (!pool.length) return;
    const ch = pool[Math.floor(Math.random() * pool.length)];
    play(ch);
    osd(pad(ch.num), 900);
  }

  /* ---------- Number zapping (type a channel number) ---------- */
  let zapBuf = '';
  let zapTimer;
  function zapDigit(d) {
    zapBuf = (zapBuf + d).slice(-4);
    osd(zapBuf.padStart(3, '-'), 1800);
    clearTimeout(zapTimer);
    zapTimer = setTimeout(() => {
      const ch = state.byNum.get(Number(zapBuf));
      if (ch) play(ch); else toast(`No channel ${zapBuf}`);
      zapBuf = '';
    }, 1200);
  }

  /* ---------- Favorites ---------- */
  function updateFavButton() {
    const on = state.current && state.favorites.has(state.current.id);
    $('favBtn').setAttribute('aria-pressed', on ? 'true' : 'false');
    $('favBtn').title = on ? 'Remove from favorites (S)' : 'Add to favorites (S)';
  }

  function toggleFav() {
    const ch = state.current;
    if (!ch) return;
    if (state.favorites.has(ch.id)) { state.favorites.delete(ch.id); toast('Removed from favorites'); }
    else { state.favorites.add(ch.id); toast('★ Saved to favorites'); }
    store.set(FAV_KEY, [...state.favorites]);
    updateFavButton();
    renderCategories();
    renderGrid();
  }

  /* ---------- Volume ---------- */
  const volume = $('volume');
  const muteBtn = $('muteBtn');
  function syncVolume() {
    volume.value = video.muted ? 0 : video.volume;
    volume.style.setProperty('--p', `${volume.value * 100}%`);
    muteBtn.classList.toggle('off', video.muted || video.volume === 0);
  }
  video.volume = Math.min(1, Math.max(0, store.get(VOL_KEY, 1)));
  volume.addEventListener('input', () => {
    video.volume = Number(volume.value);
    video.muted = video.volume === 0;
    store.set(VOL_KEY, video.volume);
  });
  video.addEventListener('volumechange', syncVolume);
  function toggleMute() {
    video.muted = !video.muted;
    if (!video.muted && video.volume === 0) video.volume = .5;
    toast(video.muted ? 'Muted' : 'Sound on');
  }
  muteBtn.onclick = (e) => { e.preventDefault(); toggleMute(); };
  syncVolume();

  /* ---------- Sleep timer ---------- */
  let sleepEnd = 0;
  let sleepTick;
  $('sleep').addEventListener('change', (e) => {
    const mins = Number(e.target.value);
    clearInterval(sleepTick);
    const chip = $('hudSleep');
    if (!mins) { sleepEnd = 0; chip.hidden = true; toast('Sleep timer off'); return; }
    sleepEnd = Date.now() + mins * 60000;
    toast(`Sleep timer set for ${e.target.selectedOptions[0].textContent}`);
    const update = () => {
      const left = sleepEnd - Date.now();
      if (left <= 0) {
        clearInterval(sleepTick);
        chip.hidden = true;
        e.target.value = '0';
        video.pause();
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        toast('Sleep timer: playback stopped');
        return;
      }
      const m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
      chip.textContent = `SLEEP ${m}:${String(s).padStart(2, '0')}`;
      chip.hidden = false;
    };
    update();
    sleepTick = setInterval(update, 1000);
  });

  /* ---------- Theater / view ---------- */
  function setTheater(on) {
    document.body.classList.toggle('theater', on);
    $('theaterBtn').setAttribute('aria-pressed', on ? 'true' : 'false');
    store.set(THEATER_KEY, on);
  }
  setTheater(store.get(THEATER_KEY, false));

  function setView(v) {
    state.view = v;
    store.set(VIEW_KEY, v);
    $('viewGrid').setAttribute('aria-pressed', v === 'grid' ? 'true' : 'false');
    $('viewList').setAttribute('aria-pressed', v === 'list' ? 'true' : 'false');
    if (state.channels.length) renderGrid();
  }
  $('viewGrid').onclick = () => setView('grid');
  $('viewList').onclick = () => setView('list');
  setView(state.view === 'list' ? 'list' : 'grid');

  /* ---------- Controls ---------- */
  $('prevBtn').onclick = () => step(-1);
  $('nextBtn').onclick = () => step(1);
  $('skipBtn').onclick = () => step(1);
  $('retryBtn').onclick = () => play(state.current);
  $('favBtn').onclick = toggleFav;
  $('randomBtn').onclick = randomChannel;
  $('theaterBtn').onclick = () => setTheater(!document.body.classList.contains('theater'));
  $('fsBtn').onclick = () => {
    if (document.fullscreenElement || document.webkitFullscreenElement) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    else if (screen.requestFullscreen) screen.requestFullscreen().catch(() => {});
    else if (screen.webkitRequestFullscreen) screen.webkitRequestFullscreen();
    else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen(); // iPhone
  };
  const pipSupported = document.pictureInPictureEnabled || typeof video.webkitSetPresentationMode === 'function';
  $('pipBtn').onclick = async () => {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else if (video.requestPictureInPicture) await video.requestPictureInPicture();
      else video.webkitSetPresentationMode(video.webkitPresentationMode === 'picture-in-picture' ? 'inline' : 'picture-in-picture');
    } catch { toast('Picture-in-picture is not available here'); }
  };
  if (!pipSupported) $('pipBtn').hidden = true;
  $('shareBtn').onclick = async () => {
    const url = location.href;
    try {
      if (navigator.share && matchMedia('(pointer: coarse)').matches) await navigator.share({ title: document.title, url });
      else { await navigator.clipboard.writeText(url); toast('Link copied'); }
    } catch {}
  };

  // Dialogs
  document.querySelectorAll('dialog').forEach((d) => {
    d.addEventListener('click', (e) => { if (e.target === d || e.target.closest('[data-close]')) d.close(); });
  });
  const openDialog = (d) => { if (d.showModal) d.showModal(); else d.setAttribute('open', ''); };
  $('helpBtn').onclick = () => openDialog($('helpDialog'));

  // Hide HUD when the viewer is idle
  let idleTimer;
  const wake = () => {
    screen.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (!video.paused) screen.classList.add('idle'); }, 3000);
  };
  ['pointermove', 'pointerdown', 'touchstart'].forEach((ev) => screen.addEventListener(ev, wake, { passive: true }));

  // Swipe left/right on the player to change channels (touch devices)
  let tx = 0, ty = 0;
  screen.addEventListener('touchstart', (e) => { tx = e.touches[0].clientX; ty = e.touches[0].clientY; }, { passive: true });
  screen.addEventListener('touchend', (e) => {
    const dx = e.changedTouches[0].clientX - tx, dy = e.changedTouches[0].clientY - ty;
    if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1);
  }, { passive: true });

  let searchTimer;
  search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.query = search.value; renderGrid(); }, 120);
  });

  document.addEventListener('keydown', (e) => {
    if (e.target === search) { if (e.key === 'Escape') { search.value = ''; state.query = ''; renderGrid(); search.blur(); } return; }
    if (e.target.closest('input, textarea, select, dialog') || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (e.key === '/') { e.preventDefault(); search.focus(); }
    else if (e.key === '?') openDialog($('helpDialog'));
    else if (e.key === 'ArrowDown' || e.key === 'PageDown') { e.preventDefault(); step(1); }
    else if (e.key === 'ArrowUp' || e.key === 'PageUp') { e.preventDefault(); step(-1); }
    else if (/^[0-9]$/.test(e.key)) zapDigit(e.key);
    else if (k === 'f') $('fsBtn').click();
    else if (k === 'm') toggleMute();
    else if (k === 't') $('theaterBtn').click();
    else if (k === 'p') $('pipBtn').click();
    else if (k === 's') toggleFav();
    else if (k === 'r') randomChannel();
  });

  window.addEventListener('hashchange', () => {
    const ch = state.byId.get(location.hash.slice(1));
    if (ch && ch.id !== state.current?.id) play(ch);
  });

  // Clock
  const tick = () => {
    const d = new Date();
    $('clockTime').textContent = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    $('clockDate').textContent = d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
  };
  tick(); setInterval(tick, 15000);

  /* ---------- Lock screen controls & screen wake ---------- */
  function updateMediaSession(ch) {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: ch.name,
        artist: `PlayWithTV · ${ch.group}`,
        artwork: [
          ...(ch.logo ? [{ src: ch.logo, sizes: '256x256' }] : []),
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
        ],
      });
      navigator.mediaSession.setActionHandler('previoustrack', () => step(-1));
      navigator.mediaSession.setActionHandler('nexttrack', () => step(1));
    } catch {}
  }

  let wakeLock = null;
  async function requestWakeLock() {
    try { if ('wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } } catch {}
  }
  function releaseWakeLock() { try { wakeLock?.release(); } catch {} wakeLock = null; }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && !video.paused) requestWakeLock(); });

  /* ---------- Install (home screen) ---------- */
  const installBtn = $('installBtn');
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredPrompt = e; installBtn.hidden = false; });
  window.addEventListener('appinstalled', () => { installBtn.hidden = true; toast('PlayWithTV installed'); });
  if (isIOS && !standalone) installBtn.hidden = false;
  installBtn.onclick = async () => {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      await deferredPrompt.userChoice.catch(() => {});
      deferredPrompt = null;
      installBtn.hidden = true;
    } else openDialog($('iosDialog'));
  };

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  }

  /* ---------- Boot ---------- */
  function hideSplash() { $('splash').classList.add('out'); }
  setTimeout(hideSplash, 4000); // never keep the splash up for long

  function skeleton() {
    grid.innerHTML = Array.from({ length: 18 }, () => '<div class="skeleton"></div>').join('');
  }

  async function boot() {
    skeleton();
    setOverlay('loading', 'Loading channels…');
    try {
      const res = await fetch('/api/playlist');
      const data = await res.json();
      if (!res.ok || !Array.isArray(data.channels)) throw new Error(data.error || 'Bad response');
      state.channels = data.channels.map((c, i) => ({ ...c, num: i + 1 }));
      state.byId = new Map(state.channels.map((c) => [c.id, c]));
      state.byNum = new Map(state.channels.map((c) => [c.num, c]));
      // Drop stale recent entries that no longer exist upstream
      state.recent = state.recent.filter((id) => state.byId.has(id));
      if (data.updated) $('updated').textContent = `Channel list updated ${data.updated}`;
      renderCategories();
      renderGrid();
      setTimeout(hideSplash, 350);
      const start = state.byId.get(location.hash.slice(1)) || state.byId.get(store.get(LAST_KEY, '')) ||
        state.channels.find((c) => c.group === 'BDIX Live' && c.url.startsWith('https')) || state.channels.find((c) => c.url.startsWith('https'));
      if (start) play(start);
      else setOverlay('error', 'No channels available.');
    } catch {
      hideSplash();
      grid.textContent = '';
      setOverlay('error', 'Could not load the channel list. Check your connection and try again.');
      $('retryBtn').onclick = () => location.reload();
      $('skipBtn').hidden = true;
    }
  }

  boot();
})();
