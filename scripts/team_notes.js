/* 团队笔记：条目的「共享…」入口（右键 / 长按菜单）与「设置 → 数据与同步 → 团队笔记」分区。

   共享关系记在服务端（谁把哪一篇共享给了谁、对方同意了没有），客户端只做三件事：
     · 发起与应答：邀请某个账户、同意 / 拒绝收到的请求、撤销自己发出的、退出已加入的；
     · 读回投影：别人共享过来的笔记落在 shared/<所有者 id>/<条目 id>.md（见 scripts/store.js），
       在列表里就是一篇普通笔记，改动会推回所有者那份；
     · 更新列表：共享请求不带来任何本地文件改动，因此每轮同步结束后都对一次共享列表。 */

// 最近一次从服务端读到的共享列表（null 表示还没读到或读取失败）
let teamNotesData = null;
// 共享动作进行中：按钮统一置灰，避免连点
let teamNotesBusy = false;
// 上一次读取的时刻：每轮同步结束都会走到这里，短时间内不重复请求
let teamNotesFetchedAt = 0;
// 上一次读到的待确认条数（null 表示还没读到过）：多出来时才提示一次
let teamRequestsKnown = null;
// 这份列表属于哪个本地命名空间（账户 @ 服务器）：换账户后立即作废
let teamNotesScope = '';
const TEAM_NOTES_REFRESH_MS = 5000;

function teamNotesEnabled() {
    return !!State.sync.enabled && typeof Sync !== 'undefined' && Sync.supportsSync();
}

// 这份缓存能不能直接用：账户没换过且不久之前刚读过
function teamNotesCacheFresh() {
    return !!teamNotesData && teamNotesScope === Sync.scope
        && Date.now() - teamNotesFetchedAt < TEAM_NOTES_REFRESH_MS;
}

function setTeamNotesStatus(text, tone) {
    const status = document.getElementById('team-status');
    if (!status) return;
    status.textContent = text;
    status.dataset.tone = tone || '';
}

/* ---------------- 读取 ---------------- */

async function loadTeamNotes() {
    if (!teamNotesEnabled()) {
        teamNotesData = null;
        teamNotesScope = '';
        teamRequestsKnown = null;
        teamNotesFetchedAt = Date.now();
        return null;
    }
    const result = await Sync.listShares();
    if (!result.ok) {
        teamNotesData = null;
        setTeamNotesStatus(`读取共享列表失败：${result.error || '与服务器通信异常'}`, 'error');
    } else {
        const data = result.data || {};
        teamNotesData = {
            ...data,
            // 三个列表都按数组兜底：服务端版本偏旧时不会留下读到一半的界面
            incoming: Array.isArray(data.incoming) ? data.incoming : [],
            received: Array.isArray(data.received) ? data.received : [],
            outgoing: Array.isArray(data.outgoing) ? data.outgoing : []
        };
        teamNotesScope = Sync.scope;
    }
    teamNotesFetchedAt = Date.now();
    announceTeamRequests();
    return teamNotesData;
}

// 立即刷新（按钮与共享动作之后走这里）
async function refreshTeamNotes() {
    await loadTeamNotes();
    syncTeamNotesSettingsUI();
}

/* 每轮同步结束后调用：账户没换过且刚读过就只重画列表，不重复请求服务端 */
function refreshTeamNotesSoon() {
    if (!teamNotesEnabled()) {
        teamNotesData = null;
        teamNotesScope = '';
        syncTeamNotesSettingsUI();
        return;
    }
    if (teamNotesCacheFresh()) {
        syncTeamNotesSettingsUI();
        return;
    }
    refreshTeamNotes().catch((error) => {
        console.warn(`[WARN] [TeamNotes] 刷新共享列表失败: ${error && error.message}`);
    });
}

/* 新到的共享请求只有服务端知道（它不带来任何本地文件改动），因此每轮同步结束后都会读一次列表；
   待确认条数比上一次多时提示一句，多出来的那几条才不至于没人看见。 */
function announceTeamRequests() {
    if (!teamNotesData) return;
    const pending = teamNotesData.incoming.length;
    if (teamRequestsKnown !== null && pending > teamRequestsKnown) {
        showToast(`收到 ${pending - teamRequestsKnown} 条共享请求：可在「设置 → 数据与同步 → 团队笔记」中处理`);
    }
    teamRequestsKnown = pending;
}

