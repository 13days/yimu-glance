// 标签页管理视图：IDE 目录树（窗口 → 分组 → 标签页）
// 单击切换 / 双击或 F2 起小名 / 右键菜单 / 拖拽移动 / ↑↓ 键盘导航 / 批量操作 / 去重
// ← → 按访问顺序跨标签页后退 / 前进（历史由后台维护）/ 🧹 清理不常用标签页（🛡 名单永久跳过）

import {
  normalizeUrl, addLink, loadAliases, setAlias, loadPanelGroups, savePanelGroups, makeId, loadKeep, setKeep,
  loadSettings, saveSettings,
} from './shared.js';
import {
  $, esc, tokensOf, highlight, prettyUrl, normHost, faviconOf,
  toast, showMenu, matchFields, snippetOf, copyText, grabPageContent, FIELD_LABEL,
} from './ui-common.js';
import { initCleanPanel, openCleanPanel, renderClean } from './view-clean.js';

const GROUP_COLORS = {
  grey: '#8b8e94', blue: '#4285f4', red: '#ea4335', yellow: '#f5b400',
  green: '#34a853', pink: '#e85d9b', purple: '#a142f4', cyan: '#24b0c4', orange: '#fa903e',
};
const COLOR_KEYS = Object.keys(GROUP_COLORS);

const t = {
  windows: [],
  groups: new Map(),        // groupId -> tabGroups.TabGroup
  aliases: {},              // normUrl -> 小名
  query: '',
  contentIndex: new Map(),  // tabId -> {url, text}
  selectMode: false,
  selected: new Set(),      // tabId
  editAliasTab: null,       // 正在加备注的 tabId
  editGroup: null,          // 正在重命名的浏览器组 id
  pgroups: { groups: [], assign: {}, tabs: {} }, // 面板虚拟分组（不产生标签栏胶囊）
  pgCollapsed: new Set(),   // 折叠的面板分组 id
  editPGroup: null,         // 正在重命名的面板分组 id
  confirmDupes: false,
  currentWindowId: null,
  wcollapsed: new Set(),    // 面板内折叠的窗口 id
  indexing: false,
  kb: null,                 // 键盘焦点行的 data-key
  compact: false,           // 收缩图标模式（类 Edge 垂直标签栏）
  autoGroup: false,         // 自动整理：新标签自动按域名归组（含自动建组）
  keep: {},                 // 不清理名单：normUrl -> {title, addedAt}
  lastActive: {},           // 后台记录的 tabId -> 最后激活时间（清理时兜底 lastAccessed）
};

let refreshTimer = null;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 120);
}

export async function initTabsView() {
  bindToolbar();
  bindList();
  // 恢复收缩模式偏好
  const settings = await loadSettings();
  if (settings.compactTabs) applyCompact(true, false);
  t.autoGroup = !!settings.autoGroup;
  await initCleanPanel({
    tabs: allTabs,
    aliases: () => t.aliases,
    keep: () => t.keep,
    lastActive: () => t.lastActive,
  });
  const events = [
    chrome.tabs.onCreated, chrome.tabs.onRemoved, chrome.tabs.onUpdated,
    chrome.tabs.onMoved, chrome.tabs.onActivated, chrome.tabs.onAttached,
    chrome.tabs.onDetached, chrome.tabs.onReplaced,
    chrome.tabGroups.onCreated, chrome.tabGroups.onUpdated,
    chrome.tabGroups.onRemoved, chrome.tabGroups.onMoved,
    chrome.windows.onCreated, chrome.windows.onRemoved, chrome.windows.onFocusChanged,
  ];
  for (const ev of events) ev.addListener(scheduleRefresh);
  await refresh();
  // 打开侧边栏时自动定位到当前标签页
  await locateActiveTab({ flash: false, smooth: false, silent: true });
}

export function setTabsQuery(q) {
  t.query = q;
  render();
}

export async function onAliasChanged() {
  t.aliases = await loadAliases();
  render();
}

export async function onKeepChanged() {
  t.keep = await loadKeep();
  render();
}

/* ------- ← → 跨标签页后退 / 前进：历史在后台（background.js）维护，这里只发指令、同步按钮状态 ------- */

function applyNavState(s) {
  if (!s) return;
  if (s.lastActive) t.lastActive = s.lastActive;
  $('#t-back').disabled = !s.canBack;
  $('#t-fwd').disabled = !s.canFwd;
}

async function syncNavState() {
  const s = await chrome.runtime.sendMessage({ type: 'nav-state' }).catch(() => null);
  applyNavState(s);
}

// dir = -1 后退 / +1 前进；跳过去后把那一行滚到可见处
export async function navigateTabs(dir) {
  const r = await chrome.runtime.sendMessage({ type: 'nav-go', dir }).catch(() => null);
  if (!r) {
    toast('后台没有响应，请重新打开侧边栏再试');
    return;
  }
  applyNavState(r);
  if (!r.ok) {
    toast(dir < 0 ? '已经是最早访问的标签页了' : '已经是最新访问的标签页了');
    return;
  }
  await refresh();
  const row = document.querySelector(`#t-list .row[data-tab="${r.tabId}"]`);
  if (row) setKb(row);
}

/* ---------------- 数据 ---------------- */

async function refresh() {
  const [wins, groups, cur, aliases, pgroups, keep] = await Promise.all([
    chrome.windows.getAll({ populate: true, windowTypes: ['normal'] }),
    chrome.tabGroups.query({}),
    chrome.windows.getCurrent().catch(() => null),
    loadAliases(),
    loadPanelGroups(),
    loadKeep(),
  ]);
  t.currentWindowId = cur?.id ?? null;
  wins.sort((a, b) => (b.id === t.currentWindowId) - (a.id === t.currentWindowId));
  t.windows = wins;
  t.groups = new Map(groups.map((g) => [g.id, g]));
  t.aliases = aliases;
  t.pgroups = pgroups;
  t.keep = keep;
  syncNavState(); // 每次标签页变动都刷一下 ← → 可用状态（不阻塞渲染）

  const alive = new Set(allTabs().map((tb) => tb.id));
  for (const id of [...t.selected]) if (!alive.has(id)) t.selected.delete(id);
  for (const id of [...t.contentIndex.keys()]) if (!alive.has(id)) t.contentIndex.delete(id);
  if (t.editAliasTab && !alive.has(t.editAliasTab)) t.editAliasTab = null;
  // 清理已关闭标签页的分组归属
  let dirty = false;
  for (const k of Object.keys(t.pgroups.tabs || {})) {
    if (!alive.has(Number(k))) {
      delete t.pgroups.tabs[k];
      dirty = true;
    }
  }
  // 粘性收编：URL 精确命中 → 收编；域名组（按域名分组建的）→ 同域名散装标签自动吸附
  const liveGroupIds = new Set(t.pgroups.groups.map((g) => g.id));
  const hostToGid = new Map();
  for (const g of t.pgroups.groups) {
    const h = g.host || (/^[\w-]+(\.[\w-]+)+$/.test(g.name || '') ? g.name : null);
    if (h) hostToGid.set(h, g.id);
  }
  for (const tb of allTabs()) {
    if (t.pgroups.tabs[tb.id] !== undefined) continue; // 已有归属或明确移出
    const url = urlOf(tb);
    let gid = t.pgroups.assign[normalizeUrl(url)];
    if ((!gid || !liveGroupIds.has(gid)) && !tb.pinned && tb.groupId === -1 && /^https?:/i.test(url)) {
      gid = hostToGid.get(normHost(url)); // 域名吸附
    }
    if (gid && liveGroupIds.has(gid)) {
      t.pgroups.tabs[tb.id] = gid;
      dirty = true;
    }
  }
  // 自动整理开启时：为新域名自动建组并归入（含不足以吸附的散装标签）
  if (t.autoGroup && autoGroupPass()) dirty = true;
  if (dirty) savePanelGroups(t.pgroups);

  // 正在行内输入（起小名 / 组重命名）时不打断
  const ae = document.activeElement;
  if (ae && ae.closest && ae.closest('#t-list') && ae.tagName === 'INPUT') return;
  render();
}

