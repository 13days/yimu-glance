// 入口：视图切换 + 全局搜索分发 + 存储变更广播

import { $, closeMenu, toast } from './ui-common.js';
import { STORAGE_KEY, ALIAS_KEY, VISITS_KEY, KEEP_KEY, loadSettings, saveSettings } from './shared.js';
import { initTabsView, setTabsQuery, onAliasChanged, onKeepChanged, navigateTabs } from './view-tabs.js';
import { initCollectionView, setCollectionQuery, onCollectionStorageChanged } from './view-collection.js';
import { initRecentView, setRecentQuery, onRecentAliasChanged, onVisitsChanged } from './view-recent.js';

let view = 'tabs';
const searchEl = $('#search');

init();

async function init() {
  $('#nav-tabs').addEventListener('click', () => switchView('tabs'));
  $('#nav-recent').addEventListener('click', () => switchView('recent'));
  $('#nav-coll').addEventListener('click', () => switchView('coll'));

  let timer;
  searchEl.addEventListener('input', () => {
    updateOpenHint();
    clearTimeout(timer);
    timer = setTimeout(() => dispatchQuery(searchEl.value.trim()), 120);
  });
  searchEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      searchEl.value = '';
      updateOpenHint();
      dispatchQuery('');
    } else if (e.key === 'Enter') {
      const url = urlFromInput(searchEl.value);
      if (url) {
        e.preventDefault();
        openFromSearch(url);
      }
    } else if (e.key === 'ArrowDown' && view === 'tabs') {
      e.preventDefault();
      $('#t-list').focus();
    }
  });
  $('#open-hint').addEventListener('click', () => {
    const url = $('#open-hint').dataset.url;
    if (url) openFromSearch(url);
  });

  // IDE 习惯：/ 或 Cmd/Ctrl+F 聚焦搜索；Alt+← / Alt+→ 按访问顺序跨标签页后退 / 前进
  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
    if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      searchEl.focus();
      searchEl.select();
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      searchEl.focus();
      searchEl.select();
    } else if (e.altKey && !e.metaKey && !e.ctrlKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !typing) {
      e.preventDefault();
      navigateTabs(e.key === 'ArrowLeft' ? -1 : 1);
    }
  });

  await Promise.all([initTabsView(), initCollectionView(), initRecentView(), initBrand()]);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[STORAGE_KEY]) onCollectionStorageChanged();
    if (changes[ALIAS_KEY]) {
      onAliasChanged();
      onRecentAliasChanged();
    }
    if (changes[VISITS_KEY]) onVisitsChanged();
    if (changes[KEEP_KEY]) onKeepChanged();
  });
}

function switchView(v) {
  view = v;
  closeMenu();
  $('#nav-tabs').classList.toggle('active', v === 'tabs');
  $('#nav-recent').classList.toggle('active', v === 'recent');
  $('#nav-coll').classList.toggle('active', v === 'coll');
  $('#view-tabs').classList.toggle('hidden', v !== 'tabs');
  $('#t-compact').classList.toggle('hidden', v !== 'tabs'); // 收缩按钮只在标签页视图显示
  $('#view-recent').classList.toggle('hidden', v !== 'recent');
  $('#view-coll').classList.toggle('hidden', v !== 'coll');
  dispatchQuery(searchEl.value.trim());
}

function dispatchQuery(q) {
  if (view === 'tabs') setTabsQuery(q);
  else if (view === 'recent') setRecentQuery(q);
  else setCollectionQuery(q);
}

/* ------- 搜索框直接打开链接（omnibox 风格） ------- */

// 输入内容长得像 URL 时返回可打开的完整地址，否则 null
function urlFromInput(q) {
  q = q.trim();
  if (!q || /\s/.test(q)) return null;
  try {
    if (/^https?:\/\/\S+$/i.test(q)) return new URL(q).href;
    const bare = /^localhost(:\d+)?(\/\S*)?$/i.test(q)
      || /^(\d{1,3}\.){3}\d{1,3}(:\d+)?(\/\S*)?$/.test(q)
      || /^[\w-]+(\.[\w-]+)*\.[a-z]{2,}(:\d+)?(\/\S*)?$/i.test(q);
    if (bare) return new URL('https://' + q).href;
  } catch { /* 非法 URL */ }
  return null;
}

