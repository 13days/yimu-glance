// 最近视图：最近关闭（一键恢复）+ 浏览历史（今天/昨天/更早 分桶）
// 不搜索时展示近 7 天；输入关键词则搜全部历史。已打开的页面点击直接切换过去。

import { normalizeUrl, addLink, loadAliases, setAlias, mergeFavCache, loadVisits, removeVisit, loadData, STORAGE_KEY } from './shared.js';
import {
  $, esc, tokensOf, highlight, faviconOf, normHost, toast, showMenu,
  matchFields, copyText, grabPageContent, FIELD_LABEL, openOrSwitchTab,
} from './ui-common.js';

const FREQ_PAGE_SIZE = 15;
const FREQ_MAX = 90; // 榜单上限 6 页，保持「高频」含金量
// 登录 / SSO / 验证类页面是被动反复访问，次数虚高，不进高频榜
const FREQ_NOISE = /sso|login|sign-?in|oauth|passport|accounts\.google|登录|验证码/i;

const r = {
  closed: [],             // sessions.Session[]
  history: [],            // history.HistoryItem[]
  visits: [],             // 自建浏览记录（带使用次数）
  freqPage: 0,            // 高频使用当前页
  aliases: {},
  openNorms: new Map(),   // normUrl -> tabId（已打开的页面）
  openFavs: new Map(),    // normUrl -> 实时 favicon
  favCache: {},           // normUrl -> 持久缓存的 favicon
  savedNorms: new Set(),  // 已收藏链接的 normUrl（星标区分已/未收藏）
  historyOk: true,        // history 接口是否可用
  query: '',
  searchedFor: null,      // 上次实际请求历史接口用的关键词
  collapsed: new Set(['closed']), // 最近关闭默认折叠；'freq'/'today'/'yst'/'week'/'older'
  editUrl: null,          // 正在加备注的 url
  confirmDeleteUrl: null,
  loadedAt: 0,
};

export async function initRecentView() {
  bindToolbar();
  bindList();
  for (const ev of [chrome.history?.onVisited, chrome.history?.onVisitRemoved, chrome.sessions?.onChanged]) {
    ev?.addListener(scheduleReload);
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[STORAGE_KEY]) scheduleReload(); // 收藏变化刷新星标
  });
  await reload();
}

export function setRecentQuery(q) {
  const changed = q.trim() !== (r.searchedFor ?? '');
  r.query = q;
  if (changed || Date.now() - r.loadedAt > 5000) reload();
  else render();
}

export async function onRecentAliasChanged() {
  r.aliases = await loadAliases();
  render();
}

// 后台写入新的浏览记录时刷新（视图隐藏则只标记过期）
export function onVisitsChanged() {
  scheduleReload();
}

let reloadTimer;
function scheduleReload() {
  // 视图不可见时只标记过期，切回来再拉，省资源
  if ($('#view-recent').classList.contains('hidden')) {
    r.loadedAt = 0;
    return;
  }
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(reload, 400);
}

