// actions.js

import { getContext } from '../../../extensions.js';
import { event_types, eventSource } from '../../../../script.js';
import { getCharaFilename } from '../../../utils.js';
import { CONFIG, STATE, THEME_KEY } from './state.js';
import { API, setCharBindings, charSetAuxWorlds, invalidateBoundBooksCache, extractPrimaryWorld } from './api.js';
import { UI } from './ui.js';
import { logger } from './logger.js';

// ===== Token 计数：非阻塞异步方案 =====
// SillyTavern 在 main_api=openai 时，同步版 getTokenCount() 会发起阻塞式 XHR（async:false），
// 大世界书（数百条目）打开面板时会冻结主线程数秒。这里改为：
//   1) 先用与 ST guesstimate 相同的公式给出估算值，保证 UI 立即可用；
//   2) 后台低并发异步调用 getTokenCountAsync 拿精确值并回填缓存；
//   3) 精确值到位后通过 UI.onTokensRefined() 合并刷新界面。
const TOKEN_ESTIMATE_BYTES_PER_TOKEN = 3.35;
const TOKEN_MAX_CONCURRENCY = 4;
const TOKEN_CACHE_LIMIT = 2000;
const tokenCountCache = new Map(); // text -> 精确 token 数
const estimateCache = new Map();   // text -> 估算 token 数（统计行高频遍历时避免重复编码）
const tokenPending = new Set();    // 排队中/请求中的 text
const tokenQueue = [];
let tokenActive = 0;
let tokenTextEncoder = null;

function estimateTokens(text) {
    const hit = estimateCache.get(text);
    if (typeof hit === 'number') return hit;
    let value;
    try {
        if (!tokenTextEncoder) tokenTextEncoder = new TextEncoder();
        value = Math.ceil(tokenTextEncoder.encode(text).length / TOKEN_ESTIMATE_BYTES_PER_TOKEN);
    } catch (e) {
        value = Math.ceil(text.length / 3);
    }
    if (estimateCache.size > TOKEN_CACHE_LIMIT) {
        estimateCache.delete(estimateCache.keys().next().value);
    }
    estimateCache.set(text, value);
    return value;
}

function pumpTokenQueue() {
    while (tokenActive < TOKEN_MAX_CONCURRENCY && tokenQueue.length > 0) {
        const text = tokenQueue.shift();
        tokenActive++;
        Promise.resolve()
            .then(() => {
                const ctx = getContext();
                if (typeof ctx.getTokenCountAsync === 'function') return ctx.getTokenCountAsync(text);
                // 旧版本 ST 兼容：退化为同步计数（仅在异步接口缺失时）
                return typeof ctx.getTokenCount === 'function' ? ctx.getTokenCount(text) : null;
            })
            .then((count) => {
                if (typeof count === 'number' && Number.isFinite(count) && count >= 0) {
                    tokenCountCache.set(text, count);
                    if (tokenCountCache.size > TOKEN_CACHE_LIMIT) {
                        tokenCountCache.delete(tokenCountCache.keys().next().value);
                    }
                    UI.onTokensRefined();
                }
            })
            .catch(() => { /* 保留估算值 */ })
            .finally(() => {
                tokenPending.delete(text);
                tokenActive--;
                pumpTokenQueue();
            });
    }
}

function scheduleTokenCount(text) {
    if (!text || tokenPending.has(text) || tokenCountCache.has(text)) return;
    // 面板未打开时不预热，避免无意义的请求
    if (!document.getElementById(CONFIG.id)) return;
    tokenPending.add(text);
    tokenQueue.push(text);
    pumpTokenQueue();
}

