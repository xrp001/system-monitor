const { Adw, Gtk } = imports.gi;

const ExtensionUtils = imports.misc.extensionUtils;

const SETTINGS_SCHEMA = 'org.gnome.shell.extensions.system-monitor-beautiful';
const REFRESH_INTERVAL_OPTIONS = [1, 2, 3, 5, 10];

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
        description: '调整顶栏监视器的数据刷新频率。',
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
    page.add(group);
    window.add(page);
}