function allTabs() {
  return t.windows.flatMap((w) => w.tabs || []);
}

function findTab(id) {
  for (const w of t.windows) {
    const tab = (w.tabs || []).find((x) => x.id === id);
    if (tab) return tab;
  }
  return null;
}

function urlOf(tab) {
  return tab.url || tab.pendingUrl || '';
}

function contentOf(tab) {
  const e = t.contentIndex.get(tab.id);
  return e && e.url === urlOf(tab) ? e.text : '';
}

function matchTab(tab, tokens) {
  if (!tokens.length) return { matchedFields: new Set(), score: 0 };
  const url = urlOf(tab);
  return matchFields({
    alias: (t.aliases[normalizeUrl(url)] || '').toLowerCase(),
    title: (tab.title || '').toLowerCase(),
    url: url.toLowerCase(),
    content: contentOf(tab).toLowerCase(),
  }, tokens);
}

function dupMap() {
  const m = new Map(); // norm -> tabs[]
  for (const tab of allTabs()) {
    const k = normalizeUrl(urlOf(tab));
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(tab);
  }
  return m;
}

/* ---------------- 渲染 ---------------- */

function render() {
  const tokens = tokensOf(t.query);
  const dups = dupMap();
  const all = allTabs();
  let dupExtra = 0;
  for (const arr of dups.values()) dupExtra += Math.max(0, arr.length - 1);

  const dupBtn = $('#t-dedupe');
  dupBtn.classList.toggle('hidden', dupExtra === 0);
  dupBtn.textContent = t.confirmDupes ? `确认关闭 ${dupExtra} 个?` : `去重 ${dupExtra}`;
  dupBtn.title = `关闭 ${dupExtra} 个重复标签页（保留固定 / 活动 / 最近使用的）`;
  dupBtn.classList.toggle('danger', t.confirmDupes);
  $('#t-select').classList.toggle('on', t.selectMode);

  let shown = 0;
  const parts = [];
  t.windows.forEach((win, wi) => {
    const html = windowHTML(win, wi, tokens, dups, (n) => { shown += n; });
    if (html) parts.push(html);
  });

  $('#t-stats').textContent = tokens.length
    ? `匹配 ${shown} / ${all.length} 个标签页`
    : `${t.windows.length} 窗口 · ${all.length} 标签页`;

  $('#t-list').innerHTML = parts.join('') || `<div class="empty"><p>${tokens.length ? '没有匹配的标签页' : '没有打开的窗口'}</p></div>`;

  const kbEl = t.kb && document.querySelector(`#t-list .row[data-key="${CSS.escape(t.kb)}"]`);
  if (kbEl) kbEl.classList.add('kb');

  if (t.editAliasTab != null) {
    const input = document.querySelector('#t-list .alias-input');
    if (input && document.activeElement !== input) { input.focus(); input.select(); }
  }
  if (t.editGroup != null || t.editPGroup != null) {
    const input = document.querySelector('#t-list .g-name');
    if (input && document.activeElement !== input) { input.focus(); input.select(); }
  }
  renderBatchBar();
  renderClean();
}

function windowHTML(win, wi, tokens, dups, addShown) {
  const tabs = win.tabs || [];
  const blocks = [];
  let shownCount = 0;
  const pgBuckets = new Map(); // 面板分组 id -> [{tab, m}]
  const loose = [];
  let i = 0;
  while (i < tabs.length) {
    const tab = tabs[i];
    if (tab.groupId !== -1) {
      const gid = tab.groupId;
      const run = [];
      while (i < tabs.length && tabs[i].groupId === gid) run.push(tabs[i++]);
      const g = t.groups.get(gid);
      const rows = run
        .map((tb) => ({ tab: tb, m: matchTab(tb, tokens) }))
        .filter((r) => r.m);
      if (tokens.length && !rows.length) continue;
      shownCount += rows.length;
      const open = tokens.length ? true : !(g?.collapsed);
      blocks.push(groupBlockHTML(g, gid, run.length, rows, open, tokens, dups));
    } else {
      const m = matchTab(tab, tokens);
      i++;
      if (!m) continue;
      const pgid = memberGid(tab);
      if (pgid && t.pgroups.groups.some((g) => g.id === pgid)) {
        if (!pgBuckets.has(pgid)) pgBuckets.set(pgid, []);
        pgBuckets.get(pgid).push({ tab, m });
      } else {
        loose.push({ tab, m });
      }
    }
  }
  // 面板虚拟分组块（按创建顺序），散装标签排最后
  for (const pg of t.pgroups.groups) {
    const rows = pgBuckets.get(pg.id);
    if (!rows || !rows.length) continue;
    shownCount += rows.length;
    const open = tokens.length ? true : !t.pgCollapsed.has(pg.id);
    blocks.push(pGroupBlockHTML(pg, rows, open, tokens, dups));
  }
  shownCount += loose.length;
  blocks.push(...loose.map((r) => tabRowHTML(r.tab, tokens, r.m, dups, 1)));
  if (tokens.length && shownCount === 0) return '';
  addShown(shownCount);
  const collapsed = !tokens.length && t.wcollapsed.has(win.id);
  const label = win.id === t.currentWindowId ? '当前窗口' : `窗口 ${wi + 1}`;
  return `
  <div class="node">
    <div class="row win-head" data-key="win-${win.id}" data-win="${win.id}" data-drop-win="${win.id}">
      <span class="chev">${collapsed ? '▸' : '▾'}</span>
      <span class="node-name">${label}</span>
      <span class="cnt">${tabs.length}</span>
      <span class="acts">
        <button class="mini" data-wact="newtab" title="新建标签页">＋</button>
        <button class="mini" data-wact="save" title="收藏窗口内全部标签页">⭐</button>
      </span>
    </div>
    ${collapsed ? '' : `<div class="children win-children">${blocks.join('')}</div>`}
  </div>`;
}