async function reload() {
  r.loadedAt = Date.now();
  const query = r.query.trim();
  const [closed, tabs, aliases, visits, coll] = await Promise.all([
    chrome.sessions?.getRecentlyClosed({ maxResults: 20 }).catch(() => []) ?? [],
    chrome.tabs.query({}),
    loadAliases(),
    loadVisits(),
    loadData(),
  ]);
  r.savedNorms = new Set(coll.links.map((l) => l.normUrl || normalizeUrl(l.url)));
  let hist = [];
  try {
    // 不限时间直接拉最近 300 条，客户端再分桶；带关键词则搜全部历史
    hist = await chrome.history.search({ text: query, startTime: 0, maxResults: 300 });
    r.historyOk = true;
  } catch {
    r.historyOk = false;
  }
  r.searchedFor = query;
  // 最近关闭：同一 URL 只留最新一条（SSO/登录页反复关闭不再刷屏）
  const closedSeen = new Set();
  r.closed = closed.filter((s) => {
    if (!s.tab) return true;
    const k = normalizeUrl(s.tab.url || '');
    if (closedSeen.has(k)) return false;
    closedSeen.add(k);
    return true;
  });
  // 合并 Chrome 历史与插件自建浏览记录（企业策略禁用历史时也能工作）
  const byNorm = new Map();
  for (const h of hist) {
    if (!/^https?:/i.test(h.url || '')) continue;
    byNorm.set(normalizeUrl(h.url), {
      url: h.url,
      title: h.title || '',
      lastVisitTime: h.lastVisitTime || 0,
      favicon: '',
    });
  }
  for (const v of visits) {
    const ex = byNorm.get(v.normUrl);
    if (!ex) {
      byNorm.set(v.normUrl, { url: v.url, title: v.title || '', lastVisitTime: v.time || 0, favicon: v.favicon || '' });
    } else {
      if ((v.time || 0) > ex.lastVisitTime) {
        ex.lastVisitTime = v.time;
        ex.url = v.url;
        if (v.title) ex.title = v.title;
      }
      if (!ex.favicon && v.favicon) ex.favicon = v.favicon;
    }
  }
  // 展示级去重：同域名 + 同标题视为同一页面（不同 query 参数的重复项），只留最新
  const dedup = new Map();
  for (const item of [...byNorm.values()].sort((a, b) => (b.lastVisitTime || 0) - (a.lastVisitTime || 0))) {
    const key = item.title ? `${normHost(item.url)}|${item.title}` : normalizeUrl(item.url);
    const ex = dedup.get(key);
    if (!ex) dedup.set(key, item);
    else if (!ex.favicon && item.favicon) ex.favicon = item.favicon;
  }
  r.history = [...dedup.values()];
  r.visits = visits;
  r.aliases = aliases;
  r.openNorms = new Map();
  r.openFavs = new Map();
  const harvest = {};
  for (const tb of tabs) {
    if (!tb.url) continue;
    const norm = normalizeUrl(tb.url);
    r.openNorms.set(norm, tb.id);
    if (/^(https?:|data:)/i.test(tb.favIconUrl || '')) {
      r.openFavs.set(norm, tb.favIconUrl);
      harvest[norm] = tb.favIconUrl;
    }
  }
  // 顺手把打开中标签的真实图标存入持久缓存，供历史/收藏兜底
  r.favCache = await mergeFavCache(harvest);
  render();
}

function favForUrl(url) {
  const norm = normalizeUrl(url);
  return r.openFavs.get(norm) || r.favCache[norm] || faviconOf(url);
}

/* ---------------- 渲染 ---------------- */

function matchHistory(h, tokens) {
  if (!tokens.length) return { matchedFields: new Set(), score: 0 };
  return matchFields({
    alias: (r.aliases[normalizeUrl(h.url || '')] || '').toLowerCase(),
    title: (h.title || '').toLowerCase(),
    url: (h.url || '').toLowerCase(),
    content: '',
  }, tokens);
}

function matchClosed(s, tokens) {
  if (!tokens.length) return true;
  const texts = [];
  if (s.tab) texts.push(s.tab.title || '', s.tab.url || '', r.aliases[normalizeUrl(s.tab.url || '')] || '');
  if (s.window) for (const tb of s.window.tabs || []) texts.push(tb.title || '', tb.url || '');
  const joined = texts.join(' ').toLowerCase();
  return tokens.every((t) => joined.includes(t));
}

// 高频使用：按使用次数排序（同域名+同标题合并计数），只收 2 次以上的
function freqItems() {
  const map = new Map();
  for (const v of r.visits || []) {
    if (!/^https?:/i.test(v.url || '')) continue;
    const key = v.title ? `${normHost(v.url)}|${v.title}` : v.normUrl;
    const ex = map.get(key);
    if (!ex) {
      map.set(key, {
        url: v.url,
        title: v.title || '',
        lastVisitTime: v.time || 0,
        favicon: v.favicon || '',
        count: v.count || 1,
      });
    } else {
      ex.count += v.count || 1;
      if ((v.time || 0) > ex.lastVisitTime) {
        ex.lastVisitTime = v.time;
        ex.url = v.url;
      }
      if (!ex.favicon && v.favicon) ex.favicon = v.favicon;
    }
  }
  const all = [...map.values()]
    .filter((x) => !FREQ_NOISE.test(`${x.url} ${x.title}`))
    .sort((a, b) => b.count - a.count || b.lastVisitTime - a.lastVisitTime);
  // 门槛 3 次起；记录还少时降级到 2 次，保证榜单可用
  let list = all.filter((x) => x.count >= 3);
  if (list.length < 5) list = all.filter((x) => x.count >= 2);
  return list.slice(0, FREQ_MAX);
}

function fmtTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (d.toDateString() === now.toDateString()) return hm;
  const yst = new Date(now);
  yst.setDate(now.getDate() - 1);
  if (d.toDateString() === yst.toDateString()) return `昨天 ${hm}`;
  return `${d.getMonth() + 1}-${d.getDate()}`;
}

