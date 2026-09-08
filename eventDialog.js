import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import St      from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib    from 'gi://GLib';
import Gio     from 'gi://Gio';
import Shell   from 'gi://Shell';

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
        global.stage.disconnect(clickId);
        global.stage.disconnect(keyId);
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

    const clickId = global.stage.connect('button-press-event', (_stage, ev) => {
        const [x, y] = ev.get_coords();
        const actor  = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y);
        if (actor && !overlay.contains(actor)) closeOverlay();
        return Clutter.EVENT_PROPAGATE;
    });
    const keyId = global.stage.connect('key-press-event', (_stage, ev) => {
        if (ev.get_key_symbol() === Clutter.KEY_Escape) { closeOverlay(); return Clutter.EVENT_STOP; }
        return Clutter.EVENT_PROPAGATE;
    });
}

export class EventPanel {

    constructor(calManager, event, selectedDate, anchorActor, onSaved, calendarSystem = 'gregorian') {
        this._calManager     = calManager;
        this._event          = event ?? null;
        this._onSaved        = onSaved;
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

        this._build();

        Main.layoutManager.uiGroup.add_child(this._box);

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
            if (actor && !this._box.contains(actor)) this.close();
            return Clutter.EVENT_PROPAGATE;
        });

        this._keyId = global.stage.connect('key-press-event', (_stage, ev) => {
            if (this._confirmOverlay) return Clutter.EVENT_PROPAGATE; // let it handle Escape itself
            if (ev.get_key_symbol() === Clutter.KEY_Escape) {
                this.close();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
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
            this._box.set_position(
                monitor.x + Math.round((monitor.width  - boxW) / 2),
                monitor.y + panelH + Math.round((monitor.height - panelH) * 0.18)
            );
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
                    this._calDropdown.visible = false;
                });
                this._calDropdown.add_child(btn);
            }
            this._calPickerBtn.connect('clicked', () => {
                this._toggleDropdown(this._calDropdown);
            });
            calBox.add_child(this._calPickerBtn);
            calBox.add_child(this._calDropdown);
        } else {
            calBox.add_child(this._calPickerBtn);
        }
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
        this._notesEntry = new St.Entry({
            style_class: 'litsycal-panel-notes-entry',
            hint_text: _('Add notes…'),
            x_expand: true,
            can_focus: true,
        });
        this._notesEntry.clutter_text.set_single_line_mode(false);
        this._notesEntry.clutter_text.set_activatable(false);
        this._notesEntry.clutter_text.set_line_wrap(true);
        if (ev?.notes) this._notesEntry.set_text(ev.notes);
        this._focusOnClick(this._notesEntry);
        notesRow.add_child(this._notesEntry);
        box.add_child(notesRow);

        // ── Error ──────────────────────────────────────────────────────────────
        this._errorLbl = new St.Label({
            style_class: 'litsycal-panel-error', text: '', visible: false,
        });
        box.add_child(this._errorLbl);

        // ── Buttons ────────────────────────────────────────────────────────────
        const btnRow = new St.BoxLayout({style_class: 'litsycal-panel-btn-row', x_expand: true});
        if (ev) {
            const delBtn = new St.Button({label: _('Delete'), style_class: 'litsycal-panel-delete-btn'});
            delBtn.connect('clicked', () => this._confirmDelete());
            btnRow.add_child(delBtn);
        }
        btnRow.add_child(new St.Widget({x_expand: true}));
        const cancelBtn = new St.Button({label: _('Cancel'), style_class: 'litsycal-panel-cancel-btn'});
        cancelBtn.connect('clicked', () => this.close());
        this._saveBtn = new St.Button({label: _('Save Event'), style_class: 'litsycal-panel-save-btn'});
        this._saveBtn.connect('clicked', () => this._save());
        btnRow.add_child(cancelBtn);
        btnRow.add_child(this._saveBtn);
        box.add_child(btnRow);

        this._titleEntry.clutter_text.connect('text-changed', () => this._updateSaveEnabled());
        this._updateSaveEnabled();
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

    // Only one dropdown (calendar picker, date picker, time picker) open at a time.
    _toggleDropdown(dropdown, onOpen) {
        const willOpen = !dropdown.visible;
        if (this._openDropdown && this._openDropdown !== dropdown)
            this._openDropdown.visible = false;
        dropdown.visible = willOpen;
        this._openDropdown = willOpen ? dropdown : null;
        if (willOpen) onOpen?.();
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
                    dropdown.visible   = false;
                    this._openDropdown = null;
                    onChange?.(cur);
                });
                dropdown.add_child(optBtn);
            }
        };

        btnLbl.set_text(opts.find(o => o.value === cur)?.label ?? '');
        rebuildList();

        btn.connect('clicked', () => this._toggleDropdown(dropdown));

        wrap.add_child(btn);
        wrap.add_child(dropdown);

        return {
            actor: wrap,
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
                    dropdown.visible   = false;
                    this._openDropdown = null;
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
            this._toggleDropdown(dropdown, () => { view = {y: cur.y, m: cur.m}; rebuild(); });
        });

        rebuild();
        wrap.add_child(btn);
        wrap.add_child(dropdown);

        return {
            actor: wrap,
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
                    scroll.visible     = false;
                    this._openDropdown = null;
                });
                list.add_child(optBtn);
                optBtns.push(optBtn);
            }
        }

        btn.connect('clicked', () => {
            this._toggleDropdown(scroll, () => {
                const idx = optBtns.findIndex(b => b.get_label() === cur);
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
        wrap.add_child(scroll);

        return {
            actor: wrap,
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
            this._onSaved?.();
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
            this._onSaved?.();
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
        if (this._keyId)   { global.stage.disconnect(this._keyId);   this._keyId   = null; }
        if (this._box) {
            Main.layoutManager.uiGroup.remove_child(this._box);
            this._box.destroy();
            this._box = null;
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
