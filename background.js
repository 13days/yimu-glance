import { addLink, recordVisit, normalizeUrl } from './shared.js';

/* ---------- 自建浏览记录：页面加载完成时记一笔 ---------- */
const seenAt = new Map(); // norm -> 时间戳，Service Worker 存活期内去抖
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = tab?.url || '';
  if (!/^https?:/i.test(url)) return;
  const favicon = /^(https?:|data:)/i.test(tab.favIconUrl || '') ? tab.favIconUrl : '';
  if (changeInfo.status === 'complete' || (changeInfo.url && tab.status === 'complete')) {
    const norm = normalizeUrl(url);
    const now = Date.now();
    if (now - (seenAt.get(norm) || 0) < 15000) return; // 同一页 15 秒内不重复计
    seenAt.set(norm, now);
    recordVisit({ url, title: tab.title || '', favicon });
  } else if (changeInfo.title && tab.status === 'complete') {
    // SPA 场景标题晚到：只补全标题，不算新访问
    recordVisit({ url, title: changeInfo.title, favicon }, { touch: false });
  }
});

/* 切换标签页 / 切换窗口也算“浏览”：停留 2.5 秒以上才记，快速连跳不算 */
let dwellTimer = null;
function scheduleDwellRecord(tabId) {
  clearTimeout(dwellTimer);
  dwellTimer = setTimeout(async () => {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (!tab?.active) return; // 已经切走了
      const url = tab.url || '';
      if (!/^https?:/i.test(url)) return;
      const norm = normalizeUrl(url);
      const now = Date.now();
      if (now - (seenAt.get(norm) || 0) < 15000) return;
      seenAt.set(norm, now);
      recordVisit({
        url,
        title: tab.title || '',
        favicon: /^(https?:|data:)/i.test(tab.favIconUrl || '') ? tab.favIconUrl : '',
      });
    } catch {
      // 标签已关闭
    }
  }, 2500);
}

chrome.tabs.onActivated.addListener(({ tabId }) => scheduleDwellRecord(tabId));

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    clearTimeout(dwellTimer); // 浏览器失焦，取消待记录
    return;
  }
  try {
    const [tab] = await chrome.tabs.query({ active: true, windowId });
    if (tab) scheduleDwellRecord(tab.id);
  } catch {
    // 窗口已关闭
  }
});

// 点击工具栏图标 → 打开侧边栏
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'linknest-save-page', title: '收藏当前页面到「一目」', contexts: ['page'] });
    chrome.contextMenus.create({ id: 'linknest-save-link', title: '收藏此链接到「一目」', contexts: ['link'] });
  });
});

// 注入到页面里抓取正文摘要（meta description + 正文前 4000 字），供“内容”搜索
function grabPageContent() {
  const meta = document.querySelector('meta[name="description"]')?.getAttribute('content') || '';
  const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
  return ((meta ? meta + ' ' : '') + text).slice(0, 4000);
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  try {
    let result = null;
    if (info.menuItemId === 'linknest-save-page' && tab?.url && /^https?:/i.test(tab.url)) {
      let content = '';
      try {
        const res = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: grabPageContent });
        content = res?.[0]?.result || '';
      } catch {
        // 商店页 / chrome:// 等无法注入的页面，跳过内容抓取
      }
      const fav = /^(https?:|data:)/i.test(tab.favIconUrl || '') ? tab.favIconUrl : '';
      result = await addLink({ url: tab.url, title: tab.title || tab.url, content, favicon: fav });
    } else if (info.menuItemId === 'linknest-save-link' && info.linkUrl) {
      result = await addLink({ url: info.linkUrl, title: info.selectionText || info.linkUrl });
    }
    if (result) {
      chrome.action.setBadgeBackgroundColor({ color: result.status === 'added' ? '#22c55e' : '#f59e0b' });
      chrome.action.setBadgeText({ text: result.status === 'added' ? '✓' : '有' });
      setTimeout(() => chrome.action.setBadgeText({ text: '' }), 1600);
    }
  } catch (e) {
    console.error('[glance] save failed', e);
  }
});

/* ---------- 标签页访问历史：IDE 式「后退 / 前进」，跨标签页、跨窗口跳转 ----------
   stack 按激活顺序记录 tabId，cursor 指向当前位置：
   - 后退 / 前进只移动 cursor，不截断历史（浏览器前进后退语义）
   - 手动切到别的标签页 → 丢掉 cursor 之后的前进历史，追加新项
   - 标签页关闭 → 从历史里剔除，并合并因此相邻的重复项
   状态存 storage.session：Service Worker 休眠重启不丢；浏览器重启自动清空（tabId 也随之失效）。
   顺带记录每个标签页最后一次激活时间（lastActive），供「清理不常用标签页」在老版本 Chrome 上兜底 */

const NAV_KEY = 'linknest_nav_v1';
const NAV_MAX = 200;
let nav = null;                 // { stack: number[], cursor: number, lastActive: {tabId: ts} }
let navChain = Promise.resolve(); // 串行化所有读写，避免事件并发互相覆盖

function withNav(fn) {
  const run = navChain.then(async () => {
    if (!nav) {
      const obj = await chrome.storage.session.get(NAV_KEY).catch(() => ({}));
      nav = obj?.[NAV_KEY] || { stack: [], cursor: -1, lastActive: {} };
      nav.lastActive ||= {};
      if (!nav.stack.length) {
        // 首次：把当前活动标签页作为起点，这样切走一次就能「后退」回来
        const [cur] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
        if (cur) navTouch(cur.id);
      }
    }
    const ret = await fn();
    await chrome.storage.session.set({ [NAV_KEY]: nav }).catch(() => {});
    return ret;
  });
  navChain = run.catch((e) => console.error('[glance] nav', e));
  return run;
}

