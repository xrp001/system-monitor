const { GLib, GObject, St, Clutter } = imports.gi;
const ByteArray = imports.byteArray;

const Main = imports.ui.main;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;
const ExtensionUtils = imports.misc.extensionUtils;

const SETTINGS_SCHEMA = 'org.gnome.shell.extensions.system-monitor-beautiful';
const REFRESH_INTERVAL_OPTIONS = [1, 2, 3, 5, 10];

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

class ProcfsSampler {
    constructor() {
        this._previousCpu = null;
        this._previousNetwork = null;
        this._activeInterface = null;
        this._smoothedDownloadRate = null;
        this._smoothedUploadRate = null;
    }

    sample() {
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

        this._buildPanel();
        this._buildMenu();

        this._settingsChangedSignals.push(
            this._settings.connect('changed::refresh-interval', () => {
                this._syncRefreshMenu();
                this._restartTimer();
            })
        );

        this._syncRefreshMenu();
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

    _getRefreshInterval() {
        const configured = this._settings.get_int('refresh-interval');
        return clamp(configured || 1, 1, 60);
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
        const sample = this._sampler.sample();

        this._cpuLabel.text = `CPU ${formatPercent(sample.cpuUsage)}`;
        this._memoryLabel.text = `MEM ${formatPercent(sample.memoryUsage)}`;
        this._networkLabel.text = `↓${formatRate(sample.downloadRate, true)} ↑${formatRate(sample.uploadRate, true)}`;

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