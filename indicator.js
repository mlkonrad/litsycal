import St      from 'gi://St';
import GLib    from 'gi://GLib';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import Gio     from 'gi://Gio';
import Shell   from 'gi://Shell';

import * as Main      from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {LitsycalCalendar}  from './calendarWidget.js';
import {SettingsMenuPanel} from './settingsMenuPanel.js';
import {GoToDatePanel}     from './eventDialog.js';
import {
    capitalize, formatPattern, dateStr, findMeetingUrl, meetingIsJoinable, SIZE_MIN_WIDTHS,
} from './helpers.js';

// ── Panel indicator ───────────────────────────────────────────────────────────

export const LitsycalIndicator = GObject.registerClass(
class LitsycalIndicator extends PanelMenu.Button {
    _init(settings, openPrefs, extPath, uuid) {
        super._init(0.5, 'Litsycal');

        this._settings    = settings;
        this._uuid        = uuid;
        this._openPrefsFn = openPrefs;

        this._badge = new St.Label({
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'litsycal-badge',
        });
        this.add_child(this._badge);

        this._logo = new St.Icon({
            y_align: Clutter.ActorAlign.CENTER,
            icon_size: 20, visible: false,
        });
        this._logo.set_gicon(Gio.icon_new_for_string(`${extPath}/litsycal-logo.svg`));
        this.add_child(this._logo);

        // Shown in place of the (hidden) badge text when there's a meeting
        // starting soon or in progress, so the icon isn't completely blank
        // right when it matters most. See _hasUpcomingMeeting().
        this._meetingGlyph = new St.Label({
            text: '●', y_align: Clutter.ActorAlign.CENTER,
            style_class: 'litsycal-meeting-glyph', visible: false,
        });
        this.add_child(this._meetingGlyph);

        this._updateBadge();
        this._lastHour = GLib.DateTime.new_now_local().get_hour();

        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 60, () => {
            this._updateBadge();
            this._checkHourlyBeep();
            // Keep the meeting join-button window (15 min before → end) fresh
            // while the calendar is actually visible.
            if (this._menuIsOpen || this._pinned)
                this._calWidget?._buildAgenda();
            return GLib.SOURCE_CONTINUE;
        });

        this._sids = [
            'badge-style', 'show-month-in-badge', 'show-dow-in-badge',
            'hide-icon', 'datetime-pattern', 'show-time', 'time-format',
        ].map(k => settings.connect(`changed::${k}`, () => this._updateBadge()));

        this._pinned      = false;
        this._floatingBox = null;

        this._menuIsOpen = false;
        this._menuOpenId = this.menu.connect('open-state-changed', (_menu, open) => {
            this._menuIsOpen = open;
            if (open && this._pinned) {
                // The calendar widget currently lives in the floating pinned
                // box, not in this menu item. Reparenting it back while
                // open() is still setting up its modal grab races that
                // setup and leaves the widget detached from the stage
                // (never actually mapped/shown, and stuck with a stale
                // pointer-grab ":insensitive" style). Defer the unpin to
                // the next idle, once the grab has settled.
                GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    if (this._pinned)
                        this._unpinCalendar(false);
                    this._calWidget._updateAgendaMaxHeight();
                    this._calWidget._buildAgenda();
                    return GLib.SOURCE_REMOVE;
                });
            } else if (open) {
                this._calWidget._updateAgendaMaxHeight();
                this._calWidget._buildAgenda();
            }
            if (open) {
                // Capture phase on the menu's own actor, not the stage: PopupMenu's
                // modal grab (Main.pushModal, via GrabHelper) is scoped to
                // this.menu.actor, and GNOME's Clutter.Grab delivers events starting
                // from the grab actor while the grab is active — global.stage's own
                // 'captured-event' never sees them.
                //
                // Note: bare Down (any modifiers) never reaches this handler at all.
                // PopupMenu's own _keyController ('key-press', wired in the PopupMenu
                // constructor — js/ui/popupMenu.js PopupMenu._onKeyPress) sits upstream
                // of Clutter's normal actor event pipeline and unconditionally consumes
                // the Down keysym for its own accessibility keynav whenever the popup
                // drops down from the top panel. See LitsycalCalendar.handleKeyPress
                // for the h/j/k/l fallback this forces.
                this._keyPressId = this.menu.actor.connect('captured-event', (_actor, ev) => {
                    if (ev.type() !== Clutter.EventType.KEY_PRESS)
                        return Clutter.EVENT_PROPAGATE;
                    // The event panel owns text entries (title, notes, ...); never
                    // steal their keystrokes for calendar navigation.
                    if (this._calWidget._eventPanel)
                        return Clutter.EVENT_PROPAGATE;
                    const keyval = ev.get_key_symbol();
                    const state  = ev.get_state();
                    const shift  = (state & Clutter.ModifierType.SHIFT_MASK)   !== 0;
                    const ctrl   = (state & Clutter.ModifierType.CONTROL_MASK) !== 0;
                    const alt    = (state & Clutter.ModifierType.MOD1_MASK)    !== 0;
                    return this._calWidget.handleKeyPress(keyval, shift, ctrl, alt)
                        ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
                });
            } else if (this._keyPressId) {
                this.menu.actor.disconnect(this._keyPressId);
                this._keyPressId = null;
            }
        });

        const section = new PopupMenu.PopupMenuSection();
        const item    = new PopupMenu.PopupBaseMenuItem({
            reactive: false, can_focus: false, style_class: 'litsycal-popup-item',
        });
        const cal = new LitsycalCalendar(
            settings,
            anchor => this._openSettingsMenu(anchor),
            () => {
                const app = Shell.AppSystem.get_default().lookup_app('org.gnome.Calendar.desktop');
                if (app)
                    app.activate();
            },
            pinned => {
                if (pinned)
                    this._pinCalendar(); else
                    this._unpinCalendar(true);
            },
            () => this._updateBadge(),
            anchor => this._openGoToDateDialog(anchor),
            () => this._quitLitsycal()
        );
        this._calWidget = cal;
        this._menuItem  = item;
        item.add_child(cal);
        section.addMenuItem(item);
        this.menu.addMenuItem(section);

        this.menu.actor.style = 'border: none; background-color: transparent; box-shadow: none; padding: 0;';
        this.menu.box.style   = 'padding: 0; background-color: transparent; border: none;';
        try {
            this.menu.actor.bin.style = 'padding: 0; border: none; background-color: transparent;';
        } catch {}
    }

    // Opens the Preferences window on a specific tab. LitsycalPrefs
    // (prefs.js) reads and immediately resets this key on fillPreferencesWindow.
    _openPrefsPage(page) {
        this._settings.set_string('prefs-initial-page', page);
        this._openPrefsFn();
    }

    // Reached either by right-clicking the panel icon or by clicking the
    // gear button in the calendar footer — anchorActor is whichever of those
    // triggered it, so the menu appears right next to it. Deliberately
    // doesn't touch `this.menu`: the calendar dropdown stays open behind it,
    // same as any other floating panel (EventPanel, GoToDatePanel, ...).
    // Individual actions below close it themselves where that makes sense.
    _openSettingsMenu(anchorActor) {
        this._settingsMenuPanel?.close();
        this._settingsMenuPanel = new SettingsMenuPanel(anchorActor, [
            {
                label: _('About'), icon: 'help-about-symbolic',
                action: () => {
                    this.menu.close();
                    this._openPrefsPage('about');
                },
            },
            null,
            {
                label: _('Go to date…'), icon: 'go-jump-symbolic',
                action: () => this._openGoToDateDialog(anchorActor),
            },
            null,
            {
                label: _('Settings'), icon: 'preferences-system-symbolic',
                action: () => {
                    this.menu.close();
                    this._openPrefsPage('general');
                },
            },
            {
                label: _('Appearance'), icon: 'preferences-desktop-theme-symbolic',
                action: () => {
                    this.menu.close();
                    this._openPrefsPage('appearance');
                },
            },
            null,
            {
                label: _('Help'), icon: 'help-browser-symbolic', action: () => {
                    this.menu.close();
                    Gio.AppInfo.launch_default_for_uri('https://github.com/mlkonrad/litsycal/wiki', null);
                },
            },
            null,
            {
                label: _('Quit Litsycal'), icon: 'application-exit-symbolic',
                action: () => this._quitLitsycal(),
            },
        ]);
    }

    // Also reachable via Ctrl+Q (Itsycal's ⌘Q) — see LitsycalCalendar.handleKeyPress.
    _quitLitsycal() {
        this.menu.close();
        // Disabling from inside this handler would tear this actor down
        // mid-event; defer to the next idle tick.
        const uuid = this._uuid;
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            Main.extensionManager.disableExtension(uuid);
            return GLib.SOURCE_REMOVE;
        });
    }

    // Unlike the other settings-menu actions, this deliberately leaves the
    // calendar dropdown open: the date panel floats in front of it, and once
    // a date is picked the calendar (already open, or opened fresh if this
    // came from a right-click with it closed) jumps straight to it.
    _openGoToDateDialog(anchorActor) {
        this._goToDatePanel?.close();
        this._goToDatePanel = new GoToDatePanel(anchorActor, dt => {
            this._goToDatePanel = null;
            if (!dt)
                return;
            if (!this._menuIsOpen)
                this.menu.open();
            this._calWidget._goToDate(dt);
        });
    }

    vfunc_event(event) {
        if (event.type() === Clutter.EventType.BUTTON_PRESS &&
            event.get_button() === Clutter.BUTTON_SECONDARY) {
            this._openSettingsMenu(this);
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _updateBadge() {
        const today = GLib.DateTime.new_now_local();
        this.accessible_name = `${_('Calendar')} — ${capitalize(today.format('%A, %B %-d, %Y'))}`;

        const hidden = this._settings.get_boolean('hide-icon');
        this._logo.visible  = false;
        this._badge.visible = !hidden;
        if (hidden) {
            this._meetingGlyph.visible = this._hasUpcomingMeeting();
            return;
        }
        this._meetingGlyph.visible = false;

        const style   = this._settings.get_string('badge-style');
        const pattern = this._settings.get_string('datetime-pattern');

        this._badge.remove_style_class_name('litsycal-badge-dark');
        this._badge.remove_style_class_name('litsycal-badge-calendar');
        this._badge.remove_style_class_name('litsycal-badge-calendar-dark');
        this._badge.remove_style_class_name('litsycal-badge-text');
        if (style === 'number-dark')
            this._badge.add_style_class_name('litsycal-badge-dark');
        if (style === 'calendar')
            this._badge.add_style_class_name('litsycal-badge-calendar');
        if (style === 'calendar-dark')
            this._badge.add_style_class_name('litsycal-badge-calendar-dark');
        if (style === 'text')
            this._badge.add_style_class_name('litsycal-badge-text');

        const now = GLib.DateTime.new_now_local();
        this._badge.set_text(
            pattern ? formatPattern(now, pattern) : this._defaultText()
        );
    }

    // True while today has a video-call event that's joinable right now
    // (mirrors the agenda's own join-button window — see meetingIsJoinable).
    _hasUpcomingMeeting() {
        const calManager = this._calWidget?._calManager;
        if (!calManager)
            return false;
        const today = dateStr(GLib.DateTime.new_now_local());
        return calManager.getEventsForDate(today)
            .some(ev => findMeetingUrl(ev) && meetingIsJoinable(ev));
    }

    _checkHourlyBeep() {
        const now = GLib.DateTime.new_now_local();
        const h   = now.get_hour();
        if (h !== this._lastHour) {
            this._lastHour = h;
            if (this._settings.get_boolean('beep-on-hour')) {
                const customFile = this._settings.get_string('hour-sound-file');
                if (customFile) {
                    try {
                        Gio.Subprocess.new(['paplay', customFile], Gio.SubprocessFlags.NONE);
                    } catch { /* paplay unavailable or file missing */ }
                } else {
                    global.display.get_sound_player().play_from_theme('bell', 'Hour bell', null);
                }
            }
        }
    }

    _defaultText() {
        const now       = GLib.DateTime.new_now_local();
        const showMonth = this._settings.get_boolean('show-month-in-badge');
        const showDow   = this._settings.get_boolean('show-dow-in-badge');
        const showTime  = this._settings.get_boolean('show-time');
        const timeFmt   = this._settings.get_string('time-format');
        const parts     = [];
        if (showDow)
            parts.push(capitalize(now.format('%a')));
        if (showMonth)
            parts.push(capitalize(now.format('%b')));
        parts.push(String(now.get_day_of_month()).padStart(2, '0'));
        if (showTime)
            parts.push(timeFmt === '12h' ? now.format('%-I:%M%P') : now.format('%H:%M'));
        return parts.join(' ');
    }

    _pinCalendar() {
        if (this._pinned)
            return;
        this._pinned = true;
        this._calWidget.setPinned(true);
        const monitor = Main.layoutManager.monitors[
            Main.layoutManager.findIndexForActor(this)
        ] ?? Main.layoutManager.primaryMonitor;
        // Captured before reparenting below, from the calendar's actual
        // rendered position in the still-open popup, and used as-is — any
        // reprocessing (recentring under the button, snapping to a min/max
        // gap below the panel) lands a pixel or two off GNOME's own
        // BoxPointer arrow-offset placement, visibly shifting it as it pins.
        // Only clamped against actually running off the monitor edge.
        // get_width() also reads 0 once detached (no layout pass yet), hence
        // the SIZE_MIN_WIDTHS fallback.
        const [calX, calY] = this._calWidget.get_transformed_position();
        const calW = this._calWidget.get_width() ||
            SIZE_MIN_WIDTHS[this._settings.get_int('calendar-size')] || 255;

        this._floatingBox = new St.BoxLayout({vertical: true});
        Main.layoutManager.uiGroup.add_child(this._floatingBox);
        this._menuItem.remove_child(this._calWidget);
        this._floatingBox.add_child(this._calWidget);

        const x = Math.max(monitor.x, Math.min(Math.round(calX), monitor.x + monitor.width - calW));
        const y = Math.max(monitor.y, Math.round(calY));
        this._floatingBox.set_position(x, y);
        this.menu.close();
    }

    _unpinCalendar(andOpen = false) {
        this._pinned = false;
        this._calWidget.setPinned(false);
        if (!this._floatingBox)
            return;
        this._floatingBox.remove_child(this._calWidget);
        this._menuItem.add_child(this._calWidget);
        Main.layoutManager.uiGroup.remove_child(this._floatingBox);
        this._floatingBox.destroy();
        this._floatingBox = null;
        if (andOpen)
            this.menu.toggle();
    }

    destroy() {
        if (this._floatingBox) {
            Main.layoutManager.uiGroup.remove_child(this._floatingBox);
            this._floatingBox.destroy();
            this._floatingBox = null;
        }
        if (this._keyPressId) {
            this.menu.actor.disconnect(this._keyPressId);
            this._keyPressId = null;
        }
        if (this._menuOpenId) {
            this.menu.disconnect(this._menuOpenId);
            this._menuOpenId = null;
        }
        if (this._timer)      {
            GLib.source_remove(this._timer);
            this._timer = null;
        }
        this._goToDatePanel?.close();
        this._goToDatePanel = null;
        this._settingsMenuPanel?.close();
        this._settingsMenuPanel = null;
        for (const id of this._sids)
            this._settings.disconnect(id);
        super.destroy();
    }
});

