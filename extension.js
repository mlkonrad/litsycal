import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import St      from 'gi://St';
import GLib    from 'gi://GLib';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import Cairo   from 'gi://cairo';
import Gio     from 'gi://Gio';
import Meta    from 'gi://Meta';
import Shell   from 'gi://Shell';

import {CalendarManager} from './calendarManager.js';

// ── Constants ─────────────────────────────────────────────────────────────────

function capitalize(s) {
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

// Format datetime pattern but capitalize locale word tokens (%a %b %A %B)
function formatPattern(dt, pattern) {
    let p = pattern;
    for (const token of ['%A', '%B', '%a', '%b']) {
        const val = dt.format(token);
        if (val) p = p.split(token).join(capitalize(val));
    }
    return dt.format(p) ?? '';
}

function localeDayAbbrs() {
    return Array.from({length: 7}, (_, i) =>
        capitalize(GLib.DateTime.new_local(2025, 1, 6 + i, 0, 0, 0).format('%a'))
    );
}

const DAY_COL = {mo:0, tu:1, we:2, th:3, fr:4, sa:5, su:6};

// ── Accent colour ─────────────────────────────────────────────────────────────

const ACCENT_MAP = {
    blue:'#3584e4', teal:'#2190a4', green:'#3a944a', yellow:'#c88800',
    orange:'#e66100', red:'#e62d42', pink:'#d56199', purple:'#9141ac', slate:'#6f8396',
};

function readAccent() {
    try {
        const s = new Gio.Settings({schema: 'org.gnome.desktop.interface'});
        return ACCENT_MAP[s.get_string('accent-color')] ?? ACCENT_MAP.blue;
    } catch { return ACCENT_MAP.blue; }
}

function accentAlpha(hex, a) {
    const r = parseInt(hex.slice(1,3),16);
    const g = parseInt(hex.slice(3,5),16);
    const b = parseInt(hex.slice(5,7),16);
    return `rgba(${r},${g},${b},${a})`;
}

// ── Date helpers ──────────────────────────────────────────────────────────────

function dateStr(dt) {
    return `${dt.get_year()}-${String(dt.get_month()).padStart(2,'0')}-${String(dt.get_day_of_month()).padStart(2,'0')}`;
}

function daysInMonth(year, month) {
    const nm = month===12?1:month+1, ny = month===12?year+1:year;
    return GLib.DateTime.new_local(ny,nm,1,0,0,0).add_days(-1).get_day_of_month();
}

function prevMonthOf(year, month) {
    return month===1 ? [year-1,12] : [year,month-1];
}

// ── Outline painter ───────────────────────────────────────────────────────────

class OutlinePainter {
    configure(isDark, highlightCols) {
        this._isDark        = isDark;
        this._highlightCols = highlightCols;
    }

    paint(cr, w, h, numRows, firstCol, lastCol, lastRow) {
        const cw   = w / 7;
        const dark = this._isDark;

        for (const col of this._highlightCols) {
            cr.rectangle(col * cw, 0, cw, h);
            cr.setSourceRGBA(dark ? 1 : 0, dark ? 1 : 0, dark ? 1 : 0, dark ? 0.07 : 0.06);
            cr.fill();
        }

        const r  = 6;
        const ch = h / numRows;
        const fc = firstCol;
        const lc = lastCol;
        const lr = lastRow;

        const SPACING = 4;
        const rowGap  = i => i * ch + SPACING * (i / numRows - 0.5);
        const C = (px, py, dx, dy) =>
            cr.curveTo(px, py, px, py, px + r*dx, py + r*dy);

        const [ar, ag, ab] = dark ? [1, 1, 1] : [0, 0, 0];
        cr.setLineWidth(1.5);
        cr.setSourceRGBA(ar, ag, ab, dark ? 0.28 : 0.18);

        const stepY  = rowGap(lr);
        const notchY = rowGap(1);

        cr.moveTo(fc*cw + r, 0);
        cr.lineTo(7*cw - r, 0);  C(7*cw, 0, 0, +1);

        if (lc < 6) {
            cr.lineTo(7*cw, stepY - r);         C(7*cw, stepY, -1, 0);
            cr.lineTo((lc+1)*cw + r, stepY);    C((lc+1)*cw, stepY, 0, +1);
            cr.lineTo((lc+1)*cw, (lr+1)*ch-r);  C((lc+1)*cw, (lr+1)*ch, -1, 0);
        } else {
            cr.lineTo(7*cw, (lr+1)*ch - r);     C(7*cw, (lr+1)*ch, -1, 0);
        }

        cr.lineTo(r, (lr+1)*ch);  C(0, (lr+1)*ch, 0, -1);

        if (fc > 0) {
            cr.lineTo(0, notchY + r);     C(0, notchY, +1, 0);
            cr.lineTo(fc*cw - r, notchY); C(fc*cw, notchY, 0, -1);
            cr.lineTo(fc*cw, r);          C(fc*cw, 0, +1, 0);
        } else {
            cr.lineTo(0, r);  C(0, 0, +1, 0);
        }

        cr.lineTo(fc*cw + r, 0);
        cr.closePath();
        cr.stroke();
        cr.$dispose();
    }
}

// ── Calendar widget ───────────────────────────────────────────────────────────

const LitsycalCalendar = GObject.registerClass(
class LitsycalCalendar extends St.BoxLayout {

    _init(settings, openPrefs, openCalendar, onPinToggle) {
        super._init({vertical: true, style_class: 'litsycal-calendar'});

        this._settings     = settings;
        this._openPrefs    = openPrefs;
        this._openCalendar = openCalendar;
        this._onPinToggle  = onPinToggle;
        this._accent    = readAccent();
        this._events    = [];

        const now      = GLib.DateTime.new_now_local();
        this._year     = now.get_year();
        this._month    = now.get_month();
        this._today    = now;
        this._selected = now;

        this._firstCol = 0; this._lastCol = 6; this._lastRow = 0; this._numRows = 1;

        this._firstDayOfWeek   = settings.get_int('first-day-of-week');
        this._highlightCols    = this._readHighlight();
        this._calSize          = settings.get_int('calendar-size');
        this._theme            = settings.get_string('theme');
        this._weekendColorMode = settings.get_string('weekend-color-mode');
        this._weekendColor     = settings.get_string('weekend-color');
        this._applySizeClass();

        this._sids = [
            settings.connect('changed::first-day-of-week', () => {
                this._firstDayOfWeek = settings.get_int('first-day-of-week');
                this._highlightCols  = this._readHighlight();
                this._painter.configure(this._isDark, this._highlightCols);
                this._buildDayNameRow(true);
                this._buildGrid();
            }),
            settings.connect('changed::highlight-days', () => {
                this._highlightCols = this._readHighlight();
                this._painter.configure(this._isDark, this._highlightCols);
                this._buildDayNameRow(true);
                this._buildGrid();
            }),
            settings.connect('changed::calendar-size', () => {
                this._calSize = settings.get_int('calendar-size');
                this._applySizeClass();
                this._buildGrid();
            }),
            settings.connect('changed::theme', () => {
                this._theme = settings.get_string('theme');
                this._applyTheme();
            }),
            settings.connect('changed::weekend-color-mode', () => {
                this._weekendColorMode = settings.get_string('weekend-color-mode');
                this._buildGrid();
            }),
            settings.connect('changed::weekend-color', () => {
                this._weekendColor = settings.get_string('weekend-color');
                if (this._weekendColorMode === 'custom') this._buildGrid();
            }),
        ];

        this._iface    = new Gio.Settings({schema: 'org.gnome.desktop.interface'});
        this._accentId = this._iface.connect('changed::accent-color', () => {
            this._accent = readAccent();
            this._updateHeaderColors();
            this._buildGrid();
        });
        this._schemeId = this._iface.connect('changed::color-scheme', () => {
            if (this._theme === 'system') this._applyTheme();
        });

        this.connect('destroy', () => {
            for (const id of this._sids) this._settings.disconnect(id);
            this._iface.disconnect(this._accentId);
            this._iface.disconnect(this._schemeId);
            this._calManager?.destroy();
        });

        this._isDark  = this._computeIsDark();
        this._painter = new OutlinePainter();
        this._painter.configure(this._isDark, this._highlightCols);

        this._buildHeader();
        this._buildDayNameRow();
        this._buildGridContainer();
        this._applyTheme();

        this.add_child(new St.Widget({style_class: 'litsycal-sep'}));

        this._agendaBox = new St.BoxLayout({vertical: true, style_class: 'litsycal-agenda', x_expand: true});
        this.add_child(this._agendaBox);
        this._buildAgenda();

        this._buildFooter();
        this._buildCreateForm();

        this._calSourceIdx = 0;
        this._calManager   = new CalendarManager(events => {
            this._events = events;
            this._buildGrid();
            this._buildAgenda();
        });
        this._calManager.fetchMonth(this._year, this._month);
    }

    // ── Settings ──────────────────────────────────────────────────────────────

    _readHighlight() {
        const fd = this._firstDayOfWeek;
        return new Set(
            this._settings.get_strv('highlight-days')
                .map(d => DAY_COL[d])
                .filter(v => v !== undefined)
                .map(absDay => (absDay - fd + 7) % 7)
        );
    }

    _computeIsDark() {
        if (this._theme === 'dark')  return true;
        if (this._theme === 'light') return false;
        return this._iface.get_string('color-scheme') === 'prefer-dark';
    }

    _updateHeaderColors() {
        this._dotBtn.style = `color: ${this._accent};`;
    }

    _applySizeClass() {
        this.remove_style_class_name('litsycal-size-sm');
        this.remove_style_class_name('litsycal-size-lg');
        if (this._calSize === 0) this.add_style_class_name('litsycal-size-sm');
        else if (this._calSize === 2) this.add_style_class_name('litsycal-size-lg');
    }

    _applyTheme() {
        this._isDark = this._computeIsDark();
        this.remove_style_class_name('litsycal-theme-light');
        this.remove_style_class_name('litsycal-theme-dark');
        this.add_style_class_name(this._isDark ? 'litsycal-theme-dark' : 'litsycal-theme-light');
        this._painter.configure(this._isDark, this._highlightCols);
        if (this._prevBtn) this._updateHeaderColors();
        this._buildDayNameRow(true);
        this._buildGrid();
        if (this._agendaBox) this._buildAgenda();
        this._outline?.queue_repaint();
    }

    // ── Header ────────────────────────────────────────────────────────────────

    _buildHeader() {
        const row = new St.BoxLayout({style_class: 'litsycal-header'});

        this._monthLbl = new St.Label({style_class: 'litsycal-month-lbl', x_expand: true});

        this._prevBtn  = new St.Button({label: '‹', style_class: 'litsycal-nav-btn'});
        this._dotBtn   = new St.Button({label: '●', style_class: 'litsycal-nav-btn litsycal-dot-btn'});
        this._nextBtn  = new St.Button({label: '›', style_class: 'litsycal-nav-btn'});

        this._prevBtn.connect('clicked', () => this._shiftMonth(-1));
        this._dotBtn.connect('clicked',  () => this._goToday());
        this._nextBtn.connect('clicked', () => this._shiftMonth(+1));

        row.add_child(this._monthLbl);
        row.add_child(this._prevBtn);
        row.add_child(this._dotBtn);
        row.add_child(this._nextBtn);
        this.add_child(row);

        this._updateMonthLabel();
        this._updateHeaderColors();
    }

    // ── Day-name row ──────────────────────────────────────────────────────────

    _buildDayNameRow(rebuild = false) {
        if (rebuild && this._dayNameRow) {
            this.remove_child(this._dayNameRow);
            this._dayNameRow.destroy();
        }

        const fd          = this._firstDayOfWeek;
        const dayAbbrs    = localeDayAbbrs();
        const orderedAbbr = [...dayAbbrs.slice(fd), ...dayAbbrs.slice(0, fd)];

        const row = new St.BoxLayout({style_class: 'litsycal-day-names'});
        for (let i = 0; i < 7; i++) {
            const isHL = this._highlightCols.has(i);
            const cell = new St.BoxLayout({
                x_expand: true,
                style_class: isHL ? 'litsycal-day-name-cell litsycal-col-hl' : 'litsycal-day-name-cell',
            });
            const lbl = new St.Label({text: orderedAbbr[i], style_class: 'litsycal-day-name'});
            lbl.clutter_text.set_x_align(Clutter.ActorAlign.CENTER);
            cell.add_child(lbl);
            row.add_child(cell);
        }

        this._dayNameRow = row;
        if (rebuild) this.insert_child_at_index(row, 1);
        else         this.add_child(row);
    }

    // ── Grid container ────────────────────────────────────────────────────────

    _buildGridContainer() {
        const overlay = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true, y_expand: true,
        });

        this._gridBox = new St.BoxLayout({
            vertical: true, style_class: 'litsycal-grid',
            x_expand: true, y_expand: true,
        });

        this._outline = new St.DrawingArea({x_expand: true, y_expand: true, reactive: false});
        this._outline.connect('repaint', (area) => {
            const [w, h] = area.get_surface_size();
            if (w > 0 && h > 0 && this._numRows > 0)
                this._painter.paint(area.get_context(), w, h,
                    this._numRows, this._firstCol, this._lastCol, this._lastRow);
        });

        overlay.add_child(this._gridBox);
        overlay.add_child(this._outline);
        this.add_child(overlay);
        overlay.connect('notify::allocation', () => this._outline.queue_repaint());
    }

    // ── Calendar grid ─────────────────────────────────────────────────────────

    _buildGrid() {
        this._gridBox.destroy_all_children();

        const fd       = this._firstDayOfWeek;
        const glibDow  = GLib.DateTime.new_local(this._year, this._month, 1, 0, 0, 0)
                                       .get_day_of_week() - 1;
        const firstDow = (glibDow - fd + 7) % 7;
        const total    = daysInMonth(this._year, this._month);

        this._firstCol = firstDow;
        const lastIdx  = firstDow + total - 1;
        this._lastRow  = Math.floor(lastIdx / 7);
        this._lastCol  = lastIdx % 7;
        this._numRows  = this._lastRow + 1;

        const todayStr = dateStr(this._today);
        const selStr   = dateStr(this._selected);
        const [py, pm] = prevMonthOf(this._year, this._month);
        const prevTot  = daysInMonth(py, pm);

        let row = new St.BoxLayout({style_class: 'litsycal-grid-row'});
        let col = 0;

        for (let i = firstDow - 1; i >= 0; i--) {
            row.add_child(this._makeOverflow(prevTot - i));
            col++;
        }

        for (let d = 1; d <= total; d++) {
            const ds = `${this._year}-${String(this._month).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
            const actualDay = (col + fd) % 7;
            const isWeekend = actualDay === 5 || actualDay === 6;
            row.add_child(this._makeCell(d, ds, ds===todayStr, ds===selStr, isWeekend));
            col++;
            if (col === 7) {
                this._gridBox.add_child(row);
                row = new St.BoxLayout({style_class: 'litsycal-grid-row'});
                col = 0;
            }
        }

        if (col > 0) {
            let nd = 1;
            while (col < 7) { row.add_child(this._makeOverflow(nd++)); col++; }
            this._gridBox.add_child(row);
        }

        this._outline?.queue_repaint();
    }

    _makeOverflow(day) {
        const box = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'litsycal-cell-box'});
        const lbl = new St.Label({text: String(day), style_class: 'litsycal-overflow', x_expand: true});
        lbl.clutter_text.set_x_align(Clutter.ActorAlign.CENTER);
        box.add_child(lbl);
        box.add_child(new St.BoxLayout({style_class: 'litsycal-dot-row', x_expand: true}));
        return box;
    }

    _makeCell(day, ds, isToday, isSel, isWeekend) {
        let sc = 'litsycal-day-btn';
        if (isToday)    sc += ' litsycal-today';
        else if (isSel) sc += ' litsycal-selected';

        const btn = new St.Button({style_class: sc, x_expand: true});

        if (isToday) {
            btn.style = `background-color: ${this._accent}; color: white;`;
        } else if (isSel) {
            btn.style = `background-color: ${accentAlpha(this._accent, 0.25)};`;
        } else if (isWeekend && this._weekendColorMode === 'custom') {
            btn.style = `color: ${this._weekendColor};`;
        } else if (isWeekend && this._weekendColorMode === 'default') {
            btn.add_style_class_name('litsycal-weekend');
        }

        const box    = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'litsycal-cell-box'});
        const numLbl = new St.Label({text: String(day), x_expand: true, style_class: 'litsycal-cell-num'});
        numLbl.clutter_text.set_x_align(Clutter.ActorAlign.CENTER);
        box.add_child(numLbl);

        const dotRow = new St.BoxLayout({style_class: 'litsycal-dot-row', x_expand: true});
        dotRow.set_x_align(Clutter.ActorAlign.CENTER);
        for (const ev of this._events.filter(e => e.date === ds).slice(0, 3)) {
            const dot = new St.Widget({style_class: 'litsycal-event-dot'});
            dot.style = `background-color: ${ev.color};`;
            dotRow.add_child(dot);
        }
        box.add_child(dotRow);
        btn.set_child(box);

        btn.connect('clicked', () => {
            const [y, m, d] = ds.split('-').map(Number);
            this._selected  = GLib.DateTime.new_local(y, m, d, 0, 0, 0);
            this._buildGrid();
            this._buildAgenda();
        });
        return btn;
    }

    // ── Agenda ────────────────────────────────────────────────────────────────

    _buildAgenda() {
        this._agendaBox.destroy_all_children();

        const today = GLib.DateTime.new_now_local();

        // Collect qualifying days first so we know which is last
        const groups = [];
        for (let i = 0; i < 7; i++) {
            const day = today.add_days(i);
            const ds  = dateStr(day);
            const evs = this._events
                .filter(e => e.date === ds)
                .sort((a, b) => {
                    if (a.allDay && !b.allDay) return -1;
                    if (!a.allDay && b.allDay) return  1;
                    return (a.time ?? '').localeCompare(b.time ?? '');
                });
            if (i === 0 || evs.length > 0)
                groups.push({day, ds, evs, i});
        }

        groups.forEach(({day, evs, i}, g) => {
            let dayLabel;
            if (i === 0)      dayLabel = _('Today');
            else if (i === 1) dayLabel = _('Tomorrow');
            else              dayLabel = capitalize(day.format('%A'));

            const header  = new St.BoxLayout({style_class: 'litsycal-agenda-header'});
            const nameLbl = new St.Label({text: dayLabel, style_class: 'litsycal-agenda-day-name'});
            const dateLbl = new St.Label({
                text: `${capitalize(day.format('%b'))} ${day.get_day_of_month()}`,
                style_class: 'litsycal-agenda-day-date',
            });
            header.add_child(nameLbl);
            header.add_child(dateLbl);
            this._agendaBox.add_child(header);

            if (evs.length === 0) {
                this._agendaBox.add_child(
                    new St.Label({text: _('No events'), style_class: 'litsycal-agenda-empty'})
                );
            } else {
                for (const ev of evs) {
                    const row1 = new St.BoxLayout({style_class: 'litsycal-agenda-row'});
                    const dot  = new St.Widget({style_class: 'litsycal-agenda-pill'});
                    dot.style  = `background-color: ${ev.color};`;
                    row1.add_child(dot);
                    row1.add_child(new St.Label({
                        text: ev.title, style_class: 'litsycal-agenda-title', x_expand: true,
                    }));
                    this._agendaBox.add_child(row1);

                    const row2 = new St.BoxLayout({style_class: 'litsycal-agenda-time-row'});
                    row2.add_child(new St.Label({
                        text: ev.time ?? _('All day'),
                        style_class: 'litsycal-agenda-time',
                    }));
                    this._agendaBox.add_child(row2);
                }
            }

            // Separator between groups — not after last
            if (g < groups.length - 1)
                this._agendaBox.add_child(new St.Widget({style_class: 'litsycal-agenda-sep'}));
        });
    }

    // ── Footer ────────────────────────────────────────────────────────────────

    _buildFooter() {
        this.add_child(new St.Widget({style_class: 'litsycal-sep'}));
        const footer = new St.BoxLayout({style_class: 'litsycal-footer'});

        const makeIconBtn = (iconName, toggle = false) => new St.Button({
            style_class: 'litsycal-footer-btn',
            child: new St.Icon({icon_name: iconName, style_class: 'litsycal-gear-icon'}),
            x_expand: false, toggle_mode: toggle,
        });

        this._addBtn = new St.Button({label: '+', style_class: 'litsycal-footer-btn litsycal-add-btn'});
        this._addBtn.connect('clicked', () => this._showCreateForm());

        const pinBtn = makeIconBtn('view-pin-symbolic', true);
        pinBtn.connect('notify::checked', () => {
            if (this._onPinToggle) this._onPinToggle(pinBtn.get_checked());
        });

        const calBtn = makeIconBtn('x-office-calendar-symbolic');
        calBtn.connect('clicked', () => { if (this._openCalendar) this._openCalendar(); });

        const gear = makeIconBtn('preferences-system-symbolic');
        gear.connect('clicked', () => this._openPrefs());

        footer.add_child(this._addBtn);
        footer.add_child(new St.Widget({x_expand: true}));
        footer.add_child(pinBtn);
        footer.add_child(calBtn);
        footer.add_child(gear);
        this.add_child(footer);
    }

    // ── Create form ───────────────────────────────────────────────────────────

    _buildCreateForm() {
        this._createForm = new St.BoxLayout({
            vertical: true, style_class: 'litsycal-create-form', visible: false,
        });

        // Title
        this._titleEntry = new St.Entry({
            hint_text: _('Event title'), style_class: 'litsycal-create-entry', x_expand: true,
        });
        this._createForm.add_child(this._titleEntry);

        // All-day + calendar picker row
        const optRow = new St.BoxLayout({style_class: 'litsycal-create-row', x_expand: true});

        this._allDayBtn = new St.Button({
            label: _('All day'),
            style_class: 'litsycal-create-toggle litsycal-create-toggle-on',
            toggle_mode: true, checked: true,
        });
        this._allDayBtn.connect('notify::checked', () => {
            const on = this._allDayBtn.get_checked();
            this._allDayBtn.remove_style_class_name(on ? 'litsycal-create-toggle-off' : 'litsycal-create-toggle-on');
            this._allDayBtn.add_style_class_name(on  ? 'litsycal-create-toggle-on'  : 'litsycal-create-toggle-off');
            this._timeRow.visible = !on;
        });
        optRow.add_child(this._allDayBtn);
        optRow.add_child(new St.Widget({x_expand: true}));

        this._calPickerBtn = new St.Button({style_class: 'litsycal-create-cal-btn'});
        this._calPickerBtn.connect('clicked', () => {
            const srcs = this._calManager?.getSources() ?? [];
            if (srcs.length === 0) return;
            this._calSourceIdx = (this._calSourceIdx + 1) % srcs.length;
            this._refreshCalPicker();
        });
        optRow.add_child(this._calPickerBtn);
        this._createForm.add_child(optRow);

        // Time row
        this._timeRow = new St.BoxLayout({style_class: 'litsycal-create-row', visible: false});
        this._timeRow.add_child(new St.Label({text: _('Time:'), style_class: 'litsycal-create-lbl'}));
        this._hourEntry = new St.Entry({hint_text: 'HH', style_class: 'litsycal-create-time'});
        this._minEntry  = new St.Entry({hint_text: 'MM', style_class: 'litsycal-create-time'});
        this._timeRow.add_child(this._hourEntry);
        this._timeRow.add_child(new St.Label({text: ':', style_class: 'litsycal-create-lbl'}));
        this._timeRow.add_child(this._minEntry);
        this._createForm.add_child(this._timeRow);

        // Error
        this._createError = new St.Label({style_class: 'litsycal-create-error', visible: false});
        this._createForm.add_child(this._createError);

        // Cancel / Create
        const btnRow    = new St.BoxLayout({style_class: 'litsycal-create-row'});
        const cancelBtn = new St.Button({label: _('Cancel'), style_class: 'litsycal-create-cancel'});
        const saveBtn   = new St.Button({label: _('Create'), style_class: 'litsycal-create-save'});
        cancelBtn.connect('clicked', () => this._hideCreateForm());
        saveBtn.connect('clicked',   () => this._saveEvent());
        btnRow.add_child(cancelBtn);
        btnRow.add_child(new St.Widget({x_expand: true}));
        btnRow.add_child(saveBtn);
        this._createForm.add_child(btnRow);

        this.add_child(this._createForm);
    }

    _refreshCalPicker() {
        const srcs = this._calManager?.getSources() ?? [];
        if (srcs.length === 0) {
            this._calPickerBtn.set_label(_('No calendars'));
            return;
        }
        const src = srcs[this._calSourceIdx % srcs.length];
        const box = new St.BoxLayout({style: 'spacing: 4px;'});
        const dot = new St.Widget({style_class: 'litsycal-event-dot'});
        dot.style = `background-color: ${src.color};`;
        const lbl = new St.Label({text: src.name, style_class: 'litsycal-create-cal-lbl'});
        box.add_child(dot);
        box.add_child(lbl);
        this._calPickerBtn.set_child(box);
    }

    _showCreateForm() {
        const now = GLib.DateTime.new_now_local();
        this._titleEntry.set_text('');
        this._hourEntry.set_text(String(now.get_hour()).padStart(2, '0'));
        this._minEntry.set_text('00');
        this._allDayBtn.set_checked(true);
        this._timeRow.visible    = false;
        this._createError.visible = false;
        this._calSourceIdx = 0;
        this._refreshCalPicker();
        this._agendaBox.hide();
        this._createForm.show();
        this._titleEntry.grab_key_focus();
    }

    _hideCreateForm() {
        this._createForm.hide();
        this._agendaBox.show();
    }

    _saveEvent() {
        const title = this._titleEntry.get_text().trim();
        if (!title) { this._showCreateError(_('Title is required')); return; }

        const srcs = this._calManager?.getSources() ?? [];
        if (srcs.length === 0) { this._showCreateError(_('No calendars available')); return; }

        const src    = srcs[this._calSourceIdx % srcs.length];
        const allDay = this._allDayBtn.get_checked();
        const ds     = dateStr(this._selected);

        let hour = 0, min = 0;
        if (!allDay) {
            hour = parseInt(this._hourEntry.get_text()) || 0;
            min  = parseInt(this._minEntry.get_text())  || 0;
            if (hour < 0 || hour > 23 || min < 0 || min > 59) {
                this._showCreateError(_('Invalid time'));
                return;
            }
        }

        this._calManager.createEvent(title, ds, allDay, hour, min, src.uid, err => {
            if (err) { this._showCreateError(_('Failed to create event')); return; }
            this._hideCreateForm();
        });
    }

    _showCreateError(msg) {
        this._createError.set_text(msg);
        this._createError.visible = true;
    }

    // ── Navigation ────────────────────────────────────────────────────────────

    _shiftMonth(delta) {
        this._month += delta;
        if (this._month < 1)  { this._month = 12; this._year--; }
        if (this._month > 12) { this._month = 1;  this._year++; }
        this._updateMonthLabel();
        this._buildGrid();
        this._calManager?.fetchMonth(this._year, this._month);
    }

    _goToday() {
        const now = GLib.DateTime.new_now_local();
        this._year = now.get_year(); this._month = now.get_month();
        this._today = now; this._selected = now;
        this._updateMonthLabel();
        this._buildGrid();
        this._buildAgenda();
        this._calManager?.fetchMonth(this._year, this._month);
    }

    _updateMonthLabel() {
        const monthName = capitalize(GLib.DateTime.new_local(this._year, this._month, 1, 0, 0, 0).format('%b'));
        this._monthLbl.set_text(`${monthName} ${this._year}`);
    }
});

// ── Panel indicator ───────────────────────────────────────────────────────────

const LitsycalIndicator = GObject.registerClass(
class LitsycalIndicator extends PanelMenu.Button {

    _init(settings, openPrefs, extPath) {
        super._init(0.5, 'Litsycal');

        this._settings = settings;

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

        this._updateBadge();
        this._lastHour = GLib.DateTime.new_now_local().get_hour();

        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 60, () => {
            this._updateBadge();
            this._checkHourlyBeep();
            return GLib.SOURCE_CONTINUE;
        });

        this._sids = [
            'badge-style','show-month-in-badge','show-dow-in-badge',
            'hide-icon','datetime-pattern','show-time','time-format',
        ].map(k => settings.connect(`changed::${k}`, () => this._updateBadge()));

        this._pinned      = false;
        this._floatingBox = null;

        this._menuOpenId = this.menu.connect('open-state-changed', (_menu, open) => {
            if (open && this._pinned) this._unpinCalendar(false);
        });

        const section = new PopupMenu.PopupMenuSection();
        const item    = new PopupMenu.PopupBaseMenuItem({
            reactive: false, can_focus: false, style_class: 'litsycal-popup-item',
        });
        const cal = new LitsycalCalendar(
            settings,
            () => { this.menu.close(); openPrefs(); },
            () => {
                const app = Shell.AppSystem.get_default().lookup_app('org.gnome.Calendar.desktop');
                if (app) app.activate();
            },
            (pinned) => { if (pinned) this._pinCalendar(); else this._unpinCalendar(true); }
        );
        this._calWidget = cal;
        this._menuItem  = item;
        item.add_child(cal);
        section.addMenuItem(item);
        this.menu.addMenuItem(section);

        this.menu.actor.style = 'border: none; background-color: transparent; box-shadow: none; padding: 0;';
        this.menu.box.style   = 'padding: 0; background-color: transparent; border: none;';
        try { this.menu.actor.bin.style = 'padding: 0; border: none; background-color: transparent;'; } catch (_) {}
    }

    _updateBadge() {
        const hidden = this._settings.get_boolean('hide-icon');
        this._logo.visible  = false;
        this._badge.visible = !hidden;
        if (hidden) return;

        const style   = this._settings.get_string('badge-style');
        const pattern = this._settings.get_string('datetime-pattern');

        this._badge.remove_style_class_name('litsycal-badge-dark');
        this._badge.remove_style_class_name('litsycal-badge-calendar');
        this._badge.remove_style_class_name('litsycal-badge-calendar-dark');
        if (style === 'number-dark')   this._badge.add_style_class_name('litsycal-badge-dark');
        if (style === 'calendar')      this._badge.add_style_class_name('litsycal-badge-calendar');
        if (style === 'calendar-dark') this._badge.add_style_class_name('litsycal-badge-calendar-dark');

        const now = GLib.DateTime.new_now_local();
        this._badge.set_text(
            pattern ? formatPattern(now, pattern) : this._defaultText()
        );
    }

    _checkHourlyBeep() {
        const now = GLib.DateTime.new_now_local();
        const h   = now.get_hour();
        if (h !== this._lastHour) {
            this._lastHour = h;
            if (this._settings.get_boolean('beep-on-hour'))
                global.display.get_sound_player().play_from_theme('bell', 'Hour bell', null);
        }
    }

    _defaultText() {
        const now       = GLib.DateTime.new_now_local();
        const showMonth = this._settings.get_boolean('show-month-in-badge');
        const showDow   = this._settings.get_boolean('show-dow-in-badge');
        const showTime  = this._settings.get_boolean('show-time');
        const timeFmt   = this._settings.get_string('time-format');
        const parts     = [];
        if (showDow)   parts.push(capitalize(now.format('%a')));
        if (showMonth) parts.push(capitalize(now.format('%b')));
        parts.push(String(now.get_day_of_month()).padStart(2, '0'));
        if (showTime)
            parts.push(timeFmt === '12h' ? now.format('%-I:%M%P') : now.format('%H:%M'));
        return parts.join(' ');
    }

    _pinCalendar() {
        this._pinned = true;
        const monitor = Main.layoutManager.monitors[
            Main.layoutManager.findIndexForActor(this)
        ] ?? Main.layoutManager.primaryMonitor;
        const panelH = Main.panel.get_height();
        const [btnX] = this.get_transformed_position();
        const btnW   = this.get_width();

        this._floatingBox = new St.BoxLayout({vertical: true});
        Main.layoutManager.uiGroup.add_child(this._floatingBox);
        this._menuItem.remove_child(this._calWidget);
        this._floatingBox.add_child(this._calWidget);

        const calW = this._calWidget.get_width() || 270;
        let x = Math.round(btnX + btnW / 2 - calW / 2);
        x = Math.max(monitor.x + 4, Math.min(x, monitor.x + monitor.width - calW - 4));
        this._floatingBox.set_position(x, monitor.y + panelH + 4);
        this.menu.close();
    }

    _unpinCalendar(andOpen = false) {
        this._pinned = false;
        if (!this._floatingBox) return;
        this._floatingBox.remove_child(this._calWidget);
        this._menuItem.add_child(this._calWidget);
        Main.layoutManager.uiGroup.remove_child(this._floatingBox);
        this._floatingBox.destroy();
        this._floatingBox = null;
        if (andOpen) this.menu.toggle();
    }

    destroy() {
        if (this._floatingBox) {
            Main.layoutManager.uiGroup.remove_child(this._floatingBox);
            this._floatingBox.destroy();
            this._floatingBox = null;
        }
        if (this._menuOpenId) { this.menu.disconnect(this._menuOpenId); this._menuOpenId = null; }
        if (this._timer)      { GLib.source_remove(this._timer); this._timer = null; }
        for (const id of this._sids) this._settings.disconnect(id);
        super.destroy();
    }
});

// ── Extension lifecycle ───────────────────────────────────────────────────────

export default class LitsycalExtension extends Extension {
    enable() {
        this._settings  = this.getSettings();
        this._indicator = new LitsycalIndicator(this._settings, () => this.openPreferences(), this.path);
        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'right');

        Main.wm.addKeybinding(
            'toggle-shortcut',
            this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._indicator.menu.toggle()
        );
    }

    disable() {
        Main.wm.removeKeybinding('toggle-shortcut');
        this._indicator?.destroy();
        this._indicator = null;
        this._settings  = null;
    }
}
