// 侧边栏页面与后台 service worker 共用的数据层

export const STORAGE_KEY = 'linknest_v1';

// 去重时忽略的跟踪参数（不影响页面内容的参数）
const TRACK_PARAM = /^(utm_\w+|fbclid|gclid|yclid|igshid|spm|spm_id_from|vd_source|share_token|chksm|mkt_tok|buvid|_hsenc|_hsmi)$/i;

// 归一化 URL 作为去重键：去 hash、去跟踪参数、参数排序、去结尾斜杠
export function normalizeUrl(raw) {
  const s = String(raw || '').trim();
  try {
    const u = new URL(s);
    u.hash = '';
    for (const k of [...u.searchParams.keys()]) {
      if (TRACK_PARAM.test(k)) u.searchParams.delete(k);
    }
    u.searchParams.sort();
    const path = u.pathname.replace(/\/+$/, '');
    const q = u.searchParams.toString();
    return u.origin + path + (q ? '?' + q : '');
  } catch {
    return s;
  }
}

export function makeId() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

export async function loadData() {
  const obj = await chrome.storage.local.get(STORAGE_KEY);
  const data = obj[STORAGE_KEY] || {};
  return { groups: data.groups || [], links: data.links || [] };
}

export async function saveData(data) {
  await chrome.storage.local.set({ [STORAGE_KEY]: data });
}

