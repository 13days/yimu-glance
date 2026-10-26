// 清理不常用标签页：按「多久没看过」筛出候选，逐个勾选后确认关闭
// 🛡 标记不清理：按 URL 永久记忆（storage.local），以后清理时自动跳过，不用每次再勾
// 依赖 view-tabs 提供的上下文（标签页列表 / 备注 / 名单 / 最后激活时间），自己不查浏览器

import { normalizeUrl, setKeep, loadSettings, saveSettings } from './shared.js';
import { $, esc, faviconOf, toast, fmtAgo } from './ui-common.js';

const AGES = [
  { ms: 30 * 60e3, label: '30 分钟' },
  { ms: 2 * 3600e3, label: '2 小时' },
  { ms: 6 * 3600e3, label: '6 小时' },
  { ms: 24 * 3600e3, label: '1 天' },
  { ms: 3 * 86400e3, label: '3 天' },
  { ms: 7 * 86400e3, label: '7 天' },
  { ms: 0, label: '任意时长' },
];
const DEFAULT_AGE = 24 * 3600e3;

let ctx = null; // { tabs(), aliases(), keep(), lastActive() }
const c = {
  open: false,
  ageMs: DEFAULT_AGE,
  candidates: [],        // 打开 / 改阈值时快照的 tabId：浏览过程中列表不跳动
  unchecked: new Set(),  // 用户取消勾选的 tabId（默认全选）
  showKept: false,       // 展开「已标记不清理」分区
};

export async function initCleanPanel(context) {
  ctx = context;
  const s = await loadSettings();
  if (typeof s.cleanAgeMs === 'number' && AGES.some((a) => a.ms === s.cleanAgeMs)) c.ageMs = s.cleanAgeMs;

  const sel = $('#cl-age');
  sel.innerHTML = AGES.map((a) => `<option value="${a.ms}">${a.label}</option>`).join('');
  sel.addEventListener('change', async () => {
    c.ageMs = Number(sel.value);
    c.unchecked.clear();
    snapshot();
    renderClean();
    await saveSettings({ cleanAgeMs: c.ageMs });
  });

  $('#cl-close').addEventListener('click', closeCleanPanel);
  $('#cl-cancel').addEventListener('click', closeCleanPanel);
  $('#cl-all').addEventListener('click', () => {
    const { rows } = splitRows();
    const allSelected = rows.every((tb) => !c.unchecked.has(tb.id));
    if (allSelected) for (const tb of rows) c.unchecked.add(tb.id);
    else c.unchecked.clear();
    renderClean();
  });
  $('#cl-confirm').addEventListener('click', confirmClean);

  const list = $('#cl-list');
  list.addEventListener('click', onListClick);
  list.addEventListener('error', (e) => {
    if (e.target.matches?.('img.fav')) e.target.classList.add('broken');
  }, true);

  document.addEventListener('keydown', (e) => {
    if (c.open && e.key === 'Escape') closeCleanPanel();
  });
}

export function isCleanOpen() {
  return c.open;
}

export function openCleanPanel() {
  c.open = true;
  c.unchecked.clear();
  c.showKept = false;
  $('#cl-age').value = String(c.ageMs);
  snapshot();
  $('#t-clean').classList.remove('hidden');
  renderClean();
}

export function closeCleanPanel() {
  c.open = false;
  $('#t-clean').classList.add('hidden');
}

/* ---------------- 数据 ---------------- */

function urlOf(tab) {
  return tab.url || tab.pendingUrl || '';
}

// 最后一次看这个标签页的时间：Chrome 121+ 自带 lastAccessed，老版本用后台记录的激活时间兜底
function lastUsedOf(tab) {
  return Math.max(tab.lastAccessed || 0, ctx.lastActive()[tab.id] || 0);
}

// 候选快照：不是活动页、没固定、没在出声、超过阈值没看过（🛡 名单里的也进快照，单独分区展示）
function snapshot() {
  const now = Date.now();
  c.candidates = ctx.tabs()
    .filter((tb) => !tb.active && !tb.pinned && !tb.audible)
    .filter((tb) => {
      const lu = lastUsedOf(tb);
      return !lu || now - lu >= c.ageMs;
    })
    .sort((a, b) => lastUsedOf(a) - lastUsedOf(b)) // 最久没看的排最前
    .map((tb) => tb.id);
}

// 把快照按「还活着」过滤，并分成 待清理 / 已标记不清理 两组
function splitRows() {
  const byId = new Map(ctx.tabs().map((tb) => [tb.id, tb]));
  const keep = ctx.keep();
  const rows = [];
  const kept = [];
  for (const id of c.candidates) {
    const tb = byId.get(id);
    if (!tb) continue;
    (keep[normalizeUrl(urlOf(tb))] ? kept : rows).push(tb);
  }
  for (const id of [...c.unchecked]) if (!byId.has(id)) c.unchecked.delete(id);
  return { rows, kept };
}

/* ---------------- 渲染 ---------------- */