function groupBlockHTML(g, gid, total, rows, open, tokens, dups) {
  const color = GROUP_COLORS[g?.color] || '#8b8e94';
  let head;
  if (t.editGroup === gid && g) {
    const dots = COLOR_KEYS.map((c) =>
      `<span class="dot ${c === g.color ? 'on' : ''}" data-gcolor="${c}" style="background:${GROUP_COLORS[c]}"></span>`).join('');
    head = `<div class="row grp-head editing" data-group="${gid}" style="--gc:${color}">
      <input class="g-name" value="${esc(g.title || '')}" placeholder="分组名" maxlength="24">
      <span class="dots">${dots}</span>
      <button class="mini" data-gact="save" title="保存">✓</button>
    </div>`;
  } else {
    head = `<div class="row grp-head" data-key="grp-${gid}" data-group="${gid}" data-drop-group="${gid}" style="--gc:${color}">
      <span class="chev">${open ? '▾' : '▸'}</span>
      <span class="gdot"></span>
      <span class="node-name">${esc(g?.title || '未命名分组')}</span>
      <span class="cnt">${total}</span>
      <span class="acts">
        <button class="mini" data-gact="edit" title="重命名 / 颜色 (F2)">✎</button>
        <button class="mini" data-gact="save-all" title="收藏整组">⭐</button>
        <button class="mini" data-gact="close" title="关闭整组">✕</button>
      </span>
    </div>`;
  }
  const body = open
    ? `<div class="children grp-children" style="--gc:${color}">${rows.map((r) => tabRowHTML(r.tab, tokens, r.m, dups, 2)).join('')}</div>`
    : '';
  return `<div class="node">${head}${body}</div>`;
}

// 面板虚拟分组块：结构同浏览器组，但空心圆点标识，折叠状态本地维护
function pGroupBlockHTML(pg, rows, open, tokens, dups) {
  const color = GROUP_COLORS[pg.color] || '#8b8e94';
  let head;
  if (t.editPGroup === pg.id) {
    const dots = COLOR_KEYS.map((c) =>
      `<span class="dot ${c === pg.color ? 'on' : ''}" data-gcolor="${c}" style="background:${GROUP_COLORS[c]}"></span>`).join('');
    head = `<div class="row grp-head editing" data-pgroup="${esc(pg.id)}" style="--gc:${color}">
      <input class="g-name" value="${esc(pg.name || '')}" placeholder="分组名" maxlength="24">
      <span class="dots">${dots}</span>
      <button class="mini" data-pgact="save" title="保存">✓</button>
    </div>`;
  } else {
    head = `<div class="row grp-head" data-key="pg-${esc(pg.id)}" data-pgroup="${esc(pg.id)}" data-drop-pgroup="${esc(pg.id)}" style="--gc:${color}">
      <span class="chev">${open ? '▾' : '▸'}</span>
      <span class="gdot hollow"></span>
      <span class="node-name">${esc(pg.name || '未命名分组')}</span>
      <span class="cnt">${rows.length}</span>
      <span class="acts">
        <button class="mini" data-pgact="edit" title="重命名 / 颜色 (F2)">✎</button>
        <button class="mini" data-pgact="save-all" title="收藏整组">⭐</button>
        <button class="mini" data-pgact="ungroup" title="取消分组（标签保留）">⊟</button>
        <button class="mini" data-pgact="close" title="关闭整组标签页">✕</button>
      </span>
    </div>`;
  }
  const body = open
    ? `<div class="children grp-children" style="--gc:${color}">${rows.map((r) => tabRowHTML(r.tab, tokens, r.m, dups, 2)).join('')}</div>`
    : '';
  return `<div class="node">${head}${body}</div>`;
}

function favOf(tab) {
  const f = tab.favIconUrl || '';
  if (/^(https?:|data:)/i.test(f)) return f;
  return faviconOf(urlOf(tab));
}

function tabRowHTML(tab, tokens, m, dups, depth) {
  const url = urlOf(tab);
  const norm = normalizeUrl(url);
  const alias = t.aliases[norm] || '';

  if (t.editAliasTab === tab.id) {
    return `<div class="row tab-row editing depth${depth}" data-tab="${tab.id}">
      <img class="fav" src="${esc(favOf(tab))}" alt="">
      <input class="alias-input" value="${esc(alias)}" placeholder="加个备注，回车保存" maxlength="30">
      <button class="mini" data-tact="alias-save" title="保存">✓</button>
      <button class="mini" data-tact="alias-cancel" title="取消">✕</button>
    </div>`;
  }

  const badges = [];
  if (tokens.length) for (const f of m.matchedFields) badges.push(`<span class="badge">${FIELD_LABEL[f]}</span>`);
  if ((dups.get(norm) || []).length > 1) badges.push('<span class="badge warn">重复</span>');
  const check = t.selectMode ? `<input type="checkbox" class="t-check" ${t.selected.has(tab.id) ? 'checked' : ''}>` : '';
  const pinned = tab.pinned ? '<span class="ind" title="已固定">📌</span>' : '';
  const kept = t.keep[norm] ? '<span class="ind" title="已标记不清理：清理不常用标签页时自动跳过">🛡</span>' : '';
  const sound = tab.mutedInfo?.muted
    ? '<button class="mini ind" data-tact="mute" title="取消静音">🔇</button>'
    : tab.audible ? '<button class="mini ind" data-tact="mute" title="静音">🔊</button>' : '';
  const aliasHtml = alias ? `<span class="alias">${highlight(alias, tokens)}</span>` : '';
  const activeCls = tab.active ? (tab.windowId === t.currentWindowId ? 'active' : 'semi') : '';

  let extra = '';
  if (tokens.length && (m.matchedFields.has('url') || m.matchedFields.has('content'))) {
    extra += `<div class="sub depth${depth}">${highlight(prettyUrl(url), tokens)}</div>`;
    const snip = m.matchedFields.has('content') ? snippetOf(contentOf(tab), tokens) : '';
    if (snip) extra += `<div class="sub snippet depth${depth}">${highlight(snip, tokens)}</div>`;
  }

  return `
  <div class="row tab-row depth${depth} ${activeCls} ${t.selected.has(tab.id) ? 'selected' : ''}"
       data-key="tab-${tab.id}" data-tab="${tab.id}" draggable="true" title="${esc(url)}">
    ${check}
    <img class="fav" src="${esc(favOf(tab))}" alt="">
    <span class="t-title">${aliasHtml}${highlight(tab.title || url, tokens)}</span>
    ${badges.join('')}${pinned}${kept}${sound}
    <span class="acts">
      <button class="mini" data-tact="save" title="收藏">⭐</button>
      <button class="mini" data-tact="alias" title="加备注 (F2 / 双击)">✎</button>
      <button class="mini" data-tact="close" title="关闭 (Del)">✕</button>
    </span>
  </div>${extra}`;
}