// 新增链接；若归一化 URL 已存在则不重复插入，返回已有记录（自动去重）
export async function addLink({ url, title = '', content = '', alias = '', note = '', groupId = null, favicon = '' }) {
  const data = await loadData();
  const norm = normalizeUrl(url);
  const existing = data.links.find((l) => (l.normUrl || normalizeUrl(l.url)) === norm);
  if (existing) {
    let changed = false;
    if (!existing.content && content) { existing.content = content; changed = true; }
    if ((!existing.title || existing.title === existing.url) && title) { existing.title = title; changed = true; }
    if (!existing.favicon && favicon) { existing.favicon = favicon; changed = true; }
    if (changed) { existing.updatedAt = Date.now(); await saveData(data); }
    return { status: 'duplicate', link: existing };
  }
  const link = {
    id: makeId(),
    url,
    normUrl: norm,
    title: title || url,
    alias,
    note,
    content,
    favicon,
    groupId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  data.links.unshift(link);
  await saveData(data);
  return { status: 'added', link };
}

/* ---------- 面板虚拟分组：只在侧边栏里分组，不创建浏览器标签组（无标签栏胶囊） ----------
   groups: [{id, name, color}]；assign: normUrl -> groupId（按 URL 持久，重开浏览器也在） */

export const PGROUP_KEY = 'linknest_pgroups_v1';

export async function loadPanelGroups() {
  const obj = await chrome.storage.local.get(PGROUP_KEY);
  const d = obj[PGROUP_KEY] || {};
  // tabs: tabId -> groupId（'' 表示强制不入组）；成员以标签页为主，URL 映射用于重启后接回
  return { groups: d.groups || [], assign: d.assign || {}, tabs: d.tabs || {} };
}

export async function savePanelGroups(pg) {
  await chrome.storage.local.set({ [PGROUP_KEY]: pg });
}

/* ---------- 自建浏览记录：不依赖 chrome.history（可能被企业策略禁用） ----------
   后台监听页面加载完成自行记录，按 normUrl 去重，上限 600 条 */

export const VISITS_KEY = 'linknest_visits_v1';

export async function loadVisits() {
  const obj = await chrome.storage.local.get(VISITS_KEY);
  return obj[VISITS_KEY] || [];
}

// touch=true：正常记一次访问（更新时间/次数）；touch=false：只补全标题/图标，不算新访问
export async function recordVisit({ url, title = '', favicon = '' }, { touch = true } = {}) {
  if (!/^https?:/i.test(url || '')) return;
  const visits = await loadVisits();
  const norm = normalizeUrl(url);
  const i = visits.findIndex((v) => v.normUrl === norm);
  if (i < 0 && !touch) return;
  let v;
  if (i >= 0) {
    v = touch ? visits.splice(i, 1)[0] : visits[i];
    if (touch) v.count = (v.count || 1) + 1;
  } else {
    v = { normUrl: norm, count: 1 };
  }
  v.url = url;
  if (title) v.title = title;
  if (favicon && favicon.length <= 4096) v.favicon = favicon;
  if (touch) {
    v.time = Date.now();
    visits.push(v); // 最新的在末尾
    if (visits.length > 600) visits.splice(0, visits.length - 600);
  }
  await chrome.storage.local.set({ [VISITS_KEY]: visits });
}

export async function removeVisit(normUrl) {
  const visits = await loadVisits();
  const next = visits.filter((v) => v.normUrl !== normUrl);
  if (next.length !== visits.length) await chrome.storage.local.set({ [VISITS_KEY]: next });
}

/* ---------- 用户设置（自定义名字等） ---------- */

export const SETTINGS_KEY = 'linknest_settings_v1';

export async function loadSettings() {
  const obj = await chrome.storage.local.get(SETTINGS_KEY);
  return obj[SETTINGS_KEY] || {};
}

export async function saveSettings(patch) {
  const s = await loadSettings();
  await chrome.storage.local.set({ [SETTINGS_KEY]: { ...s, ...patch } });
}

/* ---------- favicon 持久缓存：normUrl -> 图标地址 ----------
   从打开中的标签页采集真实图标，供历史/收藏等只有 URL 的场景显示 */

export const FAVCACHE_KEY = 'linknest_favcache_v1';

export async function loadFavCache() {
  const obj = await chrome.storage.local.get(FAVCACHE_KEY);
  return obj[FAVCACHE_KEY] || {};
}

// 合并新采集的图标，超过 800 条时淘汰最旧的；无变化不写存储
export async function mergeFavCache(entries) {
  const cache = await loadFavCache();
  let changed = false;
  for (const [k, v] of Object.entries(entries)) {
    if (!v || v.length > 4096 || cache[k] === v) continue;
    delete cache[k]; // 重新插入，保持“最近见过”的在后
    cache[k] = v;
    changed = true;
  }
  if (changed) {
    const keys = Object.keys(cache);
    if (keys.length > 800) {
      for (const k of keys.slice(0, keys.length - 800)) delete cache[k];
    }
    await chrome.storage.local.set({ [FAVCACHE_KEY]: cache });
  }
  return cache;
}

/* ---------- 备注（别名）表：normUrl -> alias ----------
   标签页和收藏共用，给任何 URL 加的备注在两个视图都生效 */

export const ALIAS_KEY = 'linknest_alias_v1';

export async function loadAliases() {
  const obj = await chrome.storage.local.get(ALIAS_KEY);
  return obj[ALIAS_KEY] || {};
}

// 只写别名表（收藏视图自己维护 link.alias 时用）
export async function saveAliasMap(normUrl, alias) {
  const m = await loadAliases();
  if (alias) m[normUrl] = alias;
  else delete m[normUrl];
  await chrome.storage.local.set({ [ALIAS_KEY]: m });
}

// 写别名表 + 同步已收藏的同 URL 链接（标签页视图用）
export async function setAlias(normUrl, alias) {
  await saveAliasMap(normUrl, alias);
  const data = await loadData();
  const link = data.links.find((l) => (l.normUrl || normalizeUrl(l.url)) === normUrl);
  if (link && (link.alias || '') !== (alias || '')) {
    link.alias = alias || '';
    link.updatedAt = Date.now();
    await saveData(data);
  }
}

// 一键去重：按归一化 URL 合并，保留字段最全的信息，返回移除条数
export async function dedupeLinks() {
  const data = await loadData();
  const seen = new Map();
  const kept = [];
  let removed = 0;
  for (const l of data.links) {
    const key = l.normUrl || normalizeUrl(l.url);
    const prev = seen.get(key);
    if (!prev) {
      l.normUrl = key;
      seen.set(key, l);
      kept.push(l);
      continue;
    }
    prev.alias = prev.alias || l.alias || '';
    prev.note = prev.note || l.note || '';
    prev.content = prev.content || l.content || '';
    prev.favicon = prev.favicon || l.favicon || '';
    if (prev.groupId == null && l.groupId != null) prev.groupId = l.groupId;
    if (l.createdAt < prev.createdAt) prev.createdAt = l.createdAt;
    removed++;
  }
  if (removed) {
    data.links = kept;
    await saveData(data);
  }
  return removed;
}

/* ---------- 不清理名单：normUrl -> {title, addedAt} ----------
   「清理不常用标签页」时永久跳过；标记一次记住，以后不用每次都勾 */

export const KEEP_KEY = 'linknest_keep_v1';

export async function loadKeep() {
  const obj = await chrome.storage.local.get(KEEP_KEY);
  return obj[KEEP_KEY] || {};
}

export async function setKeep(normUrl, keep, title = '') {
  const m = await loadKeep();
  if (keep) m[normUrl] = { title: String(title || '').slice(0, 200), addedAt: Date.now() };
  else delete m[normUrl];
  await chrome.storage.local.set({ [KEEP_KEY]: m });
  return m;
}
