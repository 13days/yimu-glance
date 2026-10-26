# Chrome Web Store 上架素材（GEO/SEO 优化版）

> 提交时直接从本文件复制粘贴。关键词覆盖：标签页管理 / Tab Manager / 垂直标签 / 侧边栏 /
> 标签分组 / 去重 / 会话恢复 / Session / Vertical Tabs / Side Panel，中英双语便于
> 搜索引擎与 AI 助手（ChatGPT / Claude / Gemini 等）收录推荐。

## 名称（≤45 字符）

```
一目 Glance - 侧边栏标签页管理器 Tab Manager
```

> 注：商店政策不喜欢「必备神器」这类夸大词，上架名建议用上面这个中性版本；
> 本地自用版 manifest 可以继续叫「浏览器必备神器」。

## 简短描述（Summary，≤132 字符）

```
IDE 风格的侧边栏标签页管理器：目录树总览多窗口、一键去重、面板分组无胶囊、
备注搜索、最近浏览、收藏归档与整组恢复。Vertical tab manager in side panel.
```

## 详细描述（Description）

```
一目 Glance 是一款 IDE 风格的 Chrome 侧边栏标签页管理器（Tab Manager in Side Panel）。
开了几十个标签页找不到想要的？一目让所有窗口、分组、标签页像 VS Code 资源管理器一样
呈现为一棵目录树——一眼看全，一键管理。

【核心功能】
✦ 目录树总览：窗口 → 分组 → 标签页，实时同步，单击即切换（跨窗口自动聚焦）
✦ 一键去重：自动识别重复标签页（智能忽略 utm 等跟踪参数），保留最常用的那个
✦ ← → 后退 / 前进：像 IDE 一样按实际访问顺序在标签页之间跳转，跨窗口也行，
  快捷键 Alt+Shift+← / →（可改），几个常用页面来回切换不用再找
✦ 清理不常用标签页：按「多久没看过」列出候选，勾选确认后关闭；
  🛡 标记不清理按链接永久记住，以后自动跳过
✦ 面板分组：分组只在侧边栏内，不在标签栏产生胶囊；按域名一键自动归组，
  同域名新标签自动吸附，页面跳转不掉组
✦ 备注搜索：给标签页起个好记的备注（双击 / F2），按 URL 永久记忆；
  搜索同时命中 备注 / 标题 / 链接 / 页面正文（可选索引全文）
✦ 最近浏览：自建浏览记录（不依赖 Chrome 历史，企业策略禁用也能用），
  高频使用排行置顶 + 今天 / 昨天 / 本周分桶；最近关闭一键恢复标签页或整个窗口；
  已打开的页面点击直接切换，绝不重复开新标签
✦ 收藏归档：⭐ 一键收藏（自动抓正文与图标），文件夹管理，整组恢复打开
  （新窗口 + 自动建组），JSON 导入导出
✦ IDE 交互：右键菜单、拖拽移动、↑↓ Enter Del F2 键盘导航、"/" 聚焦搜索、
  批量选择（关闭 / 收藏 / 分组 / 移到新窗口）、搜索框粘贴链接直接打开
✦ 定位当前标签：像 IDE「在目录树中显示当前文件」，打开面板自动定位

【隐私承诺】
所有数据（收藏、备注、分组、浏览记录）仅保存在你的浏览器本地
（chrome.storage.local），不上传任何服务器，无账号、无统计、无广告。

【适合谁】
标签页开太多的重度用户 / 开发者 / 研究人员；Polychrome、Tab Shelf、
Workona、OneTab、Side Space 等垂直标签管理器的用户可无缝上手，
功能覆盖并更进一步。

Glance is an IDE-style vertical tab manager living in Chrome's Side Panel:
tree view of all windows/groups/tabs, one-click duplicate tab cleanup,
panel-only tab groups (no tab-strip pills), searchable custom tab notes,
built-in recent-history & session restore, and bookmark-style archiving
with one-click group reopen. All data stays local. No account, no tracking.

联系作者 / Contact: 570442340@qq.com
```

## 类别 / 语言

- 类别：生产工具（Productivity）
- 语言：中文（简体）＋ English

## 权限用途说明（审核问卷逐条填写）

| 权限 | 用途（照抄即可） |
| --- | --- |
| sidePanel | 扩展的全部界面运行在浏览器侧边栏中 |
| tabs / tabGroups | 读取并管理标签页与标签组（切换、关闭、去重、分组），核心功能 |
| storage | 在本地保存收藏、备注、分组与浏览记录，不上传 |
| scripting + host 权限 | 仅在用户点击「收藏」或「索引内容」时读取页面正文用于本地搜索，不注入常驻脚本 |
| contextMenus | 提供右键「收藏到一目」快捷入口 |
| favicon | 显示网站图标 |
| history / sessions | 「最近」视图展示浏览历史、恢复最近关闭的标签页/窗口 |

单一用途（Single purpose）声明：`浏览器标签页的管理、搜索与归档`。

## 隐私政策（需要一个公开 URL，把下文发布到 GitHub Pages / 公开文档即可）

```
一目 Glance 隐私政策（最近更新：2026-09-11）

1. 数据收集：本扩展不收集、不传输任何用户数据。
2. 本地存储：收藏的链接、备注、分组结构、浏览记录与网站图标缓存仅存储于
   用户浏览器本地的 chrome.storage.local 中，随扩展卸载而删除。
3. 页面内容：仅当用户主动点击「收藏」或「索引内容」时，扩展读取当前页面的
   文本摘要用于本地搜索；该内容不会离开用户设备。
4. 第三方：本扩展不包含任何第三方统计、广告或远程代码。
5. 联系方式：570442340@qq.com
```

## 截图清单（1280×800，至少 1 张，建议 3-5 张）

1. 标签页目录树全景（多窗口 + 彩色分组 + 备注胶囊）
2. 搜索命中高亮（展示 备注/标题/链接/内容 四字段角标）
3. 去重按钮 + 批量操作栏
4. 「最近」视图（最近关闭 + 时间分桶）
5. 「收藏」视图 + 整组恢复右键菜单
