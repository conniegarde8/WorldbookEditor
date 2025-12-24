import { getContext } from '../../../extensions.js';
import { event_types, eventSource } from '../../../../script.js';
import { getCharaFilename } from '../../../utils.js';
import {
    world_info,
    world_names,
    selected_world_info,
    charUpdatePrimaryWorld,
    charSetAuxWorlds
} from '../../../world-info.js';

const CONFIG = {
    id: 'enhanced-wb-panel-v6',
    btnId: 'wb-menu-btn-v6',
    settingsKey: 'WorldbookEditor_Metadata', // extension_settings
    colors: {
        accent: '#7c5cbd',
    }
};

const STATE = {
    currentView: 'editor', // 'editor' | 'binding' | 'manage'
    currentBookName: null,

    // 初始化标记，防止重复监听和重复加载
    isInitialized: false,

    // 数据缓存
    entries: [],
    allBookNames: [],
    metadata: {},

    // (已移除 globalSettingsCache)

    // 缓存已被任意角色绑定的世界书名称集合
    boundBooksSet: {},

    bindings: {
        char: { primary: null, additional: [] },
        global: [],
        chat: null
    },

    debouncer: null
};

// ST 原生位置枚举，用于 UI 转换
const WI_POSITION_MAP = {
    0: 'before_character_definition',
    1: 'after_character_definition',
    2: 'before_author_note',
    3: 'after_author_note',
    4: 'at_depth',
    5: 'before_example_messages',
    6: 'after_example_messages'
};
// 反向映射用于保存
const WI_POSITION_MAP_REV = Object.fromEntries(Object.entries(WI_POSITION_MAP).map(([k, v]) => [v, parseInt(k)]));

// --- 绑定处理函数 (独立于 API 对象) ---
/**
 * 处理不同类型的世界书绑定
 * @param {string} type - 绑定类型: 'primary'(主要), 'auxiliary'(附加), 'chat'(聊天), 'global'(全局)
 * @param {string} worldName - 世界书的名称
 * @param {boolean} isEnabled - 是绑定(true)还是解绑(false)
 */
async function setCharBindings(type, worldName, isEnabled) {
    const context = getContext();

    // 1. 处理主要世界书 (Primary) - 归属于角色卡片
    if (type === 'primary') {
        // 如果是启用，设置名字；如果是禁用，设置为空字符串
        const targetName = isEnabled ? worldName : '';
        // 调用核心函数更新角色主世界书
        await charUpdatePrimaryWorld(targetName);
        return;
    }

    // 2. 处理附加世界书 (Auxiliary) - 归属于角色设置(Settings)
    if (type === 'auxiliary') {
        const charId = context.characterId;
        if (!charId && charId !== 0) return;

        // 获取角色对应的文件名
        const charAvatar = context.characters[charId].avatar;
        const charFileName = getCharaFilename(null, { manualAvatarKey: charAvatar });

        // 获取当前已绑定的附加世界书列表
        const charLoreEntry = world_info.charLore?.find(e => e.name === charFileName);
        let currentBooks = charLoreEntry ? [...charLoreEntry.extraBooks] : [];

        if (isEnabled) {
            // 添加绑定（去重）
            if (!currentBooks.includes(worldName)) {
                currentBooks.push(worldName);
            }
        } else {
            // 移除绑定
            currentBooks = currentBooks.filter(name => name !== worldName);
        }

        // 调用核心函数保存更新
        charSetAuxWorlds(charFileName, currentBooks);
        return;
    }

    // 3. 处理聊天世界书 (Chat) - 归属于当前聊天元数据
    if (type === 'chat') {
        if (isEnabled) {
            context.chatMetadata['world_info'] = worldName;
        } else {
            // 如果解绑的是当前绑定的这一本，则删除字段
            if (context.chatMetadata['world_info'] === worldName) {
                delete context.chatMetadata['world_info'];
            }
        }
        // 保存元数据
        context.saveMetadataDebounced();
        return;
    }

    // 4. 处理全局世界书 (Global) - 归属于全局设置
    if (type === 'global') {
        // 使用 Slash Command 是操作全局世界书最安全的方式（会自动处理 UI 刷新）
        // /world name -> 激活
        // /world state=off name -> 禁用
        const command = isEnabled
            ? `/world silent=true "${worldName}"`
            : `/world state=off silent=true "${worldName}"`;

        await context.executeSlashCommands(command);
        return;
    }

    console.warn(`未知的绑定类型: ${type}`);
}

const API = {
    // --- 读取类 ---
    async getAllBookNames() {
        // 直接从 ST 核心模块读取实时变量
        return (world_names || []).sort((a, b) => a.localeCompare(b));
    },

    async getCharBindings() {
        const context = getContext();
        const charId = context.characterId;
        // 注意：context.characterId 可能是 undefined，或者是数字索引
        if (charId === undefined || charId === null) return { primary: null, additional: [] };

        const character = context.characters[charId];
        if (!character) return { primary: null, additional: [] };

        // 1. 获取 Primary (直接从内存中的角色对象读取)
        const primary = character.data?.extensions?.world || null;

        // 2. 获取 Auxiliary (从 world_info.charLore 内存对象读取)
        let additional = [];
        // 获取标准化文件名 (去除扩展名)
        const fileName = character.avatar.replace(/\.[^/.]+$/, "");

        // world_info 是从 world-info.js 导入的实时对象引用
        const charLore = world_info.charLore || [];
        const entry = charLore.find(e => e.name === fileName);
        if (entry && Array.isArray(entry.extraBooks)) {
            additional = entry.extraBooks;
        }

        return { primary, additional };
    },

    async getGlobalBindings() {
        // 直接返回 ST 核心维护的全局选中数组
        return selected_world_info || [];
    },

    async getChatBinding() {
        const context = getContext();
        return context.chatMetadata?.world_info || null;
    },

    async loadBook(name) {
        // 直接加载原生数据，不做映射转换
        const data = await getContext().loadWorldInfo(name);
        if (!data) throw new Error(`Worldbook ${name} not found`);
        // 将对象转为数组以便前端处理，但保持内部字段原样
        const entries = data.entries ? Object.values(data.entries) : [];
        // 确保按顺序排序 (原生 order 字段)
        return entries.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    },

    // --- 写入/操作类 ---
    async saveBookEntries(name, entriesArray) {
        // 加载旧数据以保留未修改的深层字段
        const oldData = await getContext().loadWorldInfo(name) || { entries: {} };
        const newEntriesObj = {};

        entriesArray.forEach(entry => {
            // 直接使用原生字段，不再进行映射
            // 确保 UID 存在
            const uid = entry.uid;

            // 合并旧数据（防止插件未支持的字段丢失），覆盖新数据
            newEntriesObj[uid] = {
                ...oldData.entries[uid], // 保留旧字段
                ...entry // 覆盖新字段
            };
        });

        const newData = { ...oldData, entries: newEntriesObj };
        await getContext().saveWorldInfo(name, newData, false);
    },

    async createEntry(name, newEntriesArray) {
        // 保持逻辑不变，但依赖上面的 saveBookEntries
        const currentEntries = await this.loadBook(name);
        // 新条目放在数组最前面，使其物理位置置顶
        const combined = [...newEntriesArray, ...currentEntries];
        await this.saveBookEntries(name, combined);
    },

    async deleteEntries(name, uidsToDelete) {
        let currentEntries = await this.loadBook(name);
        currentEntries = currentEntries.filter(e => !uidsToDelete.includes(e.uid));
        await this.saveBookEntries(name, currentEntries);
    },

    // --- 辅助查询 ---
    async getAllBoundBookNames() {
        const context = getContext();
        // 确保获取最新的角色列表
        const characters = context.characters || [];
        const boundMap = {};

        characters.forEach(char => {
            // 防御性检查：确保 data 对象存在
            if (!char || !char.data) return;

            // 安全读取扩展字段
            const primary = char.data.extensions?.world;

            if (primary) {
                if (!boundMap[primary]) boundMap[primary] = [];
                boundMap[primary].push(char.name);
            }
        });
        return boundMap;
    },

    // --- 元数据管理 ---
    getMetadata() {
        const context = getContext();
        return context.extensionSettings[CONFIG.settingsKey] || {};
    },
    async saveMetadata(data) {
        const context = getContext();
        context.extensionSettings[CONFIG.settingsKey] = data;
        context.saveSettingsDebounced();
    },

    // --- 世界书管理接口 ---
    async createWorldbook(name) {
        await getContext().saveWorldInfo(name, { entries: {} }, true);
        await getContext().updateWorldInfoList();
    },
    async deleteWorldbook(name) {
        await fetch('/api/worldinfo/delete', {
            method: 'POST',
            headers: getContext().getRequestHeaders(),
            body: JSON.stringify({ name }),
        });
        await getContext().updateWorldInfoList();
    },
    async renameWorldbook(oldName, newName) {
        const data = await getContext().loadWorldInfo(oldName);
        if (data) {
            // 1. 创建新文件
            await getContext().saveWorldInfo(newName, data, true);

            // 2. 迁移绑定关系
            try {
                // 检查并更新角色主要绑定
                const { primary, additional } = await this.getCharBindings();
                if (primary === oldName) {
                    await setCharBindings('primary', newName, true);
                }

                // 检查并更新角色附加绑定
                if (additional.includes(oldName)) {
                    // 先解绑旧的，再绑定新的
                    await setCharBindings('auxiliary', oldName, false);
                    await setCharBindings('auxiliary', newName, true);
                }

                // 检查并更新全局绑定
                const globalBindings = await this.getGlobalBindings();
                if (globalBindings.includes(oldName)) {
                    await setCharBindings('global', oldName, false);
                    await setCharBindings('global', newName, true);
                }

                // 检查并更新聊天绑定
                const chatBinding = await this.getChatBinding();
                if (chatBinding === oldName) {
                    await setCharBindings('chat', newName, true);
                }
            } catch (e) {
                console.error("绑定迁移失败:", e);
                toastr.warning("重命名成功，但在迁移绑定关系时遇到错误");
            }

            // 3. 删除旧文件
            await this.deleteWorldbook(oldName);
        }
    }
};

