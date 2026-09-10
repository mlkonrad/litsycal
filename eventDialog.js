import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import St      from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib    from 'gi://GLib';
import Gio     from 'gi://Gio';
import Shell   from 'gi://Shell';
import Pango   from 'gi://Pango';

const _ = str => GLib.dgettext('litsycal@mlkonrad.github.com', str);

function pad(n) { return String(n).padStart(2, '0'); }
function dateStr(dt) {
    return `${dt.get_year()}-${pad(dt.get_month())}-${pad(dt.get_day_of_month())}`;
}
function capitalize(s) {
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
function daysInMonth(year, month) {
    const nm = month === 12 ? 1 : month + 1, ny = month === 12 ? year + 1 : year;
    return GLib.DateTime.new_local(ny, nm, 1, 0, 0, 0).add_days(-1).get_day_of_month();
}
// Buddhist Era year = Gregorian + 543 — display only; every date value that
// flows into save/parse logic below stays Gregorian (see _makeDateField).
const BUDDHIST_ERA_OFFSET = 543;
function displayYear(gregorianYear, calendarSystem) {
    return calendarSystem === 'buddhist' ? gregorianYear + BUDDHIST_ERA_OFFSET : gregorianYear;
}
function ngettext(one, many, n) {
    return GLib.dngettext('litsycal@mlkonrad.github.com', one, many, n);
}

// Repeat presets are keyed "FREQ:INTERVAL". An existing event whose recurrence
// doesn't match one of these (an unusual interval, BYDAY rules, ...) shows as
// CUSTOM and is left untouched unless the user explicitly picks something else.
const REPEAT_PRESETS = [
    {value: 'NONE',      freq: null,      interval: 1},
    {value: 'DAILY:1',   freq: 'DAILY',   interval: 1},
    {value: 'WEEKLY:1',  freq: 'WEEKLY',  interval: 1},
    {value: 'WEEKLY:2',  freq: 'WEEKLY',  interval: 2},
    {value: 'MONTHLY:1', freq: 'MONTHLY', interval: 1},
    {value: 'YEARLY:1',  freq: 'YEARLY',  interval: 1},
];

function repeatLabel(value) {
    return {
        'NONE':      _('Never'),
        'DAILY:1':   _('Every day'),
        'WEEKLY:1':  _('Every week'),
        'WEEKLY:2':  _('Every 2 weeks'),
        'MONTHLY:1': _('Every month'),
        'YEARLY:1':  _('Every year'),
    }[value] ?? value;
}

// Alert presets are keyed by minutes-before as a string ("0" = at/on the day).
// A non-preset minutesBefore from another app is injected as an extra option
// (labelled via minutesLabel) rather than treated as unsupported, since any
// integer offset round-trips fine through our VALARM writer.
const ALERT_PRESETS_TIMED  = ['NONE', '0', '5', '10', '15', '30', '60', '120', '1440', '2880'];
const ALERT_PRESETS_ALLDAY = ['NONE', '0', '1440', '2880', '10080'];

function minutesLabel(min, allDay) {
    if (min === 0) return allDay ? _('On the day') : _('At time of event');
    if (min % 1440 === 0) {
        const days = min / 1440;
        return days === 7 ? _('1 week before') : ngettext('%d day before', '%d days before', days).replace('%d', days);
    }
    if (min % 60 === 0) {
        const hours = min / 60;
        return ngettext('%d hour before', '%d hours before', hours).replace('%d', hours);
    }
    return ngettext('%d minute before', '%d minutes before', min).replace('%d', min);
}

function alertLabel(value, allDay) {
    if (value === 'NONE') return _('None');
    return minutesLabel(parseInt(value), allDay);
}

// Standalone delete-confirmation flow, usable with or without an open
// EventPanel (the agenda list's right-click Delete action has no panel open
// at all). Non-recurring events skip the prompt and delete immediately.
// Deletion itself always triggers CalendarManager's onEventsChanged, so
// callers don't need to refresh anything themselves on success.
//
// onDone(err) fires once, after the delete attempt (or immediately with
// undefined if the user cancels the prompt). onOverlayChange, if given, is
// called with the overlay actor while the prompt is up and with null once
// it's gone — EventPanel uses this to keep its own click-outside/Escape
// handling from closing the whole panel out from under the prompt.
export function confirmDeleteEvent(calManager, event, onDone, onOverlayChange) {
    const doDelete = (scope) => {
        const recurrenceId = event.recurrenceId ?? null;
        calManager.deleteEvent(event.uid, event.clientUid, {scope, recurrenceId}, err => onDone?.(err));
    };

    const isRecurring = !!(event.recurrence || event.recurrenceId);
    if (!isRecurring) { doDelete('ALL'); return; }

    const overlay = new St.BoxLayout({
        vertical: true,
        style_class: 'popup-menu-content litsycal-confirm-panel',
        reactive: true,
        // Hidden via opacity until the idle-positioning callback below
        // centers it, so it never paints for a frame at its pre-layout
        // (0,0) default.
        opacity: 0,
    });
    overlay.add_child(new St.Label({
        text: _('This is a repeating event.'), style_class: 'litsycal-confirm-title',
    }));

    const closeOverlay = () => {
        overlay.disconnect(eventId);
        if (grab) Main.popModal(grab);
        Main.layoutManager.uiGroup.remove_child(overlay);
        overlay.destroy();
        onOverlayChange?.(null);
    };

    const mkBtn = (label, styleClass, onClick) => {
        const b = new St.Button({label, style_class: styleClass, x_expand: true});
        b.connect('clicked', () => { closeOverlay(); onClick(); });
        return b;
    };

    overlay.add_child(mkBtn(_('Delete this event'), 'litsycal-confirm-btn litsycal-confirm-btn-danger',
        () => doDelete('THIS')));
    overlay.add_child(mkBtn(_('Delete all events'), 'litsycal-confirm-btn litsycal-confirm-btn-danger',
        () => doDelete('ALL')));
    overlay.add_child(mkBtn(_('Cancel'), 'litsycal-confirm-btn', () => {}));

    Main.layoutManager.uiGroup.add_child(overlay);
    onOverlayChange?.(overlay);

    // Opens nested inside EventPanel's own modal grab (which itself nests
    // inside the calendar dropdown's grab) — needs its own competing grab
    // for the same reason EventPanel does: see the comment on EventPanel's
    // this._grab.
    const grab = Main.pushModal(overlay, {actionMode: Shell.ActionMode.POPUP});

    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
        const monitor = Main.layoutManager.primaryMonitor;
        const w = overlay.get_width()  || 260;
        const h = overlay.get_height() || 160;
        overlay.set_position(
            monitor.x + Math.round((monitor.width  - w) / 2),
            monitor.y + Math.round((monitor.height - h) / 2)
        );
        overlay.opacity = 255;
        return GLib.SOURCE_REMOVE;
    });

    const eventId = overlay.connect('captured-event', (_actor, ev) => {
        if (ev.type() === Clutter.EventType.BUTTON_PRESS) {
            const [x, y] = ev.get_coords();
            const actor  = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y);
            if (actor && !overlay.contains(actor)) {
                closeOverlay();
                return Clutter.EVENT_STOP;
            }
        } else if (ev.type() === Clutter.EventType.KEY_PRESS &&
                   ev.get_key_symbol() === Clutter.KEY_Escape) {
            closeOverlay();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    });
}

export class EventPanel {