function renderBatchBar() {
  const bar = $('#t-batchbar');
  bar.classList.toggle('hidden', !t.selectMode);
  if (!t.selectMode) return;
  $('#t-selcount').textContent = `已选 ${t.selected.size}`;
  const sel = $('#t-batch-group');
  const opts = ['<option value="">分组到…</option>'];
  for (const g of t.pgroups.groups) {
    opts.push(`<option value="${esc(g.id)}">${esc(g.name || '未命名分组')}</option>`);
  }
  opts.push('<option value="__new__">＋ 新建分组</option>');
  sel.innerHTML = opts.join('');
}

/* ---------------- 动作 ---------------- */

// 定位当前标签页（IDE 的「在目录树中显示」）：清搜索、展开所在窗口/分组、滚动高亮
async function locateActiveTab({ flash = true, smooth = true, silent = false } = {}) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    if (!silent) toast('没有活动的标签页');
    return;
  }
  if (t.query) {
    t.query = '';
    const search = $('#search');
    if (search) search.value = '';
  }
  t.wcollapsed.delete(tab.windowId);
  const pgid = memberGid(tab);
  if (pgid) t.pgCollapsed.delete(pgid);
  const g = tab.groupId !== -1 ? t.groups.get(tab.groupId) : null;
  if (g?.collapsed) await chrome.tabGroups.update(g.id, { collapsed: false }).catch(() => {});
  await refresh();
  const row = document.querySelector(`#t-list .row[data-tab="${tab.id}"]`);
  if (!row) {
    if (!silent) toast('没有找到当前标签页');
    return;
  }
  setKb(row);
  row.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'center' });
  if (flash) {
    row.classList.add('flash');
    setTimeout(() => row.classList.remove('flash'), 1600);
  }
}

async function activateTab(id) {
  const tab = findTab(id);
  if (!tab) return;
  await chrome.tabs.update(id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
}

async function saveTabToCollection(tab, { silent = false } = {}) {
  const url = urlOf(tab);
  if (!/^https?:/i.test(url)) {
    if (!silent) toast('此标签页无法收藏（仅支持 http/https）');
    return null;
  }
  let content = contentOf(tab);
  if (!content) {
    try {
      const res = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: grabPageContent });
      content = res?.[0]?.result || '';
    } catch { /* 无法注入的页面 */ }
  }
  const norm = normalizeUrl(url);
  const fav = /^(https?:|data:)/i.test(tab.favIconUrl || '') ? tab.favIconUrl : '';
  const result = await addLink({ url, title: tab.title || url, content, alias: t.aliases[norm] || '', favicon: fav });
  if (!silent) toast(result.status === 'added' ? '已收藏 ✓（见「收藏」视图）' : '已在收藏中，自动去重 ✓');
  return result;
}

async function saveTabsBatch(tabs) {
  let added = 0, dup = 0, skip = 0;
  for (const tab of tabs) {
    const r = await saveTabToCollection(tab, { silent: true });
    if (!r) skip++;
    else if (r.status === 'added') added++;
    else dup++;
  }
  toast(`收藏完成：新增 ${added}${dup ? `，已有 ${dup}` : ''}${skip ? `，跳过 ${skip}` : ''}`);
}

async function closeDuplicates() {
  const toClose = [];
  for (const tabs of dupMap().values()) {
    if (tabs.length < 2) continue;
    const sorted = [...tabs].sort((a, b) =>
      (b.pinned - a.pinned) || (b.active - a.active) || ((b.lastAccessed || 0) - (a.lastAccessed || 0)));
    toClose.push(...sorted.slice(1).filter((x) => !x.pinned).map((x) => x.id));
  }
  if (toClose.length) await chrome.tabs.remove(toClose);
  toast(toClose.length ? `已关闭 ${toClose.length} 个重复标签页` : '没有可关闭的重复标签页');
}

// 自动整理一轮：散装标签按域名归组，同域 ≥2 个且无组时自动建组；只返回是否有变化，不写存储
function autoGroupPass() {
  t.pgroups.tabs ||= {};
  const byHost = new Map();
  for (const tab of allTabs()) {
    if (tab.pinned || tab.groupId !== -1) continue;
    const url = urlOf(tab);
    if (!/^https?:/i.test(url)) continue;
    if (t.pgroups.tabs[tab.id] !== undefined) continue; // 已有归属或用户明确移出
    const host = normHost(url);
    if (!byHost.has(host)) byHost.set(host, []);
    byHost.get(host).push(tab);
  }
  let changed = false;
  let ci = t.pgroups.groups.length;
  for (const [host, tabs] of byHost) {
    let pg = t.pgroups.groups.find((g) => g.host === host || g.name === host);
    if (!pg) {
      if (tabs.length < 2) continue; // 单个标签不建组
      pg = { id: makeId(), name: host, host, color: COLOR_KEYS[1 + (ci++ % (COLOR_KEYS.length - 1))] };
      t.pgroups.groups.push(pg);
      changed = true;
    }
    for (const tab of tabs) {
      t.pgroups.tabs[tab.id] = pg.id;
      t.pgroups.assign[normalizeUrl(urlOf(tab))] = pg.id;
      changed = true;
    }
  }
  return changed;
}

