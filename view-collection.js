// 收藏（归档）视图：目录树（分组文件夹 → 链接），与标签页视图同一套交互
// 单击打开 / 悬停操作 / 右键菜单 / 拖拽归组 / 行内编辑 / 一组全部恢复打开

import {
  loadData, saveData, addLink, dedupeLinks, normalizeUrl, makeId, saveAliasMap, loadFavCache,
} from './shared.js';
import {
  $, esc, tokensOf, highlight, prettyUrl, faviconOf, toast, showMenu,
  matchFields, snippetOf, copyText, grabPageContent, FIELD_LABEL, openOrSwitchTab,
} from './ui-common.js';

const c = {
  data: { groups: [], links: [] },
  tabFavs: new Map(),     // normUrl -> 打开中标签页的实时 favicon（老收藏的兜底）
  query: '',
  collapsed: new Set(),   // 折叠的分组 id（含 'none'）
  editingId: null,        // 正在编辑的链接 id
  focusAlias: false,
  renamingFolder: null,   // 正在重命名的分组 id
  addingFolder: false,
  confirmDelete: null,    // 链接 id 或 'folder:<id>'
};

export async function initCollectionView() {
  c.data = await loadData();
  await refreshTabFavs();
  bindToolbar();
  bindList();
  render();
}

let favsAt = 0;
let favCache = {};
async function refreshTabFavs() {
  favsAt = Date.now();
  try {
    const tabs = await chrome.tabs.query({});
    c.tabFavs = new Map();
    for (const tb of tabs) {
      if (/^(https?:|data:)/i.test(tb.favIconUrl || '')) {
        c.tabFavs.set(normalizeUrl(tb.url || ''), tb.favIconUrl);
      }
    }
    favCache = await loadFavCache();
  } catch { /* ignore */ }
}

function favOfLink(link) {
  const norm = link.normUrl || normalizeUrl(link.url);
  return link.favicon
    || c.tabFavs.get(norm)
    || favCache[norm]
    || faviconOf(link.url);
}

export function setCollectionQuery(q) {
  c.query = q;
  render();
  if (Date.now() - favsAt > 4000) refreshTabFavs().then(render);
}

