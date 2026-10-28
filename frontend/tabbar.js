// Phone navigation like a native app: Home, Watchlist, Positions, Commodities and More. More opens a
// sheet with every other page and Settings. It clicks the same sidebar buttons, so page switching
// and the Pro rules stay in one place. Shown only on narrow screens (style.css).
(function marketDockTabBar() {
  const bar = document.getElementById("mdTabBar");
  const sheet = document.getElementById("md-more-sheet");
  const grid = document.getElementById("mdMoreGrid");
  if (!bar || !sheet || !grid) return;

  // sidebar page -> tab it belongs to; every other page lives under More
  const TAB_OF_PAGE = {
    "im-dashboard": "home",
    "im-watchlist": "watch",
    "im-broker-account": "position",
    "im-commodities": "commodities",
  };
  const PAGE_OF_TAB = { home: "im-dashboard", watch: "im-watchlist", position: "im-broker-account", commodities: "im-commodities" };
  const sidebarButton = (page) => document.querySelector(`.sidebar .nav-button[data-page="${page}"]`);
  const activePage = () => document.querySelector(".page.active")?.id || "im-dashboard";

  function sync() {
    const current = TAB_OF_PAGE[activePage()] || "more";
    bar.querySelectorAll("[data-tabbar]").forEach((b) => b.classList.toggle("is-active", b.dataset.tabbar === current));
  }

  function go(page) {
    sidebarButton(page)?.click();
    setTimeout(sync, 0);
  }

  // A sidebar button's name without its icon.
  function label(button) {
    const copy = button.cloneNode(true);
    copy.querySelector(".nav-icon")?.remove();
    return copy.textContent.trim();
  }

  // Every other sidebar page, then Settings, as a tile. The billing page reads
  // "Update" in the sidebar; here it is called Upgrade and put first.
  function buildMore() {
    const tiles = [];
    document.querySelectorAll(".sidebar .nav-button[data-page]").forEach((b) => {
      const page = b.dataset.page;
      if (b.hidden || TAB_OF_PAGE[page]) return;
      const upgrade = page === "im-update";
      const tile = `<button type="button" class="md-more-tile${upgrade ? " md-more-upgrade" : ""}" data-more="${page}">
          <span class="md-more-icon">${upgrade ? "&#128081;" : b.querySelector(".nav-icon")?.innerHTML || ""}</span>
          <span>${upgrade ? "Upgrade" : label(b)}</span>
        </button>`;
      upgrade ? tiles.unshift(tile) : tiles.push(tile);
    });
    tiles.push(`<button type="button" class="md-more-tile" data-more-settings="1">
        <span class="md-more-icon"><svg width="15" height="15" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="2"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></span>
        <span>Settings</span>
      </button>`);
    grid.innerHTML = tiles.join("");
  }

  const openMore = () => { buildMore(); sheet.hidden = false; };
  const closeMore = () => { sheet.hidden = true; };
  window.mdCloseMoreSheet = () => { if (sheet.hidden) return false; closeMore(); return true; };

  bar.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-tabbar]");
    if (!btn) return;
    const which = btn.dataset.tabbar;
    if (PAGE_OF_TAB[which]) go(PAGE_OF_TAB[which]);
    else openMore();
  });

  grid.addEventListener("click", (event) => {
    const tile = event.target.closest(".md-more-tile");
    if (!tile) return;
    closeMore();
    if (tile.dataset.moreSettings) document.getElementById("topSettingsMenuButton")?.click();
    else go(tile.dataset.more);
  });

  document.getElementById("mdMoreClose").addEventListener("click", closeMore);
  sheet.addEventListener("click", (event) => { if (event.target === sheet) closeMore(); });

  // Pages also change from inside the app (View All, links, toasts...).
  document.addEventListener("click", (event) => {
    if (event.target.closest(".nav-button, [data-page], [data-go]")) setTimeout(sync, 0);
  });
  new MutationObserver(sync).observe(document.body, { attributes: true, subtree: true, attributeFilter: ["class"] });
  sync();
})();