/* ---------------- 设置页列表 ---------------- */

// 共享记录对应的本地条目 id：接收方那边是 shared:<所有者 id>:<条目 id>，所有者那边就是条目 id
function teamLocalItemId(record, isOwner) {
    return isOwner ? String(record.noteId) : sharedItemId(record.owner, record.noteId);
}

// 标题优先取本地那一篇（刚改过名字时更及时），拿不到才用服务端给的
function teamNoteTitle(record, isOwner) {
    const item = getItemById(teamLocalItemId(record, isOwner));
    if (item) return itemDisplayTitle(item);
    return record.title || '未命名笔记';
}

function createTeamRow(icon, title, meta) {
    const row = document.createElement('div');
    row.className = 'team-item';

    const main = document.createElement('div');
    main.className = 'team-item-main';
    const iconEl = document.createElement('span');
    iconEl.className = 'ms-icon sm';
    iconEl.textContent = icon;
    const text = document.createElement('div');
    text.className = 'team-item-text';
    const titleEl = document.createElement('span');
    titleEl.className = 'team-item-title';
    titleEl.textContent = title;
    const metaEl = document.createElement('span');
    metaEl.className = 'team-item-meta';
    metaEl.textContent = meta;
    text.append(titleEl, metaEl);
    main.append(iconEl, text);

    const actions = document.createElement('div');
    actions.className = 'team-item-actions';

    row.append(main, actions);
    return { row, actions };
}

function teamActionButton(label, title, variant, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = variant ? `settings-btn ${variant}` : 'settings-btn';
    button.textContent = label;
    if (title) button.title = title;
    button.disabled = teamNotesBusy;
    button.onclick = onClick;
    return button;
}

function teamEmptyRow(text) {
    const empty = document.createElement('div');
    empty.className = 'team-empty';
    empty.textContent = text;
    return empty;
}

// 打开本地那一篇：共享过来的条目进的是同一套标签页（id 带 shared: 前缀）
function openTeamNote(record, isOwner) {
    const itemId = teamLocalItemId(record, isOwner);
    if (!getItemById(itemId)) {
        showToast('这篇笔记还没同步到本地：同步一次后即可打开');
        return;
    }
    flushPendingSave();
    openTab(itemId);
    renderApp();
}

function syncTeamNotesSettingsUI() {
    const requests = document.getElementById('team-requests');
    const shared = document.getElementById('team-shared');
    if (!requests || !shared) return;

    requests.innerHTML = '';
    shared.innerHTML = '';

    if (!teamNotesEnabled()) {
        requests.appendChild(teamEmptyRow('尚未连接到服务端：登录后即可收发共享请求。'));
        shared.appendChild(teamEmptyRow('暂无共享。'));
        setTeamNotesStatus('尚未连接到服务端：不会读取也不会发出任何共享请求。');
        return;
    }

    const data = teamNotesData;
    if (!data) {
        requests.appendChild(teamEmptyRow('尚未读到共享列表：点「刷新」重试。'));
        shared.appendChild(teamEmptyRow('暂无共享。'));
        return;
    }

    // 1. 收到的请求：同意之前那篇笔记不会出现在本地
    if (!data.incoming.length) {
        requests.appendChild(teamEmptyRow('暂无共享请求：别人把笔记共享过来时会出现在这里。'));
    } else {
        data.incoming.forEach((record) => {
            const { row, actions } = createTeamRow(
                'mark_email_unread',
                `${record.ownerName} 请求共享《${teamNoteTitle(record, false)}》`,
                `来自账户 ${record.owner} · 同意后这篇笔记会同时出现在双方的笔记列表里`
            );
            actions.append(
                teamActionButton('拒绝', '不接收这篇笔记，对方会看到请求被拒绝', '', () => respondTeamShare(record, false)),
                teamActionButton('同意', '接收这篇笔记并立即同步到本地', 'primary', () => respondTeamShare(record, true))
            );
            requests.appendChild(row);
        });
    }

    // 2. 共享到手与共享出去的：一个列表里按角色分别说明
    const rows = [];
    data.received.forEach((record) => {
        const local = getItemById(teamLocalItemId(record, false));
        rows.push({
            record,
            isOwner: false,
            icon: 'group',
            title: `来自 ${record.ownerName}：《${teamNoteTitle(record, false)}》`,
            meta: local ? '共享笔记：正文可以直接编辑，改动会同步给所有者' : '尚未同步到本地：同步一次后即可打开'
        });
    });
    data.outgoing.forEach((record) => {
        rows.push({
            record,
            isOwner: true,
            icon: 'share',
            title: `《${teamNoteTitle(record, true)}》 → ${record.targetName}`,
            meta: record.status === 'accepted' ? '已共享：对方可以编辑这篇笔记' : '等待对方同意'
        });
    });

    if (!rows.length) {
        shared.appendChild(teamEmptyRow('暂无共享：右键一篇笔记选「共享…」即可邀请某个账户。'));
    } else {
        rows.forEach((entry) => {
            const { row, actions } = createTeamRow(entry.icon, entry.title, entry.meta);
            if (entry.isOwner) {
                actions.append(
                    teamActionButton('打开', '在标签页打开这篇笔记', '', () => openTeamNote(entry.record, true)),
                    teamActionButton('撤销', '停止与这个账户共享，对方本地那份会随之移除', '', () => revokeTeamShare(entry.record))
                );
            } else {
                actions.append(
                    teamActionButton('打开', '在标签页打开这篇笔记', '', () => openTeamNote(entry.record, false)),
                    teamActionButton('退出共享', '从列表中移除这篇笔记，所有者那份不受影响', '', () => leaveTeamShare(entry.record))
                );
            }
            shared.appendChild(row);
        });
    }

    const total = data.incoming.length + data.received.length + data.outgoing.length;
    setTeamNotesStatus(total
        ? `共 ${total} 条：待确认 ${data.incoming.length} 条 · 已共享到手 ${data.received.length} 条 · 已共享出去 ${data.outgoing.length} 条`
        : `暂无共享记录（账户 ${data.user || State.sync.account || '未知'}）。`);
}