function updateOpenHint() {
  const hint = $('#open-hint');
  const url = urlFromInput(searchEl.value);
  if (url) {
    hint.textContent = `↗ 回车在新标签页打开：${url.replace(/^https?:\/\//i, '')}`;
    hint.dataset.url = url;
    hint.classList.remove('hidden');
  } else {
    hint.classList.add('hidden');
    delete hint.dataset.url;
  }
}

async function openFromSearch(url) {
  await chrome.tabs.create({ url });
  searchEl.value = '';
  updateOpenHint();
  dispatchQuery('');
  toast('已在新标签页打开');
}

/* ------- 字标（双击自定义改名）+ 二次元走马灯 ------- */

const TAGLINES = [
  '标签整理魔法・发动！✧(≖ ◡ ≖✿)',
  '今天也要元气满满地清理重复标签哦～',
  '窗口千千万，一目全看穿 (๑•̀ㅂ•́)و✧',
  '迷失的标签页，由我来指引回家之路！',
  '备注一下，下次秒找到 (ฅ´ω`ฅ)',
  '收藏 = 传送锚点，随时召唤回来！',
  '重复标签退散！去去去～(∩^o^)⊃━☆',
  '按「/」聚焦搜索，快得像瞬间移动',
  'F2 给标签起个可爱的名字吧 (｡•̀ᴗ-)✧',
  '整组恢复，昨日的战场一键重开！',
  '双击我头上的名字，可以改名哦 ✧',
  '粘贴链接直接开新页，冲鸭～ᕕ( ᐛ )ᕗ',
];

let brandName = '一目';
let brandEditing = false;
let cycleTimer;
let showTagline = false;
let tagIdx = -1;

async function initBrand() {
  const s = await loadSettings();
  applyBrand(s.brandName || '一目');
  const b = $('#brand');
  b.addEventListener('dblclick', startBrandEdit);
  b.addEventListener('click', () => { cycleTick(true); startCycle(); });
  b.addEventListener('mouseenter', () => clearInterval(cycleTimer));
  b.addEventListener('mouseleave', startCycle);
  startCycle();
}

function applyBrand(name) {
  brandName = name;
  document.title = name;
  setBrandText(name, false);
}

function setBrandText(text, roll = true, plain = false) {
  const b = $('#brand');
  if (brandEditing) return;
  if (roll) {
    b.classList.remove('roll');
    void b.offsetWidth; // 重置动画
  }
  b.textContent = text;
  b.classList.toggle('plain', plain);
  if (roll) b.classList.add('roll');
}

// 走马灯：自定义名与语录在“一目”那几个字的位置交替滑动，不额外占行
async function cycleTick(forceTagline) {
  if (brandEditing) return;
  showTagline = forceTagline ? true : !showTagline;
  if (!showTagline) {
    setBrandText(brandName);
    return;
  }
  tagIdx = (tagIdx + 1) % (TAGLINES.length + 1);
  let text;
  if (tagIdx === TAGLINES.length) {
    try {
      const tabs = await chrome.tabs.query({});
      text = `${tabs.length} 个标签页尽在掌握 ✧`;
    } catch {
      text = TAGLINES[0];
    }
  } else {
    text = TAGLINES[tagIdx];
  }
  setBrandText(text, true, true); // 语录：普通灰色
}

function startCycle() {
  clearInterval(cycleTimer);
  cycleTimer = setInterval(cycleTick, 5000);
}

function startBrandEdit() {
  const brand = $('#brand');
  if (brandEditing) return;
  brandEditing = true;
  clearInterval(cycleTimer);
  const input = document.createElement('input');
  input.className = 'brand-input';
  input.maxLength = 12;
  input.value = brandName;
  brand.textContent = '';
  brand.appendChild(input);
  input.focus();
  input.select();
  let done = false;
  const commit = async () => {
    if (done) return;
    done = true;
    brandEditing = false;
    const v = input.value.trim() || '一目';
    applyBrand(v);
    startCycle();
    await saveSettings({ brandName: v });
    toast(`已改名「${v}」～今后请多指教 ✧`);
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') commit();
    else if (e.key === 'Escape') {
      done = true;
      brandEditing = false;
      applyBrand(brandName);
      startCycle();
    }
  });
  input.addEventListener('blur', commit);
}