// 按域名归组：只建面板虚拟分组，不动浏览器标签栏（无胶囊）
async function groupByDomain() {
  t.pgroups.tabs ||= {};
  const byHost = new Map(); // host -> tabs[]
  for (const tab of allTabs()) {
    if (tab.pinned || tab.groupId !== -1) continue;
    const url = urlOf(tab);
    if (!/^https?:/i.test(url)) continue;
    if (memberGid(tab)) continue; // 已归组的不动
    const host = normHost(url);
    if (!byHost.has(host)) byHost.set(host, []);
    byHost.get(host).push(tab);
  }
  let created = 0, grouped = 0, ci = t.pgroups.groups.length;
  for (const [host, tabs] of byHost) {
    if (tabs.length < 2) continue;
    let pg = t.pgroups.groups.find((g) => g.name === host || g.host === host);
    if (!pg) {
      // host 字段：域名吸附规则，之后该域名的散装标签自动入组（改组名也不影响）
      pg = { id: makeId(), name: host, host, color: COLOR_KEYS[1 + (ci++ % (COLOR_KEYS.length - 1))] };
      t.pgroups.groups.push(pg);
      created++;
    } else if (!pg.host) {
      pg.host = host;
    }
    for (const tab of tabs) {
      t.pgroups.tabs[tab.id] = pg.id;
      t.pgroups.assign[normalizeUrl(urlOf(tab))] = pg.id;
    }
    grouped += tabs.length;
  }
  await commitPGroups();
  toast(grouped
    ? `已按域名归入 ${created} 个面板分组（${grouped} 个标签页，标签栏无胶囊）`
    : '没有 2 个以上同域名的散装标签页');
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

/* ------- 面板虚拟分组操作 ------- */

async function commitPGroups() {
  await savePanelGroups(t.pgroups);
  render();
}

// 成员判定：标签页归属优先（跟着标签走，跳转不掉组）；URL 映射兜底（重启后接回）
function memberGid(tab) {
  const byTab = (t.pgroups.tabs || {})[tab.id];
  if (byTab !== undefined) return byTab || null; // '' = 用户明确移出
  return t.pgroups.assign[normalizeUrl(urlOf(tab))] || null;
}

function pgMemberTabs(gid) {
  return allTabs().filter((tb) => memberGid(tb) === gid);
}

async function assignTabToPGroup(tabId, gid) {
  const tab = findTab(tabId);
  if (!tab) return;
  t.pgroups.tabs ||= {};
  const norm = normalizeUrl(urlOf(tab));
  if (gid) {
    t.pgroups.tabs[tabId] = gid;      // 跟标签走
    t.pgroups.assign[norm] = gid;     // 重启后按 URL 接回
  } else {
    t.pgroups.tabs[tabId] = '';       // 强制移出，URL 匹配也不再拉回来
    if (t.pgroups.assign[norm]) delete t.pgroups.assign[norm];
  }
  await commitPGroups();
}

async function handlePGroupAction(act, gid, rowEl) {
  const pg = t.pgroups.groups.find((g) => g.id === gid);
  switch (act) {
    case 'edit':
      t.editPGroup = gid;
      render();
      break;
    case 'save': {
      const input = rowEl?.querySelector('.g-name') || document.querySelector('#t-list .g-name');
      const name = (input?.value || '').trim();
      t.editPGroup = null;
      if (pg && name) pg.name = name;
      await commitPGroups();
      break;
    }
    case 'save-all': await saveTabsBatch(pgMemberTabs(gid)); break;
    case 'ungroup': {
      for (const [k, v] of Object.entries(t.pgroups.assign)) if (v === gid) delete t.pgroups.assign[k];
      for (const [k, v] of Object.entries(t.pgroups.tabs || {})) if (v === gid) delete t.pgroups.tabs[k];
      t.pgroups.groups = t.pgroups.groups.filter((g) => g.id !== gid);
      await commitPGroups();
      toast('已取消该分组（标签页保留）');
      break;
    }
    case 'close': {
      const ids = pgMemberTabs(gid).map((x) => x.id);
      if (ids.length) await chrome.tabs.remove(ids);
      break;
    }
  }
}

function showPGroupMenu(e, gid) {
  showMenu(e.clientX, e.clientY, [
    { id: 'edit', label: '✎ 重命名 / 颜色' },
    { id: 'save-all', label: '⭐ 收藏整组' },
    { id: 'ungroup', label: '⊟ 取消分组（标签保留）' },
    '-',
    { id: 'close', label: '✕ 关闭整组标签页', danger: true },
  ], (act) => handlePGroupAction(act, gid));
}

async function ungroupAllPanel() {
  const n = t.pgroups.groups.length;
  t.pgroups = { groups: [], assign: {}, tabs: {} };
  // 用户手动清空分组时顺带关掉自动整理，否则下一次刷新又会重建
  if (t.autoGroup) {
    t.autoGroup = false;
    await saveSettings({ autoGroup: false });
  }
  await commitPGroups();
  toast(n ? `已取消全部面板分组（${n} 个，自动整理已关闭）` : '当前没有面板分组');
}

// 解散浏览器原生标签组（标签页原地保留，标签栏胶囊消失）
async function ungroupAll() {
  let tabs = 0, groups = 0;
  for (const g of [...t.groups.values()]) {
    const inGroup = await chrome.tabs.query({ groupId: g.id });
    if (inGroup.length) {
      await chrome.tabs.ungroup(inGroup.map((x) => x.id)).catch(() => {});
      tabs += inGroup.length;
      groups++;
    }
  }
  toast(groups ? `已解散 ${groups} 个分组（${tabs} 个标签页原地保留）` : '当前没有标签组');
}

async function indexContent() {
  if (t.indexing) return;
  t.indexing = true;
  const btn = $('#t-index');
  btn.classList.add('busy');
  let ok = 0, skip = 0;
  try {
    // 只索引已加载的 http/https 页面；休眠、未加载、系统页直接跳过
    const targets = allTabs().filter((tab) => {
      const url = urlOf(tab);
      if (!/^https?:/i.test(url) || tab.discarded || tab.status === 'unloaded') {
        skip++;
        return false;
      }
      const cached = t.contentIndex.get(tab.id);
      if (cached && cached.url === url) {
        ok++;
        return false;
      }
      return true;
    });
    let done = 0;
    const queue = [...targets];
    const worker = async () => {
      while (queue.length) {
        const tab = queue.shift();
        const url = urlOf(tab);
        try {
          // 单个标签最多等 4 秒：卡死 / 假死的页面不拖累整体
          const res = await withTimeout(
            chrome.scripting.executeScript({ target: { tabId: tab.id }, func: grabPageContent }),
            4000,
          );
          t.contentIndex.set(tab.id, { url, text: res?.[0]?.result || '' });
          ok++;
        } catch {
          skip++;
        }
        done++;
        $('#t-stats').textContent = `索引中 ${done}/${targets.length}…`;
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, targets.length) }, worker));
  } finally {
    t.indexing = false;
    btn.classList.remove('busy');
  }
  toast(`内容索引完成：${ok} 个标签页可全文搜索${skip ? `，跳过 ${skip} 个` : ''}`);
  render();
}