function render() {
  const tokens = tokensOf(r.query);

  const closedFiltered = r.closed.filter((s) => matchClosed(s, tokens));
  let items = r.history
    .map((h) => ({ h, m: matchHistory(h, tokens) }))
    .filter((x) => x.m);
  if (tokens.length) items.sort((a, b) => b.m.score - a.m.score || (b.h.lastVisitTime || 0) - (a.h.lastVisitTime || 0));
  else items.sort((a, b) => (b.h.lastVisitTime || 0) - (a.h.lastVisitTime || 0));

  $('#r-stats').textContent = tokens.length
    ? `全部历史匹配 ${items.length} 条`
    : `最近关闭 ${closedFiltered.length} · 历史 ${r.history.length} 条`;

  const parts = [];
  // 🔥 高频使用：置顶，每页 15 条可翻页（搜索时隐藏，搜索结果本身已按权重排序）
  if (!tokens.length) {
    const freq = freqItems();
    if (freq.length) {
      const pages = Math.ceil(freq.length / FREQ_PAGE_SIZE);
      r.freqPage = Math.min(Math.max(r.freqPage, 0), pages - 1);
      const slice = freq.slice(r.freqPage * FREQ_PAGE_SIZE, (r.freqPage + 1) * FREQ_PAGE_SIZE);
      const rows = slice.map((h) => historyRowHTML(h, tokens, { matchedFields: new Set() }));
      if (pages > 1) {
        rows.push(`<div class="row pager">
          <button class="mini pager-btn" data-ract="fprev" ${r.freqPage === 0 ? 'disabled' : ''}>‹ 上一页</button>
          <span class="pager-info">${r.freqPage + 1} / ${pages} 页</span>
          <button class="mini pager-btn" data-ract="fnext" ${r.freqPage >= pages - 1 ? 'disabled' : ''}>下一页 ›</button>
        </div>`);
      }
      parts.push(nodeHTML('freq', '🔥 高频使用', rows, tokens, freq.length));
    }
  }
  if (closedFiltered.length) {
    parts.push(nodeHTML('closed', '↩ 最近关闭', closedFiltered.map((s) => closedRowHTML(s, tokens)), tokens));
  }
  if (tokens.length) {
    parts.push(nodeHTML('search', '历史匹配', items.map((x) => historyRowHTML(x.h, tokens, x.m)), tokens));
  } else if (items.length) {
    const todayStart = new Date().setHours(0, 0, 0, 0);
    const ystStart = todayStart - 86400e3;
    const weekStart = todayStart - 6 * 86400e3;
    const buckets = [
      { key: 'today', name: '今天', items: [] },
      { key: 'yst', name: '昨天', items: [] },
      { key: 'week', name: '本周', items: [] },
      { key: 'older', name: '更早', items: [] },
    ];
    for (const x of items) {
      const ts = x.h.lastVisitTime || 0;
      (ts >= todayStart ? buckets[0] : ts >= ystStart ? buckets[1] : ts >= weekStart ? buckets[2] : buckets[3]).items.push(x);
    }
    for (const b of buckets) {
      if (b.items.length) parts.push(nodeHTML(b.key, b.name, b.items.map((x) => historyRowHTML(x.h, tokens, x.m)), tokens));
    }
  } else {
    parts.push(`<div class="empty"><p>还没有浏览记录</p>
      <p class="hint">「一目」已开始自动记录你打开的页面，去逛几个网页再回来看看～<br>（不依赖 Chrome 历史，被企业策略禁用也能记录）</p></div>`);
  }

  $('#r-list').innerHTML = parts.join('')
    || `<div class="empty"><p>没有匹配的记录</p></div>`;

  if (r.editUrl != null) {
    const input = document.querySelector('#r-list .alias-input');
    if (input && document.activeElement !== input) { input.focus(); input.select(); }
  }
}

function nodeHTML(key, name, rows, tokens, count = rows.length) {
  if (!rows.length) return '';
  const open = tokens.length ? true : !r.collapsed.has(key);
  return `<div class="node">
    <div class="row win-head" data-bucket="${esc(key)}">
      <span class="chev">${open ? '▾' : '▸'}</span>
      <span class="node-name">${esc(name)}</span>
      <span class="cnt">${count}</span>
    </div>
    ${open ? `<div class="children win-children">${rows.join('')}</div>` : ''}
  </div>`;
}

