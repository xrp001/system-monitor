const { Adw, Gtk } = imports.gi;

const ExtensionUtils = imports.misc.extensionUtils;

const SETTINGS_SCHEMA = 'org.gnome.shell.extensions.system-monitor-beautiful';
const REFRESH_INTERVAL_OPTIONS = [1, 2, 3, 5, 10];
const CPU_ALERT_THRESHOLD_KEY = 'cpu-alert-threshold';
const MEMORY_ALERT_THRESHOLD_KEY = 'memory-alert-threshold';

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

    page.add(group);
    window.add(page);
}