    // onClose is called exactly once, however the panel ends up closing —
    // saved, deleted, cancelled via Escape, or dismissed by clicking
    // outside. Callers rely on this to know the panel is gone (e.g. to null
    // out their own reference to it); wiring it to fire only on a
    // successful save left that reference stuck pointing at a dead panel
    // after every plain cancel.
    constructor(calManager, event, selectedDate, anchorActor, onClose, calendarSystem = 'gregorian') {
        this._calManager     = calManager;
        this._event          = event ?? null;
        this._onClose        = onClose;
        this._calendarSystem = calendarSystem;
        this._allDay         = event?.allDay ?? false;
        this._selDate        = event?.date
            ?? (selectedDate ? dateStr(selectedDate) : dateStr(GLib.DateTime.new_now_local()));

        const sources        = calManager.getSources();
        this._sources        = sources;
        this._selSource      = event
            ? (sources.find(s => s.uid === event.clientUid) ?? sources[0] ?? null)
            : (sources[0] ?? null);

        // Use popup-menu-content so background/text follow the user's shell theme
        this._box = new St.BoxLayout({
            vertical: true,
            style_class: 'popup-menu-content litsycal-event-panel',
            reactive: true,
            // Hidden via opacity until _position() below places it, so it
            // never paints for a frame at its pre-layout (0,0) default.
            opacity: 0,
        });

        // Dropdown/date/time pickers float above the panel instead of being
        // laid out inline, so opening one never grows the panel itself — but
        // Main.pushModal() scopes input delivery to the grabbed actor's own
        // subtree, so a floater sitting outside it could be seen (clicks
        // still hit-test fine) but never actually receive them (nothing
        // would fire on click). So both this._box and every floater are
        // parented under one shared this._root, and that's what gets the
        // grab — same wrapper-actor pattern GNOME Shell's own ModalDialog
        // uses to host a dialog plus overlays under a single grab.
        this._root = new St.Widget();
        Main.layoutManager.uiGroup.add_child(this._root);

        this._floaters = [];
        this._root.add_child(this._box);

        this._build();

        // Needed because this opens while the calendar dropdown (a
        // PopupMenu) is still open, holding its own modal grab: without a
        // competing grab here, a key event is delivered starting from that
        // grab's actor, not the stage — and PopupMenu's own built-in
        // close-on-Escape handling sits upstream of a plain global.stage
        // listener in that delivery chain, so it was consuming Escape and
        // closing the whole calendar dropdown before our own key-press-event
        // handler below ever saw it. See SettingsMenuPanel in extension.js
        // for the full explanation — same mechanism, same fix.
        this._grab = Main.pushModal(this._root, {actionMode: Shell.ActionMode.POPUP});

        // Defer positioning until after layout pass so actor size is known
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._position(anchorActor);
            this._box.opacity = 255;
            this._titleEntry.grab_key_focus();
            return GLib.SOURCE_REMOVE;
        });

        this._clickId = global.stage.connect('button-press-event', (_stage, ev) => {
            if (this._confirmOverlay) return Clutter.EVENT_PROPAGATE; // let it handle its own clicks
            const [x, y] = ev.get_coords();
            const actor  = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y);
            // A floating dropdown is a sibling of this._box (not a
            // descendant, see _attachFloatingDropdown), so a click landing
            // inside the currently open one must be exempted here too.
            if (actor && !this._box.contains(actor) &&
                !(this._openDropdown && this._openDropdown.contains(actor)))
                this.close();
            return Clutter.EVENT_PROPAGATE;
        });

        // Captured (not bubble-phase global.stage) so this fires ahead of
        // PopupMenu's own Escape handling now that our grab above is the
        // active one — see the comment on this._grab. Confirmed by
        // instrumentation: under this grab, captured-event never reaches
        // either global.stage or the grabbed actor itself (this._root) —
        // only a genuine descendant of it sees the event. So this shared
        // handler (_handleKeyEvent) is attached directly to this._box AND,
        // in _attachFloatingDropdown, to every floating dropdown too —
        // whichever of those actually contains the currently focused actor
        // is the one that will see it.
        this._keyId = this._box.connect('captured-event', (_actor, ev) => this._handleKeyEvent(ev));
    }

    _handleKeyEvent(ev) {
        if (this._confirmOverlay) return Clutter.EVENT_PROPAGATE; // let it handle Escape itself
        if (ev.type() !== Clutter.EventType.KEY_PRESS) return Clutter.EVENT_PROPAGATE;

        const sym = ev.get_key_symbol();
        if (sym === Clutter.KEY_Escape) {
            // Like a native combobox: Escape closes just the open list
            // first (returning focus to its button), and only closes
            // the whole panel once nothing is open.
            if (this._openDropdown) {
                this._closeDropdown();
                return Clutter.EVENT_STOP;
            }
            this.close();
            return Clutter.EVENT_STOP;
        }
        if (sym === Clutter.KEY_Tab || sym === Clutter.KEY_ISO_Left_Tab) {
            // Plain St/Clutter widgets have no built-in Tab-traversal
            // (unlike a GTK dialog's widgets), so intercept it here
            // before it reaches a focused St.Entry as a literal
            // tab character.
            const shift = (ev.get_state() & Clutter.ModifierType.SHIFT_MASK) !== 0;
            this._moveFocus(sym === Clutter.KEY_Tab && !shift);
            return Clutter.EVENT_STOP;
        }
        if (sym === Clutter.KEY_Down || sym === Clutter.KEY_Up) {
            if (this._openDropdown) {
                // Arrow keys, not Tab, walk an open list's own items —
                // same as a native combobox's popup.
                this._moveInDropdown(sym === Clutter.KEY_Down);
                return Clutter.EVENT_STOP;
            }
            // Nothing open yet: if the focused button is one of the
            // dropdown/date/time triggers, Down/Up opens it — same as a
            // closed native combobox. Reuses the button's own existing
            // 'clicked' handler rather than duplicating what it does.
            const focused = global.stage.get_key_focus();
            if (this._dropdownTriggers?.has(focused)) {
                focused.emit('clicked', 1);
                return Clutter.EVENT_STOP;
            }
        }
        if (sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter || sym === Clutter.KEY_space) {
            // Enter/Space activates the highlighted item in an open list —
            // same as a native combobox's popup — instead of falling through
            // to whatever St.Button's own default key handling would do.
            if (this._openDropdown) {
                const focused = global.stage.get_key_focus();
                if (focused instanceof St.Button && this._openDropdown.contains(focused)) {
                    focused.emit('clicked', 1);
                    return Clutter.EVENT_STOP;
                }
            }
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _position(anchor) {
        const monitor = Main.layoutManager.primaryMonitor;
        const panelH  = Main.panel.get_height();
        const boxW    = this._box.get_width()  || 380;
        const boxH    = this._box.get_height() || 360;

        if (anchor) {
            const [ax, ay] = anchor.get_transformed_position();
            const aw = anchor.get_width();

            let x = ax + aw + 10;
            if (x + boxW > monitor.x + monitor.width - 4)
                x = ax - boxW - 10;
            x = Math.max(monitor.x + 4, Math.min(x, monitor.x + monitor.width - boxW - 4));

            let y = ay;
            y = Math.max(monitor.y + panelH + 4, Math.min(y, monitor.y + monitor.height - boxH - 4));

            this._box.set_position(x, y);
        } else {
            // Clamp against boxH too (not just center horizontally) so a tall
            // panel — e.g. editing an event with a long note — can't have its
            // bottom pushed off-screen; it settles against the bottom margin
            // instead of overflowing past it.
            const idealY = monitor.y + panelH + Math.round((monitor.height - panelH) * 0.18);
            const y = Math.max(monitor.y + panelH + 4,
                                Math.min(idealY, monitor.y + monitor.height - boxH - 4));
            this._box.set_position(monitor.x + Math.round((monitor.width - boxW) / 2), y);
        }
    }

    _build() {
        const ev  = this._event;
        const box = this._box;

        // ── Title ──────────────────────────────────────────────────────────────
        this._titleEntry = new St.Entry({
            style_class: 'litsycal-panel-title-entry',
            hint_text: _('Event title'),
            x_expand: true,
            can_focus: true,
        });
        if (ev) this._titleEntry.set_text(ev.title ?? '');
        this._titleEntry.clutter_text.connect('activate', () => this._save());
        this._focusOnClick(this._titleEntry);
        box.add_child(this._titleEntry);

        // ── Calendar picker ────────────────────────────────────────────────────
        const calBox = new St.BoxLayout({vertical: true, x_expand: true});
        this._calPickerBtn = new St.Button({
            style_class: 'litsycal-panel-cal-btn',
            x_expand: true,
            reactive: !ev,
        });
        this._refreshCalBtn();

        if (!ev) {
            this._calDropdown = new St.BoxLayout({
                vertical: true,
                style_class: 'popup-menu-content litsycal-panel-cal-dropdown',
                visible: false,
            });
            for (const src of this._sources) {
                const btn = new St.Button({style_class: 'litsycal-panel-cal-option', x_expand: true});
                const row = new St.BoxLayout({style_class: 'litsycal-panel-icon-row'});
                const dot = new St.Widget({style_class: 'litsycal-panel-dot'});
                dot.style = `background-color: ${src.color};`;
                row.add_child(dot);
                row.add_child(new St.Label({text: src.name, x_expand: true}));
                btn.set_child(row);
                btn.connect('clicked', () => {
                    this._selSource = src;
                    this._refreshCalBtn();
                    this._closeDropdown();
                });
                this._calDropdown.add_child(btn);
            }
            this._attachFloatingDropdown(this._calDropdown, this._calPickerBtn);
            this._calPickerBtn.connect('clicked', () => {
                this._toggleDropdown(this._calDropdown, this._calPickerBtn);
            });
        }
        calBox.add_child(this._calPickerBtn);
        box.add_child(calBox);

        box.add_child(new St.Widget({style_class: 'litsycal-panel-sep'}));

        // ── Location ───────────────────────────────────────────────────────────
        const locationRow = new St.BoxLayout({style_class: 'litsycal-panel-row', x_expand: true});
        locationRow.add_child(new St.Label({text: _('Location'), style_class: 'litsycal-panel-lbl'}));
        this._locationEntry = new St.Entry({
            style_class: 'litsycal-panel-text-entry',
            hint_text: _('Add location…'),
            x_expand: true,
            can_focus: true,
        });
        if (ev?.location) this._locationEntry.set_text(ev.location);
        this._focusOnClick(this._locationEntry);
        locationRow.add_child(this._locationEntry);
        box.add_child(locationRow);

        // ── URL ────────────────────────────────────────────────────────────────
        const urlRow = new St.BoxLayout({style_class: 'litsycal-panel-row', x_expand: true});
        urlRow.add_child(new St.Label({text: _('URL'), style_class: 'litsycal-panel-lbl'}));
        this._urlEntry = new St.Entry({
            style_class: 'litsycal-panel-text-entry',
            hint_text: 'https://…',
            x_expand: true,
            can_focus: true,
        });
        if (ev?.url) this._urlEntry.set_text(ev.url);
        this._focusOnClick(this._urlEntry);

        this._openUrlBtn = new St.Button({
            label: '↗',
            style_class: 'litsycal-panel-open-btn',
            visible: !!(ev?.url),
        });
        this._openUrlBtn.connect('clicked', () => this._openUrl());
        this._urlEntry.clutter_text.connect('text-changed', () => {
            this._openUrlBtn.visible = this._urlEntry.get_text().trim().length > 0;
        });
        urlRow.add_child(this._urlEntry);
        urlRow.add_child(this._openUrlBtn);
        box.add_child(urlRow);

        box.add_child(new St.Widget({style_class: 'litsycal-panel-sep'}));

        // ── All-day ────────────────────────────────────────────────────────────
        const allDayRow = new St.BoxLayout({style_class: 'litsycal-panel-row', x_expand: true});
        allDayRow.add_child(new St.Label({
            text: _('All-day'), style_class: 'litsycal-panel-lbl', x_expand: true,
        }));
        this._allDayBtn = new St.Button({
            label: this._allDay ? _('On') : _('Off'),
            style_class: 'litsycal-panel-toggle ' +
                (this._allDay ? 'litsycal-panel-toggle-on' : 'litsycal-panel-toggle-off'),
        });
        this._allDayBtn.connect('clicked', () => this._toggleAllDay());
        allDayRow.add_child(this._allDayBtn);
        box.add_child(allDayRow);

        // ── Starts ─────────────────────────────────────────────────────────────
        const defStartTime = ev && !ev.allDay
            ? (ev.time?.split(' - ')[0] ?? this._nowHour()) : this._nowHour();
        this._startsRow = new St.BoxLayout({style_class: 'litsycal-panel-row', x_expand: true});
        this._startsRow.add_child(new St.Label({text: _('Starts'), style_class: 'litsycal-panel-lbl'}));
        this._startDatePicker = this._makeDateField(this._selDate);
        this._startTimePicker = this._makeTimeField(defStartTime);
        this._startsRow.add_child(this._startDatePicker.actor);
        this._startsRow.add_child(this._startTimePicker.actor);
        box.add_child(this._startsRow);

        // ── Ends ───────────────────────────────────────────────────────────────
        const defEndTime = ev && !ev.allDay
            ? (ev.time?.split(' - ')[1]?.trim() ?? this._nextHour()) : this._nextHour();
        this._endsRow = new St.BoxLayout({style_class: 'litsycal-panel-row', x_expand: true});
        this._endsRow.add_child(new St.Label({text: _('Ends'), style_class: 'litsycal-panel-lbl'}));
        this._endDatePicker = this._makeDateField(ev?.endDate ?? this._selDate);
        this._endTimePicker = this._makeTimeField(defEndTime);
        this._endsRow.add_child(this._endDatePicker.actor);
        this._endsRow.add_child(this._endTimePicker.actor);
        box.add_child(this._endsRow);

        this._updateTimeVisibility();

        box.add_child(new St.Widget({style_class: 'litsycal-panel-sep'}));

        // ── Repeat ─────────────────────────────────────────────────────────────
        const repeatInit = this._repeatInitFor(ev?.recurrence);
        this._customRecurrence = repeatInit.customRecurrence;

        const repeatRow = new St.BoxLayout({style_class: 'litsycal-panel-row', x_expand: true});
        repeatRow.add_child(new St.Label({text: _('Repeat'), style_class: 'litsycal-panel-lbl'}));
        this._repeatPicker = this._makeDropdownField(
            repeatInit.options, repeatInit.value, () => this._updateRepeatEndVisibility()
        );
        repeatRow.add_child(this._repeatPicker.actor);
        box.add_child(repeatRow);

        this._repeatEndRow = new St.BoxLayout({style_class: 'litsycal-panel-row', x_expand: true});
        this._repeatEndRow.add_child(new St.Label({text: _('Until'), style_class: 'litsycal-panel-lbl'}));
        const initialUntil = ev?.recurrence?.until ?? null;
        this._repeatEndPicker = this._makeDropdownField(
            [{value: 'NEVER', label: _('Never')}, {value: 'ON_DATE', label: _('On date')}],
            initialUntil ? 'ON_DATE' : 'NEVER',
            () => this._updateRepeatUntilVisibility()
        );
        this._repeatEndRow.add_child(this._repeatEndPicker.actor);
        this._repeatUntilPicker = this._makeDateField(initialUntil ?? this._selDate);
        this._repeatEndRow.add_child(this._repeatUntilPicker.actor);
        box.add_child(this._repeatEndRow);

        this._updateRepeatEndVisibility();
        this._updateRepeatUntilVisibility();

        box.add_child(new St.Widget({style_class: 'litsycal-panel-sep'}));

        // ── Alert ──────────────────────────────────────────────────────────────
        const alertInit = this._alertInitFor(ev?.alarm, this._allDay);
        const alertRow = new St.BoxLayout({style_class: 'litsycal-panel-row', x_expand: true});
        alertRow.add_child(new St.Label({text: _('Alert'), style_class: 'litsycal-panel-lbl'}));
        this._alertPicker = this._makeDropdownField(alertInit.options, alertInit.value);
        alertRow.add_child(this._alertPicker.actor);
        box.add_child(alertRow);

        box.add_child(new St.Widget({style_class: 'litsycal-panel-sep'}));

        // ── Notes ──────────────────────────────────────────────────────────────
        const notesRow = new St.BoxLayout({style_class: 'litsycal-panel-row', x_expand: true});
        notesRow.add_child(new St.Label({text: _('Notes'), style_class: 'litsycal-panel-lbl'}));
        const notesScroll = new St.ScrollView({
            style_class: 'litsycal-panel-notes-scroll',
            x_expand: true,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
        });
        this._notesEntry = new St.Entry({
            style_class: 'litsycal-panel-notes-entry',
            hint_text: _('Add notes…'),
            x_expand: true,
            can_focus: true,
        });
        this._notesEntry.clutter_text.set_single_line_mode(false);
        this._notesEntry.clutter_text.set_activatable(false);
        this._notesEntry.clutter_text.set_line_wrap(true);
        // Default word-wrap has no break point in a run of text with no
        // spaces, so it just requests a wider box instead of wrapping —
        // this is what was stretching the whole dialog. WORD_CHAR falls
        // back to breaking mid-word once a line has nowhere else to wrap.
        this._notesEntry.clutter_text.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
        if (ev?.notes) this._notesEntry.set_text(ev.notes);
        this._focusOnClick(this._notesEntry);
        // St.ScrollView.set_child() requires an St.Scrollable child, which
        // St.Entry doesn't implement (only container types like BoxLayout
        // do) — go through a plain wrapper, same as the time picker's list.
        const notesInner = new St.BoxLayout({vertical: true, x_expand: true});
        notesInner.add_child(this._notesEntry);
        notesScroll.set_child(notesInner);
        notesRow.add_child(notesScroll);
        box.add_child(notesRow);

        // ── Error ──────────────────────────────────────────────────────────────
        this._errorLbl = new St.Label({
            style_class: 'litsycal-panel-error', text: '', visible: false,
        });
        box.add_child(this._errorLbl);

        // ── Buttons ────────────────────────────────────────────────────────────
        const btnRow = new St.BoxLayout({style_class: 'litsycal-panel-btn-row', x_expand: true});
        if (ev) {
            this._deleteBtn = new St.Button({label: _('Delete'), style_class: 'litsycal-panel-delete-btn'});
            this._deleteBtn.connect('clicked', () => this._confirmDelete());
            btnRow.add_child(this._deleteBtn);
        }
        btnRow.add_child(new St.Widget({x_expand: true}));
        this._cancelBtn = new St.Button({label: _('Cancel'), style_class: 'litsycal-panel-cancel-btn'});
        this._cancelBtn.connect('clicked', () => this.close());
        this._saveBtn = new St.Button({label: _('Save Event'), style_class: 'litsycal-panel-save-btn'});
        this._saveBtn.connect('clicked', () => this._save());
        btnRow.add_child(this._cancelBtn);
        btnRow.add_child(this._saveBtn);
        box.add_child(btnRow);

        this._titleEntry.clutter_text.connect('text-changed', () => this._updateSaveEnabled());
        this._updateSaveEnabled();

        // ── Tab order ──────────────────────────────────────────────────────────
        // Plain St/Clutter widgets don't get Tab-traversal for free the way a
        // GTK dialog's widgets do — see _moveFocus() for the key handling.
        // Listed in visual order; _focusableActors() filters to whatever is
        // currently mapped/reactive (rows like Ends' time or Repeat's Until
        // come and go based on All-day/Repeat/Alert state).
        this._focusOrder = [
            this._titleEntry, this._calPickerBtn,
            this._locationEntry, this._urlEntry, this._openUrlBtn,
            this._allDayBtn,
            this._startDatePicker.btn, this._startTimePicker.btn,
            this._endDatePicker.btn, this._endTimePicker.btn,
            this._repeatPicker.btn, this._repeatEndPicker.btn, this._repeatUntilPicker.btn,
            this._alertPicker.btn,
            this._notesEntry,
            this._deleteBtn, this._cancelBtn, this._saveBtn,
        ].filter(Boolean);
    }

    _nowHour() {
        const n = GLib.DateTime.new_now_local();
        return `${pad(n.get_hour())}:00`;
    }

    _nextHour() {
        const n = GLib.DateTime.new_now_local();
        return `${pad((n.get_hour() + 1) % 24)}:00`;
    }

    _refreshCalBtn() {
        const src = this._selSource;
        const row = new St.BoxLayout({style_class: 'litsycal-panel-icon-row', x_expand: true});
        if (src) {
            const dot = new St.Widget({style_class: 'litsycal-panel-dot'});
            dot.style = `background-color: ${src.color};`;
            row.add_child(dot);
            row.add_child(new St.Label({
                text: src.name, x_expand: true, style_class: 'litsycal-panel-cal-name',
            }));
        } else {
            row.add_child(new St.Label({text: _('No calendar'), x_expand: true}));
        }
        if (!this._event)
            row.add_child(new St.Label({text: '▾', style_class: 'litsycal-panel-cal-arrow'}));
        this._calPickerBtn.set_child(row);
    }

    _toggleAllDay() {
        this._allDay = !this._allDay;
        this._allDayBtn.set_label(this._allDay ? _('On') : _('Off'));
        this._allDayBtn.remove_style_class_name('litsycal-panel-toggle-on');
        this._allDayBtn.remove_style_class_name('litsycal-panel-toggle-off');
        this._allDayBtn.add_style_class_name(
            this._allDay ? 'litsycal-panel-toggle-on' : 'litsycal-panel-toggle-off'
        );
        this._updateTimeVisibility();

        // Alert presets differ for all-day vs timed events; keep a custom
        // (unrecognized) alarm selected across the toggle, reset others to None.
        const keepCustom = this._alertPicker.getValue() === 'CUSTOM';
        const presets = this._alertPresetOptions(this._allDay);
        this._alertPicker.setOptions(
            keepCustom ? [{value: 'CUSTOM', label: _('Custom')}, ...presets] : presets,
            keepCustom ? 'CUSTOM' : 'NONE'
        );
    }

    _updateTimeVisibility() {
        this._startTimePicker.actor.visible = !this._allDay;
        this._endTimePicker.actor.visible   = !this._allDay;
    }

    _alertPresetOptions(allDay) {
        return (allDay ? ALERT_PRESETS_ALLDAY : ALERT_PRESETS_TIMED)
            .map(v => ({value: v, label: alertLabel(v, allDay)}));
    }

    _alertInitFor(alarm, allDay) {
        const presets = this._alertPresetOptions(allDay);
        if (!alarm) return {value: 'NONE', options: presets};
        if (alarm.raw)
            return {value: 'CUSTOM', options: [{value: 'CUSTOM', label: _('Custom')}, ...presets]};

        const key = String(alarm.minutesBefore);
        if (presets.some(o => o.value === key)) return {value: key, options: presets};

        // Exact offset from another app that isn't one of our presets — inject
        // it so it stays visible and editable instead of looking unsupported.
        const extra = {value: key, label: minutesLabel(alarm.minutesBefore, allDay)};
        return {value: key, options: [extra, ...presets]};
    }

    _repeatInitFor(recurrence) {
        const presets = REPEAT_PRESETS.map(p => ({value: p.value, label: repeatLabel(p.value)}));
        if (!recurrence) return {value: 'NONE', options: presets, customRecurrence: null};

        if (!recurrence.raw) {
            const match = REPEAT_PRESETS.find(
                p => p.freq === recurrence.freq && p.interval === recurrence.interval
            );
            if (match) return {value: match.value, options: presets, customRecurrence: null};
        }
        return {
            value: 'CUSTOM',
            options: [{value: 'CUSTOM', label: _('Custom')}, ...presets],
            customRecurrence: recurrence,
        };
    }

    _updateRepeatEndVisibility() {
        const val = this._repeatPicker.getValue();
        this._repeatEndRow.visible = val !== 'NONE' && val !== 'CUSTOM';
    }

    _updateRepeatUntilVisibility() {
        this._repeatUntilPicker.actor.visible = this._repeatEndPicker.getValue() === 'ON_DATE';
    }

    // Actors from this._focusOrder that are actually reachable right now —
    // a hidden row (Ends' time while All-day is on, Repeat's Until, the
    // disabled Save button, ...) leaves its actor un-mapped rather than
    // removed, so `mapped` is what tells us it's currently skippable.
    _focusableActors() {
        return this._focusOrder.filter(a => a.mapped && a.reactive !== false);
    }

    // Depth-first collection of an open floating dropdown's own focusable
    // buttons/entries — e.g. the date picker's prev/next-month buttons plus
    // its whole day grid, not just its trigger button — used by
    // _moveInDropdown() and by _toggleDropdown()'s focus-on-open step.
    _collectFocusable(actor, out = []) {
        if (actor instanceof St.Button || actor instanceof St.Entry) {
            if (actor.mapped && actor.reactive !== false) out.push(actor);
            return out;
        }
        for (const child of actor.get_children?.() ?? []) this._collectFocusable(child, out);
        return out;
    }

    // Closes the currently open dropdown, if any, and returns focus to the
    // button that opened it — the same "leave the popup" step Escape, Tab,
    // and picking an option all end up doing.
    _closeDropdown() {
        const anchor = this._openDropdownAnchor;
        this._openDropdown.visible   = false;
        this._openDropdown           = null;
        this._openDropdownAnchor     = null;
        anchor?.grab_key_focus();
    }

    // Up/Down move the highlight among an open dropdown's own items — same
    // as a native combobox's popup. Wraps at either end.
    _moveInDropdown(forward) {
        const items = this._collectFocusable(this._openDropdown);
        if (items.length === 0) return;

        const focused = global.stage.get_key_focus();
        const curIdx  = items.findIndex(a => a === focused || a.clutter_text === focused);
        const nextIdx = curIdx === -1
            ? (forward ? 0 : items.length - 1)
            : (curIdx + (forward ? 1 : -1) + items.length) % items.length;
        items[nextIdx].grab_key_focus();
    }

    // St.Entry forwards key focus to its internal clutter_text, so that's
    // what global.stage.get_key_focus() actually returns while one is
    // focused — matched here via each actor's own .clutter_text, if it has one.
    // Tab always leaves an open dropdown (Up/Down navigate within it — see
    // _moveInDropdown) rather than walking its items one Tab at a time,
    // which made tabbing past e.g. Alert's 10 options, or the date picker's
    // whole day grid, painfully slow — same as a native combobox, where Tab
    // moves between fields and the popup's own list uses arrow keys.
    _moveFocus(forward) {
        if (this._openDropdown) {
            const anchor = this._openDropdownAnchor;
            this._closeDropdown();

            const actors    = this._focusableActors();
            const anchorIdx = actors.indexOf(anchor);
            const resumeIdx = anchorIdx === -1
                ? (forward ? 0 : actors.length - 1)
                : (anchorIdx + (forward ? 1 : -1) + actors.length) % actors.length;
            actors[resumeIdx]?.grab_key_focus();
            return;
        }

        const actors = this._focusableActors();
        if (actors.length === 0) return;

        const focused = global.stage.get_key_focus();
        const curIdx  = actors.findIndex(a => a === focused || a.clutter_text === focused);
        const nextIdx = curIdx === -1
            ? (forward ? 0 : actors.length - 1)
            : (curIdx + (forward ? 1 : -1) + actors.length) % actors.length;
        actors[nextIdx].grab_key_focus();
    }

    _updateSaveEnabled() {
        const hasTitle = this._titleEntry.get_text().trim().length > 0;
        this._saveBtn.reactive  = hasTitle;
        this._saveBtn.can_focus = hasTitle;
        this._saveBtn.remove_style_class_name('litsycal-panel-save-btn-disabled');
        if (!hasTitle) this._saveBtn.add_style_class_name('litsycal-panel-save-btn-disabled');
    }

    // This panel floats in Main.layoutManager.uiGroup, detached from the shell's
    // PopupMenu that hosts the calendar — clicking an entry here doesn't reliably
    // grab key focus on its own, so do it explicitly.
    _focusOnClick(entry) {
        entry.connect('button-press-event', () => {
            entry.grab_key_focus();
            return Clutter.EVENT_PROPAGATE;
        });
    }

    // Registers a dropdown/date/time list as a floating overlay: added to
    // this._root (a later sibling of this._box there, so it paints on top
    // of it, and still inside the grabbed subtree so its buttons actually
    // receive clicks — see the constructor) rather than into the panel's
    // own layout, so showing it never grows the panel. Tracked for teardown
    // in close().
    //
    // Also wired to the same _handleKeyEvent as this._box: captured-event
    // under this panel's grab only reaches a genuine descendant of the
    // grabbed actor (this._root) that itself contains the focused actor —
    // this._box covers focus living in the main fields, but a dropdown is
    // this._root's *other* child, a sibling of this._box, so it needs its
    // own connection to see Escape/Tab/arrows while one of its own items
    // (not the trigger button) has focus.
    _attachFloatingDropdown(dropdown, anchorBtn) {
        this._root.add_child(dropdown);
        this._floaters.push(dropdown);
        // St.BoxLayout/St.ScrollView default to non-reactive, and a
        // non-reactive actor is skipped entirely by Clutter's key-event
        // capture-phase walk — without this, 'captured-event' below never
        // fires once focus is on one of the dropdown's own items, so
        // Escape/arrows silently do nothing (confirmed via instrumentation:
        // the item itself still received the raw bubble-phase event, but
        // it never reached this container or anything above it).
        dropdown.reactive = true;
        dropdown.connect('captured-event', (_actor, ev) => this._handleKeyEvent(ev));
        // Registered here, at construction, rather than lazily inside
        // _toggleDropdown() (which only ever runs once the button has
        // already been clicked once) — otherwise Down/Up-opens-a-closed-
        // trigger in _handleKeyEvent can't recognize a field that hasn't
        // been interacted with yet, and does nothing on it.
        (this._dropdownTriggers ??= new Set()).add(anchorBtn);
        return dropdown;
    }

    // Positions a floating dropdown directly under its anchor button (or
    // above it, if it wouldn't fit on screen below), matching at least the
    // anchor's width. Uses get_preferred_*() rather than get_width/height()
    // since the dropdown, as a manually-positioned this._root child, may not
    // have been through an allocation cycle yet.
    _positionFloatingDropdown(dropdown, anchorBtn) {
        const monitor  = Main.layoutManager.primaryMonitor;
        const [ax, ay] = anchorBtn.get_transformed_position();
        const aw       = anchorBtn.get_width();
        const ah       = anchorBtn.get_height();

        const [, natW] = dropdown.get_preferred_width(-1);
        const w        = Math.max(aw, natW);
        const [, natH] = dropdown.get_preferred_height(w);

        let x = Math.max(monitor.x + 4, Math.min(ax, monitor.x + monitor.width - w - 4));

        let y = ay + ah + 2;
        if (y + natH > monitor.y + monitor.height - 4) y = ay - natH - 2;
        y = Math.max(monitor.y + 4, y);

        dropdown.set_width(w);
        dropdown.set_position(x, y);
    }

    // Only one dropdown (calendar picker, date picker, time picker) open at a time.
    _toggleDropdown(dropdown, anchorBtn, onOpen) {
        const willOpen = !dropdown.visible;
        if (this._openDropdown && this._openDropdown !== dropdown)
            this._openDropdown.visible = false;
        if (willOpen) {
            onOpen?.();
            this._positionFloatingDropdown(dropdown, anchorBtn);
        }
        dropdown.visible = willOpen;
        this._openDropdown       = willOpen ? dropdown : null;
        this._openDropdownAnchor = willOpen ? anchorBtn : null;

        if (willOpen) {
            // Land keyboard focus on the list's current selection (or its
            // first item) as soon as it opens, same as a native combobox —
            // Up/Down then move within it (_moveInDropdown), no extra Tab
            // press needed to "enter" it. Deferred one idle: becoming
            // visible this frame means it hasn't been through an allocation
            // pass yet, so mapped/reactive filtering in _collectFocusable
            // isn't reliable until then.
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                if (this._openDropdown !== dropdown) return GLib.SOURCE_REMOVE;
                const items = this._collectFocusable(dropdown);
                const selected = items.find(i => i.style_class?.includes('-selected'));
                (selected ?? items[0])?.grab_key_focus();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    // options: [{value, label}]. Returns a controller with getValue() and
    // setOptions(newOptions, newValue) so the Alert list can be rebuilt when
    // All-day toggles.
    _makeDropdownField(options, initialValue, onChange) {
        const wrap    = new St.BoxLayout({vertical: true, x_expand: true});
        const btnLbl  = new St.Label({x_expand: true});
        const btn     = new St.Button({
            style_class: 'litsycal-panel-dropdown-btn', x_expand: true, child: btnLbl,
        });
        const dropdown = new St.BoxLayout({
            vertical: true,
            style_class: 'popup-menu-content litsycal-panel-dropdown-list',
            visible: false,
        });
        this._attachFloatingDropdown(dropdown, btn);

        let opts = options;
        let cur  = initialValue;

        const rebuildList = () => {
            dropdown.destroy_all_children();
            for (const opt of opts) {
                const isSel = opt.value === cur;
                const optBtn = new St.Button({
                    label: opt.label, x_expand: true,
                    style_class: 'litsycal-panel-dropdown-option' +
                        (isSel ? ' litsycal-panel-dropdown-option-selected' : ''),
                });
                optBtn.connect('clicked', () => {
                    cur = opt.value;
                    btnLbl.set_text(opt.label);
                    this._closeDropdown();
                    onChange?.(cur);
                });
                dropdown.add_child(optBtn);
            }
        };

        btnLbl.set_text(opts.find(o => o.value === cur)?.label ?? '');
        rebuildList();

        // rebuildList as onOpen: without it, the "-selected" mark (used both
        // visually and by _toggleDropdown's auto-focus-on-open) would stay
        // stuck on whatever was selected when the list was last built,
        // since picking an option updates `cur` but doesn't itself rebuild.
        btn.connect('clicked', () => this._toggleDropdown(dropdown, btn, rebuildList));

        wrap.add_child(btn);

        return {
            actor: wrap,
            btn,
            getValue: () => cur,
            setOptions(newOpts, newValue) {
                opts = newOpts;
                cur  = newValue;
                btnLbl.set_text(opts.find(o => o.value === cur)?.label ?? '');
                rebuildList();
            },
        };
    }

    _makeDateField(initialStr) {
        const [iy, im, id] = initialStr.split('-').map(Number);
        let cur  = {y: iy, m: im, d: id};
        let view = {y: iy, m: im};

        // The label shows the calendar-system year for the user, but getValue()
        // below always returns the real Gregorian ISO string _save()/_parseDate()
        // expect — display and stored value are deliberately kept separate.
        const labelFor = ({y, m, d}) =>
            `${displayYear(y, this._calendarSystem)}-${pad(m)}-${pad(d)}`;

        const wrap = new St.BoxLayout({vertical: true, x_expand: true});
        const btnLbl = new St.Label({text: labelFor(cur)});
        const btn = new St.Button({
            style_class: 'litsycal-panel-date-btn', x_expand: true, child: btnLbl,
        });

        const dropdown = new St.BoxLayout({
            vertical: true,
            style_class: 'popup-menu-content litsycal-panel-date-dropdown',
            visible: false,
        });
        this._attachFloatingDropdown(dropdown, btn);

        const header    = new St.BoxLayout({style_class: 'litsycal-panel-date-header'});
        const prevBtn   = new St.Button({label: '‹', style_class: 'litsycal-nav-btn',
                                          accessible_name: _('Previous month')});
        const monthLbl  = new St.Label({x_expand: true, style_class: 'litsycal-panel-date-month-lbl'});
        const nextBtn   = new St.Button({label: '›', style_class: 'litsycal-nav-btn',
                                          accessible_name: _('Next month')});
        header.add_child(prevBtn);
        header.add_child(monthLbl);
        header.add_child(nextBtn);
        dropdown.add_child(header);

        const dowRow = new St.BoxLayout({style_class: 'litsycal-panel-date-dow-row'});
        for (let i = 0; i < 7; i++) {
            const abbr = capitalize(GLib.DateTime.new_local(2025, 1, 6 + i, 0, 0, 0).format('%a'));
            dowRow.add_child(new St.Label({text: abbr, x_expand: true, style_class: 'litsycal-panel-date-dow'}));
        }
        dropdown.add_child(dowRow);

        const gridBox = new St.BoxLayout({vertical: true});
        dropdown.add_child(gridBox);

        const todayStr = dateStr(GLib.DateTime.new_now_local());

        const rebuild = () => {
            gridBox.destroy_all_children();
            monthLbl.set_text(
                `${capitalize(GLib.DateTime.new_local(view.y, view.m, 1, 0, 0, 0).format('%B'))} ` +
                `${displayYear(view.y, this._calendarSystem)}`
            );

            const firstDow = GLib.DateTime.new_local(view.y, view.m, 1, 0, 0, 0).get_day_of_week() - 1;
            const total    = daysInMonth(view.y, view.m);

            let row = new St.BoxLayout({style_class: 'litsycal-panel-date-row'});
            for (let i = 0; i < firstDow; i++) row.add_child(new St.Widget({x_expand: true}));
            let col = firstDow;

            for (let d = 1; d <= total; d++) {
                const ds     = `${view.y}-${pad(view.m)}-${pad(d)}`;
                const isSel  = view.y === cur.y && view.m === cur.m && d === cur.d;
                const isToday = ds === todayStr;
                let sc = 'litsycal-panel-date-day';
                if (isSel)   sc += ' litsycal-panel-date-day-selected';
                if (isToday) sc += ' litsycal-panel-date-day-today';
                const dayBtn = new St.Button({label: String(d), x_expand: true, style_class: sc});
                dayBtn.accessible_name =
                    capitalize(GLib.DateTime.new_local(view.y, view.m, d, 0, 0, 0).format('%A, %B %-d')) +
                    `, ${displayYear(view.y, this._calendarSystem)}`;
                dayBtn.connect('clicked', () => {
                    cur = {y: view.y, m: view.m, d};
                    btnLbl.set_text(labelFor(cur));
                    this._closeDropdown();
                });
                row.add_child(dayBtn);
                col++;
                if (col === 7) {
                    gridBox.add_child(row);
                    row = new St.BoxLayout({style_class: 'litsycal-panel-date-row'});
                    col = 0;
                }
            }
            if (col > 0) {
                while (col < 7) { row.add_child(new St.Widget({x_expand: true})); col++; }
                gridBox.add_child(row);
            }
        };

        prevBtn.connect('clicked', () => {
            view = view.m === 1 ? {y: view.y - 1, m: 12} : {y: view.y, m: view.m - 1};
            rebuild();
        });
        nextBtn.connect('clicked', () => {
            view = view.m === 12 ? {y: view.y + 1, m: 1} : {y: view.y, m: view.m + 1};
            rebuild();
        });
        btn.connect('clicked', () => {
            this._toggleDropdown(dropdown, btn, () => { view = {y: cur.y, m: cur.m}; rebuild(); });
        });

        rebuild();
        wrap.add_child(btn);

        return {
            actor: wrap,
            btn,
            getValue: () => `${cur.y}-${pad(cur.m)}-${pad(cur.d)}`,
        };
    }

    _makeTimeField(initialStr) {
        const wrap = new St.BoxLayout({vertical: true});
        const btnLbl = new St.Label({text: initialStr});
        const btn = new St.Button({style_class: 'litsycal-panel-time-btn', child: btnLbl});

        const scroll = new St.ScrollView({
            style_class: 'litsycal-panel-time-scroll',
            visible: false,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
        });
        const list = new St.BoxLayout({
            vertical: true, style_class: 'popup-menu-content litsycal-panel-time-dropdown',
        });
        scroll.set_child(list);
        this._attachFloatingDropdown(scroll, btn);

        let cur = initialStr;
        const optBtns = [];
        for (let h = 0; h < 24; h++) {
            for (const m of [0, 30]) {
                const value = `${pad(h)}:${pad(m)}`;
                const isSel = value === cur;
                const optBtn = new St.Button({
                    label: value, x_expand: true,
                    style_class: 'litsycal-panel-time-option' +
                        (isSel ? ' litsycal-panel-time-option-selected' : ''),
                });
                optBtn.connect('clicked', () => {
                    cur = value;
                    btnLbl.set_text(value);
                    this._closeDropdown();
                });
                list.add_child(optBtn);
                optBtns.push(optBtn);
            }
        }

        btn.connect('clicked', () => {
            this._toggleDropdown(scroll, btn, () => {
                const idx = optBtns.findIndex(b => b.get_label() === cur);
                // Buttons are built once and never rebuilt, so picking a
                // time only moves `cur` — the "-selected" mark (used both
                // visually and by _toggleDropdown's auto-focus-on-open) was
                // left stuck on whatever was current when they were built.
                // Re-derive it here every time the list opens.
                for (const b of optBtns)
                    b.remove_style_class_name('litsycal-panel-time-option-selected');
                if (idx >= 0) optBtns[idx].add_style_class_name('litsycal-panel-time-option-selected');

                if (idx < 0) return;
                GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    const adjustment = scroll.vadjustment ?? scroll.vscroll.adjustment;
                    const rowH  = optBtns[0].get_height() || 0;
                    const viewH = scroll.get_height() || 0;
                    adjustment.value = Math.max(0, rowH * idx - viewH / 2 + rowH / 2);
                    return GLib.SOURCE_REMOVE;
                });
            });
        });

        wrap.add_child(btn);

        return {
            actor: wrap,
            btn,
            getValue: () => cur,
        };
    }

    _openUrl() {
        const url = this._urlEntry.get_text().trim();
        if (!url) return;
        try { Gio.AppInfo.launch_default_for_uri(url, null); } catch(_) {}
    }

    _parseDate(str) {
        const m = (str ?? '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (!m) return null;
        const [, y, mo, d] = m.map(Number);
        if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
        return `${y}-${pad(mo)}-${pad(d)}`;
    }

    _parseTime(str) {
        const m = (str ?? '').trim().match(/^(\d{1,2}):(\d{2})$/);
        if (!m) return null;
        const h = parseInt(m[1]), min = parseInt(m[2]);
        if (h > 23 || min > 59) return null;
        return {h, min};
    }

    _showError(msg) {
        this._errorLbl.set_text(msg);
        this._errorLbl.visible = true;
    }

    _recurrenceFromUI() {
        const val = this._repeatPicker.getValue();
        if (val === 'NONE')   return null;
        if (val === 'CUSTOM') return this._customRecurrence;

        const preset = REPEAT_PRESETS.find(p => p.value === val);
        const until  = this._repeatEndPicker.getValue() === 'ON_DATE'
            ? this._parseDate(this._repeatUntilPicker.getValue())
            : null;
        return {freq: preset.freq, interval: preset.interval, until};
    }

    _alarmFromUI() {
        const val = this._alertPicker.getValue();
        if (val === 'NONE')   return null;
        if (val === 'CUSTOM') return this._customAlarm;
        return {minutesBefore: parseInt(val)};
    }

    _save() {
        const title = this._titleEntry.get_text().trim();
        if (!title)           { this._showError(_('Title required')); return; }
        if (!this._selSource) { this._showError(_('No calendar available')); return; }

        const startDate = this._parseDate(this._startDatePicker.getValue());
        if (!startDate) { this._showError(_('Invalid date (YYYY-MM-DD)')); return; }

        let hour = 0, minute = 0, endHour = 1, endMinute = 0, endDate = startDate;

        if (!this._allDay) {
            const st = this._parseTime(this._startTimePicker.getValue());
            const et = this._parseTime(this._endTimePicker.getValue());
            if (!st) { this._showError(_('Invalid start time (HH:MM)')); return; }
            if (!et) { this._showError(_('Invalid end time (HH:MM)')); return; }
            hour = st.h; minute = st.min;
            endHour = et.h; endMinute = et.min;
            endDate = this._parseDate(this._endDatePicker.getValue()) ?? startDate;
        }

        const notes      = this._notesEntry.get_text().trim()    || null;
        const url        = this._urlEntry.get_text().trim()      || null;
        const location   = this._locationEntry.get_text().trim() || null;
        const recurrence = this._recurrenceFromUI();
        const alarm      = this._alarmFromUI();

        const fields = {title, date: startDate, allDay: this._allDay, hour, minute,
                         endDate, endHour, endMinute, notes, url, location, recurrence, alarm};

        const done = err => {
            if (err) { this._showError(err.message); return; }
            this.close();
        };

        if (this._event) {
            this._calManager.updateEvent(this._event.uid, this._event.clientUid, fields, done);
        } else {
            this._calManager.createEvent(fields, this._selSource.uid, done);
        }
    }

    _confirmDelete() {
        confirmDeleteEvent(this._calManager, this._event, err => {
            if (err) { this._showError(err.message); return; }
            this.close();
        }, overlay => { this._confirmOverlay = overlay; });
    }

    close() {
        if (this._confirmOverlay) {
            Main.layoutManager.uiGroup.remove_child(this._confirmOverlay);
            this._confirmOverlay.destroy();
            this._confirmOverlay = null;
        }
        if (this._clickId) { global.stage.disconnect(this._clickId); this._clickId = null; }
        if (this._keyId)   { this._box?.disconnect(this._keyId);     this._keyId   = null; }
        if (this._grab)    { Main.popModal(this._grab); this._grab = null; }
        if (this._floaters) {
            for (const f of this._floaters) {
                this._root.remove_child(f);
                f.destroy();
            }
            this._floaters = null;
        }
        this._openDropdown       = null;
        this._openDropdownAnchor = null;
        if (this._box) {
            this._root.remove_child(this._box);
            this._box.destroy();
            this._box = null;
            // Fire only on the transition that actually tears the box down,
            // so a redundant close() call (harmless everywhere else here)
            // can't invoke the caller's callback twice.
            this._onClose?.();
        }
        if (this._root) {
            Main.layoutManager.uiGroup.remove_child(this._root);
            this._root.destroy();
            this._root = null;
        }
    }
}

// A tiny floating panel with a single "yyyy-mm-dd" entry and a Go button,
// used by the settings menu's "Go to date" item. Follows the same floating-
// panel-in-uiGroup pattern as EventPanel above (own stage click/Escape
// handling, explicit teardown), just much smaller.
export class GoToDatePanel {

    // onClose is called exactly once, with the parsed GLib.DateTime on a
    // successful submit or null on cancel (Escape / click outside).
    constructor(anchorActor, onClose) {
        this._onClose = onClose;

        this._box = new St.BoxLayout({
            vertical: true,
            style_class: 'popup-menu-content litsycal-goto-panel',
            reactive: true,
            // Hidden via opacity (not `visible`, which the modal grab below
            // needs the actor mapped for) until _position() places it.
            opacity: 0,
        });

        this._build();
        Main.layoutManager.uiGroup.add_child(this._box);

        // Needed because this can now appear while the calendar dropdown
        // (this.menu) is still open, i.e. still holding its own modal grab:
        // without a competing grab here, input is redelivered starting from
        // that grab's actor rather than the stage, so our own stage-level
        // listeners below would never see it, and even a click on our own
        // entry/button would be swallowed as a click-outside-of-that-menu
        // instead of reaching us. See SettingsMenuPanel in extension.js for
        // the full explanation — same mechanism, same fix.
        this._grab = Main.pushModal(this._box, {actionMode: Shell.ActionMode.POPUP});

        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._position(anchorActor);
            this._box.opacity = 255;
            this._entry.grab_key_focus();
            return GLib.SOURCE_REMOVE;
        });

        this._eventId = this._box.connect('captured-event', (_actor, ev) => {
            if (ev.type() === Clutter.EventType.BUTTON_PRESS) {
                const [x, y] = ev.get_coords();
                const actor  = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y);
                if (actor && !this._box.contains(actor)) {
                    this._finish(null);
                    return Clutter.EVENT_STOP;
                }
            } else if (ev.type() === Clutter.EventType.KEY_PRESS &&
                       ev.get_key_symbol() === Clutter.KEY_Escape) {
                this._finish(null);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    _position(anchor) {
        const monitor = Main.layoutManager.primaryMonitor;
        const panelH  = Main.panel.get_height();
        const boxW    = this._box.get_width()  || 220;
        const boxH    = this._box.get_height() || 100;

        if (anchor) {
            const [ax, ay] = anchor.get_transformed_position();
            const aw = anchor.get_width();
            const ah = anchor.get_height();

            let x = ax + Math.round((aw - boxW) / 2);
            x = Math.max(monitor.x + 4, Math.min(x, monitor.x + monitor.width - boxW - 4));

            let y = Math.max(monitor.y + panelH + 4,
                              Math.min(ay + ah + 6, monitor.y + monitor.height - boxH - 4));

            this._box.set_position(x, y);
        } else {
            this._box.set_position(
                monitor.x + Math.round((monitor.width  - boxW) / 2),
                monitor.y + panelH + Math.round((monitor.height - panelH) * 0.18)
            );
        }
    }

    _build() {
        const box = this._box;

        box.add_child(new St.Label({text: _('Go to date'), style_class: 'litsycal-goto-title'}));

        const row = new St.BoxLayout({style_class: 'litsycal-panel-row', x_expand: true});

        this._entry = new St.Entry({
            style_class: 'litsycal-panel-text-entry',
            hint_text: 'yyyy-mm-dd',
            x_expand: true,
            can_focus: true,
        });
        this._entry.clutter_text.connect('activate', () => this._submit());
        this._entry.clutter_text.connect('text-changed', () => { this._errorLbl.visible = false; });
        row.add_child(this._entry);

        const goBtn = new St.Button({label: _('Go'), style_class: 'litsycal-panel-save-btn'});
        goBtn.connect('clicked', () => this._submit());
        row.add_child(goBtn);

        box.add_child(row);

        this._errorLbl = new St.Label({
            text: _('Enter a date as yyyy-mm-dd'),
            style_class: 'litsycal-panel-error',
            visible: false,
        });
        box.add_child(this._errorLbl);
    }

    _submit() {
        const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(this._entry.get_text().trim());
        const y = match ? parseInt(match[1], 10) : NaN;
        const m = match ? parseInt(match[2], 10) : NaN;
        const d = match ? parseInt(match[3], 10) : NaN;
        const valid = !!match && y >= 1 && y <= 9999 && m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);

        if (!valid) {
            this._errorLbl.visible = true;
            return;
        }
        this._finish(GLib.DateTime.new_local(y, m, d, 0, 0, 0));
    }

    _finish(dt) {
        if (!this._box) return;
        if (this._eventId) { this._box.disconnect(this._eventId); this._eventId = null; }
        if (this._grab)    { Main.popModal(this._grab); this._grab = null; }
        Main.layoutManager.uiGroup.remove_child(this._box);
        this._box.destroy();
        this._box = null;
        this._onClose(dt);
    }

    close() {
        this._finish(null);
    }
}
