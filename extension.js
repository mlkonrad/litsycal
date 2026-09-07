import {Extension, gettext as _, ngettext} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import St      from 'gi://St';
import GLib    from 'gi://GLib';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import Pango   from 'gi://Pango';
import Cairo   from 'gi://cairo';
import Gio     from 'gi://Gio';
import Meta    from 'gi://Meta';
import Shell   from 'gi://Shell';

import {CalendarManager} from './calendarManager.js';
import {EventPanel}      from './eventDialog.js';

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

// calendar-size index -> style class (index 2 "Medium" is the base CSS, no class needed).
const SIZE_CLASSES = ['litsycal-size-sm', 'litsycal-size-sm-plus', null, 'litsycal-size-md-plus', 'litsycal-size-lg'];
const SIZE_MIN_WIDTHS = [220, 238, 255, 285, 315]; // must match the widths above
// Outline top inset per calendar-size — see OutlinePainter.paint(). The line
// should sit close under the weekday-name row and clear of the day numbers
// (Itsycal draws it flush with the cell's top edge, inset 0) — Small's own
// cell is so short that even a couple of extra px reads as "line hugging
// the numbers, far from the weekday row" instead.
const OUTLINE_TOP_INSET = [0, 2, 4, 4, 4];

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

// ISO 8601 week number: shift to the Thursday of the same week (whose year
// determines the ISO week-year at year boundaries), then week = ceil(day-of-year / 7).
function isoWeekNumber(dt) {
    const isoDow    = dt.get_day_of_week(); // 1=Mon … 7=Sun
    const thursday  = dt.add_days(4 - isoDow);
    return Math.ceil(thursday.get_day_of_year() / 7);
}

// ── Meeting link detection ───────────────────────────────────────────────────

