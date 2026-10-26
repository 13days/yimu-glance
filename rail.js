// 一目 Glance · 迷你侧轨：在网页左缘叠加 44px 垂直标签图标轨（真·收窄）
// 内容脚本（无模块）。默认关闭，由侧边栏面板开启；Shadow DOM 隔离，不影响页面样式。
(() => {
  if (window.top !== window) return;        // 只在顶层页面
  if (window.__yimuRail) return;            // 防重复注入
  window.__yimuRail = 1;

  const SETTINGS_KEY = 'linknest_settings_v1';

  let host = null;
  let railEl = null;
  let sliverEl = null;
  let listEl = null;
  let enabled = false;
  let collapsed = false;

  async function getSettings() {
    try {
      const o = await chrome.storage.local.get(SETTINGS_KEY);
      return o[SETTINGS_KEY] || {};
    } catch {
      return {};
    }
  }

  async function patchSettings(patch) {
    try {
      const s = await getSettings();
      await chrome.storage.local.set({ [SETTINGS_KEY]: { ...s, ...patch } });
    } catch { /* ignore */ }
  }

  function buildUI() {
    if (host) return;
    host = document.createElement('div');
    host.style.cssText = 'all:initial;position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;';
    const sh = host.attachShadow({ mode: 'closed' });

    const style = document.createElement('style');
    style.textContent = `
      .rail {
        position: fixed; left: 6px; top: 50%; transform: translateY(-50%);
        width: 44px; max-height: 82vh;
        display: flex; flex-direction: column; align-items: center;
        background: rgba(250, 250, 252, 0.95);
        border: 1px solid rgba(0, 0, 0, 0.12);
        border-radius: 12px;
        box-shadow: 0 4px 18px rgba(0, 0, 0, 0.2);
        padding: 4px 0; gap: 2px;
        font: 12px -apple-system, "PingFang SC", sans-serif;
      }
      .list {
        overflow-y: auto; scrollbar-width: none;
        display: flex; flex-direction: column; gap: 3px; padding: 2px 0;
      }
      .list::-webkit-scrollbar { display: none; }
      .it {
        width: 32px; height: 32px; border-radius: 8px; border: none;
        background: transparent; cursor: pointer; position: relative;
        display: flex; align-items: center; justify-content: center; padding: 0;
      }
      .it:hover { background: rgba(0, 0, 0, 0.08); }
      .it.active { background: rgba(37, 99, 235, 0.14); box-shadow: inset 0 0 0 2px #2563eb; }
      .it img { width: 18px; height: 18px; border-radius: 4px; display: block; }
      .it .dot {
        width: 18px; height: 18px; border-radius: 4px; background: #8a8f98;
        color: #fff; font-size: 11px; line-height: 18px; text-align: center;
      }
      .it .x {
        position: absolute; top: -3px; right: -3px; width: 14px; height: 14px;
        border-radius: 50%; background: #555; color: #fff; font-size: 9px;
        line-height: 14px; text-align: center; display: none;
      }
      .it:hover .x { display: block; }
      .hbtn {
        width: 28px; height: 20px; border: none; background: transparent;
        color: #8a8f98; cursor: pointer; border-radius: 6px; font-size: 12px; padding: 0;
      }
      .hbtn:hover { background: rgba(0, 0, 0, 0.08); color: #333; }
      .sliver {
        position: fixed; left: 0; top: 50%; transform: translateY(-50%);
        width: 6px; height: 110px; border-radius: 0 6px 6px 0;
        background: rgba(37, 99, 235, 0.5); cursor: pointer; border: none; padding: 0;
      }
      .sliver:hover { background: rgba(37, 99, 235, 0.85); width: 9px; }
      @media (prefers-color-scheme: dark) {
        .rail { background: rgba(34, 36, 40, 0.95); border-color: rgba(255, 255, 255, 0.14); }
        .it:hover { background: rgba(255, 255, 255, 0.1); }
        .hbtn:hover { background: rgba(255, 255, 255, 0.1); color: #eee; }
      }
      [hidden] { display: none !important; }
    `;

    railEl = document.createElement('div');
    railEl.className = 'rail';

    const collapseBtn = document.createElement('button');
    collapseBtn.className = 'hbtn';
    collapseBtn.title = '收起为细条';
    collapseBtn.textContent = '«';
    collapseBtn.addEventListener('click', () => setCollapsed(true, true));

    listEl = document.createElement('div');
    listEl.className = 'list';

    const newBtn = document.createElement('button');
    newBtn.className = 'hbtn';
    newBtn.title = '新建标签页';
    newBtn.textContent = '＋';
    newBtn.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'rail:new' }).catch(() => {}));

    railEl.append(collapseBtn, listEl, newBtn);

    sliverEl = document.createElement('button');
    sliverEl.className = 'sliver';
    sliverEl.title = '展开迷你侧轨';
    sliverEl.hidden = true;
    sliverEl.addEventListener('click', () => setCollapsed(false, true));

    sh.append(style, railEl, sliverEl);
    document.documentElement.appendChild(host);
  }

  function setCollapsed(v, persist) {
    collapsed = v;
    if (railEl) railEl.hidden = v;
    if (sliverEl) sliverEl.hidden = !v;
    if (persist) patchSettings({ railCollapsed: v });
    if (!v) refresh();
  }

  function apply() {
    if (!enabled) {
      if (host) host.remove();
      host = null;
      railEl = null;
      sliverEl = null;
      listEl = null;
      return;
    }
    buildUI();
    setCollapsed(collapsed, false);
    refresh();
  }

  async function refresh() {
    if (!enabled || collapsed || !listEl) return;
    let tabs;
    try {
      tabs = await chrome.runtime.sendMessage({ type: 'rail:list' });
    } catch {
      return; // 后台未就绪
    }
    if (!Array.isArray(tabs)) return;
    listEl.textContent = '';
    for (const t of tabs) {
      const b = document.createElement('button');
      b.className = 'it' + (t.active ? ' active' : '');
      b.title = t.title || '';
      if (/^(https?:|data:)/.test(t.fav || '')) {
        const img = document.createElement('img');
        img.src = t.fav;
        img.addEventListener('error', () => {
          const dot = document.createElement('span');
          dot.className = 'dot';
          dot.textContent = (t.title || '?').trim().charAt(0).toUpperCase();
          img.replaceWith(dot);
        });
        b.appendChild(img);
      } else {
        const dot = document.createElement('span');
        dot.className = 'dot';
        dot.textContent = (t.title || '?').trim().charAt(0).toUpperCase();
        b.appendChild(dot);
      }
      const x = document.createElement('span');
      x.className = 'x';
      x.textContent = '✕';
      x.title = '关闭';
      x.addEventListener('click', (e) => {
        e.stopPropagation();
        chrome.runtime.sendMessage({ type: 'rail:close', tabId: t.id }).catch(() => {});
      });
      b.appendChild(x);
      b.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'rail:activate', tabId: t.id }).catch(() => {}));
      listEl.appendChild(b);
    }
  }

  // 面板里开关 / 其他页面收起时，实时同步
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[SETTINGS_KEY]) return;
    const s = changes[SETTINGS_KEY].newValue || {};
    enabled = !!s.railEnabled;
    collapsed = !!s.railCollapsed;
    apply();
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'rail:refresh') refresh();
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refresh();
  });

  getSettings().then((s) => {
    enabled = !!s.railEnabled;
    collapsed = !!s.railCollapsed;
    apply();
  });
})();