export async function onCollectionStorageChanged() {
  c.data = await loadData();
  const ae = document.activeElement;
  if (ae && ae.closest && ae.closest('#c-list') && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return;
  render();
}

async function commit() {
  await saveData(c.data);
  render();
}

/* ---------------- 渲染 ---------------- */

function combinedContent(link) {
  return [link.note, link.content].filter(Boolean).join(' ⋯ ');
}

function matchLink(link, tokens) {
  if (!tokens.length) return { matchedFields: new Set(), score: 0 };
  return matchFields({
    alias: (link.alias || '').toLowerCase(),
    title: (link.title || '').toLowerCase(),
    url: (link.url || '').toLowerCase(),
    content: combinedContent(link).toLowerCase(),
  }, tokens);
}

function render() {
  const tokens = tokensOf(c.query);
  const linksOf = (fid) => c.data.links
    .filter((l) => (fid === 'none' ? !l.groupId : l.groupId === fid))
    .sort((a, b) => b.createdAt - a.createdAt);

  const folders = [...c.data.groups.map((g) => ({ id: g.id, name: g.name })), { id: 'none', name: '未分组' }];
  let shown = 0;
  const parts = [];

  if (c.addingFolder) {
    parts.push(`<div class="row grp-head editing" data-folder="__new__">
      <input class="f-name" placeholder="新分组名，回车创建" maxlength="24">
      <button class="mini" data-fact="create" title="创建">✓</button>
    </div>`);
  }

  for (const f of folders) {
    const rows = linksOf(f.id)
      .map((link) => ({ link, m: matchLink(link, tokens) }))
      .filter((r) => r.m);
    if (tokens.length) {
      rows.sort((a, b) => b.m.score - a.m.score || b.link.createdAt - a.link.createdAt);
      if (!rows.length) continue;
    }
    shown += rows.length;
    parts.push(folderHTML(f, rows, tokens));
  }

  const total = c.data.links.length;
  $('#c-stats').textContent = tokens.length ? `匹配 ${shown} / ${total} 条` : `共 ${total} 条`;

  const listEl = $('#c-list');
  if (!total && !c.data.groups.length && !c.addingFolder) {
    listEl.innerHTML = `
      <div class="empty">
        <div class="empty-icon">🔖</div>
        <p>还没有收藏。在「标签页」视图点 ⭐，<br>或右键网页选「收藏到一目」。</p>
        <p class="hint">收藏 = 归档：标签页关掉也不怕丢，<br>之后可以整组一键恢复打开。</p>
      </div>`;
  } else if (tokens.length && !shown) {
    listEl.innerHTML = '<div class="empty"><p>没有匹配的收藏</p></div>';
  } else {
    listEl.innerHTML = parts.join('');
  }

  if (c.addingFolder) $('#c-list .f-name')?.focus();
  if (c.renamingFolder != null) {
    const i = $('#c-list .f-rename');
    if (i && document.activeElement !== i) { i.focus(); i.select(); }
  }
  if (c.editingId && c.focusAlias) {
    const i = $('#c-list .e-alias');
    if (i) { i.focus(); i.select(); }
    c.focusAlias = false;
  }
}

function folderHTML(f, rows, tokens) {
  if (c.renamingFolder === f.id) {
    return `<div class="node">
      <div class="row grp-head editing" data-folder="${esc(f.id)}">
        <input class="f-rename" value="${esc(f.name)}" maxlength="24">
        <button class="mini" data-fact="rename-save" title="保存">✓</button>
      </div>
    </div>`;
  }
  const open = tokens.length ? true : !c.collapsed.has(f.id);
  const isNone = f.id === 'none';
  const delConfirm = c.confirmDelete === 'folder:' + f.id;
  const acts = [
    rows.length ? `<button class="mini" data-fact="openall" title="在新窗口打开整组">↗</button>` : '',
    isNone ? '' : `<button class="mini" data-fact="rename" title="重命名">✎</button>`,
    isNone ? '' : (delConfirm
      ? '<button class="mini danger-btn" data-fact="del">确认删除</button>'
      : '<button class="mini" data-fact="del" title="删除分组（链接移入未分组）">✕</button>'),
  ].join('');
  return `
  <div class="node">
    <div class="row grp-head folder" data-key="fold-${esc(f.id)}" data-folder="${esc(f.id)}" data-drop-folder="${esc(f.id)}">
      <span class="chev">${open ? '▾' : '▸'}</span>
      <span class="node-name">${open ? '📂' : '📁'} ${esc(f.name)}</span>
      <span class="cnt">${rows.length}</span>
      <span class="acts">${acts}</span>
    </div>
    ${open ? `<div class="children win-children">${rows.map((r) => linkRowHTML(r.link, tokens, r.m)).join('')}</div>` : ''}
  </div>`;
}

function linkRowHTML(link, tokens, m) {
  if (c.editingId === link.id) return editFormHTML(link);
  const aliasHtml = link.alias ? `<span class="alias">${highlight(link.alias, tokens)}</span>` : '';
  const badges = [];
  if (tokens.length) for (const f of m.matchedFields) badges.push(`<span class="badge">${FIELD_LABEL[f]}</span>`);
  const delBtn = c.confirmDelete === link.id
    ? '<button class="mini danger-btn" data-lact="del">确认删除</button>'
    : '<button class="mini" data-lact="del" title="删除">✕</button>';

  let extra = '';
  if (tokens.length && (m.matchedFields.has('url') || m.matchedFields.has('content'))) {
    extra += `<div class="sub depth1">${highlight(prettyUrl(link.url), tokens)}</div>`;
    const snip = m.matchedFields.has('content') ? snippetOf(combinedContent(link), tokens) : '';
    if (snip) extra += `<div class="sub snippet depth1">${highlight(snip, tokens)}</div>`;
  }

  return `
  <div class="row tab-row depth1" data-link="${esc(link.id)}" draggable="true" title="${esc(link.url)}">
    <img class="fav" src="${esc(favOfLink(link))}" alt="">
    <span class="t-title">${aliasHtml}${highlight(link.title || link.url, tokens)}</span>
    ${badges.join('')}
    <span class="acts">
      <button class="mini" data-lact="edit" title="编辑备注 / 描述">✎</button>
      ${delBtn}
    </span>
  </div>${extra}`;
}

function editFormHTML(link) {
  const groupOpts = [`<option value="">未分组</option>`,
    ...c.data.groups.map((g) => `<option value="${esc(g.id)}" ${g.id === link.groupId ? 'selected' : ''}>${esc(g.name)}</option>`),
  ].join('');
  return `
  <div class="edit-form" data-link="${esc(link.id)}">
    <div class="sub depth1" title="${esc(link.url)}">${esc(prettyUrl(link.url))}</div>
    <label>备注<input class="e-alias" value="${esc(link.alias || '')}" maxlength="30" placeholder="加个好记的备注，如：周报模板"></label>
    <label>标题<input class="e-title" value="${esc(link.title || '')}"></label>
    <label>描述<textarea class="e-note" rows="2" placeholder="补充描述，可被「内容」搜索命中">${esc(link.note || '')}</textarea></label>
    <label>分组<select class="e-group">${groupOpts}</select></label>
    <div class="form-btns">
      <button class="primary" data-lact="save-edit">保存</button>
      <button data-lact="cancel-edit">取消</button>
    </div>
  </div>`;
}

/* ---------------- 动作 ---------------- */

export async function saveCurrentTab(groupId = null) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || !/^https?:/i.test(tab.url)) {
    toast('此页面无法收藏（仅支持 http / https）');
    return;
  }
  let content = '';
  try {
    const res = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: grabPageContent });
    content = res?.[0]?.result || '';
  } catch { /* 无法注入的页面 */ }
  const fav = /^(https?:|data:)/i.test(tab.favIconUrl || '') ? tab.favIconUrl : '';
  const { status, link } = await addLink({ url: tab.url, title: tab.title || tab.url, content, groupId, favicon: fav });
  c.data = await loadData();
  // 指定了分组：已存在的重复项也顺手移过去
  if (groupId) {
    const l = c.data.links.find((x) => x.id === link.id);
    if (l && l.groupId !== groupId) {
      l.groupId = groupId;
      await saveData(c.data);
    }
  }
  if (status === 'added') {
    c.editingId = link.id;
    c.focusAlias = true;
    render();
    toast('已收藏 ✓ 顺手加个备注吧');
  } else {
    render();
    toast('该链接已收藏过，已自动去重 ✓');
    const el = document.querySelector(`#c-list [data-link="${CSS.escape(link.id)}"]`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('flash');
      setTimeout(() => el.classList.remove('flash'), 1600);
    }
  }
}