function closedRowHTML(s, tokens) {
  const time = `<span class="date">${fmtTime((s.lastModified || 0) * 1000)}</span>`;
  if (s.tab) {
    const url = s.tab.url || '';
    const alias = r.aliases[normalizeUrl(url)] || '';
    const fav = /^(https?:|data:)/i.test(s.tab.favIconUrl || '') ? s.tab.favIconUrl : favForUrl(url);
    return `<div class="row tab-row depth1" data-sid="${esc(s.tab.sessionId)}" title="${esc(url)}">
      <img class="fav" src="${esc(fav)}" alt="">
      <span class="t-title">${alias ? `<span class="alias">${highlight(alias, tokens)}</span>` : ''}${highlight(s.tab.title || url, tokens)}</span>
      ${time}
      <span class="acts"><button class="mini" data-ract="restore" title="恢复此标签页">↩</button></span>
    </div>`;
  }
  if (s.window) {
    const n = s.window.tabs?.length || 0;
    return `<div class="row tab-row depth1" data-sid="${esc(s.window.sessionId)}">
      <span class="chev">🗔</span>
      <span class="t-title">关闭的窗口（${n} 个标签页）</span>
      ${time}
      <span class="acts"><button class="mini" data-ract="restore" title="恢复整个窗口">↩</button></span>
    </div>`;
  }
  return '';
}

function historyRowHTML(h, tokens, m) {
  const url = h.url || '';
  const norm = normalizeUrl(url);
  const alias = r.aliases[norm] || '';
  const fav = h.favicon || favForUrl(url);

  if (r.editUrl === url) {
    return `<div class="row tab-row editing depth1" data-url="${esc(url)}">
      <img class="fav" src="${esc(fav)}" alt="">
      <input class="alias-input" value="${esc(alias)}" placeholder="加个备注，回车保存" maxlength="30">
      <button class="mini" data-ract="alias-save" title="保存">✓</button>
      <button class="mini" data-ract="alias-cancel" title="取消">✕</button>
    </div>`;
  }

  const badges = [];
  if (tokens.length) for (const f of m.matchedFields) badges.push(`<span class="badge">${FIELD_LABEL[f]}</span>`);
  if (h.count > 1) badges.push(`<span class="badge">${h.count} 次</span>`);
  if (r.openNorms.has(norm)) badges.push('<span class="badge">已打开</span>');
  const del = r.confirmDeleteUrl === url
    ? '<button class="mini danger-btn" data-ract="del">确认删除</button>'
    : '<button class="mini" data-ract="del" title="从历史记录删除">✕</button>';
  return `<div class="row tab-row depth1" data-url="${esc(url)}" title="${esc(url)}">
    <img class="fav" src="${esc(fav)}" alt="">
    <span class="t-title">${alias ? `<span class="alias">${highlight(alias, tokens)}</span>` : ''}${highlight(h.title || url, tokens)}</span>
    ${badges.join('')}
    <span class="date">${fmtTime(h.lastVisitTime)}</span>
    <span class="acts">
      <button class="mini ${r.savedNorms.has(norm) ? 'starred' : ''}" data-ract="save" title="${r.savedNorms.has(norm) ? '已收藏' : '收藏'}">${r.savedNorms.has(norm) ? '★' : '☆'}</button>
      <button class="mini" data-ract="alias" title="加备注 (双击)">✎</button>
      ${del}
    </span>
  </div>`;
}

/* ---------------- 动作 ---------------- */

// 已打开 → 切过去；否则新标签打开（实时查询，不依赖快照）
async function openHistoryUrl(url) {
  const result = await openOrSwitchTab(url);
  if (result === 'switched') toast('已切换到打开中的标签页');
}

async function saveHistoryItem(url) {
  const norm = normalizeUrl(url);
  const h = r.history.find((x) => x.url === url);
  let content = '';
  const tabId = r.openNorms.get(norm);
  if (tabId != null) {
    try {
      const res = await chrome.scripting.executeScript({ target: { tabId }, func: grabPageContent });
      content = res?.[0]?.result || '';
    } catch { /* 页面无法注入 */ }
  }
  const { status } = await addLink({
    url,
    title: h?.title || url,
    content,
    alias: r.aliases[norm] || '',
    favicon: r.openFavs.get(norm) || '',
  });
  toast(status === 'added' ? '已收藏 ✓（见「收藏」视图）' : '已在收藏中，自动去重 ✓');
}