const Actions = {
    // --- 核心排序算法：计算条目的优先级分数 ---
    getEntrySortScore(entry) {
        // 1. 获取当前环境下的作者注释深度
        const context = getContext();
        // 优先级: 聊天独立设置 > 全局设置 > 默认值(4)
        const anDepth = (context.chatMetadata && context.chatMetadata['note_depth'])
            ?? (context.extensionSettings && context.extensionSettings.note && context.extensionSettings.note.defaultDepth)
            ?? 4;

        const pos = typeof entry.position === 'number' ? entry.position : 1;

        // 2. 静态位置 (Static Positions) - 永远置顶
        // 设定一个巨大的基数，保证它们在任何深度条目之上
        // 顺序: Before Char > After Char > Before Ex > After Ex
        if (pos === 0) return 100000; // Before Char
        if (pos === 1) return 90000;  // After Char
        if (pos === 5) return 80000;  // Before Example
        if (pos === 6) return 70000;  // After Example

        // 3. 动态深度位置 (Dynamic Depth Positions)
        // 逻辑: 深度越深，在上下文中插入得越早(越靠上)，因此分数越高

        if (pos === 4) {
            // 普通 @D
            return entry.depth ?? 4;
        }

        // 作者注释 (AN) 相关
        // 利用 "@D 4.5" 逻辑：
        // 假设 AN 深度为 4，顺序应为: ... -> @D5 -> Before AN -> After AN -> @D4 -> ...
        if (pos === 2) {
            // Before Author's Note
            // 比当前 AN 深度略大，排在同级 @D 之前
            return anDepth + 0.6;
        }

        if (pos === 3) {
            // After Author's Note
            // 比当前 AN 深度略大，但在 Before AN 之后
            return anDepth + 0.4;
        }

        return -9999; // 未知/垫底
    },

    async init() {
        // 防止重复初始化
        if (STATE.isInitialized) return;

        UI.initTooltips();
        this.registerCharDeleteListener();

        // 注册事件监听，确保数据同步
        const es = eventSource;
        const et = event_types;

        // 监听设置变更，刷新上下文 (数据源已改为直接引用，此处仅为了触发 UI 重绘)
        es.on(et.SETTINGS_UPDATED, () => {
            if (document.getElementById(CONFIG.id)) this.refreshAllContext();
        });

        // 监听世界书数据变更
        es.on(et.WORLDINFO_UPDATED, (name, data) => {
            if (STATE.currentBookName === name) this.loadBook(name);
        });

        // 监听聊天变更（更新绑定）
        es.on(et.CHAT_CHANGED, () => {
            if (document.getElementById(CONFIG.id)) this.refreshAllContext();
        });

        // [新增] 监听角色选择变更：这是"绑定页面"不更新的主要原因
        es.on(et.CHARACTER_SELECTED, () => {
            // 稍作延迟以确保 ST 内部状态已完全切换
            setTimeout(() => {
                if (document.getElementById(CONFIG.id)) this.refreshAllContext();
                else {
                    // 如果面板未打开，只更新缓存数据（可选，refreshAllContext 内部会处理）
                    this.refreshAllContext();
                }
            }, 100);
        });

        // [新增] 监听角色编辑：这是"管理页面"绑定分组不准确的原因
        es.on(et.CHARACTER_EDITED, () => {
            if (document.getElementById(CONFIG.id)) this.refreshAllContext();
        });

        // 标记为已初始化
        STATE.isInitialized = true;

        // 执行初始数据预加载
        await this.refreshAllContext();

        // 默认加载逻辑
        let defaultBook = STATE.bindings.char.primary;
        if (!defaultBook && STATE.bindings.global.length > 0) defaultBook = STATE.bindings.global[0];
        if (!defaultBook && STATE.allBookNames.length > 0) defaultBook = STATE.allBookNames[0];

        if (defaultBook) {
            await this.loadBook(defaultBook);
        }

        console.log("[Worldbook Editor] Initialization and Pre-loading complete.");
    },

    async refreshAllContext() {
        try {
            // 数据源现已改为内存变量，读取是瞬时的，无需 Loading 遮罩
            const [all, char, glob, chat, boundSet] = await Promise.all([
                API.getAllBookNames(),
                API.getCharBindings(),
                API.getGlobalBindings(),
                API.getChatBinding(),
                API.getAllBoundBookNames()
            ]);

            STATE.allBookNames = all.sort((a, b) => a.localeCompare(b));
            STATE.bindings.char = char;
            STATE.bindings.global = glob;
            STATE.bindings.chat = chat;
            STATE.boundBooksSet = boundSet;
            STATE.metadata = API.getMetadata();

            UI.renderBookSelector();

            // 刷新完成后若仍在 Loading 状态则由调用者关闭，或者此处强制更新状态
            // 但为了配合 open() 的逻辑，这里不做关闭，只做数据准备
        } catch (e) {
            console.error("Failed to refresh context:", e);
        }
    },

    switchView(viewName) {
        STATE.currentView = viewName;
        document.querySelectorAll('.wb-view-section').forEach(el => el.classList.add('wb-hidden'));
        document.getElementById(`wb-view-${viewName}`).classList.remove('wb-hidden');
        document.querySelectorAll('.wb-tab').forEach(el => {
            el.classList.toggle('active', el.dataset.tab === viewName);
        });

        // 立即渲染，不再等待网络请求。数据更新由后台事件或手动刷新触发。
        if (viewName === 'binding') {
            UI.renderBindingView();
        } else if (viewName === 'manage') {
            UI.renderManageView();
        } else if (viewName === 'editor') {
            // 检查当前书名是否有效（可能在管理界面被删除了）
            if (STATE.currentBookName && !STATE.allBookNames.includes(STATE.currentBookName)) {
                STATE.currentBookName = null;
                STATE.entries = [];
                UI.renderList();
            }
            // 重新渲染头部和列表以确保显示最新状态
            UI.renderBookSelector();
            UI.updateHeaderInfo();
        }
    },

    async loadBook(name) {
        if (!name) return;
        STATE.currentBookName = name;
        try {
            STATE.entries = await API.loadBook(name);

            // --- [新增] 加载时自动在内存中排序 ---
            // 这确保了打开书本时，视觉顺序与上下文执行顺序一致
            STATE.entries.sort((a, b) => {
                const scoreA = this.getEntrySortScore(a);
                const scoreB = this.getEntrySortScore(b);
                if (scoreA !== scoreB) return scoreB - scoreA;
                return (a.order ?? 0) - (b.order ?? 0) || a.uid - b.uid;
            });
            // -----------------------------------

            UI.updateHeaderInfo();
            UI.renderList();
            const selector = document.getElementById('wb-book-selector');
            if (selector) selector.value = name;
        } catch (e) {
            console.error("Load book failed", e);
            toastr.error(`无法加载世界书 "${name}"`);
        }
    },

    updateEntry(uid, updater) {
        const entry = STATE.entries.find(e => e.uid === uid);
        if (!entry) return;
        updater(entry);

        UI.updateCardStatus(uid);
        UI.renderGlobalStats();

        if (STATE.debouncer) clearTimeout(STATE.debouncer);
        STATE.debouncer = setTimeout(() => {
            API.saveBookEntries(STATE.currentBookName, STATE.entries);
        }, 300);
    },
    
    async addNewEntry() {
        if (!STATE.currentBookName) return toastr.warning("请先选择一本世界书");

        // 使用 ST 原生方法获取可用 UID (需要通过 context 获取)
        // 如果 context 中没有直接暴露 getFreeWorldEntryUid，我们这里简单模拟一个不冲突的
        // 更好的是：读取当前 max uid + 1
        const maxUid = STATE.entries.reduce((max, e) => Math.max(max, Number(e.uid) || 0), -1);
        const newUid = maxUid + 1;

        const newEntry = {
            uid: newUid,
            comment: '新建条目', // 原生字段: comment
            disable: false,      // 原生字段: disable (false = enabled)
            content: '',
            constant: false,     // 原生字段: constant
            key: [],             // 原生字段: key
            order: 1,            // 默认顺序改为1，配合数组前置，确保新建时出现在顶部
            position: 0,         // 原生字段: 1 (after_char_def)
            depth: 4,            // 原生字段: depth
            probability: 100,
            selective: true,
            // 其他字段保持默认
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

            // 1. 按"有效深度分数"降序排列
            if (scoreA !== scoreB) return scoreB - scoreA;

            // 2. 分数相同时，按 Order 升序 (Order 越小越靠前)
            const orderA = a.order ?? 0;
            const orderB = b.order ?? 0;
            if (orderA !== orderB) return orderA - orderB;

            // 3. 最后按 UID 升序兜底
            return a.uid - b.uid;
        });

        UI.renderList();
        API.saveBookEntries(STATE.currentBookName, STATE.entries);

        // 获取当前AN深度用于提示
        const context = getContext();
        const anDepth = (context.chatMetadata?.note_depth) ?? (context.extensionSettings?.note?.defaultDepth) ?? 4;
        toastr.success(`已按上下文逻辑重排 (当前AN深度: ${anDepth})`);
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
            // 1. Primary 世界书 (使用 setCharBindings 包装器)
            await setCharBindings('primary', charPrimary || '', !!charPrimary);

            // 2. Auxiliary 世界书 (优化：直接调用 ST 核心 API 进行全量保存，避免循环调用导致竞态条件)
            const context = getContext();
            const charId = context.characterId;
            if (charId || charId === 0) {
                const charAvatar = context.characters[charId]?.avatar;
                // 获取标准文件名
                const charFileName = getCharaFilename(null, { manualAvatarKey: charAvatar });
                // 一次性写入新的列表，替代之前的循环增删
                charSetAuxWorlds(charFileName, charAdditional);
            }

            // 3. Global 世界书 (修复：this -> API)
            const currentGlobal = await API.getGlobalBindings(); // [Fix] 修复作用域错误

            // 计算差异，只对变更项调用指令
            const toRemove = currentGlobal.filter(b => !globalBooks.includes(b));
            const toAdd = globalBooks.filter(b => !currentGlobal.includes(b));

            // 执行解绑
            for (const book of toRemove) {
                await setCharBindings('global', book, false);
            }
            // 执行绑定
            for (const book of toAdd) {
                await setCharBindings('global', book, true);
            }

            // 4. Chat 世界书
            await setCharBindings('chat', chatBook || '', !!chatBook);

            // 刷新上下文以更新 UI
            await this.refreshAllContext();
            toastr.success("绑定设置已保存");
        } catch (e) {
            console.error(e);
            toastr.error('保存失败: ' + e.message);
        }
    },

    // --- 辅助 ---
    getTokenCount(text) {
        if (!text) return 0;
        try {
            // ST extension context exposes tokenizers
            const ctx = getContext();
            if (ctx.getTokenCount) return ctx.getTokenCount(text); 
            // Fallback for older ST or async only
        } catch (e) {}
        return Math.ceil(text.length / 3);
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

    // --- Meta & Manage ---
    async updateMeta(bookName, updater) {
        if (!STATE.metadata[bookName]) {
            STATE.metadata[bookName] = { group: '', note: '' };
        }
        updater(STATE.metadata[bookName]);
        await API.saveMetadata(STATE.metadata);
    },
    async setBookGroup(bookName, groupName) {
        await this.updateMeta(bookName, (meta) => { meta.group = groupName; });
        UI.renderManageView();
    },
    updateNote(bookName, note) {
        this.updateMeta(bookName, (meta) => { meta.note = note; });
    },
    async togglePin(bookName) {
        await this.updateMeta(bookName, (meta) => { meta.pinned = !meta.pinned; });
        UI.renderManageView();
    },
    async deleteBookDirectly(bookName) {
        if (!confirm(`确定要永久删除世界书 "${bookName}" 吗？`)) return;
        try {
            await API.deleteWorldbook(bookName);
            if (STATE.currentBookName === bookName) {
                STATE.currentBookName = null;
                STATE.entries = [];
            }
            await this.refreshAllContext();
            UI.renderManageView();
        } catch (e) {
            toastr.error("删除失败: " + e.message);
        }
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
                if (currentChar === targetCharName) {
                    await setCharBindings('primary', bookName, false);
                }
                await this.refreshAllContext();
                UI.renderManageView();
            } catch (e) {
                toastr.error("解绑失败: " + e.message);
            }
        } else {
            if (!currentChar) return toastr.warning("当前没有加载任何角色，无法绑定。");
            if (!confirm(`确定要将世界书 "${bookName}" 绑定为当前角色 "${currentChar}" 的主要世界书吗？`)) return;
            try {
                await setCharBindings('primary', bookName, true);
                await this.refreshAllContext();
                UI.renderManageView();
            } catch (e) {
                toastr.error("绑定失败: " + e.message);
            }
        }
    },

    // --- Actions ---
    async actionImport() {
        document.getElementById('wb-import-file').click();
    },
    async actionHandleImport(file) {
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async (e) => {
            try {
                const content = JSON.parse(e.target.result);
                // Handle different formats: standard ST object or array
                let entries = content.entries ? Object.values(content.entries) : content;
                if (!Array.isArray(entries)) entries = []; // Fallback

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
            } catch (err) {
                console.error(err);
                toastr.error("导入失败: " + err.message);
            }
        };
        reader.readAsText(file);
    },
    async actionExport() {
        if (!STATE.currentBookName) return toastr.warning("请先选择一本世界书");
        try {
            const entries = await API.loadBook(STATE.currentBookName);
            // Export as ST Standard Object Format
            const entriesObj = {};
            entries.forEach(entry => {
                entriesObj[entry.uid] = entry;
            });
            const exportData = { entries: entriesObj };
            const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${STATE.currentBookName}.json`;
            a.click();
            URL.revokeObjectURL(url);
        } catch (e) {
            toastr.error("导出失败: " + e.message);
        }
    },
    async actionExportTxt() {
        if (!STATE.currentBookName) return toastr.warning("请先选择一本世界书");

        // 创建临时模态框供用户选择
        const overlay = document.createElement('div');
        overlay.className = 'wb-sort-modal-overlay';
        overlay.style.zIndex = '25000'; // 确保在顶层
        overlay.innerHTML = `
            <div class="wb-sort-modal" style="width:400px; height:auto; border-radius:12px;">
                <div class="wb-sort-header">
                    <span><i class="fa-solid fa-file-lines"></i> 导出世界书为TXT</span>
                    <div style="cursor:pointer" class="wb-close-btn"><i class="fa-solid fa-xmark"></i></div>
                </div>
            <!-- 修改：添加 flex column 和 display flex 以启用 gap，去除按钮内联背景色 -->
                <div class="wb-sort-body" style="display:flex; flex-direction:column; gap:15px; padding:20px; background:#fff;">
                    <button class="wb-btn-rect" style="width:100%;font-size:0.95em;" data-type="all-title">导出所有条目 (含标题)</button>
                    <button class="wb-btn-rect" style="width:100%;font-size:0.95em;" data-type="all-no-title">导出所有条目 (不含标题)</button>
                    <button class="wb-btn-rect" style="width:100%;font-size:0.95em;" data-type="enabled-title">仅导出已启用条目 (含标题)</button>
                    <button class="wb-btn-rect" style="width:100%;font-size:0.95em;" data-type="enabled-no-title">仅导出已启用条目 (不含标题)</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);
        UI.setupModalPositioning(overlay.querySelector('.wb-sort-modal'), overlay);

        // 处理导出逻辑的内部函数
        const processExport = (type) => {
            try {
                // 1. 筛选数据
                let targetEntries = [...STATE.entries];
                if (type.startsWith('enabled')) {
                    targetEntries = targetEntries.filter(e => !e.disable);
                }

                // 2. 排序 (使用统一的上下文优先级算法)
                targetEntries.sort((a, b) => {
                    const scoreA = Actions.getEntrySortScore(a);
                    const scoreB = Actions.getEntrySortScore(b);
                    if (scoreA !== scoreB) return scoreB - scoreA; // 分数高在前
                    return (a.order ?? 0) - (b.order ?? 0) || a.uid - b.uid;
                });

                if (targetEntries.length === 0) {
                    toastr.warning("没有符合条件的条目可导出");
                    return;
                }

                // 3. 构建内容
                // 修复：原逻辑 type.includes('-title') 对 'all-no-title' 也会返回 true
                const includeTitle = !type.includes('no-title');
                let txtContent = "";
                targetEntries.forEach(entry => {
                    const title = entry.comment || '无标题条目';
                    const content = entry.content || '';

                    if (includeTitle) {
                        txtContent += `#### ${title}\n${content}\n\n`;
                    } else {
                        txtContent += `${content}\n\n`;
                    }
                });

                // 4. 生成文件名
                const scopeName = type.startsWith('enabled') ? '仅启用条目' : '所有条目';
                const formatName = includeTitle ? '含条目标题' : '不含条目标题';
                const fileName = `${STATE.currentBookName}_${scopeName}_${formatName}.txt`;

                // 5. 触发下载
                const blob = new Blob([txtContent], { type: 'text/plain' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = fileName;
                a.click();
                URL.revokeObjectURL(url);

                toastr.success(`导出成功: ${fileName}`);
            } catch (e) {
                console.error(e);
                toastr.error("导出失败: " + e.message);
            }
        };

        // 绑定事件
        overlay.querySelector('.wb-close-btn').onclick = () => overlay.remove();
        overlay.querySelectorAll('button').forEach(btn => {
            btn.onclick = () => {
                processExport(btn.dataset.type);
                overlay.remove();
            };
        });
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
        } catch (e) {
            toastr.error("创建失败: " + e.message);
        }
    },
    async actionDelete() {
        if (!STATE.currentBookName) return;
        if (!confirm(`确定要永久删除世界书 "${STATE.currentBookName}" 吗？`)) return;
        try {
            await API.deleteWorldbook(STATE.currentBookName);
            STATE.currentBookName = null;
            STATE.entries = [];
            await this.refreshAllContext();
            await this.init();
        } catch (e) {
            toastr.error("删除失败: " + e.message);
        }
    },
    async actionRename() {
        if (!STATE.currentBookName) return;
        const newName = prompt("重命名世界书为:", STATE.currentBookName);
        if (!newName || newName === STATE.currentBookName) return;
        if (STATE.allBookNames.includes(newName)) return toastr.warning("目标名称已存在");
        try {
            await API.renameWorldbook(STATE.currentBookName, newName);
            await this.refreshAllContext();
            await this.loadBook(newName);
        } catch (e) {
            toastr.error("重命名失败: " + e.message);
        }
    },
    
    // --- Global Config ---
    getGlobalConfig() {
        const allMeta = API.getMetadata() || {};
        const config = allMeta['__GLOBAL_CONFIG__'] || {};
        if (config.deleteWbWithChar === undefined) config.deleteWbWithChar = true;
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

        // Use standard ST event
        es.on(et.CHARACTER_DELETED, async (data) => {
             const config = this.getGlobalConfig();
             if (!config.deleteWbWithChar) return;

             // [修复1] 正确的数据解构：ST 传递的是 { id, character } 对象
             // data.character.name 是最准确的来源
             const charName = data.character?.name || data.name;
             if (!charName) return;

             // [修复2] 不使用缓存 STATE.boundBooksSet，因为在面板关闭时它不会更新
             // 删除操作频率低，直接获取最新的实时绑定关系以确保准确
             const map = await API.getAllBoundBookNames();

             let bookName = null;
             for (const [wb, chars] of Object.entries(map)) {
                 if (chars.includes(charName)) {
                     bookName = wb;
                     break;
                 }
             }

             if (bookName) {
                 UI.showDeleteWbConfirmModal(bookName, async () => {
                     await API.deleteWorldbook(bookName);
                 }, async () => {
                     await this.saveGlobalConfig({ deleteWbWithChar: false });
                     if (STATE.currentView === 'manage') UI.renderManageView();
                 });
             }
        });
    },

    // --- Analysis Helpers ---
    getTokenCount(text) { 
        // Re-implementing with ST context
        if (!text) return 0;
        try {
             return getContext().getTokenCount(text);
        } catch(e) { return Math.ceil(text.length / 3); }
    }
};