async function openFolder(fid) {
  const links = c.data.links.filter((l) => (fid === 'none' ? !l.groupId : l.groupId === fid));
  const urls = links.map((l) => l.url).filter((u) => /^https?:/i.test(u));
  if (!urls.length) { toast('该分组没有可打开的链接'); return; }
  // 已经开着的不重复打开
  let openSet = new Set();
  try {
    const tabs = await chrome.tabs.query({});
    openSet = new Set(tabs.map((tb) => normalizeUrl(tb.url || '')));
  } catch { /* ignore */ }
  const pending = urls.filter((u) => !openSet.has(normalizeUrl(u)));
  const skipped = urls.length - pending.length;
  if (!pending.length) {
    toast(`该组 ${urls.length} 个链接全部已在浏览器中打开`);
    return;
  }
  const win = await chrome.windows.create({ url: pending });
  const name = fid === 'none' ? null : c.data.groups.find((g) => g.id === fid)?.name;
  if (name && win?.tabs?.length > 1) {
    const gid = await chrome.tabs.group({
      tabIds: win.tabs.map((x) => x.id),
      createProperties: { windowId: win.id },
    });
    await chrome.tabGroups.update(gid, { title: name });
  }
  toast(`已打开 ${pending.length} 个链接${skipped ? `，跳过 ${skipped} 个已打开的` : ''}`);
}

