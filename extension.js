const { Gio, GLib, GObject, St, Clutter } = imports.gi;
const ByteArray = imports.byteArray;

const Main = imports.ui.main;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;
const ExtensionUtils = imports.misc.extensionUtils;

const SETTINGS_SCHEMA = 'org.gnome.shell.extensions.system-monitor-beautiful';
const REFRESH_INTERVAL_OPTIONS = [1, 2, 3, 5, 10];
const CPU_ALERT_THRESHOLD_KEY = 'cpu-alert-threshold';
const MEMORY_ALERT_THRESHOLD_KEY = 'memory-alert-threshold';
const SHOW_PROCESS_RANKING_KEY = 'show-process-ranking';
const PROCESS_RANKING_LIMIT_KEY = 'process-ranking-limit';
const PROCESS_RANKING_MIN = 1;
const PROCESS_RANKING_MAX = 10;

function runCommand(command) {
    try {
        const [ok, stdout] = GLib.spawn_command_line_sync(command);
        if (!ok)
            return null;

        return ByteArray.toString(stdout);
    } catch (error) {
        log(`[system-monitor-beautiful] Failed to run ${command}: ${error.message}`);
        return null;
    }
}

function getPageSize() {
    if (typeof GLib.get_page_size === 'function')
        return GLib.get_page_size();

    const output = runCommand('getconf PAGESIZE');
    const value = Number.parseInt((output || '').trim(), 10);
    return Number.isNaN(value) || value <= 0 ? 4096 : value;
}

