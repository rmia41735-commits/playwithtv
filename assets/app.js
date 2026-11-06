(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const video = $('video');
  const overlay = $('overlay');
  const overlayText = $('overlayText');
  const overlayActions = $('overlayActions');
  const grid = $('grid');
  const cats = $('cats');
  const chips = $('chips');
  const search = $('search');

  const FAV_KEY = 'pwtv:favorites';
  const RECENT_KEY = 'pwtv:recent';
  const LAST_KEY = 'pwtv:last';

  const store = {
    get(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } },
    set(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch {} },
  };

  const state = {
    channels: [],
    byId: new Map(),
    category: 'all',
    query: '',
    current: null,
    favorites: new Set(store.get(FAV_KEY, [])),
    recent: store.get(RECENT_KEY, []),
    visible: [],
  };

  let hls = null;
  let stallTimer = null;

  // Category ordering: most useful first, the rest alphabetically
  const PRIORITY = ['BDIX Live', 'Bangla', 'Bangladesh', 'Sports', 'Cricket', 'Football', 'News', 'Indian Bangla', 'Hindi', 'English', 'Kids', 'Music'];

  /* ---------- Utilities ---------- */
  function initials(name) {
    return name.replace(/\[[^\]]*\]/g, '').trim().split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase() || 'TV';
  }

  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove('show'), 2200);
  }

  function setOverlay(mode, text) {
    overlay.classList.remove('hide', 'error');
    overlayActions.hidden = true;
    if (mode === 'hide') { overlay.classList.add('hide'); return; }
    if (mode === 'error') { overlay.classList.add('error'); overlayActions.hidden = false; }
    overlayText.textContent = text || '';
  }

  function logoNode(ch, cls) {
    if (ch.logo) {
      const img = document.createElement('img');
      img.src = ch.logo;
      img.alt = '';
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      img.onerror = () => { const s = document.createElement('span'); s.className = cls; s.textContent = initials(ch.name); img.replaceWith(s); };
      return img;
    }
    const s = document.createElement('span');
    s.className = cls;
    s.textContent = initials(ch.name);
    return s;
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
      { key: 'fav', label: '★ Favorites', count: state.favorites.size },
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
    if (q) list = list.filter((ch) => ch.name.toLowerCase().includes(q) || ch.group.toLowerCase().includes(q));
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
      b.className = 'card' + (state.current?.id === ch.id ? ' on' : '');
      b.dataset.id = ch.id;
      b.setAttribute('role', 'listitem');
      b.title = ch.name;
      const thumb = document.createElement('div');
      thumb.className = 'thumb';
      thumb.appendChild(logoNode(ch, 'initials'));
      const body = document.createElement('div');
      body.className = 'card-body';
      const name = document.createElement('div'); name.className = 'card-name'; name.textContent = ch.name;
      const group = document.createElement('div'); group.className = 'card-group'; group.textContent = ch.group;
      body.append(name, group);
      b.append(thumb, body);
      if (state.favorites.has(ch.id)) {
        b.insertAdjacentHTML('beforeend', '<svg class="star" viewBox="0 0 24 24"><path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/></svg>');
      }
      b.onclick = () => { play(ch); window.scrollTo({ top: 0, behavior: 'smooth' }); };
      frag.appendChild(b);
    }
    grid.appendChild(frag);
  }

  function markActiveCard() {
    grid.querySelectorAll('.card.on').forEach((c) => c.classList.remove('on'));
    if (state.current) grid.querySelector(`.card[data-id="${state.current.id}"]`)?.classList.add('on');
  }

  /* ---------- Playback ---------- */
  function teardown() {
    clearTimeout(stallTimer);
    if (hls) { hls.destroy(); hls = null; }
    video.removeAttribute('src');
    video.load();
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
    const logo = $('nowLogo');
    logo.textContent = '';
    logo.appendChild(logoNode(ch, ''));
    updateFavButton();
    markActiveCard();
    if (state.category === 'recent') renderGrid();
    renderCategories();

    // Browsers block plain-http streams on an https page (mixed content)
    if (location.protocol === 'https:' && ch.url.startsWith('http://')) {
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
      hls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
    } else {
      video.src = ch.url;
      video.play().catch(() => {});
    }
  }

  video.addEventListener('playing', () => { clearTimeout(stallTimer); setOverlay('hide'); });
  video.addEventListener('waiting', () => { if (!overlay.classList.contains('error')) setOverlay('loading', 'Buffering…'); });
  video.addEventListener('error', () => { if (!hls && state.current) fail(); });

  function step(dir) {
    const list = state.visible.length ? state.visible : state.channels;
    if (!list.length) return;
    const i = list.findIndex((c) => c.id === state.current?.id);
    play(list[(i + dir + list.length) % list.length]);
  }

  /* ---------- Favorites ---------- */
  function updateFavButton() {
    const on = state.current && state.favorites.has(state.current.id);
    $('favBtn').setAttribute('aria-pressed', on ? 'true' : 'false');
    $('favBtn').title = on ? 'Remove from favorites' : 'Add to favorites';
  }


  function toggleFav() {
    const ch = state.current;
    if (!ch) return;
    if (state.favorites.has(ch.id)) { state.favorites.delete(ch.id); toast('Removed from favorites'); }
    else { state.favorites.add(ch.id); toast('Saved to favorites'); }
    store.set(FAV_KEY, [...state.favorites]);
    updateFavButton();
    renderCategories();
    renderGrid();
  }

  /* ---------- Controls ---------- */
  $('prevBtn').onclick = () => step(-1);
  $('nextBtn').onclick = () => step(1);
  $('skipBtn').onclick = () => step(1);
  $('retryBtn').onclick = () => play(state.current);
  $('favBtn').onclick = toggleFav;
  $('fsBtn').onclick = () => {
    const el = $('screen');
    if (document.fullscreenElement) document.exitFullscreen();
    else if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
    else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
  };
  $('pipBtn').onclick = async () => {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await video.requestPictureInPicture();
    } catch { toast('Picture-in-picture is not available here'); }
  };
  if (!document.pictureInPictureEnabled) $('pipBtn').hidden = true;
  $('shareBtn').onclick = async () => {
    const url = location.href;
    try {
      if (navigator.share && matchMedia('(pointer: coarse)').matches) await navigator.share({ title: document.title, url });
      else { await navigator.clipboard.writeText(url); toast('Link copied'); }
    } catch {}
  };

  let searchTimer;
  search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.query = search.value; renderGrid(); }, 120);
  });

  document.addEventListener('keydown', (e) => {
    if (e.target === search) { if (e.key === 'Escape') { search.value = ''; state.query = ''; renderGrid(); search.blur(); } return; }
    if (e.target.closest('input, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === '/') { e.preventDefault(); search.focus(); }
    else if (e.key === 'ArrowDown' || e.key === 'PageDown') { e.preventDefault(); step(1); }
    else if (e.key === 'ArrowUp' || e.key === 'PageUp') { e.preventDefault(); step(-1); }
    else if (e.key === 'f' || e.key === 'F') $('fsBtn').click();
    else if (e.key === 'm' || e.key === 'M') { video.muted = !video.muted; toast(video.muted ? 'Muted' : 'Sound on'); }
  });

  window.addEventListener('hashchange', () => {
    const ch = state.byId.get(location.hash.slice(1));
    if (ch && ch.id !== state.current?.id) play(ch);
  });

  // Clock
  const clock = $('clock');
  const tick = () => { clock.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); };
  tick(); setInterval(tick, 15000);

  /* ---------- Boot ---------- */
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
      state.channels = data.channels;
      state.byId = new Map(data.channels.map((c) => [c.id, c]));
      // Drop stale favorites/recent entries that no longer exist upstream
      state.recent = state.recent.filter((id) => state.byId.has(id));
      if (data.updated) $('updated').textContent = `Channel list updated ${data.updated}`;
      renderCategories();
      renderGrid();
      const start = state.byId.get(location.hash.slice(1)) || state.byId.get(store.get(LAST_KEY, '')) ||
        state.channels.find((c) => c.group === 'BDIX Live' && c.url.startsWith('https')) || state.channels.find((c) => c.url.startsWith('https'));
      if (start) play(start);
      else setOverlay('error', 'No channels available.');
    } catch {
      grid.textContent = '';
      setOverlay('error', 'Could not load the channel list. Check your connection and try again.');
      $('retryBtn').onclick = () => location.reload();
      $('skipBtn').hidden = true;
    }
  }

  boot();
})();
