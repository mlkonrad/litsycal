import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import St      from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib    from 'gi://GLib';

const _ = str => GLib.dgettext('litsycal@mlkonrad.github.com', str);

function pad(n) { return String(n).padStart(2, '0'); }
function dateStr(dt) {
    return `${dt.get_year()}-${pad(dt.get_month())}-${pad(dt.get_day_of_month())}`;
}

export class EventPanel {

    constructor(calManager, event, selectedDate, onSaved) {
        this._calManager = calManager;
        this._event      = event ?? null;
        this._onSaved    = onSaved;
        this._allDay     = event?.allDay ?? false;
        this._selDate    = event?.date
            ?? (selectedDate ? dateStr(selectedDate) : dateStr(GLib.DateTime.new_now_local()));

        const sources   = calManager.getSources();
        this._sources   = sources;
        this._selSource = event
            ? (sources.find(s => s.uid === event.clientUid) ?? sources[0] ?? null)
            : (sources[0] ?? null);

        this._box = new St.BoxLayout({
            vertical: true,
            style_class: 'litsycal-event-panel',
            reactive: true,
        });

        this._build();

        Main.layoutManager.uiGroup.add_child(this._box);
        this._position();

        this._clickId = global.stage.connect('button-press-event', (_stage, ev) => {
            const [x, y] = ev.get_coords();
            const actor  = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y);
            if (actor && !this._box.contains(actor)) this.close();
            return Clutter.EVENT_PROPAGATE;
        });

        this._keyId = global.stage.connect('key-press-event', (_stage, ev) => {
            if (ev.get_key_symbol() === Clutter.KEY_Escape) {
                this.close();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._titleEntry.grab_key_focus();
            return GLib.SOURCE_REMOVE;
        });
    }

    _position() {
        const monitor = Main.layoutManager.primaryMonitor;
        const panelH  = Main.panel.get_height();
        this._box.set_position(
            monitor.x + Math.round((monitor.width  - 380) / 2),
            monitor.y + panelH + Math.round((monitor.height - panelH) * 0.18)
        );
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
                style_class: 'litsycal-panel-cal-dropdown',
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
                this._calDropdown.visible = !this._calDropdown.visible;
            });
            calBox.add_child(this._calPickerBtn);
            calBox.add_child(this._calDropdown);
        } else {
            calBox.add_child(this._calPickerBtn);
        }
        box.add_child(calBox);

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
        this._startDateEntry = new St.Entry({
            style_class: 'litsycal-panel-date-entry', text: this._selDate, x_expand: true,
        });
        this._startTimeEntry = new St.Entry({
            style_class: 'litsycal-panel-time-entry', text: defStartTime,
        });
        this._startsRow.add_child(this._startDateEntry);
        this._startsRow.add_child(this._startTimeEntry);
        box.add_child(this._startsRow);

        // ── Ends ───────────────────────────────────────────────────────────────
        const defEndTime = ev && !ev.allDay
            ? (ev.time?.split(' - ')[1]?.trim() ?? this._nextHour()) : this._nextHour();
        this._endsRow = new St.BoxLayout({style_class: 'litsycal-panel-row', x_expand: true});
        this._endsRow.add_child(new St.Label({text: _('Ends'), style_class: 'litsycal-panel-lbl'}));
        this._endDateEntry = new St.Entry({
            style_class: 'litsycal-panel-date-entry', text: this._selDate, x_expand: true,
        });
        this._endTimeEntry = new St.Entry({
            style_class: 'litsycal-panel-time-entry', text: defEndTime,
        });
        this._endsRow.add_child(this._endDateEntry);
        this._endsRow.add_child(this._endTimeEntry);
        box.add_child(this._endsRow);

        this._updateTimeVisibility();

        // ── Error ──────────────────────────────────────────────────────────────
        this._errorLbl = new St.Label({
            style_class: 'litsycal-panel-error', text: '', visible: false,
        });
        box.add_child(this._errorLbl);

        // ── Buttons ────────────────────────────────────────────────────────────
        const btnRow = new St.BoxLayout({style_class: 'litsycal-panel-btn-row', x_expand: true});
        if (ev) {
            const delBtn = new St.Button({label: _('Delete'), style_class: 'litsycal-panel-delete-btn'});
            delBtn.connect('clicked', () => this._delete());
            btnRow.add_child(delBtn);
        }
        btnRow.add_child(new St.Widget({x_expand: true}));
        const cancelBtn = new St.Button({label: _('Cancel'), style_class: 'litsycal-panel-cancel-btn'});
        cancelBtn.connect('clicked', () => this.close());
        const saveBtn = new St.Button({label: _('Save Event'), style_class: 'litsycal-panel-save-btn'});
        saveBtn.connect('clicked', () => this._save());
        btnRow.add_child(cancelBtn);
        btnRow.add_child(saveBtn);
        box.add_child(btnRow);
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
    }

    _updateTimeVisibility() {
        this._startTimeEntry.visible = !this._allDay;
        this._endTimeEntry.visible   = !this._allDay;
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

    _save() {
        const title = this._titleEntry.get_text().trim();
        if (!title)           { this._showError(_('Title required')); return; }
        if (!this._selSource) { this._showError(_('No calendar available')); return; }

        const startDate = this._parseDate(this._startDateEntry.get_text());
        if (!startDate) { this._showError(_('Invalid date (YYYY-MM-DD)')); return; }

        let hour = 0, minute = 0, endHour = 1, endMinute = 0, endDate = startDate;

        if (!this._allDay) {
            const st = this._parseTime(this._startTimeEntry.get_text());
            const et = this._parseTime(this._endTimeEntry.get_text());
            if (!st) { this._showError(_('Invalid start time (HH:MM)')); return; }
            if (!et) { this._showError(_('Invalid end time (HH:MM)')); return; }
            hour = st.h; minute = st.min;
            endHour = et.h; endMinute = et.min;
            endDate = this._parseDate(this._endDateEntry.get_text()) ?? startDate;
        }

        const done = err => {
            if (err) { this._showError(err.message); return; }
            this._onSaved?.();
            this.close();
        };

        if (this._event) {
            this._calManager.updateEvent(
                this._event.uid, this._event.clientUid,
                {title, date: startDate, allDay: this._allDay, hour, minute, endDate, endHour, endMinute},
                done
            );
        } else {
            this._calManager.createEvent(
                title, startDate, this._allDay, hour, minute, endHour, endMinute, endDate,
                this._selSource.uid, done
            );
        }
    }

    _delete() {
        this._calManager.deleteEvent(this._event.uid, this._event.clientUid, err => {
            if (err) { this._showError(err.message); return; }
            this._onSaved?.();
            this.close();
        });
    }

    close() {
        if (this._clickId) { global.stage.disconnect(this._clickId); this._clickId = null; }
        if (this._keyId)   { global.stage.disconnect(this._keyId);   this._keyId   = null; }
        if (this._box) {
            Main.layoutManager.uiGroup.remove_child(this._box);
            this._box.destroy();
            this._box = null;
        }
    }
}