function readTextFile(path) {
    try {
        const [ok, contents] = GLib.file_get_contents(path);
        if (!ok)
            return null;

        return ByteArray.toString(contents);
    } catch (error) {
        log(`[system-monitor-beautiful] Failed to read ${path}: ${error.message}`);
        return null;
    }
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function formatPercent(value) {
    if (value === null || Number.isNaN(value))
        return '--';

    return `${Math.round(value)}%`;
}

function formatBytes(value) {
    if (value === null || value === undefined || Number.isNaN(value))
        return '--';

    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    let index = 0;
    let scaled = value;

    while (scaled >= 1024 && index < units.length - 1) {
        scaled /= 1024;
        index += 1;
    }

    const digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 1;
    return `${scaled.toFixed(digits)} ${units[index]}`;
}

function formatRate(value, compact = false) {
    if (value === null || value === undefined || Number.isNaN(value) || value < 0)
        return compact ? '--' : '-- B/s';

    const units = compact
        ? ['B', 'K', 'M', 'G', 'T']
        : ['B/s', 'KiB/s', 'MiB/s', 'GiB/s', 'TiB/s'];

    let index = 0;
    let scaled = value;

    while (scaled >= 1024 && index < units.length - 1) {
        scaled /= 1024;
        index += 1;
    }

    const digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 1;
    return `${scaled.toFixed(digits)}${compact ? units[index] : ` ${units[index]}`}`;
}

function formatProcessIdentity(process) {
    const label = process?.name || 'unknown';
    const pid = process?.pid ?? '--';
    return `${label} (${pid})`;
}

function toggleStyleClass(actor, className, enabled) {
    if (!actor)
        return;

    if (enabled)
        actor.add_style_class_name(className);
    else
        actor.remove_style_class_name(className);
}

class ProcfsSampler {
    constructor() {
        this._previousCpu = null;
        this._previousNetwork = null;
        this._activeInterface = null;
        this._smoothedDownloadRate = null;
        this._smoothedUploadRate = null;
        this._previousProcessCpu = null;
        this._previousProcessNetwork = null;
        this._pageSize = getPageSize();
        this._cpuCount = Math.max(1, GLib.get_num_processors());
    }

    sample(options = {}) {
        const includeProcessRanking = options.includeProcessRanking ?? false;
        const processLimit = clamp(options.processLimit ?? 3, PROCESS_RANKING_MIN, PROCESS_RANKING_MAX);
        const timestampUs = GLib.get_monotonic_time();
        const cpuSnapshot = this._readCpuSnapshot();
        const memorySnapshot = this._readMemorySnapshot();
        const networkSnapshot = this._readNetworkSnapshot();
        const activeInterface = this._selectNetworkInterface(networkSnapshot);

        let cpuUsage = null;
        if (this._previousCpu && cpuSnapshot) {
            const totalDelta = cpuSnapshot.total - this._previousCpu.total;
            const idleDelta = cpuSnapshot.idle - this._previousCpu.idle;

            if (totalDelta > 0)
                cpuUsage = clamp(((totalDelta - idleDelta) / totalDelta) * 100, 0, 100);
        }

        let downloadRate = null;
        let uploadRate = null;

        if (this._previousNetwork && activeInterface) {
            const current = networkSnapshot[activeInterface];
            const previous = this._previousNetwork.interfaces[activeInterface];
            const elapsedSeconds = (timestampUs - this._previousNetwork.timestampUs) / 1_000_000;

            if (current && previous && elapsedSeconds > 0) {
                const rxDelta = Math.max(0, current.rxBytes - previous.rxBytes);
                const txDelta = Math.max(0, current.txBytes - previous.txBytes);

                downloadRate = rxDelta / elapsedSeconds;
                uploadRate = txDelta / elapsedSeconds;
            }
        }

        downloadRate = this._smoothRate(downloadRate, '_smoothedDownloadRate');
        uploadRate = this._smoothRate(uploadRate, '_smoothedUploadRate');

        let processRanking = null;
        if (includeProcessRanking) {
            processRanking = this._sampleProcessRanking({
                processLimit,
                timestampUs,
                cpuSnapshot,
            });
        } else {
            this._previousProcessCpu = null;
            this._previousProcessNetwork = null;
        }

        this._previousCpu = cpuSnapshot;
        this._previousNetwork = {
            timestampUs,
            interfaces: networkSnapshot,
        };
        this._activeInterface = activeInterface;

        return {
            cpuUsage,
            memoryTotal: memorySnapshot.totalBytes,
            memoryUsed: memorySnapshot.usedBytes,
            memoryUsage: memorySnapshot.usagePercent,
            downloadRate,
            uploadRate,
            activeInterface,
            processRanking,
        };
    }

    _sampleProcessRanking({ processLimit, timestampUs, cpuSnapshot }) {
        const processes = this._readProcessSnapshots();
        const networkSnapshot = this._readPerProcessNetworkSnapshot();
        const hadPreviousProcessCpu = this._previousProcessCpu !== null;
        const hadPreviousProcessNetwork = this._previousProcessNetwork !== null;
        const cpuTotalDelta = this._previousCpu && cpuSnapshot
            ? Math.max(0, cpuSnapshot.total - this._previousCpu.total)
            : 0;
        const networkElapsedSeconds = this._previousProcessNetwork
            ? Math.max(0, (timestampUs - this._previousProcessNetwork.timestampUs) / 1_000_000)
            : 0;

        const cpuRanking = [];
        const memoryRanking = [];
        const networkRanking = [];

        for (const process of processes.values()) {
            memoryRanking.push(process);

            if (!this._previousProcessCpu || cpuTotalDelta <= 0)
                continue;

            const previousProcess = this._previousProcessCpu.get(process.pid);
            if (!previousProcess)
                continue;

            const cpuDelta = Math.max(0, process.cpuTime - previousProcess.cpuTime);
            if (cpuDelta <= 0)
                continue;

            cpuRanking.push({
                pid: process.pid,
                name: process.name,
                cpuUsage: (cpuDelta / cpuTotalDelta) * this._cpuCount * 100,
            });
        }

        for (const process of networkSnapshot.values()) {
            if (!this._previousProcessNetwork || networkElapsedSeconds <= 0)
                continue;

            const previousProcess = this._previousProcessNetwork.processes.get(process.pid);
            if (!previousProcess)
                continue;

            const downloadBytes = Math.max(0, process.downloadBytes - previousProcess.downloadBytes);
            const uploadBytes = Math.max(0, process.uploadBytes - previousProcess.uploadBytes);
            const totalBytes = downloadBytes + uploadBytes;
            if (totalBytes <= 0)
                continue;

            networkRanking.push({
                pid: process.pid,
                name: process.name,
                downloadRate: downloadBytes / networkElapsedSeconds,
                uploadRate: uploadBytes / networkElapsedSeconds,
                totalRate: totalBytes / networkElapsedSeconds,
            });
        }

        const nextProcessCpu = new Map();
        for (const process of processes.values()) {
            nextProcessCpu.set(process.pid, {
                cpuTime: process.cpuTime,
                name: process.name,
            });
        }
        this._previousProcessCpu = nextProcessCpu;
        this._previousProcessNetwork = {
            timestampUs,
            processes: networkSnapshot,
        };

        return {
            cpuReady: hadPreviousProcessCpu && cpuTotalDelta > 0,
            networkReady: hadPreviousProcessNetwork && networkElapsedSeconds > 0,
            cpu: cpuRanking
                .sort((left, right) => right.cpuUsage - left.cpuUsage)
                .slice(0, processLimit),
            memory: memoryRanking
                .sort((left, right) => right.memoryBytes - left.memoryBytes)
                .slice(0, processLimit),
            network: networkRanking
                .sort((left, right) => right.totalRate - left.totalRate)
                .slice(0, processLimit),
        };
    }

    _smoothRate(value, key) {
        if (value === null || value === undefined || Number.isNaN(value)) {
            this[key] = null;
            return null;
        }

        const alpha = 0.35;
        if (this[key] === null) {
            this[key] = value;
            return value;
        }

        this[key] = (alpha * value) + ((1 - alpha) * this[key]);
        return this[key];
    }

    _readCpuSnapshot() {
        const text = readTextFile('/proc/stat');
        if (!text)
            return null;

        const line = text.split('\n').find(currentLine => currentLine.startsWith('cpu '));
        if (!line)
            return null;

        const parts = line.trim().split(/\s+/).slice(1).map(Number);
        if (parts.length < 4 || parts.some(Number.isNaN))
            return null;

        const idle = (parts[3] || 0) + (parts[4] || 0);
        const total = parts.reduce((sum, value) => sum + value, 0);
        return { idle, total };
    }

    _readMemorySnapshot() {
        const text = readTextFile('/proc/meminfo');
        if (!text)
            return { totalBytes: null, usedBytes: null, usagePercent: null };

        const values = {};
        for (const line of text.split('\n')) {
            const match = line.match(/^(\w+):\s+(\d+)\s+kB$/);
            if (!match)
                continue;

            values[match[1]] = Number(match[2]) * 1024;
        }

        const totalBytes = values.MemTotal ?? null;
        const availableBytes = values.MemAvailable ?? values.MemFree ?? null;

        if (!totalBytes || !availableBytes)
            return { totalBytes, usedBytes: null, usagePercent: null };

        const usedBytes = Math.max(0, totalBytes - availableBytes);
        const usagePercent = clamp((usedBytes / totalBytes) * 100, 0, 100);

        return { totalBytes, usedBytes, usagePercent };
    }

    _readProcessSnapshots() {
        const snapshots = new Map();

        try {
            const procDir = Gio.File.new_for_path('/proc');
            const enumerator = procDir.enumerate_children(
                'standard::name',
                Gio.FileQueryInfoFlags.NONE,
                null
            );

            let info;
            while ((info = enumerator.next_file(null)) !== null) {
                const entry = info.get_name();
                if (!/^\d+$/.test(entry))
                    continue;

                const statText = readTextFile(`/proc/${entry}/stat`);
                if (!statText)
                    continue;

                const parsed = this._parseProcessStat(statText.trim());
                if (!parsed)
                    continue;

                snapshots.set(parsed.pid, parsed);
            }

            enumerator.close(null);
        } catch (error) {
            log(`[system-monitor-beautiful] Failed to read /proc process list: ${error.message}`);
        }

        return snapshots;
    }

    _parseProcessStat(text) {
        const leftParenthesis = text.indexOf('(');
        const rightParenthesis = text.lastIndexOf(')');
        if (leftParenthesis <= 0 || rightParenthesis <= leftParenthesis)
            return null;

        const pid = Number(text.slice(0, leftParenthesis).trim());
        const name = text.slice(leftParenthesis + 1, rightParenthesis).trim();
        const fields = text.slice(rightParenthesis + 2).trim().split(/\s+/);

        if (fields.length < 22 || Number.isNaN(pid))
            return null;

        const utime = Number(fields[11]);
        const stime = Number(fields[12]);
        const rssPages = Number(fields[21]);
        if ([utime, stime, rssPages].some(Number.isNaN))
            return null;

        return {
            pid,
            name,
            cpuTime: utime + stime,
            memoryBytes: Math.max(0, rssPages) * this._pageSize,
        };
    }

    _readPerProcessNetworkSnapshot() {
        const text = runCommand('ss -tinpH');
        const snapshots = new Map();

        if (!text)
            return snapshots;

        let currentProcesses = [];
        for (const line of text.split('\n')) {
            if (!line)
                continue;

            if (/^\s/.test(line)) {
                if (currentProcesses.length === 0)
                    continue;

                const sentMatch = line.match(/bytes_sent:(\d+)/);
                const receivedMatch = line.match(/bytes_received:(\d+)/);
                if (!sentMatch || !receivedMatch)
                    continue;

                const uploadBytes = Number(sentMatch[1]);
                const downloadBytes = Number(receivedMatch[1]);
                for (const process of currentProcesses) {
                    const existing = snapshots.get(process.pid) ?? {
                        pid: process.pid,
                        name: process.name,
                        downloadBytes: 0,
                        uploadBytes: 0,
                    };

                    existing.downloadBytes += downloadBytes;
                    existing.uploadBytes += uploadBytes;
                    snapshots.set(process.pid, existing);
                }

                continue;
            }

            currentProcesses = [];
            const regex = /\("([^"]+)",pid=(\d+)/g;
            let match;
            while ((match = regex.exec(line)) !== null) {
                const pid = Number(match[2]);
                if (Number.isNaN(pid))
                    continue;

                currentProcesses.push({
                    pid,
                    name: match[1],
                });
            }
        }

        return snapshots;
    }

    _readNetworkSnapshot() {
        const text = readTextFile('/proc/net/dev');
        if (!text)
            return {};

        const snapshots = {};
        for (const line of text.split('\n').slice(2)) {
            if (!line.includes(':'))
                continue;

            const [rawName, rawStats] = line.split(':', 2);
            const name = rawName.trim();
            const stats = rawStats.trim().split(/\s+/).map(Number);
            if (stats.length < 16 || stats.some(Number.isNaN))
                continue;

            snapshots[name] = {
                rxBytes: stats[0],
                txBytes: stats[8],
            };
        }

        return snapshots;
    }

    _selectNetworkInterface(networkSnapshot) {
        if (this._activeInterface && networkSnapshot[this._activeInterface])
            return this._activeInterface;

        const defaultInterface = this._readDefaultRouteInterface();
        if (defaultInterface && networkSnapshot[defaultInterface])
            return defaultInterface;

        const candidates = Object.entries(networkSnapshot)
            .filter(([name]) => name !== 'lo')
            .sort((left, right) => {
                const leftTotal = left[1].rxBytes + left[1].txBytes;
                const rightTotal = right[1].rxBytes + right[1].txBytes;
                return rightTotal - leftTotal;
            });

        return candidates.length > 0 ? candidates[0][0] : null;
    }

    _readDefaultRouteInterface() {
        const text = readTextFile('/proc/net/route');
        if (!text)
            return null;

        const lines = text.split('\n').slice(1);
        for (const line of lines) {
            const parts = line.trim().split(/\s+/);
            if (parts.length < 2)
                continue;

            const iface = parts[0];
            const destination = parts[1];
            if (destination === '00000000' && iface !== 'lo')
                return iface;
        }

        return null;
    }
}