const UI = {
    // 动态定位核心
    centerDialog(el) {
        if (!el) return;
        const winW = window.innerWidth;
        const winH = window.innerHeight;
        const elW = el.offsetWidth;
        const elH = el.offsetHeight;
        el.style.left = Math.max(0, (winW - elW) / 2) + 'px';
        el.style.top = Math.max(0, (winH - elH) / 2) + 'px';
        el.style.position = 'fixed';
        el.style.margin = '0';
        el.style.transform = 'none'; // 强制清除 CSS 的 transform 居中，防止定位冲突
    },
    setupModalPositioning(el, overlay) {
        requestAnimationFrame(() => this.centerDialog(el));
        const resizeHandler = () => this.centerDialog(el);
        window.addEventListener('resize', resizeHandler);
        const originalRemove = overlay.remove.bind(overlay);
        overlay.remove = () => {
            window.removeEventListener('resize', resizeHandler);
            originalRemove();
        };
    },

    async open() {
        if (document.getElementById(CONFIG.id)) return;

        // 必须等待上下文刷新完成，才能正确判断当前角色的绑定
        try {
            await Actions.refreshAllContext();
        } catch (e) {
            console.error("Auto-refresh failed:", e);
        }

        const panel = document.createElement('div');
        panel.id = CONFIG.id;
        panel.innerHTML = `
            <div class="wb-header-bar">
                <div class="wb-tabs">
                    <div class="wb-tab active" data-tab="editor"><i class="fa-solid fa-pen-to-square"></i> 编辑世界书</div>
                    <div class="wb-tab" data-tab="binding"><i class="fa-solid fa-link"></i> 绑定世界书</div>
                    <div class="wb-tab" data-tab="manage"><i class="fa-solid fa-list-check"></i> 管理世界书</div>
                </div>
                <div id="wb-close" class="wb-header-close" title="关闭"><i class="fa-solid fa-xmark"></i></div>
            </div>

            <div class="wb-content">
                <!-- Loading Overlay -->
                <div id="wb-loading-layer" style="position:absolute;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:100;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(2px);">
                    <div style="font-size:2em;color:#fff"><i class="fa-solid fa-circle-notch fa-spin"></i></div>
                </div>
                <!-- 视图 1: 编辑器 -->
                <div id="wb-view-editor" class="wb-view-section">
                    <div class="wb-book-bar">
                        <select id="wb-book-selector" style="flex:1;">
                            <option>加载中...</option>
                        </select>
                        <div class="wb-menu-wrapper">
                            <button class="wb-btn-circle" title="分析与统计" id="btn-wb-analysis">
                                <i class="fa-solid fa-coins"></i>
                            </button>
                            <div class="wb-menu-dropdown" id="wb-analysis-menu">
                                <div class="wb-menu-item" data-type="stats"><i class="fa-solid fa-chart-pie"></i> 世界书统计与分析</div>
                                <div class="wb-menu-item" data-type="context"><i class="fa-solid fa-align-left"></i> 世界书实际上下文</div>
                                <div class="wb-menu-item" data-type="export_txt"><i class="fa-solid fa-file-lines"></i> 导出世界书为TXT</div>
                            </div>
                        </div>
                        <div class="wb-menu-wrapper">
                            <button class="wb-btn-circle" title="更多操作" id="btn-wb-menu-trigger">
                                <i class="fa-solid fa-magic-wand-sparkles interactable"></i>
                            </button>
                            <div class="wb-menu-dropdown" id="wb-main-menu">
                                <div class="wb-menu-item" data-action="import"><i class="fa-solid fa-file-import"></i> 导入世界书</div>
                                <div class="wb-menu-item" data-action="export"><i class="fa-solid fa-file-export"></i> 导出世界书</div>
                                <!-- 已移除 export_txt -->
                                <div class="wb-menu-item" data-action="create"><i class="fa-solid fa-plus"></i> 新建世界书</div>
                                <div class="wb-menu-item" data-action="rename"><i class="fa-solid fa-pen"></i> 重命名世界书</div>
                                <div class="wb-menu-item danger" data-action="delete"><i class="fa-solid fa-trash"></i> 删除世界书</div>
                            </div>
                        </div>
                        <input type="file" id="wb-import-file" accept=".json,.wb" style="display:none">
                    </div>
                    <div class="wb-stat-line">
                        <div class="wb-stat-group">
                            <div id="wb-warning-stat" class="wb-warning-badge hidden" title="点击查看问题条目">
                                <i class="fa-solid fa-circle-exclamation"></i> <span id="wb-warning-count">0</span>
                            </div>
                            <div class="wb-stat-item" id="wb-display-count">0 条目</div>
                        </div>
                    </div>
                    <div class="wb-tool-bar">
                        <input class="wb-input-dark" id="wb-search-entry" style="flex:1; width:100%; border-radius:15px; padding-left:15px;" placeholder="搜索条目...">
                        <button class="wb-btn-circle interactable" id="btn-group-sort" title="分组排序管理">
                            <i class="fa-solid fa-arrow-down-9-1"></i>
                        </button>
                        <button class="wb-btn-circle" id="btn-sort-priority" title="列表按优先级重排"><i class="fa-solid fa-filter"></i></button>
                        <button class="wb-btn-circle" id="btn-add-entry" title="新建条目"><i class="fa-solid fa-plus"></i></button>
                    </div>
                    <div class="wb-list" id="wb-entry-list"></div>
                </div>

                <!-- 视图 2: 绑定管理 -->
                <div id="wb-view-binding" class="wb-view-section wb-hidden">
                    <div class="wb-bind-grid">
                        <div class="wb-bind-card">
                            <div class="wb-bind-title"><span><i class="fa-solid fa-user-tag"></i> 角色世界书</span></div>
                            <div class="wb-bind-label"> 主要世界书</div>
                            <div style="position:relative"><select id="wb-bind-char-primary" style="width:100%"></select></div>
                            <div class="wb-bind-label">附加世界书</div>
                            <div class="wb-scroll-list" id="wb-bind-char-list"></div>
                        </div>
                        <div class="wb-bind-card">
                            <div class="wb-bind-title"><span><i class="fa-solid fa-globe"></i> 全局世界书</span></div>
                            <div class="wb-scroll-list" id="wb-bind-global-list"></div>
                        </div>
                        <div class="wb-bind-card">
                            <div class="wb-bind-title"><span><i class="fa-solid fa-comments"></i> 聊天世界书</span></div>
                            <div style="position:relative"><select id="wb-bind-chat" style="width:100%"></select></div>
                        </div>
                    </div>
                    <div id="wb-footer-info" class="wb-footer-info"></div>
                </div>

                <!-- 视图 3: 管理 -->
                <div id="wb-view-manage" class="wb-view-section wb-hidden">
                    <div class="wb-manage-container">
                        <div class="wb-tool-bar">
                            <input class="wb-input-dark" id="wb-manage-search" style="width:100%;border-radius:15px;padding-left:15px" placeholder="🔍 搜索世界书名称或备注...">
                        </div>
                        <div class="wb-manage-content" id="wb-manage-content"></div>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(panel);

        const $ = (sel) => panel.querySelector(sel);
        const $$ = (sel) => panel.querySelectorAll(sel);

        $('#wb-close').onclick = () => panel.remove();
        $$('.wb-tab').forEach(el => el.onclick = () => Actions.switchView(el.dataset.tab));
        // 使用 addEventListener，确保与 applyCustomDropdown 中的 UI 更新逻辑共存
        $('#wb-book-selector').addEventListener('change', (e) => Actions.loadBook(e.target.value));
        $('#wb-search-entry').oninput = (e) => UI.renderList(e.target.value);
        $('#btn-add-entry').onclick = () => Actions.addNewEntry();
        $('#btn-group-sort').onclick = () => UI.openSortingModal();
        $('#btn-sort-priority').onclick = () => Actions.sortByPriority();
        
        // Menus
        const analysisBtn = $('#btn-wb-analysis');
        const analysisMenu = $('#wb-analysis-menu');
        analysisBtn.onclick = (e) => {
            e.stopPropagation();
            const isShow = analysisMenu.classList.contains('show');
            document.querySelectorAll('.wb-menu-dropdown.show').forEach(el => el.classList.remove('show'));
            if (!isShow) analysisMenu.classList.add('show');
        };
        analysisMenu.querySelectorAll('.wb-menu-item').forEach(item => {
            item.onclick = (e) => {
                e.stopPropagation();
                analysisMenu.classList.remove('show');
                const type = item.dataset.type;
                if (type === 'stats') UI.openAnalysisModal();
                else if (type === 'context') UI.openContextPreviewModal();
                else if (type === 'export_txt') Actions.actionExportTxt();
            };
        });

        const menuTrigger = $('#btn-wb-menu-trigger');
        const menuDropdown = $('#wb-main-menu');
        menuTrigger.onclick = (e) => {
            e.stopPropagation();
            const isShow = menuDropdown.classList.contains('show');
            document.querySelectorAll('.wb-menu-dropdown, .wb-gr-dropdown').forEach(el => el.classList.remove('show'));
            if (!isShow) menuDropdown.classList.add('show');
        };
        menuDropdown.querySelectorAll('.wb-menu-item').forEach(item => {
            item.onclick = async (e) => {
                e.stopPropagation();
                menuDropdown.classList.remove('show');
                const action = item.dataset.action;
                if (action === 'import') Actions.actionImport();
                else if (action === 'export') Actions.actionExport();
                else if (action === 'create') Actions.actionCreateNew();
                else if (action === 'rename') Actions.actionRename();
                else if (action === 'delete') Actions.actionDelete();
            };
        });

        document.addEventListener('click', (e) => {
            if (menuDropdown.classList.contains('show') && !menuTrigger.contains(e.target) && !menuDropdown.contains(e.target)) menuDropdown.classList.remove('show');
            if (analysisMenu.classList.contains('show') && !analysisBtn.contains(e.target) && !analysisMenu.contains(e.target)) analysisMenu.classList.remove('show');
        });

        const fileInput = $('#wb-import-file');
        fileInput.onchange = (e) => {
            if (e.target.files.length > 0) {
                Actions.actionHandleImport(e.target.files[0]);
                fileInput.value = '';
            }
        };

        $('#wb-entry-list').addEventListener('wb-reorder', (e) => Actions.reorderEntry(e.detail.from, e.detail.to));
        $('#wb-manage-search').oninput = (e) => UI.renderManageView(e.target.value);

        // 直接渲染已预加载的数据
        const loader = document.getElementById('wb-loading-layer');

        // 渲染基础组件
        UI.renderBookSelector();
        UI.updateHeaderInfo();

        // 智能选中逻辑：优先选中角色绑定的主要世界书
        const charPrimary = STATE.bindings.char.primary;
        if (charPrimary && STATE.allBookNames.includes(charPrimary)) {
            // 如果有绑定书且存在，优先加载它
            STATE.currentBookName = charPrimary;
            await Actions.loadBook(charPrimary);
        } else if (STATE.currentBookName) {
            // 如果之前有选中状态，渲染它
            UI.renderList();
        } else {
            // 否则回退到第一本
            if (STATE.allBookNames.length > 0) {
                const firstBook = STATE.allBookNames[0];
                STATE.currentBookName = firstBook;
                await Actions.loadBook(firstBook);
            } else {
                UI.renderList(); // 渲染空列表
            }
        }

        // 再次更新头部选择器状态，确保 UI 与数据一致
        UI.updateHeaderInfo();

        // 根据当前视图刷新特定部分
        Actions.switchView(STATE.currentView);

        // 关闭 Loading
        if (loader) loader.style.display = 'none';
    },

    renderBookSelector() {
        const selector = document.getElementById('wb-book-selector');
        if (!selector) return;
        const { char, global, chat } = STATE.bindings;
        const allNames = STATE.allBookNames;
        const charBooks = new Set([char.primary, ...char.additional].filter(Boolean));
        const globalBooks = new Set(global);
        const chatBook = chat;

        let html = '';

        // 1. 主要世界书 (Primary)
        if (char.primary) {
            html += `<optgroup label="主要世界书">`;
            html += `<option value="${char.primary}">${char.primary}</option>`;
            html += `</optgroup>`;
        }

        // 2. 附加世界书 (Additional) - 过滤掉可能重复的主要世界书
        const additionalBooks = char.additional.filter(name => name && name !== char.primary);
        if (additionalBooks.length > 0) {
            html += `<optgroup label="附加世界书">`;
            additionalBooks.forEach(name => html += `<option value="${name}">${name}</option>`);
            html += `</optgroup>`;
        }
        if (globalBooks.size > 0) {
            html += `<optgroup label="全局启用">`;
            globalBooks.forEach(name => html += `<option value="${name}">${name}</option>`);
            html += `</optgroup>`;
        }
        if (chatBook) {
            html += `<optgroup label="当前聊天"><option value="${chatBook}">${chatBook}</option></optgroup>`;
        }
        
        html += `<optgroup label="其他">`;
        allNames.forEach(name => html += `<option value="${name}">${name}</option>`);
        html += `</optgroup>`;

        selector.innerHTML = html;
        if (STATE.currentBookName) selector.value = STATE.currentBookName;
        this.applyCustomDropdown('wb-book-selector');
    },

    renderBindingView() {
        const allNames = STATE.allBookNames;
        const { char, global, chat } = STATE.bindings;
        const view = document.getElementById('wb-view-binding');
        if (!view) return;

        const createOpts = (selectedVal) => {
            let html = '<option value="">(无)</option>';
            allNames.forEach(name => {
                const sel = name === selectedVal ? 'selected' : '';
                html += `<option value="${name}" ${sel}>${name}</option>`;
            });
            return html;
        };

        const createMultiSelect = (containerSelector, initialSelectedArray, dataClass) => {
            const container = view.querySelector(containerSelector);
            if (!container) return;
            container.innerHTML = '';
            container.className = 'wb-multi-select';
            const selectedSet = new Set(initialSelectedArray.filter(n => allNames.includes(n)));
            const dom = document.createElement('div');
            dom.innerHTML = `
                <div class="wb-ms-tags"></div>
                <div class="wb-ms-dropdown">
                    <div class="wb-ms-search"><input type="text" placeholder="搜索选项..."></div>
                    <div class="wb-ms-list"></div>
                </div>
            `;
            container.appendChild(dom);
            const tagsEl = dom.querySelector('.wb-ms-tags');
            const dropEl = dom.querySelector('.wb-ms-dropdown');
            const inputEl = dom.querySelector('input');
            const listEl = dom.querySelector('.wb-ms-list');

            const refresh = () => {
                tagsEl.innerHTML = '';
                if (selectedSet.size === 0) tagsEl.innerHTML = `<div class="wb-ms-placeholder">点击选择世界书...</div>`;
                else {
                    selectedSet.forEach(name => {
                        const tag = document.createElement('div');
                        tag.className = 'wb-ms-tag';
                        tag.dataset.val = name;
                        tag.dataset.bindType = dataClass;
                        tag.innerHTML = `<span>${name}</span><span class="wb-ms-tag-close">×</span>`;
                        tag.querySelector('.wb-ms-tag-close').onclick = (e) => {
                            e.stopPropagation();
                            selectedSet.delete(name);
                            refresh();
                            Actions.saveBindings();
                        };
                        tagsEl.appendChild(tag);
                    });
                }
                listEl.innerHTML = '';
                const available = allNames.filter(n => !selectedSet.has(n));
                if (available.length === 0) listEl.innerHTML = `<div style="padding:10px;color:#666;text-align:center">没有更多选项</div>`;
                else {
                    available.forEach(name => {
                        const item = document.createElement('div');
                        item.className = 'wb-ms-item';
                        item.textContent = name;
                        item.onclick = () => {
                            selectedSet.add(name);
                            inputEl.value = '';
                            refresh();
                            Actions.saveBindings();
                        };
                        listEl.appendChild(item);
                    });
                    filterList(inputEl.value);
                }
            };
            const filterList = (term) => {
                const items = listEl.querySelectorAll('.wb-ms-item');
                const lower = term.toLowerCase();
                items.forEach(item => {
                    if (item.textContent.toLowerCase().includes(lower)) item.classList.remove('hidden');
                    else item.classList.add('hidden');
                });
            };
            tagsEl.onclick = () => {
                const isVisible = dropEl.classList.contains('show');
                document.querySelectorAll('.wb-ms-dropdown.show').forEach(el => el.classList.remove('show'));
                if (!isVisible) { dropEl.classList.add('show'); inputEl.focus(); }
            };
            inputEl.oninput = (e) => filterList(e.target.value);
            document.addEventListener('click', (e) => { if (!dom.contains(e.target)) dropEl.classList.remove('show'); });
            refresh();
        };

        view.querySelector('#wb-bind-char-primary').innerHTML = createOpts(char.primary);
        createMultiSelect('#wb-bind-char-list', char.additional, 'wb-bind-char-add');
        createMultiSelect('#wb-bind-global-list', global, 'wb-bind-global');
        view.querySelector('#wb-bind-chat').innerHTML = createOpts(chat);

        ['wb-bind-char-primary', 'wb-bind-chat'].forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.onchange = () => Actions.saveBindings();
                this.applyCustomDropdown(id);
            }
        });
    },

    updateHeaderInfo() {
        this.renderGlobalStats();
        const selector = document.getElementById('wb-book-selector');
        if (selector && STATE.currentBookName) selector.value = STATE.currentBookName;

        const footerEl = document.getElementById('wb-footer-info');
        if (footerEl) {
            const context = getContext();
            const charId = context.characterId;
            const charName = (context.characters && context.characters[charId]) ? context.characters[charId].name : '无';
            const avatarImgEl = document.getElementById('avatar_load_preview');
            const avatarHtml = (avatarImgEl && avatarImgEl.src) ? `<img src="${avatarImgEl.src}" class="wb-footer-avatar">` : '';
            const chatName = context.chatId ? String(context.chatId).replace(/\.json$/i, '') : '无';
            footerEl.innerHTML = `<div>当前角色为${avatarHtml}<strong>${charName}</strong></div><div>当前聊天为 <strong>${chatName}</strong></div>`;
        }
    },

    getWarningList() {
        return STATE.entries.filter(entry => entry.disable === false && entry.constant === false && !(entry.key?.length > 0));
    },

    renderGlobalStats() {
        const countEl = document.getElementById('wb-display-count');
        const warningEl = document.getElementById('wb-warning-stat');
        const warningNumEl = document.getElementById('wb-warning-count');
        if (countEl) {
            let blueTokens = 0, greenTokens = 0;
            STATE.entries.forEach(entry => {
                if (entry.disable === false) {
                    const t = Actions.getTokenCount(entry.content);
                    if (entry.constant === true) blueTokens += t;
                    else greenTokens += t;
                }
            });
            countEl.innerHTML = `<span style="margin-right:5px">${STATE.entries.length} 条目 | ${blueTokens + greenTokens} Tokens</span><span style="font-size:0.9em; color:#6b7280">( <span class="wb-text-blue" title="蓝灯">${blueTokens}</span> + <span class="wb-text-green" title="绿灯">${greenTokens}</span> )</span>`;
        }
        if (warningEl && warningNumEl) {
            const warnings = this.getWarningList();
            if (warnings.length > 0) {
                warningEl.classList.remove('hidden');
                warningNumEl.textContent = warnings.length;
                warningEl.onclick = () => UI.openWarningListModal();
            } else warningEl.classList.add('hidden');
        }
    },

    updateCardStatus(uid) {
        const entry = STATE.entries.find(e => e.uid === uid);
        const card = document.querySelector(`.wb-card[data-uid="${uid}"]`);
        if (!entry || !card) return;

        card.classList.toggle('disabled', entry.disable);
        const tokenEl = card.querySelector('.wb-token-display');
        if (tokenEl) tokenEl.textContent = Actions.getTokenCount(entry.content);
        const warnContainer = card.querySelector('.wb-warning-container');
        if (warnContainer) {
            const showWarning = entry.disable === false && entry.constant === false && !(entry.key?.length > 0);
            // 需求4: 确保动态更新时也包含 tooltip
            warnContainer.innerHTML = showWarning ? `<i class="fa-solid fa-circle-exclamation" style="color:#ef4444; margin-right:6px; cursor:help;" data-wb-tooltip="警告：绿灯条目已启用但未设置关键词，将无法触发"></i>` : '';
        }
    },

    renderList(filterText = '') {
        const list = document.getElementById('wb-entry-list');
        if (!list) return;
        list.innerHTML = '';
        const term = filterText.toLowerCase();
        STATE.entries.forEach((entry, index) => {
            // 使用 comment 进行过滤
            const name = entry.comment || '';
            if (term && !name.toLowerCase().includes(term)) return;
            const card = this.createCard(entry, index);
            list.appendChild(card);
            this.applyCustomDropdown(`wb-pos-${entry.uid}`);
        });
    },

    createCard(entry, index) {
        // --- 核心修改：适配 ST 原生字段 ---
        // 字段映射：
        // entry.name -> entry.comment
        // entry.enabled -> !entry.disable
        // entry.strategy.type === 'constant' -> entry.constant
        // entry.strategy.keys -> entry.key
        // entry.position.type -> entry.position (int)
        // entry.position.order -> entry.order
        // entry.position.depth -> entry.depth

        // 获取当前 AN 深度用于显示提示
        const context = getContext();
        const currentAnDepth = (context.chatMetadata?.note_depth) ?? (context.extensionSettings?.note?.defaultDepth) ?? 4;

        const isEnabled = !entry.disable;
        const isConstant = !!entry.constant;
        const keys = entry.key || [];

        const card = document.createElement('div');
        // 逻辑：如果禁用 -> disabled; 否则如果常驻 -> type-blue; 否则 -> type-green
        let typeClass = '';
        if (isEnabled) {
            typeClass = isConstant ? 'type-blue' : 'type-green';
        }

        card.className = `wb-card ${isEnabled ? '' : 'disabled'} ${typeClass}`;
        card.dataset.uid = entry.uid;
        card.dataset.index = index;
        card.draggable = false;

        const escapeHtml = (str) => (str || '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#039;'}[m]));

        // 使用 WI_POSITION_MAP 将整数转为字符串用于 UI 判断
        const curPosInt = typeof entry.position === 'number' ? entry.position : 1;
        const curPosStr = WI_POSITION_MAP[curPosInt] || 'after_character_definition';

        const corePositions = ['before_character_definition', 'after_character_definition', 'at_depth'];
        const allPosOptions = [
            { v: 'before_character_definition', t: '角色定义之前' },
            { v: 'after_character_definition', t: '角色定义之后' },
            { v: 'before_example_messages', t: '示例消息之前' },
            { v: 'after_example_messages', t: '示例消息之后' },
            { v: 'before_author_note', t: `作者注释之前` },
            { v: 'after_author_note', t: `作者注释之后` },
            { v: 'at_depth', t: '@D' }
        ];

        const showCoreOnly = corePositions.includes(curPosStr);
        const hasKeys = keys.length > 0;
        const showWarning = isEnabled && !isConstant && !hasKeys;
        // 需求4: 悬浮显示具体警告文本
        const warningIcon = showWarning ? `<i class="fa-solid fa-circle-exclamation" style="color:#ef4444; margin-right:6px; cursor:help;" data-wb-tooltip="警告：绿灯条目已启用但未设置关键词，将无法触发"></i>` : '';

        let optionsHtml = '';
        allPosOptions.forEach(opt => {
            if (showCoreOnly && !corePositions.includes(opt.v)) return;
            const selected = opt.v === curPosStr ? 'selected' : '';
            // value 存的是字符串 key (如 'at_depth')，之后我们会转回 int
            optionsHtml += `<option value="${opt.v}" ${selected}>${opt.t}</option>`;
        });

        card.innerHTML = `
            <div class="wb-card-header">
                <div style="flex:1;display:flex;flex-direction:column;gap:8px">
                    <div class="wb-row">
                        <!-- 绑定到 comment -->
                        <input class="wb-inp-title inp-name" value="${escapeHtml(entry.comment)}" placeholder="条目名称 (Comment)">
                        <div class="wb-warning-container">${warningIcon}</div>
                        <i class="fa-solid fa-eye btn-preview" style="cursor:pointer;padding:5px;" title="编辑内容"></i>
                        <i class="fa-solid fa-trash btn-delete" style="cursor:pointer;padding:5px;margin-left:5px" title="删除条目"></i>
                    </div>
                    <div class="wb-row" style="width: 100%;">
                        <!-- 绑定到 disable -->
                        <div class="wb-ctrl-group"><label class="wb-switch"><input type="checkbox" class="inp-enable" ${isEnabled ? 'checked' : ''}><span class="wb-slider purple"></span></label></div>
                        <!-- 绑定到 constant -->
                        <div class="wb-ctrl-group"><label class="wb-switch"><input type="checkbox" class="inp-type" ${isConstant ? 'checked' : ''}><span class="wb-slider blue"></span></label></div>
                        <div class="wb-pos-wrapper">
                            <select id="wb-pos-${entry.uid}" class="wb-input-dark inp-pos" style="font-size:0.85em">${optionsHtml}</select>
                            <input type="number" class="wb-inp-num inp-pos-depth" style="display: ${curPosStr === 'at_depth' ? 'block' : 'none'};" placeholder="D" value="${entry.depth ?? 4}">
                        </div>
                        <!-- 顺序输入框：宽度改为 65px，添加 order-group 类 -->
                        <div class="wb-ctrl-group order-group" title="顺序"><span>顺序</span><input type="number" class="wb-inp-num inp-order" style="width:65px;height:24px;font-size:0.85em" value="${entry.order ?? 0}"></div>
                        <div class="wb-input-dark wb-token-display" title="Tokens">${Actions.getTokenCount(entry.content)}</div>
                    </div>
                </div>
            </div>
        `;

        const bind = (sel, evt, fn) => { const el = card.querySelector(sel); if(el) el.addEventListener(evt, fn); };

        bind('.inp-name', 'input', (e) => Actions.updateEntry(entry.uid, d => d.comment = e.target.value));

        bind('.inp-enable', 'change', (e) => {
            card.classList.toggle('disabled', !e.target.checked);
            Actions.updateEntry(entry.uid, d => d.disable = !e.target.checked);
        });

        bind('.inp-type', 'change', (e) => Actions.updateEntry(entry.uid, d => {
            d.constant = e.target.checked;
            // 切换为常驻时，选择性设为 false，反之亦然
            if (d.constant) d.selective = false;
            else d.selective = true;
        }));

        bind('.inp-pos', 'change', (e) => {
            const val = e.target.value; // string e.g., 'at_depth'
            const depthInput = card.querySelector('.inp-pos-depth');

            // 仅控制深度输入框的显示，不再触碰宽度，宽度全由 CSS 接管
            if (depthInput) {
                depthInput.style.display = val === 'at_depth' ? 'block' : 'none';
            }
            // 原有的触发器宽度调整代码已删除，以保证布局固定

            // 将字符串转回整数保存
            const intVal = WI_POSITION_MAP_REV[val] ?? 1;
            Actions.updateEntry(entry.uid, d => d.position = intVal);
        });

        bind('.inp-pos-depth', 'input', (e) => Actions.updateEntry(entry.uid, d => d.depth = Number(e.target.value)));
        bind('.inp-order', 'input', (e) => Actions.updateEntry(entry.uid, d => d.order = Number(e.target.value)));

        bind('.btn-delete', 'click', () => Actions.deleteEntry(entry.uid));
        bind('.btn-preview', 'click', (e) => UI.openContentPopup(entry, e.target));

        return card;
    },

    openContentPopup(entry, triggerBtn) {
        const old = document.getElementById('wb-content-popup-overlay');
        if (old) old.remove();

        const overlay = document.createElement('div');
        overlay.id = 'wb-content-popup-overlay';
        overlay.className = 'wb-modal-overlay';
        const popup = document.createElement('div');
        popup.className = 'wb-content-popup';

        let tempContent = entry.content || '';
        // 使用原生 key 数组
        let tempKeys = (entry.key || []).map(k => String(k).replace(/，/g, ',')).join(',');
        const escapeHtml = (str) => (str || '').replace(/[&<>\"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#039;'}[m]));

        popup.innerHTML = `
            <div class="wb-popup-header"><span>${entry.comment || '未命名条目'}</span></div>
            <input class="wb-popup-input-keys" placeholder="关键词 (逗号分隔)" value="${escapeHtml(tempKeys)}">
            <textarea class="wb-popup-textarea" placeholder="在此编辑内容...">${escapeHtml(tempContent)}</textarea>
            <div class="wb-popup-footer"><button class="wb-btn-black btn-cancel">取消</button><button class="wb-btn-black btn-save">保存</button></div>
        `;
        overlay.appendChild(popup);
        document.body.appendChild(overlay);
        // 恢复 JS 定位以解决移动端兼容性问题
        this.setupModalPositioning(popup, overlay);

        const keysInput = popup.querySelector('.wb-popup-input-keys');
        const textarea = popup.querySelector('.wb-popup-textarea');
        textarea.oninput = (e) => { tempContent = e.target.value; };
        keysInput.oninput = (e) => { tempKeys = e.target.value; };

        const close = () => overlay.remove();
        popup.querySelector('.btn-cancel').onclick = close;
        popup.querySelector('.btn-save').onclick = () => {
            Actions.updateEntry(entry.uid, d => d.content = tempContent);
            const finalKeys = tempKeys.replace(/，/g, ',').split(',').map(s => s.trim()).filter(Boolean);
            // 直接更新原生 key 字段
            Actions.updateEntry(entry.uid, d => { d.key = finalKeys; });
            UI.updateCardStatus(entry.uid);
            UI.renderGlobalStats();
            close();
        };
        overlay.onclick = (e) => { if (e.target === overlay) close(); };
    },

    /**
     * 自定义分组排序逻辑
     * 1. 优先排列系统保留关键字
     * 2. @D 分组按数字大小自然排序 (0 -> 1 -> 10)
     */
    compareGroupNames(a, b) {
        // 定义系统分组的固定顺序权重
        const systemOrder = {
            '角色定义之前': 10,
            '角色定义': 20,
            '角色定义之后': 30,
            '普通': 40,
            '[InitVar]1st': 45,
            '作者注释之前': 50,
            '作者注释': 60,
            '作者注释之后': 70
        };

        // 获取权重，默认为极大值（排在后面）
        const weightA = systemOrder[a] || 9999;
        const weightB = systemOrder[b] || 9999;

        // 如果两个都是系统分组，按权重排序
        if (weightA !== 9999 || weightB !== 9999) {
            return weightA - weightB;
        }

        // 处理 @D 分组：提取数字进行数值比较
        const isAD = (str) => str.startsWith('@D');

        if (isAD(a) && isAD(b)) {
            // 提取数字： "@D 10" -> 10
            const numA = parseInt(a.replace(/[^0-9]/g, '')) || 0;
            const numB = parseInt(b.replace(/[^0-9]/g, '')) || 0;
            // 数值越小越靠前，越大越靠后
            return numA - numB;
        }

        // 如果一个是 @D，另一个是未知普通组
        if (isAD(a)) return 1;
        if (isAD(b)) return -1;

        // 默认字符串排序
        return a.localeCompare(b);
    },

    renderManageView(filterText = '') {
        const container = document.getElementById('wb-manage-content');
        if (!container) return;
        const term = filterText.toLowerCase();
        const boundMap = STATE.boundBooksSet || {};
        const boundBookNames = new Set(Object.keys(boundMap));
        const groups = { '已绑定角色': [], '未绑定角色': [] };
        Actions.getExistingGroups().forEach(g => groups[g] = []);

        STATE.allBookNames.forEach(name => {
            const meta = STATE.metadata[name] || {};
            if (term && !name.toLowerCase().includes(term) && !(meta.note || '').toLowerCase().includes(term)) return;
            let gName = meta.group;
            if (!gName || gName === '未分组') gName = boundBookNames.has(name) ? '已绑定角色' : '未绑定角色';
            if (!groups[gName]) groups[gName] = [];
            groups[gName].push(name);
        });

        container.innerHTML = '';
        const renderGroup = (groupName, books) => {
            if (books.length === 0) return;
            books.sort((a, b) => {
                const pinA = STATE.metadata[a]?.pinned ? 1 : 0;
                const pinB = STATE.metadata[b]?.pinned ? 1 : 0;
                return pinB - pinA || a.localeCompare(b);
            });
            const groupDiv = document.createElement('div');
            groupDiv.className = 'wb-group';
            const isSystem = groupName === '已绑定角色' || groupName === '未绑定角色';

            // 修改：如果有搜索内容，或者是系统分组，或者（为了防止pin操作后折叠）默认都尝试展开，
            // 这里逻辑调整为：如果有搜索文本(term)，强制展开；否则保持原有逻辑但允许普通分组默认展开
            const shouldExpand = term.length > 0 || !isSystem;

            groupDiv.innerHTML = `<div class="wb-group-header ${shouldExpand ? 'expanded' : ''}"><span class="wb-group-title ${isSystem ? 'system' : ''}">${groupName}</span><div style="display:flex;align-items:center"><span class="wb-group-count">${books.length}</span><i class="fa-solid fa-chevron-right wb-group-arrow"></i></div></div><div class="wb-group-body ${shouldExpand ? 'show' : ''}"></div>`;
            const header = groupDiv.querySelector('.wb-group-header');
            const body = groupDiv.querySelector('.wb-group-body');
            header.onclick = () => { header.classList.toggle('expanded'); body.classList.toggle('show'); };
            
            books.forEach(bookName => {
                const meta = STATE.metadata[bookName] || {};
                const boundChars = boundMap[bookName] || [];
                const card = document.createElement('div');
                card.className = 'wb-manage-card';
                if (meta.pinned) card.style.borderLeft = `3px solid ${CONFIG.colors.accent}`;
                
                let iconsHtml = '';
                if (boundChars.length > 0) iconsHtml += `<div class="wb-icon-action link-bound" title="已绑定到: ${boundChars.join(', ')} (点击解绑)"><i class="fa-solid fa-link"></i></div>`;
                else iconsHtml += `<div class="wb-icon-action link-unbound" title="绑定到当前角色"><i class="fa-solid fa-link"></i></div>`;
                iconsHtml += `<div class="wb-icon-action btn-view" title="跳转到编辑"><i class="fa-solid fa-eye"></i></div>`;
                iconsHtml += `<div class="wb-icon-action btn-del" title="删除世界书"><i class="fa-solid fa-trash"></i></div>`;
                iconsHtml += `<div class="wb-icon-action btn-pin ${meta.pinned ? 'pinned' : ''}" title="${meta.pinned ? '取消顶置' : '组内顶置'}"><i class="fa-solid fa-thumbtack"></i></div>`;
                iconsHtml += `<div class="wb-icon-action btn-note ${meta.note ? 'active' : ''}" title="编辑备注"><i class="fa-solid fa-pencil"></i></div>`;

                let titleHtml = `<span class="wb-card-title">${bookName}</span>`;
                if (groupName === '已绑定角色' && boundChars.length > 0) titleHtml += `<div class="wb-card-subtitle"><i class="fa-solid fa-user-tag" style="font-size:0.8em"></i> ${boundChars.join(', ')}</div>`;

                card.innerHTML = `<div class="wb-card-top"><div class="wb-card-info">${titleHtml}</div><div class="wb-manage-icons">${iconsHtml}</div></div><textarea class="wb-manage-note ${meta.note ? 'show' : ''}" placeholder="输入备注...">${meta.note || ''}</textarea>`;
                
                const q = (s) => card.querySelector(s);
                if (boundChars.length > 0) q('.link-bound').onclick = () => Actions.toggleBindState(bookName, boundChars[0], true);
                else q('.link-unbound').onclick = () => Actions.toggleBindState(bookName, null, false);
                q('.btn-view').onclick = () => Actions.jumpToEditor(bookName);
                q('.btn-del').onclick = () => Actions.deleteBookDirectly(bookName);
                q('.btn-pin').onclick = () => Actions.togglePin(bookName);
                q('.btn-note').onclick = () => { q('.wb-manage-note').classList.toggle('show'); };
                q('.wb-manage-note').onchange = (e) => Actions.updateNote(bookName, e.target.value);

                body.appendChild(card);
            });
            container.appendChild(groupDiv);
        };

        if (groups['未绑定角色'].length > 0) renderGroup('未绑定角色', groups['未绑定角色']);
        Object.keys(groups).sort(this.compareGroupNames.bind(this)).forEach(g => { if (g !== '已绑定角色' && g !== '未绑定角色') renderGroup(g, groups[g]); });
        if (groups['已绑定角色'].length > 0) renderGroup('已绑定角色', groups['已绑定角色']);

        // Settings
        const config = Actions.getGlobalConfig();
        const settingsDiv = document.createElement('div');
        settingsDiv.className = 'wb-manage-settings';
        settingsDiv.innerHTML = `<div class="wb-setting-row"><div><div class="wb-setting-label">级联删除主要世界书</div><div class="wb-setting-desc">删除角色卡时，询问是否同时删除其绑定的主要世界书</div></div><div class="wb-ctrl-group"><label class="wb-switch"><input type="checkbox" id="wb-setting-del-wb" ${config.deleteWbWithChar ? 'checked' : ''}><span class="wb-slider purple"></span></label></div></div>`;
        settingsDiv.querySelector('#wb-setting-del-wb').onchange = async (e) => await Actions.saveGlobalConfig({ deleteWbWithChar: e.target.checked });
        container.appendChild(settingsDiv);
    },

    // 核心 UI 功能
    applyCustomDropdown(selectId) {
        const originalSelect = document.getElementById(selectId);
        if (!originalSelect) return;
        let trigger = document.getElementById(`wb-trigger-${selectId}`);
        if (originalSelect.style.display !== 'none') {
            originalSelect.style.display = 'none';
            if (trigger) trigger.remove();
            trigger = document.createElement('div');
            trigger.id = `wb-trigger-${selectId}`;
            trigger.className = 'wb-gr-trigger';

            originalSelect.parentNode.insertBefore(trigger, originalSelect.nextSibling);
            trigger.onclick = (e) => { e.stopPropagation(); this.toggleCustomDropdown(selectId, trigger); };
        }
        const update = () => {
            const selectedOpt = originalSelect.options[originalSelect.selectedIndex];
            trigger.textContent = selectedOpt ? selectedOpt.text : '请选择...';

            // 宽度控制权完全移交 CSS，此处不再进行任何 JS 样式覆盖
        };
        update();
        // 使用 addEventListener 防止覆盖 Actions.loadBook 的逻辑
        originalSelect.addEventListener('change', update);
    },

    toggleCustomDropdown(selectId, triggerElem) {
        const existing = document.getElementById('wb-active-dropdown');
        if (existing) {
            const isSame = existing.dataset.source === selectId;
            existing.remove();
            if (isSame) return;
        }
        const originalSelect = document.getElementById(selectId);
        const dropdown = document.createElement('div');
        dropdown.id = 'wb-active-dropdown';
        dropdown.className = 'wb-gr-dropdown show';
        dropdown.dataset.source = selectId;

        const searchBox = document.createElement('div');
        searchBox.className = 'wb-gr-search-box';
        const searchInput = document.createElement('input');
        searchInput.className = 'wb-gr-search-input';
        searchInput.placeholder = '搜索选项...';
        searchInput.onclick = (e) => e.stopPropagation();
        searchBox.appendChild(searchInput);

        const optionsContainer = document.createElement('div');
        optionsContainer.className = 'wb-gr-options-container';

        const createOption = (optNode) => {
            const div = document.createElement('div');
            div.className = 'wb-gr-option';
            div.textContent = optNode.text;
            if (optNode.selected) div.classList.add('selected');
            div.onclick = (e) => {
                e.stopPropagation();
                originalSelect.value = optNode.value;
                originalSelect.dispatchEvent(new Event('change'));
                dropdown.remove();
            };
            optionsContainer.appendChild(div);
        };

        Array.from(originalSelect.children).forEach(child => {
            if (child.tagName === 'OPTGROUP') {
                const label = document.createElement('div');
                label.className = 'wb-gr-group-label';
                label.textContent = child.label;
                optionsContainer.appendChild(label);
                Array.from(child.children).forEach(createOption);
            } else if (child.tagName === 'OPTION') createOption(child);
        });

        if (originalSelect.options.length > 8) dropdown.appendChild(searchBox);
        dropdown.appendChild(optionsContainer);
        document.body.appendChild(dropdown);

        const rect = triggerElem.getBoundingClientRect();
        dropdown.style.top = `${rect.bottom + 5}px`;
        dropdown.style.left = `${rect.left}px`;
        dropdown.style.width = `${rect.width}px`;

        searchInput.focus();
        searchInput.oninput = (e) => {
            const term = e.target.value.toLowerCase();
            optionsContainer.querySelectorAll('.wb-gr-option').forEach(o => o.classList.toggle('hidden', !o.textContent.toLowerCase().includes(term)));
        };

        const closeHandler = (e) => {
            if (!dropdown.contains(e.target) && e.target !== triggerElem) {
                dropdown.remove();
                document.removeEventListener('click', closeHandler);
            }
        };
        setTimeout(() => document.addEventListener('click', closeHandler), 0);
    },

    openSortingModal() {
        if (!STATE.currentBookName) return toastr.warning("请先选择一本世界书");

        const groups = {};
        const groupKeys = [];

        // 1. 定义 ST 原生执行顺序的优先级 (数值越小越靠前)
        const priorityMap = {
            'before_character_definition': 10,
            'after_character_definition': 20,
            'before_author_note': 30,
            'after_author_note': 40,
            'at_depth': 50, // 需要结合 depth 二级排序
            'before_example_messages': 60,
            'after_example_messages': 70
        };

        const typeLabels = {
            'before_character_definition': '角色定义之前', 'after_character_definition': '角色定义之后',
            'before_example_messages': '示例消息之前', 'after_example_messages': '示例消息之后',
            'before_author_note': '作者注释之前', 'after_author_note': '作者注释之后', 'at_depth': '@D'
        };

        // 2. 数据分组
        const sortedEntries = [...STATE.entries].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
        sortedEntries.forEach(entry => {
            const posInt = typeof entry.position === 'number' ? entry.position : 1;
            const posStr = WI_POSITION_MAP[posInt] || 'after_character_definition';

            // 构造 Key：对于 @D，我们将 Key 设为 "at_depth"，但在分组对象内部区分
            // 修改策略：为了让不同 Depth 分开显示，我们需要唯一的 Key
            let key = posStr === 'at_depth' ? `at_depth_${entry.depth ?? 0}` : posStr;
            let label = posStr === 'at_depth' ? `@D ${entry.depth ?? 0}` : (typeLabels[key] || key);

            // 记录原始位置类型用于排序
            const rawType = posStr;
            const depthVal = entry.depth ?? 0;

            if (!groups[key]) {
                groups[key] = { label, items: [], rawType, depthVal };
                groupKeys.push(key);
            }
            groups[key].items.push(entry);
        });

        // 3. 核心修复：按优先级排序 Group Keys
        groupKeys.sort((keyA, keyB) => {
            const gA = groups[keyA];
            const gB = groups[keyB];

            const pA = priorityMap[gA.rawType] ?? 999;
            const pB = priorityMap[gB.rawType] ?? 999;

            if (pA !== pB) return pA - pB;

            // 如果都是 at_depth，按 depth 数值排序（降序：数值大的在上面）
            if (gA.rawType === 'at_depth') {
                return gB.depthVal - gA.depthVal;
            }
            return 0;
        });

        const overlay = document.createElement('div');
        overlay.className = 'wb-sort-modal-overlay';
        overlay.style.visibility = 'hidden'; // 1. 初始隐藏，防止闪烁
        overlay.innerHTML = `<div class="wb-sort-modal"><div class="wb-sort-header"><span><i class="fa-solid fa-arrow-down-9-1"></i> 分组排序管理</span><div style="cursor:pointer" id="wb-sort-close"><i class="fa-solid fa-xmark"></i></div></div><div class="wb-sort-body" id="wb-sort-body"></div><div class="wb-sort-footer" style="display:flex; justify-content:center; gap:15px;"><button class="wb-btn-rect" id="wb-sort-cancel" style="font-size:0.9em;padding:8px 20px; background:#fff; color:#000; border:1px solid #e5e7eb;">取消</button><button class="wb-btn-rect" id="wb-sort-save" style="font-size:0.9em;padding:8px 20px">保存</button></div></div>`;
        document.body.appendChild(overlay);

        // [新增] 弹窗渲染完毕后，立即计算位置
        setTimeout(() => {
            adjustSortModalLayout();
            overlay.style.visibility = 'visible'; // 2. 布局调整完毕后显示
        }, 0);

        const bodyEl = overlay.querySelector('#wb-sort-body');
        const getBg = (i) => `hsl(${(i * 137.5) % 360}, 70%, 95%)`;
        const getBdr = (i) => `hsl(${(i * 137.5) % 360}, 60%, 80%)`;
        const getTxt = (i) => `hsl(${(i * 137.5) % 360}, 80%, 30%)`;

        groupKeys.forEach((key, i) => {
            const group = groups[key];
            const container = document.createElement('div');
            container.className = 'wb-sort-group-container';
            container.style.backgroundColor = getBg(i);
            container.style.borderColor = getBdr(i);

            // 修改：添加折叠图标和交互区域
            container.innerHTML = `
                <div class="wb-sort-group-title" style="color:${getTxt(i)}">
                    <span>${group.label} <span style="font-weight:normal;font-size:0.8em;opacity:0.8">(${group.items.length})</span></span>
                    <i class="fa-solid fa-chevron-down wb-sort-arrow"></i>
                </div>
                <div class="wb-sort-group-list" data-group-key="${key}"></div>
            `;

            const titleEl = container.querySelector('.wb-sort-group-title');
            const listEl = container.querySelector('.wb-sort-group-list');

            // 添加折叠事件
            titleEl.onclick = () => {
                const isCollapsed = listEl.classList.contains('collapsed');
                if (isCollapsed) {
                    listEl.classList.remove('collapsed');
                    titleEl.classList.remove('collapsed');
                } else {
                    listEl.classList.add('collapsed');
                    titleEl.classList.add('collapsed');
                }
            };

            group.items.forEach(entry => {
                const item = document.createElement('div');
                item.className = 'wb-sort-item';
                item.draggable = true;
                item.dataset.uid = entry.uid;
                item.innerHTML = `<div class="wb-sort-item-order">${entry.order ?? 0}</div><div style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${entry.comment || '无标题'}</div><i class="fa-solid fa-bars" style="color:#ccc"></i>`;
                item.ondragstart = (e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/uid', entry.uid); e.dataTransfer.setData('text/group', key); item.classList.add('dragging'); };
                item.ondragend = () => item.classList.remove('dragging');
                listEl.appendChild(item);
            });

            // --- PC端拖拽逻辑 ---
            listEl.ondragover = (e) => {
                e.preventDefault();
                const dragging = listEl.querySelector('.dragging');
                if (!dragging) return;
                const siblings = [...listEl.querySelectorAll('.wb-sort-item:not(.dragging)')];
                const next = siblings.find(s => e.clientY <= s.getBoundingClientRect().top + s.offsetHeight / 2);
                listEl.insertBefore(dragging, next);
            };

            // 提取更新排序的逻辑以便复用
            const updateOrder = () => {
                [...listEl.querySelectorAll('.wb-sort-item')].forEach((el, idx) => {
                    const newOrder = idx + 1;
                    el.querySelector('.wb-sort-item-order').textContent = newOrder;
                    const entry = STATE.entries.find(e => e.uid === Number(el.dataset.uid));
                    if (entry) { entry.order = newOrder; }
                });
            };

            listEl.ondrop = (e) => {
                e.preventDefault();
                if (e.dataTransfer.getData('text/group') !== key) return;
                updateOrder();
            };

            // --- 移动端触摸拖拽逻辑 (手动模拟) ---
            let touchDraggingItem = null;

            listEl.addEventListener('touchstart', (e) => {
                // 只有触摸"三道杠"图标或其附近才触发拖拽，避免影响折叠操作
                const handle = e.target.closest('.fa-bars') || e.target.closest('.wb-sort-item');
                if (!handle) return;

                const item = handle.closest('.wb-sort-item');
                if (!item) return;

                touchDraggingItem = item;
                item.classList.add('dragging');
                // 禁止页面滚动
                document.body.style.overflow = 'hidden';
            }, {passive: false});

            listEl.addEventListener('touchmove', (e) => {
                if (!touchDraggingItem) return;
                e.preventDefault(); // 阻止滚动

                const touch = e.touches[0];
                // 获取手指下方的元素
                const target = document.elementFromPoint(touch.clientX, touch.clientY);
                if (!target) return;

                // 找到列表中的目标项
                const swapItem = target.closest('.wb-sort-item');

                // 确保在同个列表内移动
                if (swapItem && swapItem !== touchDraggingItem && listEl.contains(swapItem)) {
                    const rect = swapItem.getBoundingClientRect();
                    // 判断是插入到上方还是下方
                    const next = (touch.clientY - rect.top) / rect.height > 0.5;
                    listEl.insertBefore(touchDraggingItem, next ? swapItem.nextSibling : swapItem);
                }
            }, {passive: false});

            listEl.addEventListener('touchend', (e) => {
                if (touchDraggingItem) {
                    touchDraggingItem.classList.remove('dragging');
                    touchDraggingItem = null;
                    document.body.style.overflow = ''; // 恢复滚动
                    updateOrder(); // 更新数据
                }
            });

            bodyEl.appendChild(container);
        });

        // 恢复 JS 定位以解决移动端兼容性问题
        this.setupModalPositioning(overlay.querySelector('.wb-sort-modal'), overlay);
        overlay.querySelector('#wb-sort-close').onclick = () => overlay.remove();
        // [新增] 取消按钮事件
        overlay.querySelector('#wb-sort-cancel').onclick = () => overlay.remove();

        overlay.querySelector('#wb-sort-save').onclick = async () => {
            await API.saveBookEntries(STATE.currentBookName, STATE.entries);
            Actions.sortByPriority();
            overlay.remove();
        };
    },

    openAnalysisModal() {
        if (!STATE.currentBookName) return toastr.warning("请先选择一本世界书");

        // 内部状态：是否显示所有条目
        let showAll = false;

        // 创建 DOM 骨架
        const overlay = document.createElement('div');
        overlay.className = 'wb-sort-modal-overlay';
        overlay.innerHTML = `
            <div class="wb-sort-modal" id="wb-analysis-box" style="width:550px; height:auto; max-height:90vh;">
                <div class="wb-sort-header" style="background:#fff; padding: 15px 20px;">
                    <span style="font-size:1.1em; display:flex; align-items:center; gap:10px;">
                        <i class="fa-solid fa-chart-pie" style="color:#374151;"></i>
                        <span id="wb-analysis-title">${STATE.currentBookName}</span>
                    </span>
                    <div style="display:flex; gap:15px; align-items:center;">
                        <i class="fa-solid fa-repeat wb-action-icon" id="wb-analysis-toggle" title="切换：仅已启用 / 所有条目"></i>
                        <div style="cursor:pointer" class="wb-close-modal"><i class="fa-solid fa-xmark"></i></div>
                    </div>
                </div>
                <div class="wb-sort-body" style="background:#fff; padding:0; overflow:hidden !important;">
                    <div id="wb-analysis-content" class="wb-stats-container">
                        <!-- 内容将通过 render 动态生成 -->
                    </div>
                </div>
            </div>`;
        document.body.appendChild(overlay);
        // 恢复 JS 定位
        UI.setupModalPositioning(overlay.querySelector('#wb-analysis-box'), overlay);

        // 核心渲染函数
        const render = () => {
            // 1. 数据筛选
            const sourceEntries = STATE.entries;
            const targetEntries = showAll ? sourceEntries : sourceEntries.filter(e => e.disable === false);

            // 更新标题状态
            const titleEl = overlay.querySelector('#wb-analysis-title');
            titleEl.innerHTML = `${STATE.currentBookName} <span style="font-size:0.8em; font-weight:normal; color:#6b7280;">(${showAll ? '所有条目' : '仅已启用'})</span>`;

            if (targetEntries.length === 0) {
                overlay.querySelector('#wb-analysis-content').innerHTML = `<div style="text-align:center; color:#9ca3af; padding:40px;">暂无数据</div>`;
                return;
            }

            // 2. 数据计算
            let blueTokens = 0, greenTokens = 0, blueCount = 0, greenCount = 0;
            const rankList = [];

            targetEntries.forEach(entry => {
                const t = Actions.getTokenCount(entry.content);
                const isBlue = !!entry.constant;

                if (isBlue) {
                    blueTokens += t;
                    blueCount++;
                } else {
                    greenTokens += t;
                    greenCount++;
                }

                rankList.push({
                    name: entry.comment || '未命名',
                    tokens: t,
                    isBlue: isBlue,
                    uid: entry.uid
                });
            });

            const totalTokens = blueTokens + greenTokens;
            const totalCount = blueCount + greenCount;
            const bluePercent = totalTokens > 0 ? (blueTokens / totalTokens * 100).toFixed(1) : 0;
            const greenPercent = totalTokens > 0 ? (greenTokens / totalTokens * 100).toFixed(1) : 0;

            const blueCountPercent = totalCount > 0 ? (blueCount / totalCount * 100).toFixed(1) : 0;
            const greenCountPercent = totalCount > 0 ? (greenCount / totalCount * 100).toFixed(1) : 0;

            // 3. 排序逻辑：蓝灯优先，然后绿灯；同色按 Token 降序
            rankList.sort((a, b) => {
                if (a.isBlue !== b.isBlue) return a.isBlue ? -1 : 1; // 蓝前绿后
                return b.tokens - a.tokens; // Token 降序
            });

            // 进度条改为计算占总Token的比例，不再需要 maxTokens
            // const maxTokens = rankList.length > 0 ? Math.max(...rankList.map(i => i.tokens)) : 1;

            // 4. HTML 生成
            // A. Token 占比条
            const progressHtml = `
                <div class="wb-stats-row">
                    <div class="wb-stats-label">
                        <span>Token 占比</span>
                        <span class="wb-stats-total">总计: ${totalTokens}</span>
                    </div>
                    <div class="wb-progress-bar">
                        <div class="wb-bar-seg wb-bg-blue" style="width:${bluePercent}%">${blueTokens > 0 ? blueTokens : ''}</div>
                        <div class="wb-bar-seg wb-bg-green" style="width:${greenPercent}%">${greenTokens > 0 ? greenTokens : ''}</div>
                    </div>
                    <div class="wb-bar-legend">
                        <span><span class="wb-legend-dot wb-dot-blue"></span>蓝灯: ${bluePercent}%</span>
                        <span><span class="wb-legend-dot wb-dot-green"></span>绿灯: ${greenPercent}%</span>
                    </div>
                </div>
            `;

            // B. 饼图区域
            // 计算 conic-gradient
            // 蓝色从 0% 到 blueCountPercent%，绿色接续到 100%
            const pieGradient = `conic-gradient(#3b82f6 0% ${blueCountPercent}%, #22c55e ${blueCountPercent}% 100%)`;
            const pieHtml = `
                <div class="wb-pie-row">
                    <div class="wb-pie-chart" style="background: ${pieGradient};"></div>
                    <div class="wb-pie-legend">
                        <div class="wb-pie-legend-item">
                            <span class="wb-legend-dot wb-dot-blue"></span> 蓝灯条目: <strong>${blueCount}</strong> <span style="font-size:0.9em;color:#6b7280;margin-left:4px">(${blueCountPercent}%)</span>
                        </div>
                        <div class="wb-pie-legend-item">
                            <span class="wb-legend-dot wb-dot-green"></span> 绿灯条目: <strong>${greenCount}</strong> <span style="font-size:0.9em;color:#6b7280;margin-left:4px">(${greenCountPercent}%)</span>
                        </div>
                        <div class="wb-pie-sub">共 ${totalCount} 条</div>
                    </div>
                </div>
            `;

            // C. 排行榜
            let rankHtmlItems = '';
            rankList.forEach(item => {
                // 计算百分比：修改为占总数的比例
                const percent = totalTokens > 0 ? (item.tokens / totalTokens * 100).toFixed(1) : 0;
                // 蓝灯浅蓝(#dbeafe)，绿灯浅绿(#dcfce7)
                const barColor = item.isBlue ? '#dbeafe' : '#dcfce7';
                const bgStyle = `background: linear-gradient(to right, ${barColor} ${percent}%, #f8fafc ${percent}%);`;

                rankHtmlItems += `
                    <div class="wb-rank-pill" style="${bgStyle}">
                        <div class="wb-rank-pill-name" title="${item.name}">${item.name}</div>
                        <div class="wb-rank-pill-val">${item.tokens}</div>
                    </div>
                `;
            });

            const rankHtml = `
                <div class="wb-stats-row" style="flex:1; min-height:0;">
                    <div class="wb-stats-label">
                        <span>Token 排行 (蓝前绿后)</span>
                        <span class="wb-stats-total">${totalTokens}</span>
                    </div>
                    <div class="wb-rank-list">
                        ${rankHtmlItems}
                    </div>
                </div>
            `;

            overlay.querySelector('#wb-analysis-content').innerHTML = progressHtml + pieHtml + rankHtml;
        };

        // 事件绑定
        const toggleBtn = overlay.querySelector('#wb-analysis-toggle');
        toggleBtn.onclick = () => {
            showAll = !showAll;
            render();
        };

        overlay.querySelector('.wb-close-modal').onclick = () => overlay.remove();
        overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

        // 初始渲染
        render();
    },

    openWarningListModal() {
        const warnings = this.getWarningList();
        if (warnings.length === 0) return toastr.info("没有警告条目");

        const overlay = document.createElement('div');
        overlay.className = 'wb-sort-modal-overlay';

        // 构建列表项 HTML
        let listHtml = '';
        warnings.forEach(entry => {
            listHtml += `
            <div class="wb-warning-list-item">
                <div style="display:flex; align-items:center; gap:10px; overflow:hidden;">
                    <i class="fa-solid fa-circle-exclamation" style="color:#ef4444;"></i>
                    <span style="font-weight:bold; color:#374151; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${entry.comment || '未命名条目'}</span>
                </div>
                <i class="fa-solid fa-eye" style="cursor:pointer; color:#6b7280; padding:5px;" title="查看/编辑" data-edit="${entry.uid}"></i>
            </div>`;
        });

        overlay.innerHTML = `
            <div class="wb-sort-modal" id="wb-warning-box" style="width:500px; height:auto; max-height:80vh; background:#f9fafb;">
                <!-- 头部 -->
                <div class="wb-sort-header" style="background:#fff; border-bottom:1px solid #e5e7eb;">
                    <div class="wb-warning-header-red">
                        <i class="fa-solid fa-triangle-exclamation"></i>
                        <span>关键词缺失警告 (${warnings.length})</span>
                    </div>
                    <div style="cursor:pointer; color:#4b5563;" class="wb-close-modal"><i class="fa-solid fa-xmark"></i></div>
                </div>

                <!-- 内容区 -->
                <div class="wb-sort-body" style="padding:20px;">
                    <div class="wb-warning-alert-box">
                        以下绿灯条目已启用，但未设置任何关键词，因此属于无效条目。它们在聊天中将永远不会被触发。
                    </div>
                    <div style="display:flex; flex-direction:column;">
                        ${listHtml}
                    </div>
                </div>
            </div>`;

        document.body.appendChild(overlay);
        // [已删除] this.setupModalPositioning(...) 移除 JS 强制定位，使用 CSS 自动居中

        // 事件绑定
        overlay.addEventListener('click', (e) => {
            if (e.target.dataset.edit) {
                const entry = STATE.entries.find(en => en.uid === Number(e.target.dataset.edit));
                if (entry) {
                    UI.openContentPopup(entry);
                    overlay.remove(); // 关闭警告弹窗，打开编辑弹窗
                }
            }
        });

        overlay.querySelector('.wb-close-modal').onclick = () => overlay.remove();
        overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    },

    async openContextPreviewModal() {
        if (!STATE.currentBookName) return toastr.warning("请先选择一本世界书");

        const loadingToast = toastr.info("正在分析上下文...", "请稍候", { timeOut: 0, extendedTimeOut: 0 });

        try {
            const context = getContext();

            // 1. 准备扫描文本
            const charId = context.characterId;
            const charData = context.characters[charId] || {};
            let fullText = (charData.description || '') + '\n' + (charData.persona || '') + '\n';
            const chat = context.chat || [];
            const recentChat = chat.slice(-30);
            fullText += recentChat.map(c => (c.name || '') + ': ' + (c.mes || '')).join('\n');
            const searchContext = fullText.toLowerCase();

            // 2. 本地筛选
            let activatedEntries = STATE.entries.filter(entry => {
                if (entry.disable) return false;
                if (entry.constant) return true;
                if (!entry.key || entry.key.length === 0) return false;
                return entry.key.some(k => {
                    const keyStr = String(k).trim();
                    if (!keyStr) return false;
                    if (keyStr.startsWith('/') && keyStr.endsWith('/') && keyStr.length > 2) {
                        try {
                            const regexBody = keyStr.substring(1, keyStr.lastIndexOf('/'));
                            const flags = keyStr.substring(keyStr.lastIndexOf('/') + 1) + 'i';
                            const regex = new RegExp(regexBody, flags);
                            return regex.test(fullText);
                        } catch (e) { return false; }
                    } else {
                        return searchContext.includes(keyStr.toLowerCase());
                    }
                });
            });

            toastr.clear(loadingToast);

            // 3. 排序 (使用统一的上下文优先级算法)
            activatedEntries.sort((a, b) => {
                const scoreA = Actions.getEntrySortScore(a);
                const scoreB = Actions.getEntrySortScore(b);
                if (scoreA !== scoreB) return scoreB - scoreA; // 分数高在前

                const orderA = a.order ?? 0;
                const orderB = b.order ?? 0;
                return (orderA - orderB) || (a.uid - b.uid);
            });

            // 4. 构建 HTML
            let sidebarHtml = '';
            let contentHtml = '';

            // 原始文本缓存，用于搜索还原
            const originalContentMap = new Map();

            // 需求3：位置映射表
            const posMapping = {
                0: '角色定义之前',
                1: '角色定义之后',
                2: 'AN 之前',
                3: 'AN 之后',
                4: '@D',
                5: '示例消息之前',
                6: '示例消息之后'
            };

            if (activatedEntries.length === 0) {
                sidebarHtml = `<div style="padding:20px 15px;color:#9ca3af;text-align:center;font-size:0.9em;">无激活条目</div>`;
                contentHtml = `
                    <div style="display:flex;height:100%;align-items:center;justify-content:center;color:#9ca3af;flex-direction:column">
                        <i class="fa-solid fa-ghost" style="font-size:3em;margin-bottom:15px;opacity:0.5"></i>
                        <div>当前上下文未激活任何条目</div>
                    </div>`;
            } else {
                activatedEntries.forEach((entry, idx) => {
                    const title = entry.comment || (entry.key && entry.key.length ? entry.key[0] : `Entry #${entry.uid}`);

                    const isConstant = !!entry.constant;
                    const itemTypeClass = isConstant ? 'type-blue' : 'type-green';
                    const barColorClass = isConstant ? 'wb-bar-blue' : 'wb-bar-green';

                    // 计算显示位置
                    let posVal = typeof entry.position === 'number' ? entry.position : 1;
                    let posText = posMapping[posVal] || '未知位置';
                    if (posVal === 4) {
                        posText = `@D ${entry.depth ?? 4}`;
                    }

                    // [需求修改] 格式：{蓝灯/绿灯} {位置的值} {顺序数值}
                    const typeLabel = isConstant ? '蓝灯' : '绿灯';
                    const orderVal = entry.order ?? 0;
                    const tooltipText = `${typeLabel} ${posText} ${orderVal}`;
                    const colorMode = isConstant ? 'blue' : 'green';

                    const rawContent = (entry.content || '').replace(/</g, '&lt;');
                    originalContentMap.set(`ctx-block-${idx}`, { title, content: rawContent });

                    // 增加 data-color-mode 用于 CSS 样式控制
                    sidebarHtml += `
                        <div class="wb-ctx-sidebar-item ${itemTypeClass}" data-target="ctx-block-${idx}" id="sidebar-item-${idx}" title="${tooltipText}" data-color-mode="${colorMode}">
                            <div class="wb-ctx-bar ${barColorClass}"></div>
                            <div class="wb-ctx-info">
                                <span class="wb-ctx-name">${title}</span>
                            </div>
                        </div>`;

                    // [需求3] 移除 fa-location-dot 图标
                    contentHtml += `
                        <div id="ctx-block-${idx}" class="wb-ctx-block" data-idx="${idx}">
                            <div class="wb-ctx-block-title">
                                <span class="title-text">${title}</span>
                                <span style="font-size:0.8em; font-weight:normal; color:#9ca3af; margin-left:auto; font-family: 'Segoe UI', sans-serif;">
                                    ${posText}
                                </span>
                            </div>
                            <div class="wb-ctx-block-content">${rawContent}</div>
                        </div>`;
                });
            }

            // 5. 模态框容器
            const overlay = document.createElement('div');
            overlay.className = 'wb-sort-modal-overlay';
            overlay.style.zIndex = '22000';

            // 读取侧边栏展开状态
            const isSidebarCollapsed = localStorage.getItem('wb_ctx_sidebar_collapsed') === 'true';

            overlay.innerHTML = `
                <div class="wb-sort-modal" style="width:1000px; height:85vh; max-width:95vw; border-radius:12px; overflow:hidden; display:flex; flex-direction:column; box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);">
                    <div class="wb-sort-header" style="background:#fff; border-bottom:1px solid #e5e7eb; padding:10px 20px; height:60px;">
                        <span style="font-size:1.1em; font-weight:bold; color:#111827; display:flex; align-items:center; gap:15px;">
                            <i class="fa-solid fa-align-left" id="wb-ctx-toggle-sidebar" style="cursor:pointer; color:#6b7280; transition:0.2s" title="切换侧边栏"></i>
                            <span>实际上下文预览</span>
                        </span>
                        <div style="display:flex; align-items:center;">
                            <!-- 搜索框区域 -->
                            <div class="wb-ctx-search-container">
                                <i class="fa-solid fa-magnifying-glass" style="color:#9ca3af; font-size:0.9em;"></i>
                                <input type="text" class="wb-ctx-search-input" placeholder="检索关键词...">
                                <div class="wb-ctx-nav-controls">
                                    <div class="wb-ctx-nav-btn" id="wb-search-up"><i class="fa-solid fa-arrow-up"></i></div>
                                    <div class="wb-ctx-nav-btn" id="wb-search-down"><i class="fa-solid fa-arrow-down"></i></div>
                                    <div class="wb-ctx-nav-info">0/0</div>
                                </div>
                            </div>
                            <div class="wb-close-btn" style="cursor:pointer; color:#9ca3af; font-size:1.2em; padding:5px; margin-left:10px;"><i class="fa-solid fa-xmark"></i></div>
                        </div>
                    </div>
                    <div class="wb-ctx-layout-container">
                        <div class="wb-ctx-sidebar-panel ${isSidebarCollapsed ? 'collapsed' : ''}" id="wb-ctx-sidebar">${sidebarHtml}</div>
                        <div class="wb-ctx-viewer-panel" id="wb-ctx-viewer">${contentHtml}</div>
                    </div>
                </div>`;

            document.body.appendChild(overlay);
            UI.setupModalPositioning(overlay.querySelector('.wb-sort-modal'), overlay);

            // --- 6. 交互逻辑 ---
            const sidebar = overlay.querySelector('#wb-ctx-sidebar');
            const viewer = overlay.querySelector('#wb-ctx-viewer');
            const sidebarItems = Array.from(sidebar.querySelectorAll('.wb-ctx-sidebar-item'));
            const blocks = Array.from(viewer.querySelectorAll('.wb-ctx-block'));
            const toggleBtn = overlay.querySelector('#wb-ctx-toggle-sidebar');
            const searchInput = overlay.querySelector('.wb-ctx-search-input');
            const navControls = overlay.querySelector('.wb-ctx-nav-controls');
            const navInfo = overlay.querySelector('.wb-ctx-nav-info');
            const btnUp = overlay.querySelector('#wb-search-up');
            const btnDown = overlay.querySelector('#wb-search-down');

            // === 侧边栏切换 ===
            toggleBtn.onclick = () => {
                sidebar.classList.toggle('collapsed');
                const isCollapsed = sidebar.classList.contains('collapsed');
                toggleBtn.style.color = isCollapsed ? '#d1d5db' : '#6b7280';
                localStorage.setItem('wb_ctx_sidebar_collapsed', isCollapsed);
            };

            // === 点击跳转 ===
            const scrollToBlock = (targetId) => {
                const targetEl = viewer.querySelector(`#${targetId}`);
                if (targetEl) {
                    const topPos = targetEl.offsetTop - 20;
                    viewer.scrollTo({ top: topPos, behavior: 'smooth' });
                }
            };
            sidebarItems.forEach(item => {
                item.onclick = () => {
                    // 手动点击时不触发滚动监听的覆盖，或简单处理
                    sidebarItems.forEach(i => i.classList.remove('active'));
                    item.classList.add('active');
                    scrollToBlock(item.dataset.target);
                };
            });

            // === 滚动监听 (Scroll Spy) ===
            let scrollTimeout;
            viewer.addEventListener('scroll', () => {
                if (scrollTimeout) clearTimeout(scrollTimeout);
                scrollTimeout = setTimeout(() => {
                    // 找到距离视口顶部最近的可见 block
                    const viewerTop = viewer.scrollTop;
                    const viewerHeight = viewer.clientHeight;

                    let activeId = null;
                    // 遍历所有可见的 block (没被搜索筛选掉的)
                    const visibleBlocks = blocks.filter(b => b.style.display !== 'none');

                    for (let block of visibleBlocks) {
                        // 如果 block 的顶部已经在视口上方或者在视口内靠上的位置
                        if (block.offsetTop <= viewerTop + 100) {
                            activeId = block.id;
                        } else {
                            // 因为是按顺序排列的，一旦超过，后面的更远，直接跳出
                            if (!activeId) activeId = block.id; // 如果第一个都在下面，就选第一个
                            break;
                        }
                    }

                    if (activeId) {
                        sidebarItems.forEach(i => {
                            if (i.dataset.target === activeId) i.classList.add('active');
                            else i.classList.remove('active');
                        });
                        // 确保侧边栏也滚动到激活项
                        const activeItem = sidebar.querySelector(`.active`);
                        if (activeItem) {
                            activeItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                        }
                    }
                }, 100);
            });
            // 初始触发一次
            viewer.dispatchEvent(new Event('scroll'));

            // === 搜索与高亮逻辑 ===
            let searchDebounce;
            let currentMatches = []; // 存储所有高亮 DOM 元素
            let currentMatchIndex = -1;

            const updateNavInfo = () => {
                if (currentMatches.length > 0) {
                    navControls.classList.add('show');
                    navInfo.textContent = `${currentMatchIndex + 1}/${currentMatches.length}`;
                } else {
                    navControls.classList.remove('show');
                    navInfo.textContent = "0/0";
                }
            };

            const jumpToMatch = (index) => {
                if (index < 0 || index >= currentMatches.length) return;
                currentMatchIndex = index;

                // 移除旧的 active
                currentMatches.forEach(el => el.classList.remove('active'));

                const target = currentMatches[index];
                target.classList.add('active');
                target.scrollIntoView({ behavior: 'smooth', block: 'center' });
                updateNavInfo();
            };

            searchInput.addEventListener('input', (e) => {
                const term = e.target.value.trim();

                if (searchDebounce) clearTimeout(searchDebounce);
                searchDebounce = setTimeout(() => {
                    currentMatches = [];
                    currentMatchIndex = -1;

                    if (!term) {
                        // 清空搜索：还原内容，显示所有
                        blocks.forEach(block => {
                            const data = originalContentMap.get(block.id);
                            if (data) {
                                block.querySelector('.wb-ctx-block-content').innerHTML = data.content;
                                block.querySelector('.title-text').innerHTML = data.title;
                            }
                            block.classList.remove('filtered-out');
                        });
                        sidebarItems.forEach(item => item.classList.remove('filtered-out'));
                        navControls.classList.remove('show');
                        // 重新触发滚动监听以修正高亮
                        viewer.dispatchEvent(new Event('scroll'));
                        return;
                    }

                    // 执行搜索
                    const regex = new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');

                    blocks.forEach((block, i) => {
                        const data = originalContentMap.get(block.id);
                        if (!data) return;

                        const titleMatch = regex.test(data.title);
                        const contentMatch = regex.test(data.content);
                        const hasMatch = titleMatch || contentMatch;

                        // 筛选显示/隐藏
                        if (hasMatch) {
                            block.classList.remove('filtered-out');
                            sidebarItems[i].classList.remove('filtered-out');

                            // 高亮处理
                            if (contentMatch) {
                                block.querySelector('.wb-ctx-block-content').innerHTML = data.content.replace(regex, '<span class="wb-search-highlight">$1</span>');
                            } else {
                                block.querySelector('.wb-ctx-block-content').innerHTML = data.content;
                            }

                            // 标题也高亮
                            if (titleMatch) {
                                block.querySelector('.title-text').innerHTML = data.title.replace(regex, '<span class="wb-search-highlight">$1</span>');
                            } else {
                                block.querySelector('.title-text').innerHTML = data.title;
                            }

                        } else {
                            block.classList.add('filtered-out');
                            sidebarItems[i].classList.add('filtered-out');
                        }
                    });

                    // 收集所有高亮元素用于导航
                    currentMatches = Array.from(viewer.querySelectorAll('.wb-search-highlight'));
                    if (currentMatches.length > 0) {
                        jumpToMatch(0);
                    } else {
                        updateNavInfo();
                    }

                }, 300); // 300ms 防抖
            });

            // 导航按钮事件
            btnUp.onclick = () => {
                let next = currentMatchIndex - 1;
                if (next < 0) next = currentMatches.length - 1; // 循环
                jumpToMatch(next);
            };
            btnDown.onclick = () => {
                let next = currentMatchIndex + 1;
                if (next >= currentMatches.length) next = 0; // 循环
                jumpToMatch(next);
            };

            const close = () => overlay.remove();
            overlay.querySelector('.wb-close-btn').onclick = close;
            overlay.onclick = (e) => { if (e.target === overlay) close(); };

        } catch (e) {
            toastr.clear(loadingToast);
            console.error(e);
            toastr.error("计算上下文失败: " + e.message);
        }
    },

    showDeleteWbConfirmModal(bookName, onConfirm, onDisable) {
        const overlay = document.createElement('div');
        overlay.className = 'wb-sort-modal-overlay';
        overlay.style.zIndex = '25000';
        // 修改：禁用按钮移至上部区域底部居中，底部区域仅保留取消和确认且居中，取消按钮改为黑底白字
        overlay.innerHTML = `
            <div class="wb-sort-modal" id="wb-del-confirm-box" style="width:400px; height:auto; border-radius:12px; overflow:hidden;">
                <div style="padding:20px; text-align:center;">
                    <div style="font-size:3em; color:#f59e0b; margin-bottom:10px;"><i class="fa-solid fa-triangle-exclamation"></i></div>
                    <h3 style="margin:0 0 10px 0; color:#1f2937;">关联删除</h3>
                    <p style="color:#4b5563;">是否同时删除角色绑定的主要世界书<br><strong>${bookName}</strong>?</p>
                    <div style="margin-top:15px; border-top:1px solid #f3f4f6; padding-top:10px;">
                         <button class="wb-btn-modal btn-disable" style="color:#9ca3af; background:none; border:none; cursor:pointer; text-decoration:underline; font-size:0.9em;">禁用该功能</button>
                    </div>
                </div>
                <div style="background:#f9fafb; padding:15px; display:flex; justify-content:center; gap:20px; border-top:1px solid #e5e7eb;">
                    <button class="wb-btn-modal btn-cancel" style="padding:8px 25px; border-radius:6px; border:1px solid #000; background:#000; color:#fff; cursor:pointer;">取消</button>
                    <button class="wb-btn-modal btn-confirm" style="padding:8px 25px; border-radius:6px; border:none; background:#ef4444; color:#fff; cursor:pointer;">删除</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);
        this.setupModalPositioning(overlay.querySelector('.wb-sort-modal'), overlay); // 确保弹窗定位
        overlay.querySelector('.btn-cancel').onclick = () => overlay.remove();
        overlay.querySelector('.btn-confirm').onclick = () => {
            onConfirm();
            toastr.success(`已删除世界书：${bookName}`); // 增加删除成功提示
            overlay.remove();
        };
        overlay.querySelector('.btn-disable').onclick = () => { onDisable(); overlay.remove(); };
    },

    initTooltips() {
        if (this._tooltipInited) return;
        this._tooltipInited = true;
        const tipEl = document.createElement('div');
        tipEl.className = 'wb-tooltip';
        document.body.appendChild(tipEl);

        const show = (text, x, y, colorMode) => {
            tipEl.textContent = text;
            tipEl.classList.remove('blue', 'green');
            if (colorMode) tipEl.classList.add(colorMode);
            tipEl.classList.add('show');

            // 简单的边界检测，防止溢出屏幕
            const rect = tipEl.getBoundingClientRect();
            let left = x + 15;
            let top = y + 15;
            if (left + rect.width > window.innerWidth) left = x - rect.width - 5;
            if (top + rect.height > window.innerHeight) top = y - rect.height - 5;

            tipEl.style.left = left + 'px';
            tipEl.style.top = top + 'px';
        };
        const hide = () => {
            tipEl.classList.remove('show', 'blue', 'green');
        };

        // --- PC端鼠标逻辑 ---
        let isTouchInteraction = false;
        document.body.addEventListener('mouseover', (e) => {
            if (isTouchInteraction) return; // 如果是触摸触发的模拟鼠标事件，忽略

            // 增加作用域检查：只处理插件面板和相关弹窗内的元素，防止污染父网页
            const container = e.target.closest(`#${CONFIG.id}, .wb-modal-overlay, .wb-sort-modal-overlay`);
            if (!container) return;

            const target = e.target.closest('[title], [data-wb-tooltip]');
            if (target) {
                const text = target.getAttribute('title') || target.getAttribute('data-wb-tooltip');
                const colorMode = target.dataset.colorMode;
                if (target.getAttribute('title')) { target.setAttribute('data-wb-tooltip', text); target.removeAttribute('title'); }
                if (text) show(text, e.clientX, e.clientY, colorMode);
            }
        });
        document.body.addEventListener('mouseout', hide);

        // --- 移动端长按逻辑 ---
        let touchTimer = null;
        document.body.addEventListener('touchstart', (e) => {
            isTouchInteraction = true;
            hide(); // 清除之前的显示

            // 增加作用域检查：只处理插件内的元素
            const container = e.target.closest(`#${CONFIG.id}, .wb-modal-overlay, .wb-sort-modal-overlay`);
            if (!container) return;

            const target = e.target.closest('[title], [data-wb-tooltip]');
            if (!target) return;

            const text = target.getAttribute('title') || target.getAttribute('data-wb-tooltip');
            const colorMode = target.dataset.colorMode;
            if (target.getAttribute('title')) { target.setAttribute('data-wb-tooltip', text); target.removeAttribute('title'); }

            if (text) {
                touchTimer = setTimeout(() => {
                    const touch = e.touches[0];
                    show(text, touch.clientX, touch.clientY, colorMode);
                }, 500); // 500ms 长按触发
            }
        }, { passive: true });

        const cancelTouch = () => {
            if (touchTimer) {
                clearTimeout(touchTimer);
                touchTimer = null;
            }
            setTimeout(() => { isTouchInteraction = false; }, 500); // 延迟重置标记
            hide();
        };

        document.body.addEventListener('touchend', cancelTouch);
        document.body.addEventListener('touchmove', () => {
            if (touchTimer) clearTimeout(touchTimer); // 滑动则取消长按
        });
    }
};