/* ---------------- 共享动作 ---------------- */

// 动作进行中把列表里的按钮一并置灰
function setTeamActionButtonsDisabled(disabled) {
    document.querySelectorAll('#settings-content .team-item-actions button').forEach((button) => {
        button.disabled = disabled;
    });
}

/* 共享动作之后 Sync.shareAction 追了一次同步：本地文件确有改动时它自己会重载界面，
   这里只按结果写状态行与提示。 */
function applyTeamShareResult(result, message) {
    if (result && result.syncError) {
        setTeamNotesStatus(`${message}；但同步未成功：${result.syncError}`, 'error');
        showToast(`${message}（同步未成功）`);
        return;
    }
    showToast(message);
}

async function runTeamShareAction(pathname, payload, pendingText) {
    if (teamNotesBusy) return null;
    teamNotesBusy = true;
    setTeamActionButtonsDisabled(true);
    setTeamNotesStatus(pendingText);
    try {
        const result = await Sync.shareAction(pathname, payload);
        if (!result.ok) {
            setTeamNotesStatus(`操作失败：${result.error || '与服务器通信异常'}`, 'error');
            return null;
        }
        return result;
    } finally {
        teamNotesBusy = false;
        setTeamActionButtonsDisabled(false);
    }
}

async function respondTeamShare(record, accept) {
    if (!accept) {
        const confirmed = await showConfirm(`拒绝《${teamNoteTitle(record, false)}》的共享请求？`, {
            title: '拒绝共享',
            detail: `${record.ownerName} 会看到这条请求被拒绝；对方可以再次发出请求。`,
            type: 'warning',
            icon: 'block',
            confirmLabel: '拒绝',
            danger: true
        });
        if (!confirmed) return;
    }

    const result = await runTeamShareAction('/shares/respond', { id: record.id, accept },
        accept ? '正在同意并同步…' : '正在拒绝…');
    if (result) applyTeamShareResult(result, accept ? '已同意共享' : '已拒绝共享请求');
    await refreshTeamNotes();
}

async function revokeTeamShare(record) {
    const confirmed = await showConfirm(`撤销与 ${record.targetName} 的共享？`, {
        title: '撤销共享',
        detail: `撤销后《${teamNoteTitle(record, true)}》会从对方的数据里移除；对方此前改过的内容仍留在笔记里。`,
        type: 'warning',
        icon: 'link_off',
        confirmLabel: '撤销共享',
        danger: true
    });
    if (!confirmed) return;

    const result = await runTeamShareAction('/shares/revoke', { id: record.id }, '正在撤销共享…');
    if (result) applyTeamShareResult(result, '已撤销共享');
    await refreshTeamNotes();
}