async function handleTabAction(act, id, rowEl) {
  const tab = findTab(id);
  if (!tab && act !== 'alias-cancel') return;
  switch (act) {
    case 'activate': await activateTab(id); break;
    case 'save': await saveTabToCollection(tab); break;
    case 'alias':
      t.editAliasTab = id;
      render();
      break;
    case 'alias-save': {
      const input = rowEl?.querySelector('.alias-input') || document.querySelector('#t-list .alias-input');
      const v = (input?.value || '').trim();
      t.editAliasTab = null;
      await setAlias(normalizeUrl(urlOf(tab)), v);
      t.aliases = await loadAliases();
      render();
      toast(v ? `已备注「${v}」` : '已清除备注');
      break;
    }
    case 'alias-cancel':
      t.editAliasTab = null;
      render();
      break;
    case 'pin': await chrome.tabs.update(id, { pinned: !tab.pinned }); break;
    case 'mute': await chrome.tabs.update(id, { muted: !(tab.mutedInfo?.muted) }); break;
    case 'ungroup-one': await chrome.tabs.ungroup(id); break;
    case 'unassign': await assignTabToPGroup(id, null); break;
    case 'copy': await copyText(urlOf(tab)); break;
    case 'keep': {
      const norm = normalizeUrl(urlOf(tab));
      const nowKept = !t.keep[norm];
      await setKeep(norm, nowKept, tab.title || '');
      toast(nowKept ? '已标记不清理 🛡 清理不常用标签页时会自动跳过' : '已取消「不清理」标记');
      break;
    }
    case 'close': await chrome.tabs.remove(id); break;
    case 'close-dups': {
      const norm = normalizeUrl(urlOf(tab));
      const others = (dupMap().get(norm) || []).filter((x) => x.id !== id && !x.pinned).map((x) => x.id);
      if (others.length) await chrome.tabs.remove(others);
      toast(`已关闭 ${others.length} 个重复项`);
      break;
    }
  }
}

async function handleGroupAction(act, gid, rowEl) {
  const g = t.groups.get(gid);
  switch (act) {
    case 'edit':
      t.editGroup = gid;
      render();
      break;
    case 'save': {
      const input = rowEl?.querySelector('.g-name') || document.querySelector('#t-list .g-name');
      const title = (input?.value || '').trim();
      t.editGroup = null;
      if (g) await chrome.tabGroups.update(gid, { title });
      break;
    }
    case 'save-all': {
      const tabs = await chrome.tabs.query({ groupId: gid });
      await saveTabsBatch(tabs);
      break;
    }
    case 'ungroup': {
      const tabs = await chrome.tabs.query({ groupId: gid });
      if (tabs.length) await chrome.tabs.ungroup(tabs.map((x) => x.id));
      break;
    }
    case 'close': {
      const tabs = await chrome.tabs.query({ groupId: gid });
      if (tabs.length) await chrome.tabs.remove(tabs.map((x) => x.id));
      break;
    }
  }
}

async function handleWindowAction(act, wid) {
  switch (act) {
    case 'newtab': await chrome.tabs.create({ windowId: wid }); break;
    case 'save': {
      const win = t.windows.find((w) => w.id === wid);
      if (win) await saveTabsBatch(win.tabs || []);
      break;
    }
    case 'ungroup-win': {
      const win = t.windows.find((w) => w.id === wid);
      const ids = (win?.tabs || []).filter((x) => x.groupId !== -1).map((x) => x.id);
      if (ids.length) await chrome.tabs.ungroup(ids);
      toast(ids.length ? `已解散本窗口分组（${ids.length} 个标签页）` : '本窗口没有分组');
      break;
    }
    case 'close-window': await chrome.windows.remove(wid); break;
  }
}

/* ---------------- 事件 ---------------- */

// 收缩图标模式：只留 favicon，把面板拖窄即是 Edge 式垂直标签栏
function applyCompact(on, persist = true) {
  t.compact = on;
  $('#view-tabs').classList.toggle('compact', on);
  $('#t-compact').classList.toggle('on', on);
  if (persist) saveSettings({ compactTabs: on });
}

function bindToolbar() {
  $('#t-newtab').addEventListener('click', async () => {
    const win = await chrome.windows.getCurrent().catch(() => null);
    await chrome.tabs.create(win ? { windowId: win.id } : {});
  });

  $('#t-compact').addEventListener('click', async (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const s = await loadSettings();
    showMenu(rect.left - 60, rect.bottom + 4, [
      { id: 'rail', label: `${s.railEnabled ? '✓ ' : ''}▎迷你侧轨（页面左缘 44px，真·收窄）` },
      { id: 'compact', label: `${t.compact ? '✓ ' : ''}▤ 紧凑图标列表（面板内）` },
    ], async (act) => {
      if (act === 'compact') {
        applyCompact(!t.compact);
        return;
      }
      const on = !s.railEnabled;
      await saveSettings({ railEnabled: on, railCollapsed: false });
      if (on) {
        // 已打开的页面立即注入，不用等刷新
        const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
        await Promise.all(tabs.map((tb) =>
          chrome.scripting.executeScript({ target: { tabId: tb.id }, files: ['rail.js'] }).catch(() => {})));
        toast('迷你侧轨已开启：网页左缘 44px 图标轨，点「«」可收成细条');
      } else {
        toast('迷你侧轨已关闭');
      }
    });
  });

  $('#t-dedupe').addEventListener('click', async () => {
    if (!t.confirmDupes) {
      t.confirmDupes = true;
      render();
      setTimeout(() => { if (t.confirmDupes) { t.confirmDupes = false; render(); } }, 3000);
    } else {
      t.confirmDupes = false;
      await closeDuplicates();
    }
  });

  $('#t-locate').addEventListener('click', () => locateActiveTab());
  $('#t-back').addEventListener('click', () => navigateTabs(-1));
  $('#t-fwd').addEventListener('click', () => navigateTabs(1));
  $('#t-cleanup').addEventListener('click', async () => {
    await syncNavState(); // 拿最新的激活时间表再筛候选
    openCleanPanel();
  });
  $('#t-groupby').addEventListener('click', (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    showMenu(r.left - 80, r.bottom + 4, [
      { id: 'auto', label: `${t.autoGroup ? '✓ ' : ''}⟳ 自动整理：新标签自动按域名归组` },
      { id: 'group', label: '▦ 立即按域名归组一次' },
      { id: 'ungroup-panel', label: '⊟ 取消全部面板分组' },
      '-',
      { id: 'ungroup-native', label: '⊟ 解散浏览器标签组（去胶囊）', danger: true },
    ], async (act) => {
      if (act === 'auto') {
        t.autoGroup = !t.autoGroup;
        await saveSettings({ autoGroup: t.autoGroup });
        if (t.autoGroup) {
          await refresh();
          toast('自动整理已开启：新标签会自动按域名归组');
        } else {
          toast('自动整理已关闭（现有分组保留）');
        }
      } else if (act === 'group') groupByDomain();
      else if (act === 'ungroup-panel') ungroupAllPanel();
      else ungroupAll();
    });
  });
  $('#t-index').addEventListener('click', indexContent);

  $('#t-select').addEventListener('click', () => {
    t.selectMode = !t.selectMode;
    if (!t.selectMode) t.selected.clear();
    render();
  });

  $('#t-collapse').addEventListener('click', async () => {
    const anyOpen = t.windows.some((w) => !t.wcollapsed.has(w.id))
      || t.pgroups.groups.some((g) => !t.pgCollapsed.has(g.id))
      || [...t.groups.values()].some((g) => !g.collapsed);
    if (anyOpen) {
      for (const w of t.windows) t.wcollapsed.add(w.id);
      for (const g of t.pgroups.groups) t.pgCollapsed.add(g.id);
      for (const g of t.groups.values()) {
        if (!g.collapsed) await chrome.tabGroups.update(g.id, { collapsed: true }).catch(() => {});
      }
    } else {
      t.wcollapsed.clear();
      t.pgCollapsed.clear();
      for (const g of t.groups.values()) {
        if (g.collapsed) await chrome.tabGroups.update(g.id, { collapsed: false }).catch(() => {});
      }
    }
    render();
  });

  // 批量操作栏
  $('#t-batchbar').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-bact]');
    if (!btn) return;
    const ids = [...t.selected];
    switch (btn.dataset.bact) {
      case 'close':
        if (ids.length) await chrome.tabs.remove(ids);
        t.selected.clear();
        break;
      case 'save':
        await saveTabsBatch(ids.map(findTab).filter(Boolean));
        break;
      case 'window': {
        if (!ids.length) break;
        const win = await chrome.windows.create({ tabId: ids[0] });
        if (ids.length > 1) await chrome.tabs.move(ids.slice(1), { windowId: win.id, index: -1 });
        t.selected.clear();
        break;
      }
      case 'cancel':
        t.selectMode = false;
        t.selected.clear();
        render();
        break;
    }
  });

  $('#t-batch-group').addEventListener('change', async (e) => {
    const v = e.target.value;
    e.target.value = '';
    const ids = [...t.selected];
    if (!v || !ids.length) return;
    let gid = v;
    if (v === '__new__') {
      const pg = { id: makeId(), name: '新分组', color: COLOR_KEYS[1 + (t.pgroups.groups.length % (COLOR_KEYS.length - 1))] };
      t.pgroups.groups.push(pg);
      gid = pg.id;
      t.editPGroup = pg.id; // 建完直接进入重命名
    }
    t.pgroups.tabs ||= {};
    for (const id of ids) {
      const tab = findTab(id);
      if (tab) {
        t.pgroups.tabs[id] = gid;
        t.pgroups.assign[normalizeUrl(urlOf(tab))] = gid;
      }
    }
    t.selected.clear();
    t.selectMode = false;
    await commitPGroups();
  });
}