// 标签页 / 名单变化时由 view-tabs 在 render 末尾调用；面板没打开就什么都不做
export function renderClean() {
  if (!c.open) return;
  const { rows, kept } = splitRows();
  const aliases = ctx.aliases();
  const selected = rows.filter((tb) => !c.unchecked.has(tb.id)).length;
  const ageLabel = AGES.find((a) => a.ms === c.ageMs)?.label || '';

  $('#cl-stats').textContent = rows.length ? `候选 ${rows.length} · 已选 ${selected}` : '';

  const parts = [];
  if (rows.length) {
    parts.push(rows.map((tb) => rowHTML(tb, aliases, false)).join(''));
  } else {
    parts.push(`<div class="empty">
      <div class="empty-icon">✨</div>
      <p>${c.ageMs ? `没有超过 ${ageLabel} 没看过的标签页` : '没有可清理的标签页'}</p>
      <p class="hint">${c.ageMs ? '可以把上面的时长放宽一点试试' : '固定 / 出声 / 正在看的页面不会列入'}</p>
    </div>`);
  }
  if (kept.length) {
    parts.push(`<div class="cl-sec" data-clsec="kept">
      <span class="chev">${c.showKept ? '▾' : '▸'}</span>🛡 已标记不清理，自动跳过
      <span class="cnt">${kept.length}</span>
    </div>`);
    if (c.showKept) parts.push(kept.map((tb) => rowHTML(tb, aliases, true)).join(''));
  }
  parts.push('<div class="cl-hint">正在看的、📌 固定的、🔊 正在出声的标签页不会列入。点 🛡 标记不清理会按链接永久记住；误关的页面可在「最近」视图一键恢复。</div>');
  $('#cl-list').innerHTML = parts.join('');

  const confirm = $('#cl-confirm');
  confirm.disabled = selected === 0;
  confirm.textContent = selected ? `✕ 关闭 ${selected} 个` : '✕ 关闭';
  const all = $('#cl-all');
  all.disabled = !rows.length;
  all.textContent = rows.length && selected === rows.length ? '全不选' : '全选';
}

function rowHTML(tb, aliases, isKept) {
  const url = urlOf(tb);
  const alias = aliases[normalizeUrl(url)] || '';
  const lu = lastUsedOf(tb);
  const fav = /^(https?:|data:)/i.test(tb.favIconUrl || '') ? tb.favIconUrl : faviconOf(url);
  const check = isKept ? '' : `<input type="checkbox" class="t-check" ${c.unchecked.has(tb.id) ? '' : 'checked'}>`;
  const keepTitle = isKept ? '取消「不清理」标记' : '标记不清理：以后清理时自动跳过，不用再勾';
  return `
  <div class="row tab-row depth1 cl-row ${isKept ? 'kept' : ''}" data-tab="${tb.id}" title="${esc(url)}">
    ${check}
    <img class="fav" src="${esc(fav)}" alt="">
    <span class="t-title">${alias ? `<span class="alias">${esc(alias)}</span>` : ''}${esc(tb.title || url)}</span>
    <span class="date">${lu ? fmtAgo(lu) : '未看过'}</span>
    <span class="acts">
      <button class="mini" data-clact="peek" title="切换过去看一眼">↗</button>
      <button class="mini ${isKept ? 'on' : ''}" data-clact="keep" title="${keepTitle}">🛡</button>
    </span>
  </div>`;
}

/* ---------------- 事件 ---------------- */

async function onListClick(e) {
  const sec = e.target.closest('[data-clsec]');
  if (sec) {
    c.showKept = !c.showKept;
    renderClean();
    return;
  }
  const row = e.target.closest('.row[data-tab]');
  if (!row) return;
  const id = Number(row.dataset.tab);
  const tb = ctx.tabs().find((x) => x.id === id);
  if (!tb) return;

  const act = e.target.closest('[data-clact]')?.dataset.clact;
  if (act === 'peek') {
    await chrome.tabs.update(id, { active: true }).catch(() => {});
    await chrome.windows.update(tb.windowId, { focused: true }).catch(() => {});
    return;
  }
  if (act === 'keep') {
    const norm = normalizeUrl(urlOf(tb));
    const nowKept = !ctx.keep()[norm];
    await setKeep(norm, nowKept, tb.title || '');
    // 名单变化会经 storage.onChanged 回流到 view-tabs → renderClean，这里不必手动刷
    toast(nowKept ? '已标记不清理 🛡 以后清理会自动跳过这个页面' : '已取消标记，下次清理会重新列入');
    return;
  }
  if (row.classList.contains('kept')) return;
  // 点行或点复选框都切换勾选（复选框原生已切换一次，重新渲染后以我们的状态为准）
  c.unchecked.has(id) ? c.unchecked.delete(id) : c.unchecked.add(id);
  renderClean();
}

async function confirmClean() {
  const { rows } = splitRows();
  const ids = rows.filter((tb) => !c.unchecked.has(tb.id)).map((tb) => tb.id);
  if (!ids.length) return;
  try {
    await chrome.tabs.remove(ids);
  } catch {
    // 个别标签页可能刚被关掉，逐个兜底
    for (const id of ids) await chrome.tabs.remove(id).catch(() => {});
  }
  closeCleanPanel();
  toast(`已清理 ${ids.length} 个标签页，误关可在「最近」视图恢复`);
}