const MEETING_PATTERNS = [
    /https?:\/\/([\w-]+\.)?zoom\.us\/[^\s<>"']+/i,
    /https?:\/\/meet\.google\.com\/[^\s<>"']+/i,
    /https?:\/\/teams\.(microsoft|live)\.com\/[^\s<>"']+/i,
    /https?:\/\/([\w-]+\.)?webex\.com\/[^\s<>"']+/i,
    /https?:\/\/([\w-]+\.)?gotomeeting\.com\/[^\s<>"']+/i,
    /https?:\/\/chime\.aws\/[^\s<>"']+/i,
    /https?:\/\/([\w-]+\.)?meet\.jit\.si\/[^\s<>"']+/i,
    /https?:\/\/whereby\.com\/[^\s<>"']+/i,
];

// Scans the event's URL, location, and notes (in that order) for the first
// link that matches a known video-call provider — organizers often paste the
// dial-in link into notes/location rather than the dedicated URL field.
function findMeetingUrl(ev) {
    for (const text of [ev.url, ev.location, ev.notes]) {
        if (!text) continue;
        const urls = text.match(/https?:\/\/[^\s<>"']+/gi) ?? [];
        for (const url of urls) {
            if (MEETING_PATTERNS.some(re => re.test(url))) return url;
        }
    }
    return null;
}

function eventTimeRange(ev) {
    if (ev.allDay || !ev.time) return null;
    const [y, m, d] = ev.date.split('-').map(Number);
    const [startStr, endStr] = ev.time.split(' - ');
    const [sh, sm] = startStr.split(':').map(Number);
    const start = GLib.DateTime.new_local(y, m, d, sh, sm, 0);
    let end;
    if (endStr) {
        const [eh, em] = endStr.trim().split(':').map(Number);
        end = GLib.DateTime.new_local(y, m, d, eh, em, 0);
        if (end.compare(start) < 0) end = end.add_days(1); // crosses midnight
    } else {
        end = start.add_hours(1);
    }
    return {start, end};
}

// Mirrors Itsycal: the join button appears from 15 minutes before an event
// starts through its end. All-day events (and events with unparsable times)
// are treated as joinable any time, since there's no meaningful window.
function meetingIsJoinable(ev) {
    const range = eventTimeRange(ev);
    if (!range) return true;
    const now = GLib.DateTime.new_now_local();
    return now.compare(range.start.add_minutes(-15)) >= 0 && now.compare(range.end) <= 0;
}

// ── Outline painter ───────────────────────────────────────────────────────────

class OutlinePainter {
    configure(isDark, highlightCols, topInset = 4) {
        this._isDark        = isDark;
        this._highlightCols = highlightCols;
        this._topInset      = topInset;
    }

    paint(cr, w, h, numRows, firstCol, lastCol, lastRow) {
        const cw    = w / 7;
        const dark  = this._isDark;
        // Vertical breathing room so the outline doesn't clip day numbers.
        // A row's own height shrinks a lot at the smaller calendar sizes,
        // but the (fixed-size) event-dot strip under the number doesn't —
        // so a small cell has far less slack above its number than a
        // medium/large one. A single constant inset that clears the number
        // comfortably at Medium ends up overlapping it at Small, so the
        // caller scales this down for the compact sizes (see INSET_BY_SIZE).
        const INSET = this._topInset;

        for (const col of this._highlightCols) {
            cr.rectangle(col * cw, INSET, cw, h - 2 * INSET);
            cr.setSourceRGBA(dark ? 1 : 0, dark ? 1 : 0, dark ? 1 : 0, dark ? 0.07 : 0.06);
            cr.fill();
        }

        const r  = 6;
        const ch = (h - 2 * INSET) / numRows;
        const fc = firstCol;
        const lc = lastCol;
        const lr = lastRow;

        const SPACING = 4;
        const rowGap  = i => i * ch + INSET + SPACING * (i / numRows - 0.5);
        const C = (px, py, dx, dy) =>
            cr.curveTo(px, py, px, py, px + r*dx, py + r*dy);

        const [ar, ag, ab] = dark ? [1, 1, 1] : [0, 0, 0];
        cr.setLineWidth(2.5);
        cr.setSourceRGBA(ar, ag, ab, dark ? 0.38 : 0.28);

        const top    = INSET;
        const bottom = (lr + 1) * ch + INSET;
        const stepY  = rowGap(lr);
        const notchY = rowGap(1);

        cr.moveTo(fc*cw + r, top);
        cr.lineTo(7*cw - r, top);  C(7*cw, top, 0, +1);

        if (lc < 6) {
            cr.lineTo(7*cw, stepY - r);         C(7*cw, stepY, -1, 0);
            cr.lineTo((lc+1)*cw + r, stepY);    C((lc+1)*cw, stepY, 0, +1);
            cr.lineTo((lc+1)*cw, bottom - r);   C((lc+1)*cw, bottom, -1, 0);
        } else {
            cr.lineTo(7*cw, bottom - r);         C(7*cw, bottom, -1, 0);
        }

        cr.lineTo(r, bottom);  C(0, bottom, 0, -1);

        if (fc > 0) {
            cr.lineTo(0, notchY + r);     C(0, notchY, +1, 0);
            cr.lineTo(fc*cw - r, notchY); C(fc*cw, notchY, 0, -1);
            cr.lineTo(fc*cw, top + r);    C(fc*cw, top, +1, 0);
        } else {
            cr.lineTo(0, top + r);  C(0, top, +1, 0);
        }

        cr.lineTo(fc*cw + r, top);
        cr.closePath();
        cr.stroke();
        cr.$dispose();
    }
}

// ── Calendar widget ───────────────────────────────────────────────────────────

const LitsycalCalendar = GObject.registerClass(
class LitsycalCalendar extends St.BoxLayout {

    _init(settings, openPrefs, openCalendar, onPinToggle, onDataChanged) {
        super._init({vertical: true, style_class: 'litsycal-calendar'});

        this._settings     = settings;
        this._openPrefs    = openPrefs;
        this._openCalendar = openCalendar;
        this._onPinToggle  = onPinToggle;
        this._accent    = readAccent();

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
        this._agendaDays       = settings.get_int('agenda-days');
        this._showWeekNumbers  = settings.get_boolean('show-week-numbers');
        this._showEventDots    = settings.get_boolean('show-event-dots');
        this._dotColorMode     = settings.get_string('dot-color-mode');
        this._applySizeClass();

        this._sids = [
            settings.connect('changed::first-day-of-week', () => {
                this._firstDayOfWeek = settings.get_int('first-day-of-week');
                this._highlightCols  = this._readHighlight();
                this._painter.configure(this._isDark, this._highlightCols, OUTLINE_TOP_INSET[this._calSize]);
                this._buildDayNameRow(true);
                this._buildGrid();
            }),
            settings.connect('changed::highlight-days', () => {
                this._highlightCols = this._readHighlight();
                this._painter.configure(this._isDark, this._highlightCols, OUTLINE_TOP_INSET[this._calSize]);
                this._buildDayNameRow(true);
                this._buildGrid();
            }),
            settings.connect('changed::calendar-size', () => {
                this._calSize = settings.get_int('calendar-size');
                this._applySizeClass();
                this._painter.configure(this._isDark, this._highlightCols, OUTLINE_TOP_INSET[this._calSize]);
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
            settings.connect('changed::agenda-days', () => {
                this._agendaDays = settings.get_int('agenda-days');
                this._buildAgenda();
            }),
            settings.connect('changed::show-week-numbers', () => {
                this._showWeekNumbers = settings.get_boolean('show-week-numbers');
                this._buildWeekGutter();
            }),
            settings.connect('changed::show-event-dots', () => {
                this._showEventDots = settings.get_boolean('show-event-dots');
                this._buildGrid();
            }),
            settings.connect('changed::dot-color-mode', () => {
                this._dotColorMode = settings.get_string('dot-color-mode');
                this._buildGrid();
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
            this._eventPanel?.close();
            this._eventPanel = null;
            this._cancelCellTooltip();
            for (const id of this._sids) this._settings.disconnect(id);
            this._iface.disconnect(this._accentId);
            this._iface.disconnect(this._schemeId);
            this._calManager?.destroy();
        });

        // Constructed before any _buildGrid()/_buildAgenda() call below, since
        // both read events via this._calManager.getEventsForDate().
        this._calManager = new CalendarManager(settings, () => {
            this._buildGrid();
            this._buildAgenda();
            onDataChanged?.();
        });

        this._isDark  = this._computeIsDark();
        this._painter = new OutlinePainter();
        this._painter.configure(this._isDark, this._highlightCols, OUTLINE_TOP_INSET[this._calSize]);

        this._buildHeader();

        // Week-number gutter sits outside the day-name-row/grid overlay as a
        // plain sibling column, so it never affects OutlinePainter's column
        // math (which is based on the overlay's own allocated width).
        this._calBody    = new St.BoxLayout({x_expand: true});
        this._weekGutter = new St.BoxLayout({
            vertical: true, style_class: 'litsycal-week-gutter',
            visible: this._showWeekNumbers,
        });
        this._calRight   = new St.BoxLayout({vertical: true, x_expand: true});
        this._calBody.add_child(this._weekGutter);
        this._calBody.add_child(this._calRight);

        this._buildDayNameRow();
        this._buildGridContainer();
        this.add_child(this._calBody);
        this._applyTheme();

        this._agendaSep = new St.Widget({style_class: 'litsycal-sep'});
        this.add_child(this._agendaSep);

        this._agendaBox = new St.BoxLayout({vertical: true, style_class: 'litsycal-agenda', x_expand: true});
        this._agendaScroll = new St.ScrollView({
            style_class: 'litsycal-agenda-scroll',
            x_expand: true,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
        });
        this._agendaScroll.set_child(this._agendaBox);
        this.add_child(this._agendaScroll);
        this._buildAgenda();

        this._buildFooter();
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

    // calendar-size: 0=S, 1=S+, 2=M (no class — the base CSS values), 3=M+, 4=L
    _applySizeClass() {
        for (const cls of SIZE_CLASSES) {
            if (cls) this.remove_style_class_name(cls);
        }
        const cls = SIZE_CLASSES[this._calSize];
        if (cls) this.add_style_class_name(cls);
    }

    _applyTheme() {
        this._isDark = this._computeIsDark();
        this.remove_style_class_name('litsycal-theme-light');
        this.remove_style_class_name('litsycal-theme-dark');
        this.add_style_class_name(this._isDark ? 'litsycal-theme-dark' : 'litsycal-theme-light');
        this._painter.configure(this._isDark, this._highlightCols, OUTLINE_TOP_INSET[this._calSize]);
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

        this._prevBtn  = new St.Button({label: '‹', style_class: 'litsycal-nav-btn',
                                         accessible_name: _('Previous month')});
        this._dotBtn   = new St.Button({label: '●', style_class: 'litsycal-nav-btn litsycal-dot-btn',
                                         accessible_name: _('Go to today')});
        this._nextBtn  = new St.Button({label: '›', style_class: 'litsycal-nav-btn',
                                         accessible_name: _('Next month')});

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
            this._calRight.remove_child(this._dayNameRow);
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
        if (rebuild) this._calRight.insert_child_at_index(row, 0);
        else         this._calRight.add_child(row);
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
        this._calRight.add_child(overlay);
        overlay.connect('notify::allocation', () => this._outline.queue_repaint());
    }

    // ── Calendar grid ─────────────────────────────────────────────────────────

    _buildGrid() {
        this._cancelCellTooltip(); // cells about to be destroyed would leave a dangling anchor
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

        this._buildWeekGutter();
        this._outline?.queue_repaint();
        this._updateAgendaMaxHeight();
    }

    // One label per grid row, showing the ISO week number of that row's
    // first column. The gutter is a separate sibling column (so nothing
    // here affects OutlinePainter's math, which is based on the overlay's
    // own width) — but that also means its rows can't rely on shared CSS
    // to match the real grid row heights. Instead each cell's height is
    // bound directly to its corresponding grid row's actual rendered
    // height, so it always lines up exactly regardless of size class.
    _buildWeekGutter() {
        this._weekGutter.visible = this._showWeekNumbers;
        this._weekGutter.destroy_all_children();
        if (!this._showWeekNumbers) return;

        const spacer = new St.BoxLayout({style_class: 'litsycal-day-name-cell'});
        spacer.add_child(new St.Label({text: '', style_class: 'litsycal-day-name'}));
        this._weekGutter.add_child(spacer);
        spacer.add_constraint(new Clutter.BindConstraint({
            source: this._dayNameRow, coordinate: Clutter.BindCoordinate.HEIGHT,
        }));

        const gridRows = this._gridBox.get_children();
        const anchor   = GLib.DateTime.new_local(this._year, this._month, 1, 0, 0, 0);
        for (let r = 0; r < this._numRows; r++) {
            const rowDate = anchor.add_days(r * 7 - this._firstCol);
            const cell    = this._makeWeekCell(isoWeekNumber(rowDate));
            this._weekGutter.add_child(cell);
            if (gridRows[r]) {
                cell.add_constraint(new Clutter.BindConstraint({
                    source: gridRows[r], coordinate: Clutter.BindCoordinate.HEIGHT,
                }));
            }
        }
    }

    _makeWeekCell(weekNum) {
        const box = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'litsycal-cell-box'});
        const lbl = new St.Label({
            text: String(weekNum), x_expand: true, y_expand: true,
            y_align: Clutter.ActorAlign.CENTER, style_class: 'litsycal-week-num',
        });
        lbl.clutter_text.set_x_align(Clutter.ActorAlign.CENTER);
        box.add_child(lbl);
        return box;
    }

    // Cap the agenda's height to whatever screen space is actually left below
    // the calendar/header/footer, mirroring Itsycal's agendaMaxPossibleHeight —
    // rather than letting a busy week grow the popup past the monitor edge.
    _updateAgendaMaxHeight() {
        if (!this._agendaScroll) return;

        const monitor = Main.layoutManager.monitors[
            Main.layoutManager.findIndexForActor(this)
        ] ?? Main.layoutManager.primaryMonitor;
        const panelH = Main.panel.get_height();

        let othersHeight = 0;
        for (const child of this.get_children()) {
            if (child === this._agendaScroll) continue;
            othersHeight += child.get_preferred_height(-1)[1];
        }

        const margin    = 16; // breathing room below the popup
        const maxTotal  = monitor.height - panelH - margin;
        const maxAgenda = Math.max(80, maxTotal - othersHeight);
        this._agendaScroll.style = `max-height: ${maxAgenda}px;`;
    }

    _makeOverflow(day) {
        // Uses the exact same St.Button shell (litsycal-day-btn) as a real
        // day cell — same size, same padding, same layout tree — just
        // non-interactive and dimmed. Any structural difference here (a
        // different widget, different padding) throws off that cell's box
        // model just enough to misalign it and its row within the grid, so
        // overflow days must stay wire-identical to real ones, differing
        // only in text color. Mirrors Itsycal's MoCalCell, which is the one
        // cell class for every day regardless of month.
        const btn = new St.Button({
            style_class: 'litsycal-day-btn', x_expand: true,
            reactive: false, can_focus: false,
        });

        const box    = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'litsycal-cell-box'});
        const numLbl = new St.Label({
            text: String(day), x_expand: true,
            style_class: 'litsycal-cell-num litsycal-overflow',
        });
        numLbl.clutter_text.set_x_align(Clutter.ActorAlign.CENTER);
        box.add_child(numLbl);
        box.add_child(new St.BoxLayout({style_class: 'litsycal-dot-row', x_expand: true}));
        btn.set_child(box);
        return btn;
    }

    _makeCell(day, ds, isToday, isSel, isWeekend) {
        let sc = 'litsycal-day-btn';
        if (isToday)    sc += ' litsycal-today';
        else if (isSel) sc += ' litsycal-selected';

        const btn = new St.Button({style_class: sc, x_expand: true, track_hover: true});

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
        if (this._showEventDots) {
            for (const ev of this._calManager.getEventsForDate(ds).slice(0, 3)) {
                const dot = new St.Widget({style_class: 'litsycal-event-dot'});
                if (this._dotColorMode === 'mono')
                    dot.add_style_class_name('litsycal-event-dot-mono');
                else
                    dot.style = `background-color: ${ev.color};`;
                dotRow.add_child(dot);
            }
        }
        box.add_child(dotRow);
        btn.set_child(box);

        btn.accessible_name = this._cellAccessibleName(ds, day, isToday);

        btn.connect('clicked', () => {
            const [y, m, d] = ds.split('-').map(Number);
            this._selected  = GLib.DateTime.new_local(y, m, d, 0, 0, 0);
            this._buildGrid();
            this._buildAgenda();
        });
        btn.connect('notify::hover', () => {
            if (btn.hover) this._scheduleCellTooltip(ds, btn);
            else this._cancelCellTooltip();
        });
        return btn;
    }

    _cellAccessibleName(ds, day, isToday) {
        const [y, m, d] = ds.split('-').map(Number);
        const cellDate  = GLib.DateTime.new_local(y, m, d, 0, 0, 0);
        let name = `${capitalize(cellDate.format('%A'))}, ${capitalize(cellDate.format('%B'))} ${day}`;
        if (isToday) name += `, ${_('Today')}`;

        const count = this._calManager.getEventsForDate(ds).length;
        if (count > 0) {
            const template = ngettext('%d event', '%d events', count);
            name += `, ${template.replace('%d', String(count))}`;
        }
        return name;
    }

    // ── Cell hover tooltip ───────────────────────────────────────────────────
    // A lightweight day preview shown ~600ms into a hover, so browsing days
    // doesn't require clicking (which moves the selected day and rebuilds the
    // agenda panel below).

    _scheduleCellTooltip(ds, anchorBtn) {
        this._cancelCellTooltip();
        this._tooltipTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 600, () => {
            this._tooltipTimeoutId = null;
            this._showCellTooltip(ds, anchorBtn);
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelCellTooltip() {
        if (this._tooltipTimeoutId) {
            GLib.source_remove(this._tooltipTimeoutId);
            this._tooltipTimeoutId = null;
        }
        this._hideCellTooltip();
    }

    _hideCellTooltip() {
        if (this._tooltipBox) {
            Main.layoutManager.uiGroup.remove_child(this._tooltipBox);
            this._tooltipBox.destroy();
            this._tooltipBox = null;
        }
    }

    _showCellTooltip(ds, anchorBtn) {
        if (!anchorBtn.hover) return; // pointer left before the delay elapsed

        const [y, m, d] = ds.split('-').map(Number);
        const date = GLib.DateTime.new_local(y, m, d, 0, 0, 0);
        const evs  = this._calManager.getEventsForDate(ds);

        const box = new St.BoxLayout({
            vertical: true,
            style_class: 'popup-menu-content litsycal-cell-tooltip',
        });

        const header = new St.BoxLayout({style_class: 'litsycal-agenda-header'});
        header.add_child(new St.Label({
            text: capitalize(date.format('%A')), style_class: 'litsycal-agenda-day-name',
        }));
        header.add_child(new St.Widget({x_expand: true})); // spacer: pushes the date to the right edge
        header.add_child(new St.Label({
            text: `${capitalize(date.format('%b'))} ${d}`, style_class: 'litsycal-agenda-day-date',
        }));
        box.add_child(header);

        if (evs.length === 0) {
            box.add_child(new St.Label({text: _('No events'), style_class: 'litsycal-agenda-empty'}));
        } else {
            for (const ev of evs) {
                const row1 = new St.BoxLayout({style_class: 'litsycal-agenda-row'});
                const dot  = new St.Widget({style_class: 'litsycal-agenda-pill'});
                dot.style  = `background-color: ${ev.color};`;
                row1.add_child(dot);
                const titleLbl = new St.Label({
                    text: ev.title, style_class: 'litsycal-agenda-title', x_expand: true,
                });
                titleLbl.clutter_text.set_line_wrap(false);
                titleLbl.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
                row1.add_child(titleLbl);
                box.add_child(row1);

                const row2 = new St.BoxLayout({style_class: 'litsycal-agenda-time-row'});
                row2.add_child(new St.Label({
                    text: ev.time ?? _('All day'), style_class: 'litsycal-agenda-time',
                }));
                box.add_child(row2);
            }
        }

        Main.layoutManager.uiGroup.add_child(box);
        this._tooltipBox = box;

        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            if (!this._tooltipBox) return GLib.SOURCE_REMOVE; // hidden again already

            const monitor = Main.layoutManager.monitors[
                Main.layoutManager.findIndexForActor(this)
            ] ?? Main.layoutManager.primaryMonitor;
            const panelH = Main.panel.get_height();
            const [ax, ay] = anchorBtn.get_transformed_position();
            const aw = anchorBtn.get_width();
            const boxW = box.get_width()  || 200;
            const boxH = box.get_height() || 60;

            let x = ax + aw + 8;
            if (x + boxW > monitor.x + monitor.width - 4) x = ax - boxW - 8;
            x = Math.max(monitor.x + 4, Math.min(x, monitor.x + monitor.width - boxW - 4));

            let posY = ay;
            posY = Math.max(monitor.y + panelH + 4, Math.min(posY, monitor.y + monitor.height - boxH - 4));

            box.set_position(x, posY);
            return GLib.SOURCE_REMOVE;
        });
    }

    // ── Agenda ────────────────────────────────────────────────────────────────

    _buildAgenda() {
        this._agendaBox.destroy_all_children();

        const hidden = this._agendaDays <= 0;
        this._agendaScroll.visible = !hidden;
        this._agendaSep.visible    = !hidden;
        if (hidden) { this._updateAgendaMaxHeight(); return; }

        const todayStr    = dateStr(this._today);
        const tomorrowStr = dateStr(this._today.add_days(1));
        const start       = this._selected ?? this._today;

        // Collect qualifying days first so we know which is last
        const groups = [];
        for (let i = 0; i < this._agendaDays; i++) {
            const day = start.add_days(i);
            const ds  = dateStr(day);
            const evs = this._calManager.getEventsForDate(ds);
            if (i === 0 || evs.length > 0)
                groups.push({day, ds, evs, i});
        }

        groups.forEach(({day, ds, evs}, g) => {
            let dayLabel;
            if (ds === todayStr)      dayLabel = _('Today');
            else if (ds === tomorrowStr) dayLabel = _('Tomorrow');
            else                      dayLabel = capitalize(day.format('%A'));

            const header  = new St.BoxLayout({style_class: 'litsycal-agenda-header'});
            const nameLbl = new St.Label({text: dayLabel, style_class: 'litsycal-agenda-day-name'});
            const dateLbl = new St.Label({
                text: `${capitalize(day.format('%b'))} ${day.get_day_of_month()}`,
                style_class: 'litsycal-agenda-day-date',
            });
            header.add_child(nameLbl);
            header.add_child(new St.Widget({x_expand: true})); // spacer: pushes the date to the right edge
            header.add_child(dateLbl);
            this._agendaBox.add_child(header);

            if (evs.length === 0) {
                this._agendaBox.add_child(
                    new St.Label({text: _('No events'), style_class: 'litsycal-agenda-empty'})
                );
            } else {
                for (const ev of evs) {
                    const evtBtn = new St.Button({
                        style_class: 'litsycal-agenda-event-btn', x_expand: true,
                    });
                    const evtBox = new St.BoxLayout({vertical: true, x_expand: true});

                    const row1 = new St.BoxLayout({style_class: 'litsycal-agenda-row'});
                    const dot  = new St.Widget({style_class: 'litsycal-agenda-pill'});
                    dot.style  = `background-color: ${ev.color};`;
                    row1.add_child(dot);
                    const titleLbl = new St.Label({
                        text: ev.title, style_class: 'litsycal-agenda-title', x_expand: true,
                    });
                    titleLbl.clutter_text.set_line_wrap(false);
                    titleLbl.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
                    row1.add_child(titleLbl);
                    evtBox.add_child(row1);

                    const row2 = new St.BoxLayout({style_class: 'litsycal-agenda-time-row'});
                    row2.add_child(new St.Label({
                        text: ev.time ?? _('All day'),
                        style_class: 'litsycal-agenda-time',
                    }));
                    evtBox.add_child(row2);

                    if (ev.location) {
                        const row3 = new St.BoxLayout({style_class: 'litsycal-agenda-location-row'});
                        row3.add_child(new St.Icon({
                            icon_name: 'mark-location-symbolic',
                            style_class: 'litsycal-agenda-location-icon',
                        }));
                        const locLbl = new St.Label({
                            text: ev.location, style_class: 'litsycal-agenda-location', x_expand: true,
                        });
                        locLbl.clutter_text.set_line_wrap(false);
                        locLbl.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
                        row3.add_child(locLbl);
                        evtBox.add_child(row3);
                    }

                    evtBtn.set_child(evtBox);
                    evtBtn.accessible_name = `${ev.title}, ${ev.time ?? _('All day')}` +
                        (ev.location ? `, ${ev.location}` : '');
                    evtBtn.connect('clicked', () => this._openEventDialog(ev));

                    const evtRow = new St.BoxLayout({x_expand: true});
                    evtRow.add_child(evtBtn);

                    const meetingUrl = findMeetingUrl(ev);
                    if (meetingUrl && meetingIsJoinable(ev)) {
                        // A plain St.Button styled with no border/background reads as a
                        // link rather than a button; GNOME Shell's ClutterText here
                        // doesn't support Pango's <a href> markup or 'activate-link'.
                        const joinLink = new St.Button({
                            style_class: 'litsycal-agenda-join-link',
                            label: _('Join meeting'),
                            accessible_name: _('Join meeting'),
                        });
                        joinLink.connect('clicked', () => {
                            try { Gio.AppInfo.launch_default_for_uri(meetingUrl, null); } catch(_) {}
                        });
                        evtRow.add_child(joinLink);
                    }

                    if (ev.url) {
                        const urlBtn = new St.Button({
                            style_class: 'litsycal-agenda-url-btn',
                            accessible_name: _('Open link'),
                            child: new St.Icon({
                                icon_name: 'web-browser-symbolic',
                                style_class: 'litsycal-gear-icon',
                            }),
                        });
                        urlBtn.connect('clicked', () => {
                            try { Gio.AppInfo.launch_default_for_uri(ev.url, null); } catch(_) {}
                        });
                        evtRow.add_child(urlBtn);
                    }
                    this._agendaBox.add_child(evtRow);
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

        const makeIconBtn = (iconName, accessibleName, toggle = false) => new St.Button({
            style_class: 'litsycal-footer-btn',
            child: new St.Icon({icon_name: iconName, style_class: 'litsycal-gear-icon'}),
            x_expand: false, toggle_mode: toggle,
            accessible_name: accessibleName,
        });

        this._addBtn = new St.Button({label: '+', style_class: 'litsycal-footer-btn litsycal-add-btn',
                                       accessible_name: _('New event')});
        this._addBtn.connect('clicked', () => this._openCreateDialog());

        const pinBtn = makeIconBtn('view-pin-symbolic', _('Pin calendar open'), true);
        pinBtn.connect('notify::checked', () => {
            if (this._onPinToggle) this._onPinToggle(pinBtn.get_checked());
        });

        const calBtn = makeIconBtn('x-office-calendar-symbolic', _('Open Calendar app'));
        calBtn.connect('clicked', () => { if (this._openCalendar) this._openCalendar(); });

        const gear = makeIconBtn('preferences-system-symbolic', _('Preferences'));
        gear.connect('clicked', () => this._openPrefs());

        footer.add_child(this._addBtn);
        footer.add_child(new St.Widget({x_expand: true}));
        footer.add_child(pinBtn);
        footer.add_child(calBtn);
        footer.add_child(gear);
        this.add_child(footer);
    }

    // ── Event panels ──────────────────────────────────────────────────────────

    _openCreateDialog() {
        if (!this._calManager?.isAvailable()) return;
        this._eventPanel?.close();
        this._onPinToggle?.(true);  // keep calendar visible while panel is open
        this._eventPanel = new EventPanel(
            this._calManager, null, this._selected, this,
            () => { this._eventPanel = null; }
        );
    }

    _openEventDialog(ev) {
        if (!this._calManager?.isAvailable()) return;
        this._eventPanel?.close();
        this._onPinToggle?.(true);
        this._eventPanel = new EventPanel(
            this._calManager, ev, null, this,
            () => { this._eventPanel = null; }
        );
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

    // ── Keyboard navigation ──────────────────────────────────────────────────
    // Arrow keys (and vi-style h/j/k/l) move the selected day (Up/Down or k/j
    // by a week); holding Shift moves by month/year instead. Space jumps to
    // today. Wired up by LitsycalIndicator only while the popup is open and no
    // event panel (with its own text entries) is up, so this never steals
    // normal typing.
    //
    // Plain/Shift Down (and h/j/k/l's Down-equivalent, j) can't be reached via
    // the physical arrow key alone: GNOME Shell's PopupMenu reserves bare
    // Down for its own accessibility keynav whenever a menu drops down from
    // the top panel (js/ui/popupMenu.js PopupMenu._onKeyPress — it matches on
    // the keysym only, ignoring modifiers, and consumes the event before it
    // ever reaches actor-level signal handlers). j/J is the reliable way to
    // trigger that direction; the Down/Shift+Down cases below are kept for
    // when the popup isn't anchored to the top (e.g. a bottom panel).

    _moveSelectionByDays(delta) {
        const sel = this._selected.add_days(delta);
        this._selected = sel;
        const monthChanged = sel.get_year() !== this._year || sel.get_month() !== this._month;
        if (monthChanged) {
            this._year  = sel.get_year();
            this._month = sel.get_month();
            this._updateMonthLabel();
            this._calManager?.fetchMonth(this._year, this._month);
        }
        this._buildGrid();
        this._buildAgenda();
    }

    _moveSelectionByMonths(delta) {
        const y = this._selected.get_year();
        const m = this._selected.get_month();
        const d = this._selected.get_day_of_month();

        let ny = y, nm = m + delta;
        while (nm < 1)  { nm += 12; ny--; }
        while (nm > 12) { nm -= 12; ny++; }
        const nd = Math.min(d, daysInMonth(ny, nm));

        this._selected = GLib.DateTime.new_local(ny, nm, nd, 0, 0, 0);
        this._year  = ny;
        this._month = nm;
        this._updateMonthLabel();
        this._buildGrid();
        this._buildAgenda();
        this._calManager?.fetchMonth(this._year, this._month);
    }

    _moveSelectionByYears(delta) {
        this._moveSelectionByMonths(delta * 12);
    }

    // Returns true if the key was consumed (caller should stop propagation).
    handleKeyPress(keyval, shift) {
        switch (keyval) {
            case Clutter.KEY_Left:
            case Clutter.KEY_h:
            case Clutter.KEY_H:
                shift ? this._moveSelectionByMonths(-1) : this._moveSelectionByDays(-1);
                return true;
            case Clutter.KEY_Right:
            case Clutter.KEY_l:
            case Clutter.KEY_L:
                shift ? this._moveSelectionByMonths(1) : this._moveSelectionByDays(1);
                return true;
            case Clutter.KEY_Up:
            case Clutter.KEY_k:
            case Clutter.KEY_K:
                shift ? this._moveSelectionByYears(1) : this._moveSelectionByDays(-7);
                return true;
            case Clutter.KEY_Down:
            case Clutter.KEY_j:
            case Clutter.KEY_J:
                shift ? this._moveSelectionByYears(-1) : this._moveSelectionByDays(7);
                return true;
            case Clutter.KEY_space:
                this._goToday();
                return true;
            default:
                return false;
        }
    }
});

// ── Panel indicator ───────────────────────────────────────────────────────────

const LitsycalIndicator = GObject.registerClass(
class LitsycalIndicator extends PanelMenu.Button {

    _init(settings, openPrefs, extPath, uuid) {
        super._init(0.5, 'Litsycal');

        this._settings = settings;
        this._uuid     = uuid;

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
            if (this._menuIsOpen || this._pinned) this._calWidget?._buildAgenda();
            return GLib.SOURCE_CONTINUE;
        });

        this._sids = [
            'badge-style','show-month-in-badge','show-dow-in-badge',
            'hide-icon','datetime-pattern','show-time','time-format',
        ].map(k => settings.connect(`changed::${k}`, () => this._updateBadge()));

        this._pinned      = false;
        this._floatingBox = null;

        this._menuIsOpen = false;
        this._menuOpenId = this.menu.connect('open-state-changed', (_menu, open) => {
            this._menuIsOpen = open;
            if (open && this._pinned) this._unpinCalendar(false);
            if (open) {
                this._calWidget._updateAgendaMaxHeight();
                this._calWidget._buildAgenda();
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
                    if (ev.type() !== Clutter.EventType.KEY_PRESS) return Clutter.EVENT_PROPAGATE;
                    // The event panel owns text entries (title, notes, ...); never
                    // steal their keystrokes for calendar navigation.
                    if (this._calWidget._eventPanel) return Clutter.EVENT_PROPAGATE;
                    const keyval = ev.get_key_symbol();
                    const shift  = (ev.get_state() & Clutter.ModifierType.SHIFT_MASK) !== 0;
                    return this._calWidget.handleKeyPress(keyval, shift)
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
            () => { this.menu.close(); openPrefs(); },
            () => {
                const app = Shell.AppSystem.get_default().lookup_app('org.gnome.Calendar.desktop');
                if (app) app.activate();
            },
            (pinned) => { if (pinned) this._pinCalendar(); else this._unpinCalendar(true); },
            () => this._updateBadge()
        );
        this._calWidget = cal;
        this._menuItem  = item;
        item.add_child(cal);
        section.addMenuItem(item);
        this.menu.addMenuItem(section);

        this.menu.actor.style = 'border: none; background-color: transparent; box-shadow: none; padding: 0;';
        this.menu.box.style   = 'padding: 0; background-color: transparent; border: none;';
        try { this.menu.actor.bin.style = 'padding: 0; border: none; background-color: transparent;'; } catch (_) {}

        // Right-click alternative to the calendar dropdown: Preferences / Quit.
        // A second, independent PopupMenu — `this.menu` above stays reserved
        // for the left-click calendar popup.
        this._contextMenu = new PopupMenu.PopupMenu(this, 0.5, St.Side.TOP);
        Main.panel.menuManager.addMenu(this._contextMenu);

        const prefsItem = new PopupMenu.PopupMenuItem(_('Preferences…'));
        prefsItem.connect('activate', () => openPrefs());
        this._contextMenu.addMenuItem(prefsItem);

        this._contextMenu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const quitItem = new PopupMenu.PopupMenuItem(_('Quit Litsycal'));
        quitItem.connect('activate', () => {
            // Disabling from inside this item's own 'activate' handler would
            // tear this actor down mid-event; defer to the next idle tick.
            const uuid = this._uuid;
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                Main.extensionManager.disableExtension(uuid);
                return GLib.SOURCE_REMOVE;
            });
        });
        this._contextMenu.addMenuItem(quitItem);
    }

    vfunc_event(event) {
        if (event.type() === Clutter.EventType.BUTTON_PRESS &&
            event.get_button() === Clutter.BUTTON_SECONDARY) {
            this.menu.close();
            this._contextMenu.toggle();
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
        if (style === 'number-dark')   this._badge.add_style_class_name('litsycal-badge-dark');
        if (style === 'calendar')      this._badge.add_style_class_name('litsycal-badge-calendar');
        if (style === 'calendar-dark') this._badge.add_style_class_name('litsycal-badge-calendar-dark');
        if (style === 'text')          this._badge.add_style_class_name('litsycal-badge-text');

        const now = GLib.DateTime.new_now_local();
        this._badge.set_text(
            pattern ? formatPattern(now, pattern) : this._defaultText()
        );
    }

    // True while today has a video-call event that's joinable right now
    // (mirrors the agenda's own join-button window — see meetingIsJoinable).
    _hasUpcomingMeeting() {
        const calManager = this._calWidget?._calManager;
        if (!calManager) return false;
        const today = dateStr(GLib.DateTime.new_now_local());
        return calManager.getEventsForDate(today)
            .some(ev => findMeetingUrl(ev) && meetingIsJoinable(ev));
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
        if (this._pinned) return;
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

        const calW = this._calWidget.get_width()
            || SIZE_MIN_WIDTHS[this._settings.get_int('calendar-size')] || 255;
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
        if (this._keyPressId) { this.menu.actor.disconnect(this._keyPressId); this._keyPressId = null; }
        if (this._menuOpenId) { this.menu.disconnect(this._menuOpenId); this._menuOpenId = null; }
        if (this._timer)      { GLib.source_remove(this._timer); this._timer = null; }
        if (this._contextMenu) { this._contextMenu.destroy(); this._contextMenu = null; }
        for (const id of this._sids) this._settings.disconnect(id);
        super.destroy();
    }
});

// ── Extension lifecycle ───────────────────────────────────────────────────────

export default class LitsycalExtension extends Extension {
    enable() {
        this._settings  = this.getSettings();
        this._indicator = new LitsycalIndicator(this._settings, () => this.openPreferences(), this.path, this.uuid);
        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'right');

        Main.wm.addKeybinding(
            'litsycal-toggle-shortcut',
            this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._indicator.menu.toggle()
        );
    }

    disable() {
        Main.wm.removeKeybinding('litsycal-toggle-shortcut');
        this._indicator?.destroy();
        this._indicator = null;
        this._settings  = null;
    }
}