function navSummary() {
  return {
    canBack: nav.cursor > 0,
    canFwd: nav.cursor < nav.stack.length - 1,
    lastActive: nav.lastActive,
  };
}

// 记一次激活。与当前位置相同则忽略：后退/前进引发的激活、重复聚焦同一窗口都落在这里
function navTouch(tabId) {
  nav.lastActive[tabId] = Date.now();
  if (nav.stack[nav.cursor] === tabId) return;
  nav.stack.length = nav.cursor + 1; // 丢弃前进历史
  nav.stack.push(tabId);
  if (nav.stack.length > NAV_MAX) nav.stack.splice(0, nav.stack.length - NAV_MAX);
  nav.cursor = nav.stack.length - 1;
}

// 标签页关闭：剔除所有出现位置，合并相邻重复，cursor 跟随原位置之前最近的一项
function navForget(tabId) {
  delete nav.lastActive[tabId];
  if (!nav.stack.includes(tabId)) return;
  const stack = [];
  let cursor = -1;
  nav.stack.forEach((id, i) => {
    if (id !== tabId && stack[stack.length - 1] !== id) stack.push(id);
    if (i <= nav.cursor) cursor = stack.length - 1;
  });
  nav.stack = stack;
  nav.cursor = cursor;
}

// 后退(dir=-1) / 前进(dir=+1)：途中遇到已关闭的标签页就剔除继续找；到头返回 null
async function navGo(dir) {
  let i = nav.cursor + dir;
  while (i >= 0 && i < nav.stack.length) {
    const id = nav.stack[i];
    const tab = await chrome.tabs.get(id).catch(() => null);
    if (tab) {
      nav.cursor = i;
      nav.lastActive[id] = Date.now();
      await chrome.tabs.update(id, { active: true }).catch(() => {});
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
      return tab;
    }
    navForget(id); // 每次都会让 stack 变短，不会死循环
    i = nav.cursor + dir;
  }
  return null;
}

chrome.tabs.onActivated.addListener(({ tabId }) => withNav(() => navTouch(tabId)));
chrome.tabs.onRemoved.addListener((tabId) => withNav(() => navForget(tabId)));
chrome.tabs.onReplaced.addListener((addedId, removedId) => withNav(() => {
  nav.stack = nav.stack.map((id) => (id === removedId ? addedId : id));
  if (removedId in nav.lastActive) {
    nav.lastActive[addedId] = nav.lastActive[removedId];
    delete nav.lastActive[removedId];
  }
}));

// 切窗口（不切标签页）也算一次访问。稍等一下：如果是点了别的窗口里的标签页，
// onActivated 已经先记过了，这里查到的活动标签页与当前位置相同，自动忽略
let navFocusTimer = null;
chrome.windows.onFocusChanged.addListener((windowId) => {
  clearTimeout(navFocusTimer);
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  navFocusTimer = setTimeout(async () => {
    const win = await chrome.windows.get(windowId).catch(() => null);
    if (!win || win.type !== 'normal') return;
    const [tab] = await chrome.tabs.query({ active: true, windowId }).catch(() => []);
    if (tab) withNav(() => navTouch(tab.id));
  }, 150);
});

// 全局快捷键（chrome://extensions/shortcuts 可改）
chrome.commands.onCommand.addListener((cmd) => {
  if (cmd === 'nav-back') withNav(() => navGo(-1));
  else if (cmd === 'nav-forward') withNav(() => navGo(1));
});

// 侧边栏请求：nav-go 后退/前进；nav-state 查询状态；rail:* 迷你侧轨服务
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'rail:list' && sender.tab) {
    chrome.tabs.query({ windowId: sender.tab.windowId })
      .then((tabs) => sendResponse(tabs.map((t) => ({ id: t.id, title: t.title || '', fav: t.favIconUrl || '', active: t.active }))))
      .catch(() => sendResponse([]));
    return true;
  }
  if (msg?.type === 'rail:activate' && msg.tabId != null) {
    chrome.tabs.update(msg.tabId, { active: true }).catch(() => {});
    return false;
  }
  if (msg?.type === 'rail:close' && msg.tabId != null) {
    chrome.tabs.remove(msg.tabId).catch(() => {});
    return false;
  }
  if (msg?.type === 'rail:new' && sender.tab) {
    chrome.tabs.create({ windowId: sender.tab.windowId }).catch(() => {});
    return false;
  }
  if (msg?.type === 'nav-go') {
    withNav(async () => {
      const tab = await navGo(msg.dir < 0 ? -1 : 1);
      return { ok: !!tab, tabId: tab?.id ?? null, ...navSummary() };
    }).then(sendResponse).catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (msg?.type === 'nav-state') {
    withNav(() => navSummary()).then(sendResponse).catch(() => sendResponse(null));
    return true;
  }
  return false;
});

/* ---------- 迷你侧轨：标签变化时通知各窗口活动页刷新 ---------- */
let railTimer;
function railBroadcast() {
  clearTimeout(railTimer);
  railTimer = setTimeout(async () => {
    try {
      const actives = await chrome.tabs.query({ active: true });
      for (const t of actives) chrome.tabs.sendMessage(t.id, { type: 'rail:refresh' }).catch(() => {});
    } catch { /* ignore */ }
  }, 300);
}
for (const ev of [chrome.tabs.onCreated, chrome.tabs.onRemoved, chrome.tabs.onActivated, chrome.tabs.onMoved, chrome.tabs.onUpdated]) {
  ev.addListener(railBroadcast);
}
