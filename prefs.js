import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export default class LitsycalPrefs extends ExtensionPreferences {

    fillPreferencesWindow(window) {
        window.set_default_size(480, 660);
        const settings = this.getSettings();

        // ════════════════════════════════════════════════════════════════════
        // GENERAL PAGE
        // ════════════════════════════════════════════════════════════════════
        const general = new Adw.PreferencesPage({
            title:     'General',
            icon_name: 'preferences-system-symbolic',
        });
        window.add(general);

        // ── Calendar group ─────────────────────────────────────────────────
        const calGroup = new Adw.PreferencesGroup({title: 'Calendar'});
        general.add(calGroup);

        // First day of the week
        const DOW_NAMES = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
        const fdowRow = new Adw.ComboRow({
            title: 'First day of week',
            model: Gtk.StringList.new(DOW_NAMES),
        });
        fdowRow.set_selected(settings.get_int('first-day-of-week'));
        fdowRow.connect('notify::selected', () => {
            settings.set_int('first-day-of-week', fdowRow.get_selected());
        });
        calGroup.add(fdowRow);

        // ── Keyboard shortcut group ────────────────────────────────────────
        const kbGroup = new Adw.PreferencesGroup({title: 'Keyboard Shortcut'});
        general.add(kbGroup);

        const kbRow = new Adw.ActionRow({
            title:    'Show / hide calendar',
            subtitle: 'Global shortcut to toggle the calendar popup',
        });

        // Label that shows the current shortcut (or placeholder)
        const shortcutLabel = () => {
            const strv = settings.get_strv('toggle-shortcut');
            if (strv.length === 0) return 'Not set';
            const [ok, kv, mods] = Gtk.accelerator_parse(strv[0]);
            return ok ? Gtk.accelerator_get_label(kv, mods) : strv[0];
        };

        const recordBtn = new Gtk.Button({
            label:  shortcutLabel(),
            valign: Gtk.Align.CENTER,
            css_classes: ['pill'],
        });

        recordBtn.connect('clicked', () => {
            const dlg = new Adw.MessageDialog({
                heading:       'Record Shortcut',
                body:          'Press the key combination you want to use.\nEsc = cancel  ·  Backspace = clear.',
                transient_for: window,
                modal:         true,
            });

            const hint = new Gtk.ShortcutLabel({
                accelerator:   settings.get_strv('toggle-shortcut')[0] ?? '',
                disabled_text: 'Waiting for keypress…',
                halign:        Gtk.Align.CENTER,
            });
            dlg.set_extra_child(hint);
            dlg.add_response('cancel', 'Cancel');

            const ctrl = new Gtk.EventControllerKey();
            ctrl.connect('key-pressed', (_c, keyval, _code, state) => {
                if (keyval === Gdk.KEY_Escape) {
                    dlg.close();
                    return Gdk.EVENT_STOP;
                }
                if (keyval === Gdk.KEY_BackSpace) {
                    settings.set_strv('toggle-shortcut', []);
                    recordBtn.set_label('Not set');
                    dlg.close();
                    return Gdk.EVENT_STOP;
                }
                const mods = state & (
                    Gdk.ModifierType.CONTROL_MASK |
                    Gdk.ModifierType.SHIFT_MASK   |
                    Gdk.ModifierType.ALT_MASK     |
                    Gdk.ModifierType.SUPER_MASK
                );
                if (Gtk.accelerator_valid(keyval, mods)) {
                    const accel = Gtk.accelerator_name(keyval, mods);
                    settings.set_strv('toggle-shortcut', [accel]);
                    recordBtn.set_label(Gtk.accelerator_get_label(keyval, mods));
                    hint.set_accelerator(accel);
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 600, () => {
                        dlg.close();
                        return GLib.SOURCE_REMOVE;
                    });
                }
                return Gdk.EVENT_STOP;
            });
            dlg.add_controller(ctrl);
            dlg.present();
        });

        kbRow.add_suffix(recordBtn);
        kbGroup.add(kbRow);

        // ── Startup group ──────────────────────────────────────────────────
        const startGroup = new Adw.PreferencesGroup({title: 'Startup'});
        general.add(startGroup);

        const updatesRow = new Adw.SwitchRow({
            title:    'Automatically check for updates',
            subtitle: 'Check for new versions in the background',
        });
        settings.bind('check-for-updates', updatesRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        startGroup.add(updatesRow);

        // ── Other group ────────────────────────────────────────────────────
        const otherGroup = new Adw.PreferencesGroup({title: 'Other'});
        general.add(otherGroup);

        // Beep on the hour row — SwitchRow + speaker preview button
        const beepRow = new Adw.ActionRow({
            title:    'Beep on the hour',
            subtitle: 'Play a sound at the start of every hour',
        });

        const beepSwitch = new Gtk.Switch({
            valign: Gtk.Align.CENTER,
            active: settings.get_boolean('beep-on-hour'),
        });
        beepSwitch.connect('notify::active', () => {
            settings.set_boolean('beep-on-hour', beepSwitch.get_active());
        });
        settings.connect('changed::beep-on-hour', () => {
            beepSwitch.set_active(settings.get_boolean('beep-on-hour'));
        });

        const speakerBtn = new Gtk.Button({
            icon_name:    'audio-volume-high-symbolic',
            has_frame:    false,
            valign:       Gtk.Align.CENTER,
            tooltip_text: 'Preview the sound',
        });
        speakerBtn.connect('clicked', () => {
            const candidates = [
                ['paplay', '/usr/share/sounds/freedesktop/stereo/bell.oga'],
                ['canberra-gtk-play', '-i', 'bell'],
            ];
            for (const argv of candidates) {
                try {
                    Gio.Subprocess.new(argv, Gio.SubprocessFlags.NONE);
                    break;
                } catch (_) { /* try next */ }
            }
        });

        beepRow.add_suffix(beepSwitch);
        beepRow.add_suffix(speakerBtn);
        beepRow.set_activatable_widget(beepSwitch);
        otherGroup.add(beepRow);

        // ════════════════════════════════════════════════════════════════════
        // APPEARANCE PAGE  (options that were previously in "General")
        // ════════════════════════════════════════════════════════════════════
        const appearance = new Adw.PreferencesPage({
            title:     'Appearance',
            icon_name: 'applications-graphics-symbolic',
        });
        window.add(appearance);

        // ── Panel icon group ───────────────────────────────────────────────
        const iconGroup = new Adw.PreferencesGroup({title: 'Panel Icon'});
        appearance.add(iconGroup);

        const STYLE_IDS    = ['number-light', 'number-dark', 'calendar', 'calendar-dark'];
        const STYLE_LABELS = ['Number — light', 'Number — dark', 'Calendar — light', 'Calendar — dark'];

        const styleRow = new Adw.ComboRow({
            title: 'Icon style',
            model: Gtk.StringList.new(STYLE_LABELS),
        });
        const currentIdx = Math.max(0, STYLE_IDS.indexOf(settings.get_string('badge-style')));
        styleRow.set_selected(currentIdx);
        styleRow.connect('notify::selected', () => {
            const i = styleRow.get_selected();
            if (i < STYLE_IDS.length) settings.set_string('badge-style', STYLE_IDS[i]);
        });
        iconGroup.add(styleRow);

        const showMonthRow = new Adw.SwitchRow({title: 'Show month in icon'});
        settings.bind('show-month-in-badge', showMonthRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        iconGroup.add(showMonthRow);

        const showDowRow = new Adw.SwitchRow({title: 'Show day of week in icon'});
        settings.bind('show-dow-in-badge', showDowRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        iconGroup.add(showDowRow);

        const showTimeRow = new Adw.SwitchRow({title: 'Show time in icon'});
        settings.bind('show-time', showTimeRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        iconGroup.add(showTimeRow);

        const TIME_FMT_IDS    = ['24h', '12h'];
        const TIME_FMT_LABELS = ['24-hour (13:05)', '12-hour (1:05pm)'];
        const timeFmtRow = new Adw.ComboRow({
            title:   'Time format',
            model:   Gtk.StringList.new(TIME_FMT_LABELS),
            visible: settings.get_boolean('show-time'),
        });
        timeFmtRow.set_selected(Math.max(0, TIME_FMT_IDS.indexOf(settings.get_string('time-format'))));
        timeFmtRow.connect('notify::selected', () => {
            const i = timeFmtRow.get_selected();
            if (i < TIME_FMT_IDS.length) settings.set_string('time-format', TIME_FMT_IDS[i]);
        });
        settings.connect('changed::show-time', () => {
            timeFmtRow.visible = settings.get_boolean('show-time');
        });
        iconGroup.add(timeFmtRow);

        // Datetime pattern
        const patRow = new Adw.ActionRow({
            title:    'Custom datetime pattern',
            subtitle: 'Overrides other icon text when set',
        });
        const patBox   = new Gtk.Box({spacing: 4, valign: Gtk.Align.CENTER});
        const patEntry = new Gtk.Entry({placeholder_text: 'e.g. %d/%m', width_chars: 12});
        settings.bind('datetime-pattern', patEntry, 'text', Gio.SettingsBindFlags.DEFAULT);

        const helpBtn = new Gtk.Button({
            icon_name: 'dialog-question-symbolic',
            has_frame: false,
            valign:    Gtk.Align.CENTER,
            tooltip_text: 'Pattern help',
        });
        helpBtn.connect('clicked', () => {
            const dlg = new Adw.MessageDialog({
                heading:       'Datetime Pattern',
                body:          'Uses strftime format codes:\n\n' +
                               '%d  — Day number (01–31)\n' +
                               '%m  — Month number (01–12)\n' +
                               '%b  — Month abbrev (Jan, Feb…)\n' +
                               '%a  — Weekday abbrev (Mon, Tue…)\n' +
                               '%Y  — Full year (2026)\n' +
                               '%H  — Hour, 24-hour (00–23)\n' +
                               '%I  — Hour, 12-hour (01–12)\n' +
                               '%M  — Minutes (00–59)\n' +
                               '%P  — am or pm\n\n' +
                               'Examples:\n' +
                               '  %d/%m       → 03/05\n' +
                               '  %a %d       → Sun 03\n' +
                               '  %d %b %Y    → 03 May 2026\n' +
                               '  %H:%M       → 13:05\n' +
                               '  %-I:%M%P    → 1:05pm\n' +
                               '  %d %H:%M    → 03 13:05',
                transient_for: window,
                modal:         true,
            });
            dlg.add_response('ok', 'OK');
            dlg.set_default_response('ok');
            dlg.present();
        });
        patBox.append(patEntry);
        patBox.append(helpBtn);
        patRow.add_suffix(patBox);
        iconGroup.add(patRow);

        const hideRow = new Adw.SwitchRow({title: 'Hide icon'});
        settings.bind('hide-icon', hideRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        iconGroup.add(hideRow);

        // ── Calendar size group ────────────────────────────────────────────
        const sizeGroup = new Adw.PreferencesGroup({title: 'Calendar'});
        appearance.add(sizeGroup);

        const sizeRow = new Adw.ActionRow({title: 'Size', subtitle: 'Applied on-the-fly'});
        const sizeBox = new Gtk.Box({spacing: 8, valign: Gtk.Align.CENTER, hexpand: true});
        sizeBox.append(new Gtk.Label({label: 'S', css_classes: ['dim-label']}));

        const scale = new Gtk.Scale({
            orientation:   Gtk.Orientation.HORIZONTAL,
            adjustment:    new Gtk.Adjustment({lower: 0, upper: 2, step_increment: 1}),
            draw_value:    false,
            round_digits:  0,
            hexpand:       true,
            width_request: 140,
        });
        scale.add_mark(0, Gtk.PositionType.BOTTOM, null);
        scale.add_mark(1, Gtk.PositionType.BOTTOM, null);
        scale.add_mark(2, Gtk.PositionType.BOTTOM, null);
        scale.set_value(settings.get_int('calendar-size'));
        scale.connect('value-changed', () => {
            settings.set_int('calendar-size', Math.round(scale.get_value()));
        });
        sizeBox.append(scale);
        sizeBox.append(new Gtk.Label({label: 'L', css_classes: ['dim-label']}));
        sizeRow.add_suffix(sizeBox);
        sizeGroup.add(sizeRow);

        // ── Highlighted days ───────────────────────────────────────────────
        const hlGroup = new Adw.PreferencesGroup({
            title:       'Highlighted Days',
            description: 'Tints the selected day columns across the entire calendar grid',
        });
        appearance.add(hlGroup);

        const hlRow  = new Adw.ActionRow({title: 'Highlight columns'});
        const hlBox  = new Gtk.Box({spacing: 2, valign: Gtk.Align.CENTER});
        const DAY_KEYS   = ['mo','tu','we','th','fr','sa','su'];
        const DAY_LABELS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
        const hlSet  = new Set(settings.get_strv('highlight-days'));

        for (let i = 0; i < 7; i++) {
            const key  = DAY_KEYS[i];
            const vbox = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 2});
            vbox.append(new Gtk.Label({label: DAY_LABELS[i], css_classes: ['dim-label']}));
            const chk = new Gtk.CheckButton({active: hlSet.has(key), halign: Gtk.Align.CENTER});
            chk.connect('toggled', () => {
                if (chk.get_active()) hlSet.add(key);
                else hlSet.delete(key);
                settings.set_strv('highlight-days', [...hlSet]);
            });
            vbox.append(chk);
            hlBox.append(vbox);
        }
        hlRow.add_suffix(hlBox);
        hlGroup.add(hlRow);

        // ── Theme ──────────────────────────────────────────────────────────────
        const themeGroup = new Adw.PreferencesGroup({title: 'Theme'});
        appearance.add(themeGroup);

        const THEME_IDS    = ['system', 'light', 'dark'];
        const THEME_LABELS = ['System', 'Light', 'Dark'];

        const themeRow = new Adw.ComboRow({
            title: 'Colour scheme',
            subtitle: 'System follows your GNOME appearance setting',
            model: Gtk.StringList.new(THEME_LABELS),
        });
        themeRow.set_selected(Math.max(0, THEME_IDS.indexOf(settings.get_string('theme'))));
        themeRow.connect('notify::selected', () => {
            const i = themeRow.get_selected();
            if (i < THEME_IDS.length) settings.set_string('theme', THEME_IDS[i]);
        });
        themeGroup.add(themeRow);

        // ── Weekend colour ─────────────────────────────────────────────────────
        const wkGroup = new Adw.PreferencesGroup({title: 'Weekend Days'});
        appearance.add(wkGroup);

        const WK_IDS    = ['default', 'none', 'custom'];
        const WK_LABELS = ['Default (red)', 'No colour', 'Custom…'];

        const wkModeRow = new Adw.ComboRow({
            title: 'Weekend day colour',
            model: Gtk.StringList.new(WK_LABELS),
        });
        wkModeRow.set_selected(Math.max(0, WK_IDS.indexOf(settings.get_string('weekend-color-mode'))));

        const wkColorRow = new Adw.ActionRow({
            title:   'Custom colour',
            visible: settings.get_string('weekend-color-mode') === 'custom',
        });
        const colorDialog = new Gtk.ColorDialog({modal: true});
        const colorBtn    = new Gtk.ColorDialogButton({dialog: colorDialog, valign: Gtk.Align.CENTER});
        const savedRgba   = new Gdk.RGBA();
        savedRgba.parse(settings.get_string('weekend-color'));
        colorBtn.set_rgba(savedRgba);
        colorBtn.connect('notify::rgba', () => {
            const c = colorBtn.get_rgba();
            const h = v => Math.round(v * 255).toString(16).padStart(2, '0');
            settings.set_string('weekend-color', `#${h(c.red)}${h(c.green)}${h(c.blue)}`);
        });
        wkColorRow.add_suffix(colorBtn);

        wkModeRow.connect('notify::selected', () => {
            const i = wkModeRow.get_selected();
            if (i < WK_IDS.length) {
                settings.set_string('weekend-color-mode', WK_IDS[i]);
                wkColorRow.visible = WK_IDS[i] === 'custom';
            }
        });

        wkGroup.add(wkModeRow);
        wkGroup.add(wkColorRow);

        // ════════════════════════════════════════════════════════════════════
        // ABOUT PAGE
        // ════════════════════════════════════════════════════════════════════
        const about = new Adw.PreferencesPage({
            title:     'About',
            icon_name: 'help-about-symbolic',
        });
        window.add(about);

        const abGroup = new Adw.PreferencesGroup();
        about.add(abGroup);
        abGroup.add(new Adw.ActionRow({
            title:    'Litsycal',
            subtitle: `Version ${this.metadata.version} — Calendar indicator for GNOME`,
        }));
        abGroup.add(new Adw.ActionRow({
            title:    'Inspired by Itsycal for macOS',
            subtitle: 'Original by Moe Birch • Linux port by hornets',
        }));
    }
}