const SystemMonitorIndicator = GObject.registerClass(
class SystemMonitorIndicator extends PanelMenu.Button {
    _init() {
        super._init(0.0, 'System Monitor Beautiful', false);

        this._settings = ExtensionUtils.getSettings(SETTINGS_SCHEMA);
        this._sampler = new ProcfsSampler();
        this._timeoutId = 0;
        this._settingsChangedSignals = [];
        this._refreshItems = new Map();
        this._processCpuItems = [];
        this._processMemoryItems = [];
        this._processNetworkItems = [];

        this._buildPanel();
        this._buildMenu();

        this._settingsChangedSignals.push(
            this._settings.connect('changed::refresh-interval', () => {
                this._syncRefreshMenu();
                this._restartTimer();
            })
        );
        this._settingsChangedSignals.push(
            this._settings.connect(`changed::${CPU_ALERT_THRESHOLD_KEY}`, () => {
                this._update();
            })
        );
        this._settingsChangedSignals.push(
            this._settings.connect(`changed::${MEMORY_ALERT_THRESHOLD_KEY}`, () => {
                this._update();
            })
        );
        this._settingsChangedSignals.push(
            this._settings.connect(`changed::${SHOW_PROCESS_RANKING_KEY}`, () => {
                this._syncProcessRankingControls();
                this._update();
            })
        );
        this._settingsChangedSignals.push(
            this._settings.connect(`changed::${PROCESS_RANKING_LIMIT_KEY}`, () => {
                this._rebuildProcessRankingMenu();
                this._syncProcessRankingControls();
                this._update();
            })
        );

        this._syncRefreshMenu();
        this._syncProcessRankingControls();
        this._restartTimer();
    }

    _buildPanel() {
        this.add_style_class_name('system-monitor-indicator');

        this._panelBox = new St.BoxLayout({
            style_class: 'system-monitor-box',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._cpuLabel = new St.Label({
            text: 'CPU --',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'system-monitor-chip chip-cpu',
        });
        this._memoryLabel = new St.Label({
            text: 'MEM --',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'system-monitor-chip chip-memory',
        });
        this._networkLabel = new St.Label({
            text: '↓-- ↑--',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'system-monitor-chip chip-network',
        });

        this._panelBox.add_child(this._cpuLabel);
        this._panelBox.add_child(this._memoryLabel);
        this._panelBox.add_child(this._networkLabel);
        this.add_child(this._panelBox);
    }

    _buildMenu() {
        this._overviewItem = new PopupMenu.PopupMenuItem('系统状态', { reactive: false, can_focus: false });
        this._overviewItem.label.add_style_class_name('system-monitor-menu-title');
        this.menu.addMenuItem(this._overviewItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._cpuDetailItem = new PopupMenu.PopupMenuItem('CPU: --', { reactive: false, can_focus: false });
        this._memoryDetailItem = new PopupMenu.PopupMenuItem('内存: --', { reactive: false, can_focus: false });
        this._networkDetailItem = new PopupMenu.PopupMenuItem('网络: --', { reactive: false, can_focus: false });

        this.menu.addMenuItem(this._cpuDetailItem);
        this.menu.addMenuItem(this._memoryDetailItem);
        this.menu.addMenuItem(this._networkDetailItem);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._processRankingSwitch = new PopupMenu.PopupSwitchMenuItem('显示进程排行', this._getShowProcessRanking());
        this._processRankingSwitch.connect('toggled', (_item, state) => {
            if (this._settings.get_boolean(SHOW_PROCESS_RANKING_KEY) !== state)
                this._settings.set_boolean(SHOW_PROCESS_RANKING_KEY, state);
        });
        this.menu.addMenuItem(this._processRankingSwitch);

        this._processRankingSubMenu = new PopupMenu.PopupSubMenuMenuItem('进程排行');
        this.menu.addMenuItem(this._processRankingSubMenu);
        this._rebuildProcessRankingMenu();

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._refreshSubMenu = new PopupMenu.PopupSubMenuMenuItem('刷新间隔');
        this.menu.addMenuItem(this._refreshSubMenu);

        for (const interval of REFRESH_INTERVAL_OPTIONS) {
            const item = new PopupMenu.PopupMenuItem(`${interval} 秒`);
            item.connect('activate', () => {
                this._settings.set_int('refresh-interval', interval);
            });
            this._refreshSubMenu.menu.addMenuItem(item);
            this._refreshItems.set(interval, item);
        }
    }

    _syncRefreshMenu() {
        const current = this._getRefreshInterval();
        for (const [interval, item] of this._refreshItems.entries()) {
            item.setOrnament(interval === current
                ? PopupMenu.Ornament.DOT
                : PopupMenu.Ornament.NONE);
        }
        this._refreshSubMenu.label.text = `刷新间隔：${current} 秒`;
    }

    _createMenuLabelItem(text) {
        return new PopupMenu.PopupMenuItem(text, { reactive: false, can_focus: false });
    }

    _rebuildProcessRankingMenu() {
        for (const item of [
            ...(this._processMenuItems ?? []),
        ]) {
            item.destroy();
        }

        this._processMenuItems = [];
        this._processCpuItems = [];
        this._processMemoryItems = [];
        this._processNetworkItems = [];

        const limit = this._getProcessRankingLimit();
        this._processRankingSubMenu.label.text = `进程排行（前 ${limit}）`;

        const cpuTitle = this._createMenuLabelItem('CPU Top');
        cpuTitle.label.add_style_class_name('system-monitor-menu-title');
        this._processRankingSubMenu.menu.addMenuItem(cpuTitle);
        this._processMenuItems.push(cpuTitle);

        for (let index = 0; index < limit; index += 1) {
            const item = this._createMenuLabelItem('--');
            this._processRankingSubMenu.menu.addMenuItem(item);
            this._processCpuItems.push(item);
            this._processMenuItems.push(item);
        }

        const memorySeparator = new PopupMenu.PopupSeparatorMenuItem();
        this._processRankingSubMenu.menu.addMenuItem(memorySeparator);
        this._processMenuItems.push(memorySeparator);

        const memoryTitle = this._createMenuLabelItem('内存 Top');
        memoryTitle.label.add_style_class_name('system-monitor-menu-title');
        this._processRankingSubMenu.menu.addMenuItem(memoryTitle);
        this._processMenuItems.push(memoryTitle);

        for (let index = 0; index < limit; index += 1) {
            const item = this._createMenuLabelItem('--');
            this._processRankingSubMenu.menu.addMenuItem(item);
            this._processMemoryItems.push(item);
            this._processMenuItems.push(item);
        }

        const networkSeparator = new PopupMenu.PopupSeparatorMenuItem();
        this._processRankingSubMenu.menu.addMenuItem(networkSeparator);
        this._processMenuItems.push(networkSeparator);

        const networkTitle = this._createMenuLabelItem('网络 Top');
        networkTitle.label.add_style_class_name('system-monitor-menu-title');
        this._processRankingSubMenu.menu.addMenuItem(networkTitle);
        this._processMenuItems.push(networkTitle);

        for (let index = 0; index < limit; index += 1) {
            const item = this._createMenuLabelItem('--');
            this._processRankingSubMenu.menu.addMenuItem(item);
            this._processNetworkItems.push(item);
            this._processMenuItems.push(item);
        }
    }

    _syncProcessRankingControls() {
        const enabled = this._getShowProcessRanking();
        this._processRankingSwitch.setToggleState(enabled);

        if (this._processRankingSubMenu.actor)
            this._processRankingSubMenu.actor.visible = enabled;
        else
            this._processRankingSubMenu.visible = enabled;
    }

    _getRefreshInterval() {
        const configured = this._settings.get_int('refresh-interval');
        return clamp(configured || 1, 1, 60);
    }

    _getCpuAlertThreshold() {
        return clamp(this._settings.get_int(CPU_ALERT_THRESHOLD_KEY) || 80, 1, 100);
    }

    _getMemoryAlertThreshold() {
        return clamp(this._settings.get_int(MEMORY_ALERT_THRESHOLD_KEY) || 90, 1, 100);
    }

    _getShowProcessRanking() {
        return this._settings.get_boolean(SHOW_PROCESS_RANKING_KEY);
    }

    _getProcessRankingLimit() {
        const configured = this._settings.get_int(PROCESS_RANKING_LIMIT_KEY);
        return clamp(configured || 3, PROCESS_RANKING_MIN, PROCESS_RANKING_MAX);
    }

    _updateRankingSection(items, ranking, formatter, emptyText) {
        for (let index = 0; index < items.length; index += 1) {
            const item = items[index];
            const process = ranking[index];
            item.label.text = process ? formatter(process, index) : (index === 0 ? emptyText : '');
        }
    }

    _updateProcessRankingMenu(processRanking) {
        const enabled = this._getShowProcessRanking();
        if (!enabled || !processRanking) {
            this._updateRankingSection(this._processCpuItems, [], () => '', '已关闭');
            this._updateRankingSection(this._processMemoryItems, [], () => '', '已关闭');
            this._updateRankingSection(this._processNetworkItems, [], () => '', '已关闭');
            return;
        }

        this._updateRankingSection(
            this._processCpuItems,
            processRanking.cpu,
            process => `${formatProcessIdentity(process)} · ${formatPercent(process.cpuUsage)}`,
            processRanking.cpuReady ? '暂无 CPU 变化' : '采样中，请稍候…'
        );
        this._updateRankingSection(
            this._processMemoryItems,
            processRanking.memory,
            process => `${formatProcessIdentity(process)} · ${formatBytes(process.memoryBytes)}`,
            '暂无内存数据'
        );
        this._updateRankingSection(
            this._processNetworkItems,
            processRanking.network,
            process => `${formatProcessIdentity(process)} · ↓${formatRate(process.downloadRate)} ↑${formatRate(process.uploadRate)}`,
            processRanking.networkReady ? '暂无网络变化' : '采样中，请稍候…'
        );
    }

    _restartTimer() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }

        this._update();

        this._timeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            this._getRefreshInterval(),
            () => {
                this._update();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    _update() {
        const sample = this._sampler.sample({
            includeProcessRanking: this._getShowProcessRanking(),
            processLimit: this._getProcessRankingLimit(),
        });
        const cpuAlert = sample.cpuUsage !== null && sample.cpuUsage >= this._getCpuAlertThreshold();
        const memoryAlert = sample.memoryUsage !== null && sample.memoryUsage >= this._getMemoryAlertThreshold();

        this._cpuLabel.text = `CPU ${formatPercent(sample.cpuUsage)}`;
        this._memoryLabel.text = `MEM ${formatPercent(sample.memoryUsage)}`;
        this._networkLabel.text = `↓${formatRate(sample.downloadRate, true)} ↑${formatRate(sample.uploadRate, true)}`;

        toggleStyleClass(this._cpuLabel, 'chip-cpu-alert', cpuAlert);
        toggleStyleClass(this._memoryLabel, 'chip-memory-alert', memoryAlert);

        this._overviewItem.label.text = sample.activeInterface
            ? `接口 ${sample.activeInterface} · 每 ${this._getRefreshInterval()} 秒刷新`
            : `无活动网络接口 · 每 ${this._getRefreshInterval()} 秒刷新`;
        this._cpuDetailItem.label.text = `CPU：${formatPercent(sample.cpuUsage)}`;
        this._memoryDetailItem.label.text = sample.memoryUsed !== null && sample.memoryTotal !== null
            ? `内存：${formatBytes(sample.memoryUsed)} / ${formatBytes(sample.memoryTotal)} (${formatPercent(sample.memoryUsage)})`
            : '内存：--';
        this._networkDetailItem.label.text = sample.activeInterface
            ? `网络：${sample.activeInterface} · ↓${formatRate(sample.downloadRate)} · ↑${formatRate(sample.uploadRate)}`
            : '网络：未检测到活动接口';

        this._updateProcessRankingMenu(sample.processRanking);
    }

    destroy() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }

        for (const signalId of this._settingsChangedSignals)
            this._settings.disconnect(signalId);
        this._settingsChangedSignals = [];

        super.destroy();
    }
});

class Extension {
    constructor() {
        this._indicator = null;
    }

    enable() {
        if (this._indicator)
            return;

        this._indicator = new SystemMonitorIndicator();
        Main.panel.addToStatusArea('system-monitor-beautiful', this._indicator, 0, 'right');
    }

    disable() {
        if (!this._indicator)
            return;

        this._indicator.destroy();
        this._indicator = null;
    }
}

function init() {
    return new Extension();
}