/**
 * 动态计算并设置排序弹窗的位置和高度
 * 修正：强制计算高度并赋值，激活flex容器内的滚动条
 */
function adjustSortModalLayout() {
    const modal = document.querySelector('.wb-sort-modal');
    if (!modal) return;

    // 1. 获取视口高度
    const vh = window.innerHeight;
    // 2. 设定最大高度限制 (视口高度的 85%)
    const maxLimit = vh * 0.85;

    // 3. 重置高度以便测量自然高度
    modal.style.height = 'auto';
    modal.style.maxHeight = 'none';

    // 4. 测量实际内容高度
    let targetHeight = modal.offsetHeight;

    // 5. 如果内容超过最大限制，强制锁定高度
    // 这是让 body overflow-y 生效的关键：父容器必须有固定高度
    if (targetHeight > maxLimit) {
        targetHeight = maxLimit;
        modal.style.height = targetHeight + 'px';
    } else {
        // 如果未超标，保持 auto (或者显式设置当前高度以防万一)
        modal.style.height = 'auto';
    }

    // 6. 重新应用 maxHeight 样式作为双重保险
    modal.style.maxHeight = maxLimit + 'px';

    // 7. 计算垂直居中坐标
    const topPosition = (vh - targetHeight) / 2;

    // 8. 应用定位
    modal.style.top = `${Math.max(20, topPosition)}px`;
    modal.style.left = '50%';
    modal.style.transform = 'translateX(-50%)'; // 仅保留水平居中
    modal.style.margin = '0'; // 清除可能存在的 margin
}