async function handleLinkAction(act, id, container) {
  const link = c.data.links.find((l) => l.id === id);
  if (!link) return;
  switch (act) {
    case 'open': {
      const result = await openOrSwitchTab(link.url);
      if (result === 'switched') toast('已切换到打开中的标签页');
      break;
    }
    case 'edit':
      c.editingId = id;
      c.focusAlias = true;
      c.confirmDelete = null;
      render();
      break;
    case 'cancel-edit':
      c.editingId = null;
      render();
      break;
    case 'save-edit': {
      const box = container || document.querySelector(`#c-list .edit-form[data-link="${CSS.escape(id)}"]`);
      if (!box) return;
      link.alias = box.querySelector('.e-alias').value.trim();
      link.title = box.querySelector('.e-title').value.trim() || link.url;
      link.note = box.querySelector('.e-note').value.trim();
      link.groupId = box.querySelector('.e-group').value || null;
      link.updatedAt = Date.now();
      c.editingId = null;
      await commit();
      await saveAliasMap(link.normUrl || normalizeUrl(link.url), link.alias);
      toast('已保存 ✓');
      break;
    }
    case 'copy': await copyText(link.url); break;
    case 'del':
      if (c.confirmDelete !== id) {
        c.confirmDelete = id;
        render();
        setTimeout(() => { if (c.confirmDelete === id) { c.confirmDelete = null; render(); } }, 3000);
      } else {
        c.data.links = c.data.links.filter((l) => l.id !== id);
        c.confirmDelete = null;
        await commit();
        toast('已删除');
      }
      break;
    default:
      if (act.startsWith('move:')) {
        const gid = act.slice(5);
        link.groupId = gid === 'none' ? null : gid;
        link.updatedAt = Date.now();
        await commit();
        toast('已移动分组');
      }
  }
}

async function handleFolderAction(act, fid, row) {
  switch (act) {
    case 'openall': await openFolder(fid); break;
    case 'save-here': await saveCurrentTab(fid === 'none' ? null : fid); break;
    case 'rename':
      c.renamingFolder = fid;
      render();
      break;
    case 'rename-save': {
      const input = row?.querySelector('.f-rename') || $('#c-list .f-rename');
      const name = (input?.value || '').trim();
      const g = c.data.groups.find((x) => x.id === c.renamingFolder);
      c.renamingFolder = null;
      if (!g || !name || name === g.name) { render(); return; }
      if (c.data.groups.some((x) => x.name === name && x.id !== g.id)) {
        render();
        toast('同名分组已存在');
        return;
      }
      g.name = name;
      await commit();
      break;
    }
    case 'create': {
      const input = row?.querySelector('.f-name') || $('#c-list .f-name');
      const name = (input?.value || '').trim();
      c.addingFolder = false;
      if (!name) { render(); return; }
      if (c.data.groups.some((x) => x.name === name)) {
        render();
        toast('同名分组已存在');
        return;
      }
      c.data.groups.push({ id: makeId(), name });
      await commit();
      toast(`已创建分组「${name}」`);
      break;
    }
    case 'del': {
      const key = 'folder:' + fid;
      if (c.confirmDelete !== key) {
        c.confirmDelete = key;
        render();
        setTimeout(() => { if (c.confirmDelete === key) { c.confirmDelete = null; render(); } }, 3000);
      } else {
        c.data.groups = c.data.groups.filter((g) => g.id !== fid);
        for (const l of c.data.links) if (l.groupId === fid) l.groupId = null;
        c.confirmDelete = null;
        await commit();
        toast('分组已删除，链接移入「未分组」');
      }
      break;
    }
  }
}

/* ---------------- 事件 ---------------- */

