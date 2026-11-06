(() => {
  const $ = (s) => document.querySelector(s);
  const ALL = '全部';
  const root = document.documentElement;

  const store = {
    get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 無痕模式等情況 */ } },
  };

  const params = new URLSearchParams(location.search);
  const state = {
    q: params.get('q') || '',
    group: params.get('g') || ALL,
    onlyFav: false,
    onlyShowing: false, // 只看所選日期有場次的戲院
    date: null, // 所選的場次日期（YYYY-MM-DD）；沒有場次資料或已過期就維持 null
    openWeek: new Set(), // 展開「看整週場次」的戲院，重繪後維持展開
    favs: new Set(store.get('chaser-favs', [])),
    me: null, // 使用者位置 {lat, lng}，沒有授權就維持 null
    active: null,
  };

  let config, map, cluster, meMarker;
  let dates = []; // 還沒過的場次日期
  const markers = new Map();

  /* ── 工具 ── */
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const km = (a, b) => {
    const r = Math.PI / 180;
    const x = Math.sin((b.lat - a.lat) * r / 2) ** 2 +
      Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin((b.lng - a.lng) * r / 2) ** 2;
    return 12742 * Math.asin(Math.sqrt(x));
  };
  const fmtKm = (d) => (d < 1 ? `${Math.round(d * 1000)} m` : `${d.toFixed(d < 10 ? 1 : 0)} km`);
  const isDesktop = () => matchMedia('(min-width: 900px)').matches;
  const isDark = () => root.dataset.theme === 'dark';

  // 台灣時間（UTC+8）的今天與現在
  const twNow = () => new Date(Date.now() + 8 * 3600e3).toISOString();
  const today = () => twNow().slice(0, 10);
  const nowHM = () => twNow().slice(11, 16);

  // 部分場次頁網址需要日期：上映前帶上映日，上映後帶今天（台灣時間）
  function bookingDate() {
    const d = today() > config.film.releaseDate ? today() : config.film.releaseDate;
    return d.replace(/-/g, '/');
  }

  /* ── 場次 ── */
  const fmtDate = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
  const weekday = (d) => '日一二三四五六'[new Date(`${d}T00:00:00Z`).getUTCDay()];
  const timesOn = (t, d) => (t.times && t.times[d]) || [];

  // 只留今天以後的日期；整份場次都過期時 dates 為空，場次相關介面全部收起來
  function initDates() {
    const all = [...new Set(config.theaters.flatMap((t) => Object.keys(t.times || {})))].sort();
    dates = all.filter((d) => d >= today());
    state.date = dates[0] || null;
  }

  function timesHTML(t) {
    if (!state.date) return '';
    const list = timesOn(t, state.date);
    const isToday = state.date === today();
    const now = nowHM();
    const pills = list.length
      ? list.map((x) => `<span class="time${isToday && x < now ? ' past' : ''}">${x}</span>`).join('')
      : '<span class="no-time">這天沒有場次</span>';
    return `<div class="times"><span class="times-date">${fmtDate(state.date)}（${weekday(state.date)}）</span>${pills}</div>`;
  }

  function weekHTML(t) {
    if (dates.length < 2) return '';
    const rows = dates.map((d) => {
      const list = timesOn(t, d);
      return `<li${d === state.date ? ' class="on"' : ''}><span class="d">${fmtDate(d)}（${weekday(d)}）</span><span class="ts">${list.length ? list.join('、') : '—'}</span></li>`;
    }).join('');
    return `<details class="week" data-week="${t.id}"${state.openWeek.has(t.id) ? ' open' : ''}><summary>看整週場次</summary><ul>${rows}</ul></details>`;
  }

  let toastTimer;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
  }

  function matches(t) {
    if (state.group !== ALL && t.group !== state.group) return false;
    if (state.onlyFav && !state.favs.has(t.id)) return false;
    if (state.onlyShowing && state.date && !timesOn(t, state.date).length) return false;
    const q = state.q.trim().toLowerCase();
    if (!q) return true;
    return [t.name, t.city, t.group, t.address].join(' ').toLowerCase().includes(q);
  }

  const sorted = (list) => (state.me ? [...list].sort((a, b) => km(state.me, a) - km(state.me, b)) : list);

  function links(t) {
    return {
      book: t.booking.replace('{date}', bookingDate()),
      map: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(t.name + ' ' + t.address)}`,
      tel: t.phone ? t.phone.replace(/[^\d+#]/g, '') : '',
    };
  }

  /* ── HTML 片段 ── */
  function actionsHTML(t) {
    const l = links(t);
    return `<div class="actions">
      <a class="btn primary" href="${esc(l.book)}" target="_blank" rel="noopener">🎟️ 查場次・訂票</a>
      <a class="btn" href="${l.map}" target="_blank" rel="noopener">📍 導航</a>
      ${l.tel ? `<a class="btn" href="tel:${l.tel}">📞 電話</a>` : ''}
    </div>`;
  }

  function cardHTML(t) {
    const fav = state.favs.has(t.id);
    const dist = state.me ? `<span class="tag dist">${fmtKm(km(state.me, t))}</span>` : '';
    return `
      <article class="card${state.active === t.id ? ' active' : ''}" data-id="${t.id}">
        <div class="card-head">
          <h3>${esc(t.name)}</h3>
          ${dist}<span class="tag">${esc(t.city)}</span>
          <button class="fav" data-fav="${t.id}" aria-pressed="${fav}" aria-label="收藏">${fav ? '★' : '☆'}</button>
        </div>
        <p class="addr">${esc(t.address)}</p>
        ${timesHTML(t)}
        ${weekHTML(t)}
        ${actionsHTML(t)}
      </article>`;
  }

  function popupHTML(t) {
    const dist = state.me ? ` · 距離 ${fmtKm(km(state.me, t))}` : '';
    return `<div class="card-pop">
      <h3>${esc(t.name)}</h3>
      <p class="addr">${esc(t.address)}${dist}</p>
      ${timesHTML(t)}
      ${actionsHTML(t)}
    </div>`;
  }

  /* ── 地圖 ── */
  function pinIcon(t) {
    return L.divIcon({
      className: '',
      html: `<div class="pin${state.active === t.id ? ' active' : ''}"><span>W</span></div>`,
      iconSize: [30, 30],
      iconAnchor: [15, 30],
      popupAnchor: [0, -28],
    });
  }

  function initMap() {
    map = L.map('map', { zoomControl: true, scrollWheelZoom: true, zoomSnap: 0.5 }).setView([23.7, 120.95], 7);
    // OpenStreetMap 免金鑰、地名為中文；顏色用 CSS 濾鏡調成柔和風格（見 style.css 的 .map-tiles）
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      className: 'map-tiles',
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> 貢獻者',
    }).addTo(map);
    cluster = L.markerClusterGroup({
      showCoverageOnHover: false,
      maxClusterRadius: 45,
      iconCreateFunction: (c) => L.divIcon({
        className: '', html: `<div class="cluster">${c.getChildCount()}</div>`, iconSize: [40, 40],
      }),
    });
    config.theaters.forEach((t) => {
      const m = L.marker([t.lat, t.lng], { icon: pinIcon(t), title: t.name });
      m.bindPopup(() => popupHTML(t), { maxWidth: 300 });
      m.on('click', () => setActive(t.id, { fromMap: true }));
      markers.set(t.id, m);
    });
    map.addLayer(cluster);
    map.fitBounds(config.theaters.map((t) => [t.lat, t.lng]), { padding: [24, 24] });
  }

  function syncMarkers(list, fit) {
    cluster.clearLayers();
    cluster.addLayers(list.map((t) => markers.get(t.id)));
    if (fit && list.length) {
      const pts = list.map((t) => [t.lat, t.lng]);
      if (state.me) pts.push([state.me.lat, state.me.lng]);
      map.fitBounds(pts, { padding: [40, 40], maxZoom: 14 });
    }
  }

  function setActive(id, { fromMap = false } = {}) {
    const prev = state.active;
    state.active = id;
    [prev, id].forEach((x) => {
      const t = x && config.theaters.find((th) => th.id === x);
      if (t) markers.get(x).setIcon(pinIcon(t));
    });
    document.querySelectorAll('.card.active').forEach((el) => el.classList.remove('active'));
    const card = document.querySelector(`.card[data-id="${id}"]`);
    if (card) card.classList.add('active');

    if (fromMap) {
      // 桌機：列表捲到對應卡片；手機上地圖在上方，不打斷使用者
      if (card && isDesktop()) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } else {
      const m = markers.get(id);
      if (!isDesktop()) $('.map-wrap').scrollIntoView({ behavior: 'smooth', block: 'start' });
      cluster.zoomToShowLayer(m, () => {
        map.panTo(m.getLatLng());
        m.openPopup();
      });
    }
  }

  /* ── 定位（選用） ── */
  function locate() {
    if (state.me) { // 再按一次取消
      state.me = null;
      if (meMarker) meMarker.remove();
      $('#locate').setAttribute('aria-pressed', 'false');
      $('#locate').textContent = '📍 我附近';
      render(true);
      return;
    }
    if (!navigator.geolocation) { toast('這個瀏覽器不支援定位，可以直接用地區或搜尋查詢'); return; }
    $('#locate').textContent = '定位中…';
    navigator.geolocation.getCurrentPosition((pos) => {
      state.me = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      if (meMarker) meMarker.remove();
      meMarker = L.marker([state.me.lat, state.me.lng], {
        icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }),
        zIndexOffset: 1000, interactive: false,
      }).addTo(map);
      $('#locate').setAttribute('aria-pressed', 'true');
      $('#locate').textContent = '✕ 取消定位';
      state.group = ALL;
      renderChips();
      render(false);
      const nearest = sorted(config.theaters.filter(matches)).slice(0, 5);
      map.fitBounds([[state.me.lat, state.me.lng], ...nearest.map((t) => [t.lat, t.lng])], { padding: [50, 50], maxZoom: 14 });
      toast('已依距離由近到遠排序');
    }, () => {
      $('#locate').textContent = '📍 我附近';
      toast('沒有取得定位，沒關係，可以用地區或搜尋查詢戲院');
    }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 });
  }

  /* ── 畫面 ── */
  function renderChips() {
    $('#groups').innerHTML = [ALL, ...config.groups].map((g) => {
      const n = g === ALL ? config.theaters.length : config.theaters.filter((t) => t.group === g).length;
      return `<button class="chip" data-group="${esc(g)}" aria-pressed="${state.group === g}">${esc(g)}<span class="n">${n}</span></button>`;
    }).join('');
  }

  function renderDates() {
    const has = dates.length > 0;
    $('#dateRow').hidden = !has;
    $('#onlyShowingWrap').hidden = !has;
    if (!has) return;
    $('#dateLabel').textContent = (config.showtimes && config.showtimes.label) || '場次';
    $('#dates').innerHTML = dates.map((d) =>
      `<button class="chip" data-date="${d}" aria-pressed="${state.date === d}">${fmtDate(d)}<span class="n">${d === today() ? '今天' : weekday(d)}</span></button>`).join('');
  }

  function render(fit = false) {
    const list = sorted(config.theaters.filter(matches));
    const note = state.date && config.showtimes && config.showtimes.note
      ? `<p class="times-note">${esc(config.showtimes.note)}</p>` : '';
    if (state.me) {
      $('#list').innerHTML = `${note}<h2 class="section-title">離你最近 <span class="n">${list.length} 間</span></h2>
        <div class="cards">${list.map(cardHTML).join('')}</div>`;
    } else {
      const groups = state.group === ALL ? config.groups : [state.group];
      $('#list').innerHTML = note + groups.map((g) => {
        const items = list.filter((t) => t.group === g);
        if (!items.length) return '';
        return `<h2 class="section-title">${esc(g)} <span class="n">${items.length} 間</span></h2>
          <div class="cards">${items.map(cardHTML).join('')}</div>`;
      }).join('');
    }
    $('#count').textContent = `${list.length} 間戲院`;
    $('#empty').hidden = list.length > 0;
    syncMarkers(list, fit);

    const p = new URLSearchParams();
    if (state.q) p.set('q', state.q);
    if (state.group !== ALL) p.set('g', state.group);
    history.replaceState(null, '', p.toString() ? `?${p}` : location.pathname);
  }

  function applyTheme() {
    root.classList.toggle('is-dark', isDark());
    $('.toggle-icon').textContent = isDark() ? '☀️' : '🌙';
  }

  function bind() {
    const q = $('#q');
    q.value = state.q;
    let timer;
    q.addEventListener('input', () => {
      state.q = q.value;
      clearTimeout(timer);
      timer = setTimeout(() => render(true), 250);
    });

    $('#groups').addEventListener('click', (e) => {
      const b = e.target.closest('[data-group]');
      if (!b) return;
      state.group = b.dataset.group;
      renderChips(); render(true);
    });
    $('#onlyFav').addEventListener('change', (e) => { state.onlyFav = e.target.checked; render(true); });
    $('#onlyShowing').addEventListener('change', (e) => { state.onlyShowing = e.target.checked; render(true); });
    $('#dates').addEventListener('click', (e) => {
      const b = e.target.closest('[data-date]');
      if (!b) return;
      state.date = b.dataset.date;
      renderDates();
      render(state.onlyShowing);
      map.closePopup(); // 已開啟的泡泡還是舊日期的場次
    });
    // toggle 事件不會冒泡，用捕獲階段記住哪些戲院展開了整週場次
    $('#list').addEventListener('toggle', (e) => {
      const id = e.target.dataset && e.target.dataset.week;
      if (!id) return;
      e.target.open ? state.openWeek.add(id) : state.openWeek.delete(id);
    }, true);
    $('#locate').addEventListener('click', locate);

    $('#list').addEventListener('click', (e) => {
      const fav = e.target.closest('[data-fav]');
      if (fav) {
        const id = fav.dataset.fav;
        state.favs.has(id) ? state.favs.delete(id) : state.favs.add(id);
        store.set('chaser-favs', [...state.favs]);
        render(false);
        return;
      }
      if (e.target.closest('a, details')) return; // 訂票、導航、電話照常開啟；展開整週場次不移動地圖
      const card = e.target.closest('.card');
      if (card) setActive(card.dataset.id);
    });

    $('#themeToggle').addEventListener('click', () => {
      root.dataset.theme = isDark() ? 'light' : 'dark';
      store.set('chaser-theme', root.dataset.theme);
      applyTheme();
    });
  }

  async function load() {
    config = await fetch(`data/theaters.json?v=${Math.floor(Date.now() / 3600e3)}`).then((r) => r.json());
    if (!config.groups.includes(state.group)) state.group = ALL;
    initDates();
    initMap();
    renderChips();
    renderDates();
    render(state.group !== ALL || !!state.q);
  }

  applyTheme();
  bind();
  load().catch((err) => {
    $('#list').innerHTML = `<p class="empty">資料載入失敗，請重新整理頁面。（${esc(err.message)}）</p>`;
  });
})();