// 监听窗口大小变化，实时调整
window.addEventListener('resize', () => {
    if (document.querySelector('.wb-sort-modal')) {
        requestAnimationFrame(adjustSortModalLayout);
    }
});

jQuery(async () => {
    // 仿照 Regex Helper 的注入方式
    const injectButton = () => {
        // 防止重复添加
        if (document.getElementById(CONFIG.btnId)) return;

        // 定位目标：输入框下方的 "Continue" 按钮
        const target = $('#option_continue');

        if (target.length) {
            // 1. 获取兄弟元素的类名，确保样式一致 (通常是 "interactable")
            const targetClasses = target.attr('class') || 'interactable';

            // 2. 使用 <a> 标签构建按钮，添加 fa-lg 图标大小适配
            const html = `
                <a id="${CONFIG.btnId}" class="${targetClasses}" title="世界书管理" tabindex="0">
                    <i class="fa-lg fa-solid fa-book-journal-whills"></i>
                    <span>世界书</span>
                </a>
            `;

            // 3. 插入到目标之后
            target.after(html);

            // 4. 绑定点击事件
            $(`#${CONFIG.btnId}`).on('click', (e) => {
                e.preventDefault();
                // 显式关闭 #options 面板，防止遮挡
                $('#options').hide();
                UI.open();
            });

            console.log("[Worldbook Editor] Button injected successfully after #option_continue.");
        } else {
            console.warn("[Worldbook Editor] Target #option_continue not found. Button injection skipped.");
        }
    };

    // 立即执行注入
    injectButton();

    // 关键修复：立即触发数据初始化和预加载
    // 这样当用户第一次点击按钮时，数据已经在内存中了
    Actions.init().catch(e => console.error("[Worldbook Editor] Pre-loading failed:", e));

    console.log("Worldbook Editor Enhanced Script Loaded");
});