async function leaveTeamShare(record) {
    const confirmed = await showConfirm(`退出《${teamNoteTitle(record, false)}》的共享？`, {
        title: '退出共享',
        detail: `这篇笔记由 ${record.ownerName} 共享过来；退出后它会从本地列表中移除，对方那份不受影响。`,
        type: 'warning',
        icon: 'link_off',
        confirmLabel: '退出共享',
        danger: true
    });
    if (!confirmed) return;

    const result = await runTeamShareAction('/shares/leave', { id: record.id }, '正在退出共享…');
    if (result) applyTeamShareResult(result, '已退出共享');
    await refreshTeamNotes();
}

/* ---------------- 菜单入口 ---------------- */

// 条目菜单 →「共享…」：输入对方的账户 ID 或账户名，发出共享请求
async function shareNoteFromMenu(itemId) {
    const item = getItemById(itemId);
    if (!item) return;
    if (isTodoItem(item)) {
        showToast('团队笔记目前只支持笔记');
        return;
    }
    if (isSharedItem(item)) {
        showToast('这是别人共享过来的笔记，无法再次共享');
        return;
    }
    if (!teamNotesEnabled()) {
        showToast('共享需要先连接到服务端');
        return;
    }

    const data = await loadTeamNotes();
    if (!data) {
        showToast('读取共享列表失败：请先在设置里确认服务端连接');
        return;
    }

    const notePath = itemPath(item);
    const existing = data.outgoing.filter((record) => record.note === notePath);
    const summary = existing.length
        ? `已共享给：${existing.map((record) => `${record.targetName}（${record.status === 'accepted' ? '已同意' : '待确认'}）`).join('、')}`
        : '尚未共享给任何人';

    const target = await showPrompt(`把《${itemDisplayTitle(item)}》共享给谁？`, {
        title: '共享笔记',
        icon: 'share',
        label: '对方的用户 ID',
        placeholder: '例如：alice',
        confirmLabel: '发送请求',
        detail: `${summary}。填写对方的用户 ID 或账户名：对方在「设置 → 数据与同步 → 团队笔记」里同意之后，`
            + '这篇笔记会同时出现在双方的笔记列表里，双方都能编辑；共享者可以随时在同一个分区里撤销。'
    });
    if (target === null) return;

    const wanted = String(target).trim();
    if (!wanted) {
        showToast('请填写对方的用户 ID');
        return;
    }

    teamNotesBusy = true;
    setTeamNotesStatus('正在共享…');
    try {
        /* 先把本机改动推上去：服务端只接受它已经见过的笔记。
           同步失败不影响这一步，真正的失败原因由下面的请求返回。 */
        flushPendingSave();
        await Sync.syncNow({ reason: '共享' });
    } catch (error) {
        console.warn(`[WARN] [TeamNotes] 共享前的同步失败: ${error && error.message}`);
    } finally {
        teamNotesBusy = false;
    }

    const result = await runTeamShareAction('/shares/request', { path: notePath, target: wanted }, '正在共享…');
    if (result) {
        showToast(`已向 ${wanted} 发出共享请求`);
        setTeamNotesStatus(`已向 ${wanted} 发出共享请求；对方同意后这篇笔记会出现在双方的列表里。`);
    }
    await refreshTeamNotes();
}

// 条目菜单 →「退出共享」：共享过来的笔记只能这样从列表里移除
async function leaveSharedNoteFromMenu(itemId) {
    const item = getItemById(itemId);
    if (!isSharedItem(item)) return;

    const data = teamNotesData || await loadTeamNotes();
    const record = data
        ? data.received.find((entry) => entry.owner === item.shared.owner && entry.noteId === item.shared.noteId)
        : null;
    if (!record) {
        showToast('找不到这条共享记录：请先在设置里刷新「团队笔记」');
        return;
    }
    await leaveTeamShare(record);
}

/* ---------------- 初始化 ----------------
   「刷新」按钮与列表渲染都挂在设置面板的绑定流程里（见 scripts/settings.js 的 bindDataSyncPanel）：
   设置面板每次进入都会重建 DOM，绑定因此必须跟着重建一起做。 */