function bindToolbar() {
  $('#c-save-tab').addEventListener('click', () => saveCurrentTab());

  $('#c-new-folder').addEventListener('click', () => {
    c.addingFolder = true;
    render();
  });

  $('#c-menu-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    $('#c-menu').classList.toggle('hidden');
  });
  document.addEventListener('click', () => $('#c-menu').classList.add('hidden'));

  $('#c-dedupe').addEventListener('click', async () => {
    const removed = await dedupeLinks();
    c.data = await loadData();
    render();
    toast(removed ? `去重完成，合并了 ${removed} 条重复链接` : '没有发现重复链接 ✓');
  });
  $('#c-export').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(c.data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `glance-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
  $('#c-import').addEventListener('click', () => $('#file-import').click());
  $('#file-import').addEventListener('change', importJSON);
}

function bindList() {
  const list = $('#c-list');

  list.addEventListener('click', async (e) => {
    const form = e.target.closest('.edit-form');
    if (form) {
      const btn = e.target.closest('[data-lact]');
      if (btn) await handleLinkAction(btn.dataset.lact, form.dataset.link, form);
      return;
    }
    const row = e.target.closest('.row');
    if (!row) return;

    const lact = e.target.closest('[data-lact]');
    if (lact) { await handleLinkAction(lact.dataset.lact, row.dataset.link, row); return; }
    const fact = e.target.closest('[data-fact]');
    if (fact) { await handleFolderAction(fact.dataset.fact, row.dataset.folder, row); return; }

    if (row.classList.contains('editing')) return;
    if (row.dataset.link) {
      await handleLinkAction('open', row.dataset.link);
    } else if (row.dataset.folder) {
      const fid = row.dataset.folder;
      c.collapsed.has(fid) ? c.collapsed.delete(fid) : c.collapsed.add(fid);
      render();
    }
  });

  list.addEventListener('dblclick', (e) => {
    const row = e.target.closest('.row[data-link]');
    if (row) handleLinkAction('edit', row.dataset.link);
  });

  list.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.row');
    if (!row) return;
    e.preventDefault();
    if (row.dataset.link) {
      const moves = [
        ...c.data.groups.map((g) => ({ id: 'move:' + g.id, label: `📁 移到「${g.name}」` })),
        { id: 'move:none', label: '📁 移到「未分组」' },
      ];
      showMenu(e.clientX, e.clientY, [
        { id: 'open', label: '↗ 打开' },
        { id: 'edit', label: '✎ 编辑备注 / 描述' },
        { id: 'copy', label: '📋 复制链接' },
        '-',
        ...moves,
        '-',
        { id: 'del', label: '✕ 删除', danger: true },
      ], (act) => handleLinkAction(act, row.dataset.link));
    } else if (row.dataset.folder && !row.classList.contains('editing')) {
      const fid = row.dataset.folder;
      showMenu(e.clientX, e.clientY, [
        { id: 'save-here', label: '＋ 收藏当前页到此组' },
        { id: 'openall', label: '↗ 在新窗口打开整组' },
        fid !== 'none' ? { id: 'rename', label: '✎ 重命名' } : null,
        fid !== 'none' ? { id: 'del', label: '✕ 删除分组', danger: true } : null,
      ].filter(Boolean), (act) => handleFolderAction(act, fid));
    }
  });

  // 创建/重命名按钮不抢输入框焦点，避免 focusout 先行提交
  list.addEventListener('mousedown', (e) => {
    if (e.target.closest('[data-fact="create"], [data-fact="rename-save"]')) e.preventDefault();
  });

  list.addEventListener('keydown', async (e) => {
    if (e.isComposing || e.keyCode === 229) return; // 输入法上屏回车不提交
    if (e.target.matches('.f-name')) {
      if (e.key === 'Enter') await handleFolderAction('create', '__new__', e.target.closest('.row'));
      else if (e.key === 'Escape') { c.addingFolder = false; render(); }
    } else if (e.target.matches('.f-rename')) {
      if (e.key === 'Enter') await handleFolderAction('rename-save', c.renamingFolder, e.target.closest('.row'));
      else if (e.key === 'Escape') { c.renamingFolder = null; render(); }
    } else if (e.target.matches('.e-alias, .e-title')) {
      if (e.key === 'Enter') {
        const form = e.target.closest('.edit-form');
        await handleLinkAction('save-edit', form.dataset.link, form);
      } else if (e.key === 'Escape') { c.editingId = null; render(); }
    }
  });

  list.addEventListener('focusout', async (e) => {
    if (e.target.matches('.f-name') && c.addingFolder) {
      if (e.relatedTarget?.dataset?.fact === 'create') return;
      await handleFolderAction('create', '__new__', e.target.closest('.row'));
    } else if (e.target.matches('.f-rename') && c.renamingFolder != null) {
      if (e.relatedTarget?.dataset?.fact === 'rename-save') return;
      await handleFolderAction('rename-save', c.renamingFolder, e.target.closest('.row'));
    }
  });

  // 拖拽链接到分组文件夹
  list.addEventListener('dragstart', (e) => {
    const row = e.target.closest('.row[data-link]');
    if (!row) { e.preventDefault(); return; }
    e.dataTransfer.setData('text/plain', row.dataset.link);
    e.dataTransfer.effectAllowed = 'move';
  });
  list.addEventListener('dragover', (e) => {
    const target = e.target.closest('[data-drop-folder]');
    if (!target) return;
    e.preventDefault();
    for (const el of document.querySelectorAll('#c-list .drop-into')) el.classList.remove('drop-into');
    target.classList.add('drop-into');
  });
  list.addEventListener('drop', async (e) => {
    const target = e.target.closest('[data-drop-folder]');
    for (const el of document.querySelectorAll('#c-list .drop-into')) el.classList.remove('drop-into');
    if (!target) return;
    e.preventDefault();
    const id = e.dataTransfer.getData('text/plain');
    await handleLinkAction('move:' + target.dataset.dropFolder, id);
  });
  list.addEventListener('dragend', () => {
    for (const el of document.querySelectorAll('#c-list .drop-into')) el.classList.remove('drop-into');
  });

  // favicon 加载失败：先降级到 Chrome 缓存接口，再失败才隐藏
  list.addEventListener('error', (e) => {
    const img = e.target;
    if (!img.matches?.('img.fav')) return;
    const row = img.closest('.row[data-link]');
    if (row && !img.dataset.fb) {
      img.dataset.fb = '1';
      img.src = faviconOf(row.title || '');
    } else {
      img.classList.add('broken');
    }
  }, true);
}

async function importJSON(e) {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  try {
    const incoming = JSON.parse(await file.text());
    const data = c.data;
    const groupByName = new Map(data.groups.map((g) => [g.name, g]));
    const idMap = new Map();
    for (const g of incoming.groups || []) {
      const ex = groupByName.get(g.name);
      if (ex) {
        idMap.set(g.id, ex.id);
      } else {
        const ng = { id: makeId(), name: g.name };
        data.groups.push(ng);
        groupByName.set(ng.name, ng);
        idMap.set(g.id, ng.id);
      }
    }
    const norms = new Set(data.links.map((l) => l.normUrl || normalizeUrl(l.url)));
    let added = 0;
    let skipped = 0;
    for (const l of incoming.links || []) {
      if (!l?.url) continue;
      const norm = normalizeUrl(l.url);
      if (norms.has(norm)) { skipped++; continue; }
      norms.add(norm);
      data.links.push({
        id: makeId(),
        url: l.url,
        normUrl: norm,
        title: l.title || l.url,
        alias: l.alias || '',
        note: l.note || '',
        content: l.content || '',
        favicon: l.favicon || '',
        groupId: l.groupId ? (idMap.get(l.groupId) ?? null) : null,
        createdAt: l.createdAt || Date.now(),
        updatedAt: Date.now(),
      });
      added++;
    }
    await commit();
    toast(`导入完成：新增 ${added} 条，跳过重复 ${skipped} 条`);
  } catch {
    toast('导入失败：不是有效的 JSON 文件');
  }
}