export const Actions = {
    async flushPendingSave() {
        if (STATE.debouncer) {
            clearTimeout(STATE.debouncer);
            STATE.debouncer = null;
            if (STATE.currentBookName && Array.isArray(STATE.entries)) {
                await API.saveBookEntries(STATE.currentBookName, STATE.entries);
            }
        }
    },

    async loadBoundBooksSetAsync() {
        return await API.getAllBoundBookNames();
    },

    getEntrySortScore(entry) {
        const context = getContext();
        const anDepth = (context.chatMetadata && context.chatMetadata['note_depth'])
            ?? (context.extensionSettings && context.extensionSettings.note && context.extensionSettings.note.defaultDepth)
            ?? 4;
        const pos = typeof entry.position === 'number' ? entry.position : 1;

        if (pos === 0) return 100000; 
        if (pos === 1) return 90000;  
        if (pos === 5) return 80000;  
        if (pos === 6) return 70000;  
        if (pos === 4) return entry.depth ?? 4;
        if (pos === 2) return anDepth + 0.6;
        if (pos === 3) return anDepth + 0.4;
        return -9999;
    },

    async init() {
        if (STATE.isInitialized) return;
        UI.initTooltips();
        this.registerCharDeleteListener();

        const es = eventSource;
        const et = event_types;

        es.on(et.SETTINGS_UPDATED, () => { if (document.getElementById(CONFIG.id)) this.refreshAllContext(); });
        es.on(et.WORLDINFO_UPDATED, (name, data) => {
            if (STATE.currentBookName !== name) return;
            // 插件自身保存会触发该事件；此时本地 STATE.entries 就是数据源，重载会
            // 整表重建 DOM（丢失输入焦点、造成卡顿），因此用引用+时间窗比对跳过。
            const selfSave = STATE.lastSelfSave;
            if (selfSave && selfSave.name === name && selfSave.data === data && (Date.now() - selfSave.ts) < 5000) return;
            this.loadBook(name);
        });
        es.on(et.CHAT_CHANGED, () => {
            // 当前聊天绑定已并入绑定映射缓存，切换聊天后必须失效
            invalidateBoundBooksCache();
            if (document.getElementById(CONFIG.id)) this.refreshAllContext();
        });
        es.on(et.CHARACTER_SELECTED, () => {
            invalidateBoundBooksCache();
            setTimeout(() => {
                if (document.getElementById(CONFIG.id)) this.refreshAllContext();
                else this.refreshAllContext();
            }, 100);
        });
        es.on(et.CHARACTER_EDITED, () => { if (document.getElementById(CONFIG.id)) this.refreshAllContext(); });
        // 角色新增/导入后，绑定的世界书映射缓存需要失效，否则"管理世界书"分组与
        // "联级删除主要世界书"会看不到新角色的绑定。
        es.on(et.CHARACTER_PAGE_LOADED, () => { invalidateBoundBooksCache(); });

        // Tokenizer 模型/来源切换后，已缓存的精确 token 数不再可信
        const clearTokenCache = () => {
            tokenCountCache.clear();
            UI.onTokensRefined();
        };
        es.on(et.CHATCOMPLETION_SOURCE_CHANGED, clearTokenCache);
        es.on(et.CHATCOMPLETION_MODEL_CHANGED, clearTokenCache);

        STATE.isInitialized = true;
        await this.refreshAllContext();
        logger.info("Initialization complete.");
    },

    async refreshAllContext() {
        try {
            // 快速加载核心数据（不包含耗时的 boundBooksSet）
            const [all, char, glob, chat] = await Promise.all([
                API.getAllBookNames(),
                API.getCharBindings(),
                API.getGlobalBindings(),
                API.getChatBinding()
            ]);

            STATE.allBookNames = all.sort((a, b) => a.localeCompare(b));
            STATE.bindings.char = char;
            STATE.bindings.global = glob;
            STATE.bindings.chat = chat;
            STATE.metadata = API.getMetadata();

            // 清理已删除世界书的孤儿元数据（以 __ 开头的键是插件内部配置，如 __GLOBAL_CONFIG__，必须保留）
            const metaKeys = Object.keys(STATE.metadata);
            let needsSave = false;
            metaKeys.forEach(key => {
                if (key.startsWith('__')) return;
                if (!STATE.allBookNames.includes(key)) {
                    delete STATE.metadata[key];
                    needsSave = true;
                }
            });
            if (needsSave) {
                await API.saveMetadata(STATE.metadata);
            }

            // 后台异步加载绑定映射，避免阻塞UI
            this.loadBoundBooksSetAsync().then(boundSet => {
                STATE.boundBooksSet = boundSet;
                // 如果当前在管理视图，刷新以显示正确的绑定状态
                if (STATE.currentView === 'manage') {
                    UI.renderManageView();
                }
            }).catch(e => {
                logger.error("Async load of bound books set failed:", e);
            });

            UI.renderBookSelector();
        } catch (e) {
            logger.error("Failed to refresh context:", e);
        }
    },

    async switchView(viewName) {
        await this.flushPendingSave();
        UI.updateGlider(viewName);
        document.querySelectorAll('.wb-tab').forEach(el => {
            el.classList.toggle('active', el.dataset.tab === viewName);
        });

        setTimeout(() => {
            STATE.currentView = viewName;
            document.querySelectorAll('.wb-view-section').forEach(el => el.classList.add('wb-hidden'));
            const targetView = document.getElementById(`wb-view-${viewName}`);
            if (targetView) targetView.classList.remove('wb-hidden');

            if (viewName === 'binding') {
                UI.renderBindingView();
            } else if (viewName === 'manage') {
                // 修复一：确保视图显示后再计算滑块位置
                UI.updateManageGlider(STATE.manageTab);

                if (STATE.isManageDirty) {
                    UI.renderManageView();
                    // 这里原本直接修改，移到 renderManageView 内部管理
                }
            } else if (viewName === 'editor') {
                if (STATE.currentBookName && !STATE.allBookNames.includes(STATE.currentBookName)) {
                    STATE.currentBookName = null;
                    STATE.entries = [];
                    UI.renderList();
                }
                UI.renderBookSelector();
                UI.updateHeaderInfo();
            }
        }, 10);
    },

    async loadBook(name) {
        if (!name) return;
        await this.flushPendingSave();
        STATE.currentBookName = name;

        try {
            const loadedEntries = await API.loadBook(name);
            if (STATE.currentBookName !== name) return;

            STATE.entries = loadedEntries;
            STATE.entries.sort((a, b) => {
                const scoreA = this.getEntrySortScore(a);
                const scoreB = this.getEntrySortScore(b);
                if (scoreA !== scoreB) return scoreB - scoreA;
                return (a.order ?? 0) - (b.order ?? 0) || a.uid - b.uid;
            });

            UI.updateHeaderInfo();
            UI.renderList();

            // 首屏卡片已用估算值渲染；其余条目的精确值在后台低并发补齐，
            // 让统计行/分析弹窗最终显示精确 token 数（ST 侧带持久缓存，重复加载几乎无开销）
            this.hydrateTokenCounts();

            const selector = document.getElementById('wb-book-selector');
            if (selector) selector.value = name;
        } catch (e) {
            if (STATE.currentBookName === name) {
                logger.error("Load book failed", e);
                toastr.error(`无法加载世界书 "${name}"`);
            }
        }
    },

    updateEntry(uid, updater) {
        const entry = STATE.entries.find(e => e.uid === uid);
        if (!entry) return;

        updater(entry);
        UI.updateCardStatus && UI.updateCardStatus(uid);
        // 统计行涉及全量条目遍历，改为防抖刷新，避免每次按键都全量重算
        UI.scheduleStatsRefresh();

        // 标题/内容变化后搜索文本缓存失效。这里不触发列表重建：
        // 编辑过程中卡片保持可见，避免用户正在输入时条目突然消失。
        UI.invalidateSearchTextCache(entry);

        if (STATE.debouncer) clearTimeout(STATE.debouncer);
        const targetBookName = STATE.currentBookName;
        const targetEntries = STATE.entries;

        STATE.debouncer = setTimeout(() => {
            STATE.debouncer = null;
            if (targetBookName && targetEntries) {
                API.saveBookEntries(targetBookName, targetEntries);
            }
        }, 1500); // 延长防抖以减少 I/O
    },
    
    async addNewEntry() {
        if (!STATE.currentBookName) return toastr.warning("请先选择一本世界书");
        const maxUid = STATE.entries.reduce((max, e) => Math.max(max, Number(e.uid) || 0), -1);
        const newUid = maxUid + 1;

        const newEntry = {
            uid: newUid,
            comment: '新建条目', disable: false, content: '',
            constant: true, key: [], order: 0, position: 0, depth: 4, probability: 100, selective: true
        };
        await API.createEntry(STATE.currentBookName, [newEntry]);
        await this.loadBook(STATE.currentBookName);
    },

    async deleteEntry(uid) {
        if (!confirm("确定要删除此条目吗？")) return;
        await API.deleteEntries(STATE.currentBookName, [uid]);
        await this.loadBook(STATE.currentBookName);
    },

    sortByPriority() {
        STATE.entries.sort((a, b) => {
            const scoreA = this.getEntrySortScore(a);
            const scoreB = this.getEntrySortScore(b);
            if (scoreA !== scoreB) return scoreB - scoreA;
            const orderA = a.order ?? 0;
            const orderB = b.order ?? 0;
            if (orderA !== orderB) return orderA - orderB;
            return a.uid - b.uid;
        });

        UI.renderList();
        API.saveBookEntries(STATE.currentBookName, STATE.entries);
        toastr.success(`已重新按上下文逻辑重排`);
    },

    async batchSetExcludeRecursion(uids, value = true) {
        if (!STATE.currentBookName) throw new Error('No book loaded');
        let modified = false;
        STATE.entries.forEach(entry => {
            if (uids.includes(entry.uid) && entry.excludeRecursion !== value) {
                entry.excludeRecursion = value;
                modified = true;
            }
        });
        if (modified) {
            await API.saveBookEntries(STATE.currentBookName, STATE.entries);
            UI.renderGlobalStats();
            uids.forEach(uid => UI.updateCardStatus(uid));
        }
    },
    
    applyTheme(theme) {
      const themeBtn = document.getElementById('btn-wb-menu-theme-toggle');
      if (themeBtn) {
          if (theme === 'light') themeBtn.classList.replace('fa-moon', 'fa-sun');
          else themeBtn.classList.replace('fa-sun', 'fa-moon');
      }
      document.body.setAttribute('data-theme', theme === 'light' ? 'light' : 'dark');
    },

    /**
     * 带"波纹揭示"的主题切换：借助 View Transitions，对 ::view-transition-new(root)
     * 做 clip-path 圆形扩散——圆心在左下角、半径取视口对角线，于是波前呈圆弧状
     * 斜向扫过整屏，右上角最后被新主题覆盖。
     * 不支持 View Transitions 或用户偏好减少动效时，退回瞬时切换。
     */
    applyThemeWithRipple(theme) {
      const reduceMotion = typeof window.matchMedia === 'function'
          && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (typeof document.startViewTransition !== 'function' || reduceMotion) {
          this.applyTheme(theme);
          return;
      }

      // 波纹进行时临时禁用元素自身的颜色过渡（见 style.css 的 .wb-theme-instant），
      // 否则"新主题快照"会捕获到过渡中间态颜色；用计数保证连点时不提前解除
      this._themeRippleCount = (this._themeRippleCount || 0) + 1;
      document.body.classList.add('wb-theme-instant');
      let released = false;
      const release = () => {
          if (released) return;
          released = true;
          this._themeRippleCount = Math.max(0, (this._themeRippleCount || 1) - 1);
          if (this._themeRippleCount === 0) document.body.classList.remove('wb-theme-instant');
      };

      let transition;
      try {
          transition = document.startViewTransition(() => this.applyTheme(theme));
      } catch (e) {
          // 极端情况下 startViewTransition 同步抛错：立即降级为瞬时切换
          release();
          this.applyTheme(theme);
          return;
      }
      transition.ready.then(() => {
          const radius = Math.ceil(Math.hypot(window.innerWidth, window.innerHeight));
          try {
              document.documentElement.animate(
                  { clipPath: [`circle(0px at 0% 100%)`, `circle(${radius}px at 0% 100%)`] },
                  {
                      duration: 700,
                      easing: 'cubic-bezier(0.4, 0, 0.2, 1)',
                      pseudoElement: '::view-transition-new(root)',
                  }
              );
          } catch (e) {
              logger.warn('Theme ripple animation failed, theme applied instantly:', e);
          }
      }).catch(() => { /* 过渡被后续切换跳过：忽略，主题本身已应用 */ });
      transition.finished.then(release, release);
      // 双保险：极端情况下 finished 长时间不触发也不会让过渡被永久禁用
      setTimeout(release, 2500);
    },

    switchTheme() {
      const currentTheme = localStorage.getItem(THEME_KEY) === 'light' ? 'dark' : 'light';
      this.applyThemeWithRipple(currentTheme);
      localStorage.setItem(THEME_KEY, currentTheme);
    },

    async saveBindings() {
        const view = document.getElementById('wb-view-binding');
        const charPrimary = view.querySelector('#wb-bind-char-primary').value;
        const charAddTags = view.querySelectorAll('.wb-ms-tag[data-bind-type="wb-bind-char-add"]');
        const charAdditional = Array.from(charAddTags).map(el => el.dataset.val);
        const globalTags = view.querySelectorAll('.wb-ms-tag[data-bind-type="wb-bind-global"]');
        const globalBooks = Array.from(globalTags).map(el => el.dataset.val);
        const chatBook = view.querySelector('#wb-bind-chat').value;

        try {
            // Get current global bindings to compute changes
            const currentGlobal = await API.getGlobalBindings();
            const toRemove = currentGlobal.filter(b => !globalBooks.includes(b));
            const toAdd = globalBooks.filter(b => !currentGlobal.includes(b));

            // Optimistically update local state and UI for immediate feedback
            STATE.bindings.char.primary = charPrimary || null;
            STATE.bindings.char.additional = charAdditional;
            STATE.bindings.global = globalBooks;
            STATE.bindings.chat = chatBook || null;

            UI.renderBookSelector();
            UI.renderBindingView();

            // Build all async operations in parallel
            const promises = [];

            // Primary binding
            promises.push(setCharBindings('primary', charPrimary || '', !!charPrimary));

            // Auxiliary binding (synchronous but triggers async save)
            const context = getContext();
            const charId = context.characterId;
            if (charId || charId === 0) {
                const charAvatar = context.characters[charId]?.avatar;
                const charFileName = getCharaFilename(null, { manualAvatarKey: charAvatar });
                charSetAuxWorlds(charFileName, charAdditional);
            }

            // Global bindings - execute in parallel
            toRemove.forEach(book => promises.push(setCharBindings('global', book, false)));
            toAdd.forEach(book => promises.push(setCharBindings('global', book, true)));

            // Chat binding
            promises.push(setCharBindings('chat', chatBook || '', !!chatBook));

            // Wait for all operations to settle
            await Promise.all(promises);

            // Do not force refresh here; rely on optimistic UI and eventual SETTINGS_UPDATED event
            toastr.success("绑定设置已保存");
        } catch (e) {
            toastr.error('保存失败: ' + e.message);
        }
    },

    getTokenCount(text) {
        if (!text) return 0;
        const cached = tokenCountCache.get(text);
        if (typeof cached === 'number') return cached;
        // 未命中缓存：先返回估算值保证渲染不阻塞，同时排队后台精确计数
        const estimate = estimateTokens(text);
        scheduleTokenCount(text);
        return estimate;
    },

    /**
     * 仅读取缓存/估算值的版本：用于统计行等会高频全量遍历的场景，
     * 不为未渲染的条目排队精确计数请求（数百条目会产生数百次 XHR）。
     */
    getTokenCountFast(text) {
        if (!text) return 0;
        const cached = tokenCountCache.get(text);
        if (typeof cached === 'number') return cached;
        return estimateTokens(text);
    },

    /**
     * 为当前世界书的所有条目排队后台精确 token 计数。
     * 队列按文本去重、低并发执行，可安全重复调用；面板关闭时不排队。
     */
    hydrateTokenCounts() {
        if (!document.getElementById(CONFIG.id)) return;
        for (const entry of STATE.entries) {
            if (!entry.content) continue;
            if (tokenCountCache.has(entry.content)) continue;
            scheduleTokenCount(entry.content);
        }
    },
    
    getExistingGroups() {
        const groups = new Set();
        Object.values(STATE.metadata).forEach(m => {
            if (m.group && m.group !== '未分组') groups.add(m.group);
        });
        return Array.from(groups).sort();
    },

    async reorderEntry(fromIndex, toIndex) {
        if (fromIndex === toIndex) return;
        const [item] = STATE.entries.splice(fromIndex, 1);
        STATE.entries.splice(toIndex, 0, item);
        UI.renderList();
        await API.saveBookEntries(STATE.currentBookName, STATE.entries);
    },

    async updateMeta(bookName, updater) {
        if (!STATE.metadata[bookName]) { STATE.metadata[bookName] = { group: '', note: '' }; }
        updater(STATE.metadata[bookName]);
        await API.saveMetadata(STATE.metadata);
    },
    async setBookGroup(bookName, groupName) {
        await this.updateMeta(bookName, (meta) => { meta.group = groupName; });
        UI.renderManageView();
    },
    updateNote(bookName, note) { this.updateMeta(bookName, (meta) => { meta.note = note; }); },
    async togglePin(bookName) {
        await this.updateMeta(bookName, (meta) => { meta.pinned = !meta.pinned; });
        STATE.isManageDirty = true; // 强制完整重排以应用新的置顶顺序
        UI.renderManageView();
    },
    async addCustomTag(bookName, tagText) {
        await this.updateMeta(bookName, (meta) => {
            if (!meta.tags) meta.tags = [];
            if (meta.tags.length < 5 && !meta.tags.includes(tagText)) meta.tags.push(tagText);
        });
    },
    async removeCustomTag(bookName, index) {
        await this.updateMeta(bookName, (meta) => {
            if (meta.tags && meta.tags.length > index) meta.tags.splice(index, 1);
        });
    },

    async deleteBookDirectly(bookName) {
        if (!confirm(`确定要永久删除世界书 "${bookName}" 吗？`)) return;
        try {
            if (STATE.currentBookName === bookName && STATE.debouncer) {
                clearTimeout(STATE.debouncer);
                STATE.debouncer = null;
            }
            await API.deleteWorldbook(bookName);
            // 删除对应的元数据条目
            if (STATE.metadata[bookName]) {
                delete STATE.metadata[bookName];
                await API.saveMetadata(STATE.metadata);
            }
            if (STATE.currentBookName === bookName) {
                STATE.currentBookName = null;
                STATE.entries = [];
            }
            await this.refreshAllContext();
            STATE.isManageDirty = true;
            UI.renderManageView();
        } catch (e) { toastr.error("删除失败: " + e.message); }
    },

    async jumpToEditor(bookName) {
        await this.loadBook(bookName);
        this.switchView('editor');
    },

    async toggleBindState(bookName, targetCharName, isUnbind) {
        const context = getContext();
        const currentChar = context.characters[context.characterId]?.name;

        if (isUnbind) {
            if (!confirm(`确定要解除世界书 "${bookName}" 与角色 "${targetCharName}" 的绑定吗？`)) return;
            try {
                if (currentChar === targetCharName) await setCharBindings('primary', bookName, false);
                await this.refreshAllContext();
                STATE.isManageDirty = true;
                UI.renderManageView();
            } catch (e) { toastr.error("解绑失败: " + e.message); }
        } else {
            if (!currentChar) return toastr.warning("当前没有加载任何角色，无法绑定。");
            if (!confirm(`确定要将世界书 "${bookName}" 绑定为当前角色 "${currentChar}" 的主要世界书吗？`)) return;
            try {
                await setCharBindings('primary', bookName, true);
                await this.refreshAllContext();
                STATE.isManageDirty = true;
                if (bookName) await this.loadBook(bookName);
                UI.renderManageView();
            } catch (e) { toastr.error("绑定失败: " + e.message); }
        }
    },

    async actionImport() { document.getElementById('wb-import-file').click(); },
    
    async actionHandleImport(file) {
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async (e) => {
            try {
                const content = JSON.parse(e.target.result);
                let entries = content.entries ? Object.values(content.entries) : content;
                if (!Array.isArray(entries)) entries = [];

                let bookName = file.name.replace(/\.(json|wb)$/i, '');
                const name = prompt("请输入导入后的世界书名称:", bookName);
                if (!name) return;

                if (STATE.allBookNames.includes(name)) {
                    if (!confirm(`世界书 "${name}" 已存在，是否覆盖？`)) return;
                }
                if (!STATE.allBookNames.includes(name)) await API.createWorldbook(name);
                await API.saveBookEntries(name, entries);
                toastr.success(`导入成功: ${name}`);
                await this.refreshAllContext();
                await this.loadBook(name);
            } catch (err) { toastr.error("导入失败: " + err.message); }
        };
        reader.readAsText(file);
    },

    async actionExport() {
        if (!STATE.currentBookName) return toastr.warning("请先选择一本世界书");
        try {
            const entries = await API.loadBook(STATE.currentBookName);
            const entriesObj = {};
            entries.forEach(entry => { entriesObj[entry.uid] = entry; });
            const exportData = { entries: entriesObj };
            const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${STATE.currentBookName}.json`;
            a.click();
            URL.revokeObjectURL(url);
        } catch (e) { toastr.error("导出失败: " + e.message); }
    },

    async actionExportTxt() {
        if (!STATE.currentBookName) return toastr.warning("请先选择一本世界书");

        const overlay = document.createElement('div');
        overlay.className = 'wb-sort-modal-overlay';
        overlay.style.zIndex = '25000';
        overlay.innerHTML = `
            <div class="wb-export-card">
                <div class="wb-export-header"><div class="wb-export-title">导出世界书为 TXT</div><div class="wb-export-close">×</div></div>
                <div class="wb-export-section"><div class="wb-export-label">导出所有条目</div><div class="wb-export-grid"><button class="wb-export-btn" data-type="all-title">含标题</button><button class="wb-export-btn" data-type="all-no-title">不含标题</button></div></div>
                <div class="wb-export-section"><div class="wb-export-label">仅导出已启用条目</div><div class="wb-export-grid"><button class="wb-export-btn" data-type="enabled-title">含标题</button><button class="wb-export-btn" data-type="enabled-no-title">不含标题</button></div></div>
            </div>`;
        document.body.appendChild(overlay);

        const processExport = (type) => {
            try {
                let targetEntries = [...STATE.entries];
                if (type.startsWith('enabled')) targetEntries = targetEntries.filter(e => !e.disable);
                targetEntries.sort((a, b) => {
                    const scoreA = this.getEntrySortScore(a);
                    const scoreB = this.getEntrySortScore(b);
                    if (scoreA !== scoreB) return scoreB - scoreA;
                    return (a.order ?? 0) - (b.order ?? 0) || a.uid - b.uid;
                });

                if (targetEntries.length === 0) return toastr.warning("没有符合条件的条目可导出");
                const includeTitle = !type.includes('no-title');
                let txtContent = "";
                targetEntries.forEach(entry => {
                    const title = entry.comment || '无标题条目';
                    const content = entry.content || '';
                    if (includeTitle) txtContent += `#### ${title}\n${content}\n\n`;
                    else txtContent += `${content}\n\n`;
                });

                const scopeName = type.startsWith('enabled') ? '仅启用' : '所有';
                const formatName = includeTitle ? '含标题' : '无标题';
                const fileName = `${STATE.currentBookName}_${scopeName}_${formatName}.txt`;
                const blob = new Blob([txtContent], { type: 'text/plain' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = fileName;
                a.click();
                URL.revokeObjectURL(url);
                toastr.success(`导出成功: ${fileName}`);
                overlay.remove();
            } catch (e) { toastr.error("导出失败: " + e.message); }
        };

        overlay.querySelector('.wb-export-close').onclick = () => overlay.remove();
        overlay.querySelectorAll('.wb-export-btn').forEach(btn => { btn.onclick = () => processExport(btn.dataset.type); });
        overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    },

    async actionCreateNew() {
        const name = prompt("请输入新世界书名称:");
        if (!name) return;
        if (STATE.allBookNames.includes(name)) return toastr.warning("该名称已存在");
        try {
            await API.createWorldbook(name);
            await this.refreshAllContext();
            await this.loadBook(name);
        } catch (e) { toastr.error("创建失败: " + e.message); }
    },

    async actionDelete() {
        if (!STATE.currentBookName) return;
        if (!confirm(`确定要永久删除世界书 "${STATE.currentBookName}" 吗？`)) return;
        try {
            if (STATE.debouncer) { clearTimeout(STATE.debouncer); STATE.debouncer = null; }
            await API.deleteWorldbook(STATE.currentBookName);
            STATE.currentBookName = null;
            STATE.entries = [];
            await this.refreshAllContext();
            await this.init(); 
        } catch (e) { toastr.error("删除失败: " + e.message); }
    },

    async actionRename() {
        if (!STATE.currentBookName) return;
        const newName = prompt("重命名世界书为:", STATE.currentBookName);
        if (!newName || newName === STATE.currentBookName) return;
        if (STATE.allBookNames.includes(newName)) return toastr.warning("目标名称已存在");

        try {
            await this.flushPendingSave();
            await API.renameWorldbook(STATE.currentBookName, newName);
            await this.refreshAllContext();
            await this.loadBook(newName);
        } catch (e) { toastr.error("重命名失败: " + e.message); }
    },

    getGlobalConfig() {
        const allMeta = API.getMetadata() || {};
        const config = allMeta['__GLOBAL_CONFIG__'] || {};
        if (config.deleteWbWithChar === undefined) config.deleteWbWithChar = true;
        if (config.showLogButton === undefined) config.showLogButton = false;
        return config;
    },
    
    async saveGlobalConfig(newConfig) {
        const allMeta = API.getMetadata() || {};
        allMeta['__GLOBAL_CONFIG__'] = { ...allMeta['__GLOBAL_CONFIG__'], ...newConfig };
        await API.saveMetadata(allMeta);
    },
    
    registerCharDeleteListener() {
        const es = eventSource;
        const et = event_types;
        if (!es) return;

        es.on(et.CHARACTER_DELETED, async (data) => {
             // 无论是否联级删除，角色已删除 => 绑定映射缓存立即失效
             invalidateBoundBooksCache();

             const config = this.getGlobalConfig();
             if (!config.deleteWbWithChar) return;

             const charObj = data?.character || {};
             const charName = charObj.name || data?.name;
             if (!charName && !charObj.avatar) return;

             // 首选：直接从事件载荷的角色卡数据读取主要世界书。
             // CHARACTER_DELETED 在角色文件已从磁盘删除之后才触发，重新扫描角色列表
             // 是拿不到绑定的；而载荷里的角色对象仍保留 data.extensions.world。
             let bookName = this.extractPrimaryWorld(charObj);

             // 回退：使用删除前构建的绑定缓存快照（保留原缓存，不做即时重建，
             // 否则重建发生在角色删除之后，绑定信息同样会丢失）
             if (!bookName && charName && STATE.boundBooksCache?.data) {
                 for (const [wb, bindInfo] of Object.entries(STATE.boundBooksCache.data)) {
                     if (bindInfo.primary && bindInfo.primary.includes(charName)) {
                         bookName = wb;
                         break;
                     }
                 }
             }

             if (!bookName || typeof bookName !== 'string') return;
             // 世界书必须仍然存在才提示；本地列表过期时会自动刷新一次
             if (!(await API.worldbookExists(bookName))) return;

             UI.showDeleteWbConfirmModal(bookName, async () => {
                 await API.deleteWorldbook(bookName);
                 // 刷新面板数据（书单、下拉框、管理视图）
                 if (document.getElementById(CONFIG.id)) {
                     await this.refreshAllContext();
                     STATE.isManageDirty = true;
                     if (STATE.currentView === 'manage') UI.renderManageView();
                     if (STATE.currentBookName === bookName) {
                         STATE.currentBookName = null;
                         STATE.entries = [];
                         UI.renderList();
                         UI.updateHeaderInfo();
                     }
                 }
             }, async () => {
                 await this.saveGlobalConfig({ deleteWbWithChar: false });
                 if (STATE.currentView === 'manage') UI.renderManageView();
             });
        });
    },

    /**
     * 从角色卡对象里提取"主要世界书"字段，兼容新旧多种存储位置。
     * @param {object} charObj 角色卡对象（可能是浅层数据）
     * @returns {string|null}
     */
    extractPrimaryWorld(charObj) {
        return extractPrimaryWorld(charObj);
    },

    async removeTagFromWorldbook(bookName, tagToRemove) {
        const meta = STATE.metadata[bookName] || {};
        const tags = meta.tags || [];
        const newTags = tags.filter(tag => tag !== tagToRemove);
        await this.updateMeta(bookName, (meta) => { meta.tags = newTags; });
        STATE.isManageDirty = true;
        const searchInput = document.getElementById('wb-manage-search');
        if (searchInput) {
            UI.renderManageView(searchInput.value);
        } else {
            UI.renderManageView();
        }
    }
};