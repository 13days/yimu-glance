// 各视图共用的 UI 工具：转义 / 高亮 / 搜索匹配 / Toast / 右键菜单 / 打开链接

import { normalizeUrl } from './shared.js';

export const $ = (s) => document.querySelector(s);

// 打开链接：该 URL 已有打开中的标签页则直接切过去（跨窗口聚焦），否则新标签打开
export async function openOrSwitchTab(url) {
  try {
    const norm = normalizeUrl(url);
    const tabs = await chrome.tabs.query({});
    const hit = tabs.find((tb) => normalizeUrl(tb.url || '') === norm);
    if (hit) {
      await chrome.tabs.update(hit.id, { active: true });
      await chrome.windows.update(hit.windowId, { focused: true });
      return 'switched';
    }
  } catch { /* 查询失败则直接新开 */ }
  await chrome.tabs.create({ url });
  return 'opened';
}

export const FIELD_LABEL = { alias: '备注', title: '标题', url: '链接', content: '内容' };

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function tokensOf(q) {
  return String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
}

// 命中片段加 <mark> 高亮（先按原文找区间，再整体转义拼接）
export function highlight(text, tokens) {
  text = String(text ?? '');
  if (!tokens.length) return esc(text);
  const lower = text.toLowerCase();
  const ranges = [];
  for (const t of tokens) {
    let i = 0;
    while ((i = lower.indexOf(t, i)) !== -1) {
      ranges.push([i, i + t.length]);
      i += t.length;
    }
  }
  if (!ranges.length) return esc(text);
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r]);
  }
  let out = '';
  let pos = 0;
  for (const [s, e] of merged) {
    out += esc(text.slice(pos, s)) + '<mark>' + esc(text.slice(s, e)) + '</mark>';
    pos = e;
  }
  return out + esc(text.slice(pos));
}

// 所有词都要命中（任一字段即可）；返回命中字段集合与权重分，未命中返回 null
export function matchFields(fields, tokens) {
  const matchedFields = new Set();
  for (const t of tokens) {
    let hit = false;
    for (const [k, v] of Object.entries(fields)) {
      if (v.includes(t)) { matchedFields.add(k); hit = true; }
    }
    if (!hit) return null;
  }
  let score = 0;
  if (matchedFields.has('alias')) score += 8;
  if (matchedFields.has('title')) score += 4;
  if (matchedFields.has('url')) score += 2;
  if (matchedFields.has('content')) score += 1;
  return { matchedFields, score };
}

export function snippetOf(content, tokens) {
  content = String(content || '');
  if (!content) return '';
  const lower = content.toLowerCase();
  let idx = -1;
  for (const t of tokens) {
    const i = lower.indexOf(t);
    if (i !== -1 && (idx === -1 || i < idx)) idx = i;
  }
  if (idx === -1) return '';
  const start = Math.max(0, idx - 26);
  const end = Math.min(content.length, idx + 80);
  return (start > 0 ? '…' : '') + content.slice(start, end) + (end < content.length ? '…' : '');
}

// 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前
export function fmtAgo(ms) {
  if (!ms) return '';
  const d = Date.now() - ms;
  if (d < 60e3) return '刚刚';
  if (d < 3600e3) return `${Math.floor(d / 60e3)} 分钟前`;
  if (d < 86400e3) return `${Math.floor(d / 3600e3)} 小时前`;
  return `${Math.floor(d / 86400e3)} 天前`;
}

export function prettyUrl(u) {
  return String(u || '').replace(/^https?:\/\//i, '').replace(/\/$/, '');
}

export function normHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function faviconOf(url) {
  return chrome.runtime.getURL('/_favicon/') + `?pageUrl=${encodeURIComponent(url)}&size=32`;
}

let toastTimer;
export function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2400);
}

export async function copyText(s) {
  try {
    await navigator.clipboard.writeText(s);
    toast('已复制链接');
  } catch {
    toast('复制失败');
  }
}

// 注入到页面里抓取正文摘要（meta description + 正文前 4000 字）
export function grabPageContent() {
  const meta = document.querySelector('meta[name="description"]')?.getAttribute('content') || '';
  const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
  return ((meta ? meta + ' ' : '') + text).slice(0, 4000);
}

/* ---------- 通用右键菜单 ----------
   items: [{id, label, danger?}, '-', ...]，onPick(id) */
export function showMenu(x, y, items, onPick) {
  closeMenu();
  const m = document.createElement('div');
  m.className = 'ctx';
  m.id = 'ctx-menu';
  for (const it of items) {
    if (it === '-') {
      const s = document.createElement('div');
      s.className = 'sep';
      m.appendChild(s);
      continue;
    }
    const b = document.createElement('button');
    b.textContent = it.label;
    if (it.danger) b.classList.add('danger');
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      closeMenu();
      onPick(it.id);
    });
    m.appendChild(b);
  }
  document.body.appendChild(m);
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(4, Math.min(x, window.innerWidth - r.width - 6)) + 'px';
  m.style.top = Math.max(4, Math.min(y, window.innerHeight - r.height - 6)) + 'px';

  const onDown = (e) => {
    if (m.contains(e.target)) {
      window.addEventListener('mousedown', onDown, { capture: true, once: true });
      return;
    }
    closeMenu();
  };
  setTimeout(() => {
    window.addEventListener('mousedown', onDown, { capture: true, once: true });
    window.addEventListener('scroll', closeMenu, { capture: true, once: true });
    window.addEventListener('keydown', escClose, true);
  }, 0);
}

function escClose(e) {
  if (e.key === 'Escape') closeMenu();
}

export function closeMenu() {
  document.getElementById('ctx-menu')?.remove();
  window.removeEventListener('keydown', escClose, true);
}
