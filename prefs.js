const { Adw, Gtk } = imports.gi;

const ExtensionUtils = imports.misc.extensionUtils;

const SETTINGS_SCHEMA = 'org.gnome.shell.extensions.system-monitor-beautiful';
const REFRESH_INTERVAL_OPTIONS = [1, 2, 3, 5, 10];
const CPU_ALERT_THRESHOLD_KEY = 'cpu-alert-threshold';
const MEMORY_ALERT_THRESHOLD_KEY = 'memory-alert-threshold';
const SHOW_PROCESS_RANKING_KEY = 'show-process-ranking';
const PROCESS_RANKING_LIMIT_KEY = 'process-ranking-limit';

function init() {
}

function fillPreferencesWindow(window) {
    const settings = ExtensionUtils.getSettings(SETTINGS_SCHEMA);

    const page = new Adw.PreferencesPage({
        title: 'System Monitor Beautiful',
        icon_name: 'utilities-system-monitor-symbolic',
    });

    const group = new Adw.PreferencesGroup({
        title: '显示设置',
        description: '调整顶栏监视器的数据刷新频率和告警阈值。',
    });

    const row = new Adw.ActionRow({
        title: '刷新间隔',
        subtitle: '值越小越实时，但更新次数更多。',
    });

    const model = Gtk.StringList.new(REFRESH_INTERVAL_OPTIONS.map(value => `${value} 秒`));
    const combo = new Gtk.DropDown({
        model,
        valign: Gtk.Align.CENTER,
    });

    const syncFromSettings = () => {
        const current = settings.get_int('refresh-interval');
        const index = Math.max(0, REFRESH_INTERVAL_OPTIONS.indexOf(current));
        combo.set_selected(index);
    };

    combo.connect('notify::selected', widget => {
        const index = widget.get_selected();
        const value = REFRESH_INTERVAL_OPTIONS[index] ?? REFRESH_INTERVAL_OPTIONS[0];
        if (settings.get_int('refresh-interval') !== value)
            settings.set_int('refresh-interval', value);
    });

    settings.connect('changed::refresh-interval', syncFromSettings);
    syncFromSettings();

    row.add_suffix(combo);
    row.activatable_widget = combo;
    group.add(row);

    const createThresholdRow = (title, subtitle, settingKey) => {
        const thresholdRow = new Adw.ActionRow({
            title,
            subtitle,
        });

        const adjustment = new Gtk.Adjustment({
            lower: 1,
            upper: 100,
            step_increment: 1,
            page_increment: 5,
            page_size: 0,
            value: settings.get_int(settingKey),
        });

        const spinButton = new Gtk.SpinButton({
            adjustment,
            climb_rate: 1,
            digits: 0,
            numeric: true,
            valign: Gtk.Align.CENTER,
            width_chars: 4,
        });

        const syncThreshold = () => {
            const current = settings.get_int(settingKey);
            if (spinButton.get_value_as_int() !== current)
                spinButton.set_value(current);
        };

        spinButton.connect('value-changed', widget => {
            const value = widget.get_value_as_int();
            if (settings.get_int(settingKey) !== value)
                settings.set_int(settingKey, value);
        });

        settings.connect(`changed::${settingKey}`, syncThreshold);
        syncThreshold();

        const suffixBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            valign: Gtk.Align.CENTER,
        });
        suffixBox.append(spinButton);
        suffixBox.append(new Gtk.Label({
            label: '%',
            valign: Gtk.Align.CENTER,
        }));

        thresholdRow.add_suffix(suffixBox);
        thresholdRow.activatable_widget = spinButton;
        group.add(thresholdRow);
    };

    createThresholdRow('CPU 告警阈值', 'CPU 使用率达到该值时高亮提示。', CPU_ALERT_THRESHOLD_KEY);
    createThresholdRow('内存告警阈值', '内存使用率达到该值时高亮提示。', MEMORY_ALERT_THRESHOLD_KEY);

    const rankingSwitchRow = new Adw.ActionRow({
        title: '显示进程排行',
        subtitle: '在插件下拉菜单中展示 CPU、内存、网络占用前 N 的进程。',
    });
    const rankingSwitch = new Gtk.Switch({
        valign: Gtk.Align.CENTER,
        active: settings.get_boolean(SHOW_PROCESS_RANKING_KEY),
    });
    const syncRankingSwitch = () => {
        const active = settings.get_boolean(SHOW_PROCESS_RANKING_KEY);
        if (rankingSwitch.get_active() !== active)
            rankingSwitch.set_active(active);
    };
    rankingSwitch.connect('notify::active', widget => {
        const value = widget.get_active();
        if (settings.get_boolean(SHOW_PROCESS_RANKING_KEY) !== value)
            settings.set_boolean(SHOW_PROCESS_RANKING_KEY, value);
    });
    settings.connect(`changed::${SHOW_PROCESS_RANKING_KEY}`, syncRankingSwitch);
    syncRankingSwitch();
    rankingSwitchRow.add_suffix(rankingSwitch);
    rankingSwitchRow.activatable_widget = rankingSwitch;
    group.add(rankingSwitchRow);

    const rankingLimitRow = new Adw.ActionRow({
        title: '进程排行数量',
        subtitle: '控制每个分类显示前多少个进程。',
    });
    const rankingLimitAdjustment = new Gtk.Adjustment({
        lower: 1,
        upper: 10,
        step_increment: 1,
        page_increment: 1,
        page_size: 0,
        value: settings.get_int(PROCESS_RANKING_LIMIT_KEY),
    });
    const rankingLimitSpinButton = new Gtk.SpinButton({
        adjustment: rankingLimitAdjustment,
        climb_rate: 1,
        digits: 0,
        numeric: true,
        valign: Gtk.Align.CENTER,
        width_chars: 3,
    });
    const syncRankingLimit = () => {
        const current = settings.get_int(PROCESS_RANKING_LIMIT_KEY);
        if (rankingLimitSpinButton.get_value_as_int() !== current)
            rankingLimitSpinButton.set_value(current);
    };
    rankingLimitSpinButton.connect('value-changed', widget => {
        const value = widget.get_value_as_int();
        if (settings.get_int(PROCESS_RANKING_LIMIT_KEY) !== value)
            settings.set_int(PROCESS_RANKING_LIMIT_KEY, value);
    });
    settings.connect(`changed::${PROCESS_RANKING_LIMIT_KEY}`, syncRankingLimit);
    syncRankingLimit();
    rankingLimitRow.add_suffix(rankingLimitSpinButton);
    rankingLimitRow.activatable_widget = rankingLimitSpinButton;
    group.add(rankingLimitRow);

    page.add(group);
    window.add(page);
}