function bindList() {
  const list = $('#t-list');

  list.addEventListener('click', async (e) => {
    const row = e.target.closest('.row');
    if (!row) return;
    setKb(row);

    if (e.target.classList.contains('t-check')) {
      const id = Number(row.dataset.tab);
      e.target.checked ? t.selected.add(id) : t.selected.delete(id);
      render();
      return;
    }
    const dot = e.target.closest('.dot');
    if (dot) {
      if (row.dataset.pgroup) {
        const pg = t.pgroups.groups.find((g) => g.id === row.dataset.pgroup);
        if (pg) { pg.color = dot.dataset.gcolor; await commitPGroups(); }
      } else {
        await chrome.tabGroups.update(Number(row.dataset.group), { color: dot.dataset.gcolor });
      }
      return;
    }
    const tact = e.target.closest('[data-tact]');
    if (tact) { await handleTabAction(tact.dataset.tact, Number(row.dataset.tab), row); return; }
    const pgact = e.target.closest('[data-pgact]');
    if (pgact) { await handlePGroupAction(pgact.dataset.pgact, row.dataset.pgroup, row); return; }
    const gact = e.target.closest('[data-gact]');
    if (gact) { await handleGroupAction(gact.dataset.gact, Number(row.dataset.group), row); return; }
    const wact = e.target.closest('[data-wact]');
    if (wact) { await handleWindowAction(wact.dataset.wact, Number(row.dataset.win)); return; }

    if (row.classList.contains('editing')) return;
    if (row.dataset.tab) {
      const id = Number(row.dataset.tab);
      if (t.selectMode) {
        t.selected.has(id) ? t.selected.delete(id) : t.selected.add(id);
        render();
      } else {
        await activateTab(id);
      }
    } else if (row.dataset.pgroup) {
      const gid = row.dataset.pgroup;
      t.pgCollapsed.has(gid) ? t.pgCollapsed.delete(gid) : t.pgCollapsed.add(gid);
      render();
    } else if (row.dataset.group) {
      const g = t.groups.get(Number(row.dataset.group));
      if (g) await chrome.tabGroups.update(g.id, { collapsed: !g.collapsed });
    } else if (row.dataset.win) {
      const wid = Number(row.dataset.win);
      t.wcollapsed.has(wid) ? t.wcollapsed.delete(wid) : t.wcollapsed.add(wid);
      render();
    }
  });

  // 双击标签页 → 起小名（IDE 双击重命名）
  list.addEventListener('dblclick', (e) => {
    const row = e.target.closest('.row[data-tab]');
    if (!row || row.classList.contains('editing')) return;
    t.editAliasTab = Number(row.dataset.tab);
    render();
  });

  // 右键菜单
  list.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.row');
    if (!row) return;
    e.preventDefault();
    if (row.dataset.tab && !row.classList.contains('editing')) showTabMenu(e, Number(row.dataset.tab));
    else if (row.dataset.pgroup && !row.classList.contains('editing')) showPGroupMenu(e, row.dataset.pgroup);
    else if (row.dataset.group && !row.classList.contains('editing')) showGroupMenu(e, Number(row.dataset.group));
    else if (row.dataset.win) showWinMenu(e, Number(row.dataset.win));
  });

  // 行内输入：Enter 保存 / Esc 取消；失焦提交（IDE 习惯）
  list.addEventListener('keydown', async (e) => {
    if (e.target.matches('.alias-input')) {
      e.stopPropagation();
      const row = e.target.closest('.row');
      if (e.key === 'Enter') await handleTabAction('alias-save', Number(row.dataset.tab), row);
      else if (e.key === 'Escape') await handleTabAction('alias-cancel', Number(row.dataset.tab), row);
      return;
    }
    if (e.target.matches('.g-name')) {
      e.stopPropagation();
      const row = e.target.closest('.row');
      if (e.key === 'Enter') {
        if (row.dataset.pgroup) await handlePGroupAction('save', row.dataset.pgroup, row);
        else await handleGroupAction('save', Number(row.dataset.group), row);
      } else if (e.key === 'Escape') {
        t.editGroup = null;
        t.editPGroup = null;
        render();
      }
      return;
    }
    onTreeKey(e);
  });

  list.addEventListener('focusout', async (e) => {
    if (e.target.matches('.alias-input') && t.editAliasTab != null) {
      if (e.relatedTarget?.dataset?.tact === 'alias-cancel') return;
      const row = e.target.closest('.row');
      await handleTabAction('alias-save', Number(row.dataset.tab), row);
    } else if (e.target.matches('.g-name') && (t.editGroup != null || t.editPGroup != null)) {
      if (e.relatedTarget?.closest?.('.dot')) return; // 点颜色不退出编辑
      const row = e.target.closest('.row');
      if (row.dataset.pgroup) await handlePGroupAction('save', row.dataset.pgroup, row);
      else await handleGroupAction('save', Number(row.dataset.group), row);
    }
  });

  // 拖拽：拖到标签行 = 插到它前面；拖到分组头 = 入组；拖到窗口头 = 移到该窗口末尾
  list.addEventListener('dragstart', (e) => {
    const row = e.target.closest('.row[data-tab]');
    if (!row) { e.preventDefault(); return; }
    e.dataTransfer.setData('text/plain', row.dataset.tab);
    e.dataTransfer.effectAllowed = 'move';
  });
  list.addEventListener('dragover', (e) => {
    const target = e.target.closest('.row[data-tab], [data-drop-pgroup], [data-drop-group], [data-drop-win]');
    if (!target) return;
    e.preventDefault();
    clearDropCls();
    target.classList.add(target.dataset.tab ? 'drop-before' : 'drop-into');
  });
  list.addEventListener('drop', async (e) => {
    const target = e.target.closest('.row[data-tab], [data-drop-pgroup], [data-drop-group], [data-drop-win]');
    clearDropCls();
    if (!target) return;
    e.preventDefault();
    const tabId = Number(e.dataTransfer.getData('text/plain'));
    if (!tabId) return;
    if (target.dataset.tab) {
      const dst = findTab(Number(target.dataset.tab));
      if (!dst || dst.id === tabId) return;
      await chrome.tabs.move(tabId, { windowId: dst.windowId, index: dst.index });
      if (dst.groupId !== -1) await chrome.tabs.group({ tabIds: tabId, groupId: dst.groupId });
      // 拖到面板分组内的标签前面 → 顺带归入该面板分组
      const dstPg = memberGid(dst);
      if (dstPg) await assignTabToPGroup(tabId, dstPg);
    } else if (target.dataset.dropPgroup) {
      await assignTabToPGroup(tabId, target.dataset.dropPgroup);
    } else if (target.dataset.dropGroup) {
      await chrome.tabs.group({ tabIds: tabId, groupId: Number(target.dataset.dropGroup) });
    } else if (target.dataset.dropWin) {
      await chrome.tabs.move(tabId, { windowId: Number(target.dataset.dropWin), index: -1 });
    }
  });
  list.addEventListener('dragend', clearDropCls);

  // favicon 加载失败时隐藏（error 不冒泡，用捕获）
  list.addEventListener('error', (e) => {
    if (e.target.matches?.('img.fav')) e.target.classList.add('broken');
  }, true);
}

