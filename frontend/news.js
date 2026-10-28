// Market News page — no AI. Headlines, a short summary, the story's picture,
// the source and a link to the original article, from the publishers' own
// RSS feeds (GET /api/news on the market API). English or हिंदी; English stories can be opened
// in Google Translate for a Hindi reading.
(function marketNews() {
  const NEWS_API = "https://api.marketdock.in";
  const REFRESH_MS = 3 * 60 * 1000;
  const PAGE = 20;
  const LANG_KEY = "imNwLang";
  const el = (id) => document.getElementById(id);
  const list = el("imNwList");
  if (!list) return;

  const cache = { en: null, hi: null };
  let lang = "en";
  let tag = "ALL";
  let shown = PAGE;
  let timer = null;
  let loading = false;

  try { if (localStorage.getItem(LANG_KEY) === "hi") lang = "hi"; } catch (e) { /* storage off */ }

  const T = {
    en: { loading: "Loading the latest headlines…", empty: "No news right now. Tap Refresh in a minute.", failed: "News could not be loaded. Check your connection and tap Refresh.", updated: "Updated", read: "Read on", hindi: "हिंदी में पढ़ें", share: "Share", all: "All", more: "Show more news", sources: "sources" },
    hi: { loading: "ताज़ा खबरें लोड हो रही हैं…", empty: "अभी हिंदी में कोई बाज़ार खबर नहीं है। English टैब देखें।", failed: "खबरें लोड नहीं हो सकीं। इंटरनेट देखें और Refresh दबाएँ।", updated: "अपडेट", read: "पूरी खबर", hindi: "", share: "शेयर", all: "सभी", more: "और खबरें", sources: "स्रोत" },
  };

  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function ago(ts) {
    if (!ts) return "";
    const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
    if (lang === "hi") {
      if (s < 60) return "अभी";
      if (s < 3600) return `${Math.floor(s / 60)} मिनट पहले`;
      if (s < 86400) return `${Math.floor(s / 3600)} घंटे पहले`;
      return `${Math.floor(s / 86400)} दिन पहले`;
    }
    if (s < 60) return "Just now";
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    const d = Math.floor(s / 86400);
    return d === 1 ? "Yesterday" : `${d}d ago`;
  }

  const favicon = (site) => `https://www.google.com/s2/favicons?domain=${encodeURIComponent(site)}&sz=64`;
  const translateUrl = (url) => `https://translate.google.com/translate?sl=auto&tl=hi&hl=hi&u=${encodeURIComponent(url)}`;

  function picture(item, big) {
    const initial = esc((item.source || "?").slice(0, 1));
    const fallback = `<span class="im-nw-noimg">${item.coins && item.coins[0] ? esc(item.coins[0]) : initial}</span>`;
    if (!item.image) return `<div class="im-nw-img${big ? " is-big" : ""} is-empty">${fallback}</div>`;
    return `<div class="im-nw-img${big ? " is-big" : ""}">
        <img src="${esc(item.image)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer"
          onerror="this.parentNode.classList.add('is-empty');this.remove()">${fallback}
      </div>`;
  }

  function meta(item) {
    return `<div class="im-nw-meta">
        <img class="im-nw-fav" src="${favicon(item.site)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">
        <span class="im-nw-src">${esc(item.source)}</span>
        <span class="im-nw-dot">·</span>
        <time data-ts="${item.published || ""}">${esc(ago(item.published))}</time>
        ${(item.coins || []).slice(0, 3).map((c) => `<span class="im-nw-tag">${esc(c)}</span>`).join("")}
      </div>`;
  }

  function actions(item) {
    const t = T[lang];
    return `<div class="im-nw-actions">
        <a class="im-nw-link" href="${esc(item.url)}" target="_blank" rel="noopener noreferrer">${esc(t.read)} ${esc(item.site)} ↗</a>
        ${lang === "en" ? `<a class="im-nw-hi" href="${esc(translateUrl(item.url))}" target="_blank" rel="noopener noreferrer">${t.hindi}</a>` : ""}
        ${navigator.share ? `<button type="button" class="im-nw-share" data-share="${esc(item.id)}">${esc(t.share)}</button>` : ""}
      </div>`;
  }

  function card(item, i) {
    const big = i === 0;
    return `<article class="im-nw-card${big ? " is-lead" : ""}">
        <a class="im-nw-main" href="${esc(item.url)}" target="_blank" rel="noopener noreferrer">
          ${big ? picture(item, true) : ""}
          <div class="im-nw-body">
            ${meta(item)}
            <h3 class="im-nw-title">${esc(item.title)}</h3>
            ${item.summary ? `<p class="im-nw-sum">${esc(item.summary)}</p>` : ""}
          </div>
          ${big ? "" : picture(item, false)}
        </a>
        ${actions(item)}
      </article>`;
  }

  function filtered() {
    const data = cache[lang];
    const items = data ? data.items || [] : [];
    return tag === "ALL" ? items : items.filter((it) => (it.coins || []).includes(tag));
  }

  function renderCoins() {
    const box = el("imNwTags");
    const data = cache[lang];
    if (!box) return;
    const counts = new Map();
    (data ? data.items : []).forEach((it) => (it.coins || []).forEach((c) => counts.set(c, (counts.get(c) || 0) + 1)));
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([c]) => c);
    if (tag !== "ALL" && !top.includes(tag)) tag = "ALL";
    box.innerHTML = top.length < 2 ? "" : ["ALL", ...top].map((c) =>
      `<button type="button" class="im-nw-pill${c === tag ? " is-active" : ""}" data-news-tag="${esc(c)}">${c === "ALL" ? esc(T[lang].all) : esc(c)}</button>`).join("");
  }

  function render() {
    const t = T[lang];
    document.querySelectorAll("#imNwLang [data-news-lang]").forEach((b) => b.classList.toggle("is-active", b.dataset.newsLang === lang));
    list.classList.toggle("is-hindi", lang === "hi");
    const data = cache[lang];
    const updated = el("imNwUpdated");
    if (!data) {
      updated.textContent = loading ? t.loading : t.failed;
      if (!list.childElementCount || !loading) list.innerHTML = loading ? skeleton() : `<p class="im-nw-empty">${esc(t.failed)}</p>`;
      el("imNwMore").hidden = true;
      renderCoins();
      return;
    }
    const when = new Date(data.updated_at * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    updated.textContent = `${t.updated} ${when} · ${data.sources_ok}/${data.sources_total} ${t.sources}${loading ? " · …" : ""}`;
    renderCoins();
    const items = filtered();
    list.innerHTML = items.slice(0, shown).map(card).join("") || `<p class="im-nw-empty">${esc(t.empty)}</p>`;
    const more = el("imNwMore");
    more.hidden = items.length <= shown;
    more.textContent = t.more;
  }

  function skeleton() {
    return Array.from({ length: 4 }, (_, i) => `<div class="im-nw-card is-skeleton${i === 0 ? " is-lead" : ""}"><div class="im-nw-main">
      ${i === 0 ? '<div class="im-nw-img is-big"></div>' : ""}<div class="im-nw-body"><i></i><i></i><i></i></div>${i === 0 ? "" : '<div class="im-nw-img"></div>'}</div></div>`).join("");
  }

  async function load(force) {
    const want = lang;
    const fresh = cache[want] && Date.now() - cache[want].fetchedAt < REFRESH_MS - 5000;
    if (loading || (fresh && !force)) { render(); return; }
    loading = true;
    render();
    try {
      const res = await fetch(`${NEWS_API}/api/news?lang=${want}`, { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      data.fetchedAt = Date.now();
      cache[want] = data;
    } catch (e) {
      // Keep whatever is already on screen.
    } finally {
      loading = false;
      if (want === lang) render();
    }
  }

  const onNewsPage = () => document.getElementById("im-news")?.classList.contains("active") === true;

  function schedule() {
    clearTimeout(timer);
    if (!onNewsPage()) return;
    timer = setTimeout(async () => {
      if (document.visibilityState === "visible" && onNewsPage()) await load(true);
      schedule();
    }, REFRESH_MS);
  }

  function open() {
    shown = PAGE;
    load(false);
    schedule();
  }

  document.addEventListener("click", async (event) => {
    const langBtn = event.target.closest("#imNwLang [data-news-lang]");
    if (langBtn) {
      lang = langBtn.dataset.newsLang === "hi" ? "hi" : "en";
      try { localStorage.setItem(LANG_KEY, lang); } catch (e) { /* storage off */ }
      tag = "ALL";
      shown = PAGE;
      load(false);
      return;
    }
    const tagBtn = event.target.closest("#imNwTags [data-news-tag]");
    if (tagBtn) { tag = tagBtn.dataset.newsTag; shown = PAGE; render(); return; }
    if (event.target.closest("#imNwMore")) { shown += PAGE; render(); return; }
    if (event.target.closest("#imNwRefresh")) { load(true); return; }
    const share = event.target.closest("[data-share]");
    if (share && navigator.share) {
      const item = (cache[lang]?.items || []).find((it) => it.id === share.dataset.share);
      if (item) { try { await navigator.share({ title: item.title, url: item.url }); } catch (e) { /* cancelled */ } }
      return;
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && onNewsPage()) { load(false); schedule(); }
  });

  // Keep "5m ago" honest while the page stays open.
  setInterval(() => {
    if (!onNewsPage()) return;
    list.querySelectorAll("time[data-ts]").forEach((t) => { t.textContent = ago(Number(t.dataset.ts) || 0); });
  }, 60 * 1000);
  // Also when the app reopens straight onto the News page (no click).
  const panel = document.getElementById("im-news");
  if (panel) {
    let wasActive = panel.classList.contains("active");
    new MutationObserver(() => {
      const active = panel.classList.contains("active");
      if (active === wasActive) return;
      wasActive = active;
      if (active) open();
      else clearTimeout(timer);
    }).observe(panel, { attributes: true, attributeFilter: ["class"] });
  }
  if (onNewsPage()) open();
  window.imOpenMarketNews = open;
})();