async function handleAction(act, row) {
  const url = row.dataset.url || '';
  switch (act) {
    case 'fprev':
      r.freqPage = Math.max(0, r.freqPage - 1);
      render();
      break;
    case 'fnext':
      r.freqPage += 1;
      render();
      break;
    case 'restore':
      await chrome.sessions.restore(row.dataset.sid).catch(() => toast('该记录已无法恢复'));
      scheduleReload();
      break;
    case 'save': await saveHistoryItem(url); break;
    case 'alias':
      r.editUrl = url;
      render();
      break;
    case 'alias-save': {
      if (r.editUrl == null) return; // 重入防护（focusout 与 click 双触发）
      const input = row.querySelector('.alias-input') || document.querySelector('#r-list .alias-input');
      const v = (input?.value || '').trim();
      r.editUrl = null;
      await setAlias(normalizeUrl(url), v);
      r.aliases = await loadAliases();
      render();
      toast(v ? `已备注「${v}」` : '已清除备注');
      break;
    }
    case 'alias-cancel':
      r.editUrl = null;
      render();
      break;
    case 'copy': await copyText(url); break;
    case 'del':
      if (r.confirmDeleteUrl !== url) {
        r.confirmDeleteUrl = url;
        render();
        setTimeout(() => { if (r.confirmDeleteUrl === url) { r.confirmDeleteUrl = null; render(); } }, 3000);
      } else {
        r.confirmDeleteUrl = null;
        await chrome.history?.deleteUrl({ url }).catch(() => {});
        await removeVisit(normalizeUrl(url));
        r.history = r.history.filter((x) => x.url !== url);
        r.visits = r.visits.filter((v) => v.normUrl !== normalizeUrl(url));
        render();
        toast('已从历史记录删除');
      }
      break;
  }
}

/* ---------------- 事件 ---------------- */

function bindToolbar() {
  $('#r-refresh').addEventListener('click', reload);
}

function bindList() {
  const list = $('#r-list');

  list.addEventListener('click', async (e) => {
    const row = e.target.closest('.row');
    if (!row) return;
    const act = e.target.closest('[data-ract]');
    if (act) { await handleAction(act.dataset.ract, row); return; }
    if (row.classList.contains('editing')) return;
    if (row.dataset.bucket) {
      const k = row.dataset.bucket;
      r.collapsed.has(k) ? r.collapsed.delete(k) : r.collapsed.add(k);
      render();
    } else if (row.dataset.sid) {
      await handleAction('restore', row);
    } else if (row.dataset.url) {
      await openHistoryUrl(row.dataset.url);
    }
  });

  list.addEventListener('dblclick', (e) => {
    const row = e.target.closest('.row[data-url]');
    if (!row || row.classList.contains('editing')) return;
    r.editUrl = row.dataset.url;
    render();
  });

  list.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.row[data-url]');
    if (!row || row.classList.contains('editing')) return;
    e.preventDefault();
    const url = row.dataset.url;
    const isOpen = r.openNorms.has(normalizeUrl(url));
    showMenu(e.clientX, e.clientY, [
      { id: 'open', label: isOpen ? '切换到已打开的标签页' : '↗ 打开' },
      { id: 'save', label: '⭐ 收藏' },
      { id: 'alias', label: '✎ 加备注' },
      { id: 'copy', label: '📋 复制链接' },
      '-',
      { id: 'del', label: '✕ 从历史记录删除', danger: true },
    ], async (act) => {
      if (act === 'open') await openHistoryUrl(url);
      else await handleAction(act, row);
    });
  });

  // 保存/取消按钮不抢输入框焦点，避免 focusout 先行提交
  list.addEventListener('mousedown', (e) => {
    if (e.target.closest('[data-ract="alias-save"], [data-ract="alias-cancel"]')) e.preventDefault();
  });

  list.addEventListener('keydown', async (e) => {
    if (e.isComposing || e.keyCode === 229) return; // 输入法上屏回车不提交
    if (!e.target.matches('.alias-input')) return;
    e.stopPropagation();
    const row = e.target.closest('.row');
    if (e.key === 'Enter') await handleAction('alias-save', row);
    else if (e.key === 'Escape') await handleAction('alias-cancel', row);
  });

  list.addEventListener('focusout', async (e) => {
    if (e.target.matches('.alias-input') && r.editUrl != null) {
      if (e.relatedTarget?.dataset?.ract === 'alias-cancel') return;
      await handleAction('alias-save', e.target.closest('.row'));
    }
  });

  list.addEventListener('error', (e) => {
    if (e.target.matches?.('img.fav')) e.target.classList.add('broken');
  }, true);
}