function clearDropCls() {
  for (const el of document.querySelectorAll('#t-list .drop-before, #t-list .drop-into')) {
    el.classList.remove('drop-before', 'drop-into');
  }
}

/* ------- 右键菜单内容 ------- */

function showTabMenu(e, id) {
  const tab = findTab(id);
  if (!tab) return;
  const norm = normalizeUrl(urlOf(tab));
  const dup = (dupMap().get(norm) || []).length > 1;
  const inPanel = !!memberGid(tab);
  const kept = !!t.keep[norm];
  showMenu(e.clientX, e.clientY, [
    { id: 'activate', label: '切换到此标签页' },
    { id: 'save', label: '⭐ 收藏' },
    { id: 'alias', label: '✎ 加备注' },
    { id: 'pin', label: tab.pinned ? '取消固定' : '📌 固定' },
    { id: 'keep', label: kept ? '取消「不清理」标记' : '🛡 标记不清理（清理时跳过）' },
    { id: 'mute', label: tab.mutedInfo?.muted ? '取消静音' : '🔇 静音' },
    inPanel ? { id: 'unassign', label: '⊟ 移出面板分组' } : null,
    tab.groupId !== -1 ? { id: 'ungroup-one', label: '⊟ 移出浏览器组' } : null,
    { id: 'copy', label: '📋 复制链接' },
    '-',
    dup ? { id: 'close-dups', label: '🧹 关闭它的重复项' } : null,
    { id: 'close', label: '✕ 关闭', danger: true },
  ].filter(Boolean), (act) => handleTabAction(act, id));
}

function showGroupMenu(e, gid) {
  showMenu(e.clientX, e.clientY, [
    { id: 'edit', label: '✎ 重命名 / 颜色' },
    { id: 'save-all', label: '⭐ 收藏整组' },
    { id: 'ungroup', label: '⊟ 取消分组' },
    '-',
    { id: 'close', label: '✕ 关闭整组', danger: true },
  ], (act) => handleGroupAction(act, gid));
}

function showWinMenu(e, wid) {
  showMenu(e.clientX, e.clientY, [
    { id: 'newtab', label: '＋ 新建标签页' },
    { id: 'save', label: '⭐ 收藏窗口内全部' },
    { id: 'ungroup-win', label: '⊟ 解散本窗口所有分组' },
    '-',
    { id: 'close-window', label: '✕ 关闭整个窗口', danger: true },
  ], (act) => handleWindowAction(act, wid));
}

/* ------- 键盘导航：↑↓ 移动 / Enter 打开 / Del 关闭 / F2 起小名 ------- */

function setKb(row) {
  document.querySelector('#t-list .row.kb')?.classList.remove('kb');
  if (!row?.dataset.key) { t.kb = null; return; }
  t.kb = row.dataset.key;
  row.classList.add('kb');
  row.scrollIntoView({ block: 'nearest' });
}

function onTreeKey(e) {
  const rows = [...document.querySelectorAll('#t-list .row[data-key]')];
  if (!rows.length) return;
  const idx = rows.findIndex((r) => r.dataset.key === t.kb);

  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const next = e.key === 'ArrowDown'
      ? rows[Math.min(rows.length - 1, idx + 1)]
      : rows[Math.max(0, idx <= 0 ? 0 : idx - 1)];
    setKb(next);
    return;
  }
  if (idx < 0) return;
  const row = rows[idx];

  if (e.key === 'Enter') {
    e.preventDefault();
    if (row.dataset.tab) activateTab(Number(row.dataset.tab));
    else row.click();
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    if (row.dataset.tab) {
      e.preventDefault();
      chrome.tabs.remove(Number(row.dataset.tab));
    }
  } else if (e.key === 'F2') {
    e.preventDefault();
    if (row.dataset.tab) {
      t.editAliasTab = Number(row.dataset.tab);
      render();
    } else if (row.dataset.pgroup) {
      t.editPGroup = row.dataset.pgroup;
      render();
    } else if (row.dataset.group) {
      t.editGroup = Number(row.dataset.group);
      render();
    }
  }
}
