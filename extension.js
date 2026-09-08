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

import {CalendarManager}           from './calendarManager.js';
import {EventPanel, GoToDatePanel} from './eventDialog.js';

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

// font-size index -> style class (index 1 "Medium" is the base CSS, no class needed).
const FONT_SIZE_CLASSES = ['litsycal-font-sm', null, 'litsycal-font-lg'];
// Must match schemas/…gschema.xml's extra-week-rows <range max="…">.
const MAX_EXTRA_WEEK_ROWS = 5;
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

// Buddhist Era year = Gregorian + 543. Months/days/leap years are identical
// between the two calendars, so this only ever touches the printed year —
// every date computation elsewhere in this file stays Gregorian.
const BUDDHIST_ERA_OFFSET = 543;

function displayYear(gregorianYear, calendarSystem) {
    return calendarSystem === 'buddhist' ? gregorianYear + BUDDHIST_ERA_OFFSET : gregorianYear;
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

    _init(settings, openSettingsMenu, openCalendar, onPinToggle, onDataChanged) {
        super._init({vertical: true, style_class: 'litsycal-calendar'});

        this._settings         = settings;
        this._openSettingsMenu = openSettingsMenu;
        this._openCalendar     = openCalendar;
        this._onPinToggle      = onPinToggle;
        this._accent           = readAccent();

        const now      = GLib.DateTime.new_now_local();
        this._year     = now.get_year();
        this._month    = now.get_month();
        this._today    = now;
        this._selected = now;

        this._firstCol = 0; this._lastCol = 6; this._lastRow = 0; this._numRows = 1;

        this._firstDayOfWeek   = settings.get_int('first-day-of-week');
        this._highlightCols    = this._readHighlight();
        this._calSize          = settings.get_int('calendar-size');
        this._fontSize         = settings.get_int('font-size');
        this._theme            = settings.get_string('theme');
        this._weekendColorMode = settings.get_string('weekend-color-mode');
        this._weekendColor     = settings.get_string('weekend-color');
        this._agendaDays       = settings.get_int('agenda-days');
        this._showWeekNumbers  = settings.get_boolean('show-week-numbers');
        this._extraWeekRows    = settings.get_int('extra-week-rows');
        this._showEventDots    = settings.get_boolean('show-event-dots');
        this._dotColorMode     = settings.get_string('dot-color-mode');
        this._showEventLocation   = settings.get_boolean('show-event-location');
        this._showEmptyAgendaDays = settings.get_boolean('show-empty-agenda-days');
        this._calendarSystem   = settings.get_string('calendar-system');
        this._applySizeClass();
        this._applyFontSizeClass();

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
            settings.connect('changed::font-size', () => {
                this._fontSize = settings.get_int('font-size');
                this._applyFontSizeClass();
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
            settings.connect('changed::extra-week-rows', () => {
                this._extraWeekRows = settings.get_int('extra-week-rows');
                this._buildGrid();
            }),
            settings.connect('changed::show-event-dots', () => {
                this._showEventDots = settings.get_boolean('show-event-dots');
                this._buildGrid();
            }),
            settings.connect('changed::dot-color-mode', () => {
                this._dotColorMode = settings.get_string('dot-color-mode');
                this._buildGrid();
            }),
            settings.connect('changed::show-event-location', () => {
                this._showEventLocation = settings.get_boolean('show-event-location');
                this._buildAgenda();
            }),
            settings.connect('changed::show-empty-agenda-days', () => {
                this._showEmptyAgendaDays = settings.get_boolean('show-empty-agenda-days');
                this._buildAgenda();
            }),
            settings.connect('changed::calendar-system', () => {
                this._calendarSystem = settings.get_string('calendar-system');
                // Only the header year needs an immediate refresh. Day cells'
                // accessible names embed the year too, but rebuilding all of
                // them here means destroying every interactive day-cell
                // button — unnecessary just to refresh a label, and each one
                // will pick up the new year on its next natural rebuild
                // (month navigation, day selection, ...) anyway.
                this._updateMonthLabel();
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
            if (this._dragStartY !== undefined) this._endHandleDrag(this._resizeHandle);
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

        this.add_child(this._buildResizeHandle());

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

    // font-size: 0=S, 1=M (no class — the base CSS values), 2=L
    _applyFontSizeClass() {
        for (const cls of FONT_SIZE_CLASSES) {
            if (cls) this.remove_style_class_name(cls);
        }
        const cls = FONT_SIZE_CLASSES[this._fontSize];
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

    // ── Resize handle ─────────────────────────────────────────────────────────
    // A thin drag grip below the grid, mirroring Itsycal's own resize handle:
    // dragging it down reveals extra overflow weeks from next month (up to
    // MAX_EXTRA_WEEK_ROWS), dragging up hides them again. The chosen row
    // count is persisted in extra-week-rows so it survives month
    // navigation/reopening.

    _buildResizeHandle() {
        const handle = new St.Widget({
            style_class: 'litsycal-resize-handle',
            layout_manager: new Clutter.BinLayout(),
            x_expand: true, reactive: true, track_hover: true,
            accessible_name: _('Drag to show more weeks'),
        });
        handle.add_child(new St.Widget({
            style_class: 'litsycal-resize-track', x_expand: true, y_align: Clutter.ActorAlign.CENTER,
        }));
        handle.add_child(new St.Widget({
            style_class: 'litsycal-resize-grip',
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER,
        }));

        handle.connect('button-press-event', (actor, event) => {
            if (event.get_button() !== Clutter.BUTTON_PRIMARY) return Clutter.EVENT_PROPAGATE;
            this._dragStartY     = event.get_coords()[1];
            this._dragStartExtra = this._extraWeekRows;
            this._dragRowHeight  = this._gridBox.get_height() / Math.max(1, this._numRows);
            this._resizeGrab     = global.stage.grab(actor);
            this._dragMotionId   = actor.connect('motion-event', (a, ev) => this._onHandleDrag(ev));
            this._dragReleaseId  = actor.connect('button-release-event', () => this._endHandleDrag(actor));
            return Clutter.EVENT_STOP;
        });

        this._resizeHandle = handle;
        return handle;
    }

    _onHandleDrag(event) {
        if (this._dragStartY === undefined || !this._dragRowHeight) return Clutter.EVENT_PROPAGATE;

        const delta  = event.get_coords()[1] - this._dragStartY;
        const rows   = Math.round(delta / this._dragRowHeight);
        const wanted = Math.min(MAX_EXTRA_WEEK_ROWS, Math.max(0, this._dragStartExtra + rows));

        if (wanted !== this._extraWeekRows) this._settings.set_int('extra-week-rows', wanted);
        return Clutter.EVENT_STOP;
    }

    _endHandleDrag(actor) {
        if (this._dragMotionId)  { actor.disconnect(this._dragMotionId);  this._dragMotionId  = null; }
        if (this._dragReleaseId) { actor.disconnect(this._dragReleaseId); this._dragReleaseId = null; }
        this._resizeGrab?.dismiss();
        this._resizeGrab  = null;
        this._dragStartY  = undefined;
    }

    // ── Calendar grid ─────────────────────────────────────────────────────────

    _buildGrid() {
        this._cancelCellTooltip(); // cells about to be destroyed would leave a dangling anchor
        this._gridBox.destroy_all_children();
        this._cellsByDate = new Map();
        this._rangeHighlightedCells = []; // stale refs to now-destroyed buttons — drop them

        const fd       = this._firstDayOfWeek;
        const glibDow  = GLib.DateTime.new_local(this._year, this._month, 1, 0, 0, 0)
                                       .get_day_of_week() - 1;
        const firstDow = (glibDow - fd + 7) % 7;
        const total    = daysInMonth(this._year, this._month);

        this._firstCol = firstDow;
        const lastIdx  = firstDow + total - 1;
        this._lastRow  = Math.floor(lastIdx / 7);
        this._lastCol  = lastIdx % 7;

        // Extra overflow weeks (dragged in via the resize handle) top up the
        // month's natural row count. The outline itself stays keyed to
        // _lastRow/_lastCol (the real month), so it never grows into these.
        this._extraRows = this._extraWeekRows;
        this._numRows   = this._lastRow + 1 + this._extraRows;

        const todayStr = dateStr(this._today);
        const selStr   = dateStr(this._selected);
        const [py, pm] = prevMonthOf(this._year, this._month);
        const prevTot  = daysInMonth(py, pm);

        let row = new St.BoxLayout({style_class: 'litsycal-grid-row'});
        let col = 0;

        for (let i = firstDow - 1; i >= 0; i--) {
            const day = prevTot - i;
            const ds  = `${py}-${String(pm).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
            row.add_child(this._makeOverflow(day, ds));
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

        // A running date (not just a day-of-month counter) so overflow
        // numbering rolls over correctly when the extra rows stretch past a
        // single following month (up to MAX_EXTRA_WEEK_ROWS extra weeks).
        let cursor = GLib.DateTime.new_local(this._year, this._month, total, 0, 0, 0).add_days(1);
        const nextOverflow = () => {
            const day = cursor.get_day_of_month();
            const ds  = dateStr(cursor);
            cursor = cursor.add_days(1);
            return {day, ds};
        };

        if (col > 0) {
            while (col < 7) {
                const {day, ds} = nextOverflow();
                row.add_child(this._makeOverflow(day, ds));
                col++;
            }
            this._gridBox.add_child(row);
        }

        for (let r = 0; r < this._extraRows; r++) {
            const extraRow = new St.BoxLayout({style_class: 'litsycal-grid-row'});
            for (let c = 0; c < 7; c++) {
                const {day, ds} = nextOverflow();
                extraRow.add_child(this._makeOverflow(day, ds));
            }
            this._gridBox.add_child(extraRow);
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

        // Row cells go in their own nested box so the 4px inter-row spacing
        // (which must match .litsycal-grid's) only applies between rows —
        // not between the spacer above and the first row, which sits flush
        // against the day-name row/grid boundary with no gap, same as
        // _calRight's dayNameRow-to-grid-overlay join.
        const rows = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'litsycal-week-rows'});
        this._weekGutter.add_child(rows);

        const gridRows = this._gridBox.get_children();
        const anchor   = GLib.DateTime.new_local(this._year, this._month, 1, 0, 0, 0);
        for (let r = 0; r < this._numRows; r++) {
            const rowDate = anchor.add_days(r * 7 - this._firstCol);
            const cell    = this._makeWeekCell(isoWeekNumber(rowDate));
            rows.add_child(cell);
            if (gridRows[r]) {
                cell.add_constraint(new Clutter.BindConstraint({
                    source: gridRows[r], coordinate: Clutter.BindCoordinate.HEIGHT,
                }));
            }
        }
    }

    // Mirrors _makeCell's number+dot-row composition (number on top, an
    // empty dot-row-height spacer below, the pair centered as a group via
    // the St.Bin wrapper — exactly like St.Button centers a day cell's
    // content) so the printed week number sits at the same vertical offset
    // as the day numbers rather than at the row's raw geometric center.
    _makeWeekCell(weekNum) {
        const bin = new St.Bin({
            x_expand: true, y_expand: true,
            x_align: Clutter.ActorAlign.FILL, y_align: Clutter.ActorAlign.CENTER,
        });
        const box = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'litsycal-cell-box'});
        const lbl = new St.Label({text: String(weekNum), x_expand: true, style_class: 'litsycal-week-num'});
        lbl.clutter_text.set_x_align(Clutter.ActorAlign.CENTER);
        box.add_child(lbl);
        box.add_child(new St.BoxLayout({style_class: 'litsycal-dot-row', x_expand: true}));
        bin.set_child(box);
        return bin;
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

    // Uses the exact same St.Button shell (litsycal-day-btn) and behaviour as
    // _makeCell — click/keyboard select, hover tint, the hover-delay day
    // tooltip, event dots — just visually muted, since it belongs to an
    // adjacent month. Selecting a visible overflow day does NOT change the
    // displayed month (see the click handler below and _moveSelectionByDays'
    // _visibleDateRange check) — only navigating off the rendered grid
    // entirely does, mirroring Itsycal's MoCalendar (mouseUp: passes its
    // *current* monthDate through unchanged; moveSelectionByDays: only
    // re-centers once the new date is outside the whole visible grid, not
    // just a different month). Any structural difference here (a different
    // widget, different padding) throws off this cell's box model just
    // enough to misalign it and its row within the grid, so it must stay
    // wire-identical to a real cell otherwise. Mirrors Itsycal's MoCalCell,
    // which is the one cell class for every day regardless of month.
    _makeOverflow(day, ds) {
        const isToday = ds === dateStr(this._today);
        const isSel   = !isToday && ds === dateStr(this._selected);
        const [y, m, d] = ds.split('-').map(Number);
        const dow = GLib.DateTime.new_local(y, m, d, 0, 0, 0).get_day_of_week(); // 1=Mon..7=Sun
        const isWeekend = dow === 6 || dow === 7;

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
        const numLbl = new St.Label({
            text: String(day), x_expand: true,
            // A today-in-overflow cell gets the same accent treatment as a
            // real today cell, so it shouldn't also look dimmed.
            style_class: isToday ? 'litsycal-cell-num' : 'litsycal-cell-num litsycal-overflow',
        });
        numLbl.clutter_text.set_x_align(Clutter.ActorAlign.CENTER);
        box.add_child(numLbl);

        // Same dots as a real day cell (own event colour kept, mirroring
        // Itsycal), just faded via litsycal-event-dot-overflow so an
        // overflow week still reads as "not the active month" — unless this
        // is today, which is already called out via the accent background.
        const dotRow = new St.BoxLayout({style_class: 'litsycal-dot-row', x_expand: true});
        dotRow.set_x_align(Clutter.ActorAlign.CENTER);
        if (this._showEventDots) {
            for (const ev of this._calManager.getEventsForDate(ds).slice(0, 3)) {
                const dot = new St.Widget({style_class: 'litsycal-event-dot'});
                if (this._dotColorMode === 'mono') {
                    dot.add_style_class_name('litsycal-event-dot-mono');
                } else {
                    dot.style = `background-color: ${ev.color};`;
                    if (!isToday) dot.add_style_class_name('litsycal-event-dot-overflow');
                }
                dotRow.add_child(dot);
            }
        }
        box.add_child(dotRow);
        btn.set_child(box);

        btn.accessible_name = this._cellAccessibleName(ds, day, isToday);

        // Mirrors Itsycal's mouseUp: → setMonthDate:self.monthDate
        // selectedDate:clickedCell.date — the displayed month is passed
        // through unchanged, so clicking a visible overflow day just moves
        // the selection onto it in place rather than navigating there.
        btn.connect('clicked', () => {
            this._selected = GLib.DateTime.new_local(y, m, d, 0, 0, 0);
            this._buildGrid();
            this._buildAgenda();
        });
        btn.connect('notify::hover', () => {
            if (btn.hover) this._scheduleCellTooltip(ds, btn);
            else this._cancelCellTooltip();
        });

        // Tracked alongside real cells so a multi-day agenda event's hover
        // highlight (_highlightDateRange) still reaches days it spans into
        // an adjacent month, not just the active one.
        this._cellsByDate.set(ds, btn);
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
        this._cellsByDate.set(ds, btn);
        return btn;
    }

    // ── Range hover highlight ────────────────────────────────────────────────
    // Hovering a multi-day event in the agenda list highlights every day it
    // spans in the grid above, using the same tint as a plain cell :hover —
    // mirrors Itsycal's agendaHoveredOverRow/highlightCellsFromDate, minus
    // the custom Cairo drawing (a toggled CSS class does the same job here).

    _highlightDateRange(ev) {
        this._clearDateRangeHighlight();
        for (const ds of this._calManager.datesSpanned(ev)) {
            const btn = this._cellsByDate.get(ds);
            if (!btn) continue; // day falls entirely outside the rendered grid (overflow cells are tracked here too)
            btn.add_style_class_name('litsycal-day-btn-range-highlight');
            this._rangeHighlightedCells.push(btn);
        }
    }

    _clearDateRangeHighlight() {
        for (const btn of this._rangeHighlightedCells)
            btn.remove_style_class_name('litsycal-day-btn-range-highlight');
        this._rangeHighlightedCells = [];
    }

    _cellAccessibleName(ds, day, isToday) {
        const [y, m, d] = ds.split('-').map(Number);
        const cellDate  = GLib.DateTime.new_local(y, m, d, 0, 0, 0);
        let name = `${capitalize(cellDate.format('%A'))}, ${capitalize(cellDate.format('%B'))} ${day}, ` +
                   `${displayYear(y, this._calendarSystem)}`;
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
            if (i === 0 || evs.length > 0 || this._showEmptyAgendaDays)
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

                    const meetingUrl = findMeetingUrl(ev);
                    if (meetingUrl && meetingIsJoinable(ev)) {
                        const joinIcon = new St.Icon({
                            icon_name: 'camera-video-symbolic',
                            style_class: 'litsycal-agenda-join-icon',
                        });
                        joinIcon.style = `color: ${ev.color};`;
                        const joinBtn = new St.Button({
                            style_class: 'litsycal-agenda-join-btn',
                            accessible_name: _('Join meeting'),
                            child: joinIcon,
                        });
                        joinBtn.connect('clicked', () => {
                            try { Gio.AppInfo.launch_default_for_uri(meetingUrl, null); } catch(_) {}
                        });
                        row2.add_child(joinBtn);
                    }
                    evtBox.add_child(row2);

                    if (ev.location && this._showEventLocation) {
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
                    evtBtn.connect('notify::hover', () => {
                        if (evtBtn.hover) this._highlightDateRange(ev);
                        else this._clearDateRangeHighlight();
                    });

                    const evtRow = new St.BoxLayout({x_expand: true});
                    evtRow.add_child(evtBtn);

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
            if (this._suppressPinNotify) return;
            if (this._onPinToggle) this._onPinToggle(pinBtn.get_checked());
        });
        this._pinBtn = pinBtn;

        const calBtn = makeIconBtn('x-office-calendar-symbolic', _('Open Calendar app'));
        calBtn.connect('clicked', () => { if (this._openCalendar) this._openCalendar(); });

        const gear = makeIconBtn('preferences-system-symbolic', _('Settings menu'));
        gear.connect('clicked', () => this._openSettingsMenu(gear));

        footer.add_child(this._addBtn);
        footer.add_child(new St.Widget({x_expand: true}));
        footer.add_child(pinBtn);
        footer.add_child(calBtn);
        footer.add_child(gear);
        this.add_child(footer);
    }

    // Keeps the footer pin toggle's visual state in sync when pinning/
    // unpinning happens programmatically (e.g. LitsycalIndicator force-
    // unpinning the calendar when the menu is reopened) rather than from a
    // direct click on this button.
    setPinned(pinned) {
        if (this._pinBtn.get_checked() === pinned) return;
        this._suppressPinNotify = true;
        this._pinBtn.set_checked(pinned);
        this._suppressPinNotify = false;
    }

    // ── Event panels ──────────────────────────────────────────────────────────

    _openCreateDialog() {
        if (!this._calManager?.isAvailable()) return;
        this._eventPanel?.close();
        this._eventPanel = new EventPanel(
            this._calManager, null, this._selected, this,
            () => { this._eventPanel = null; }, this._calendarSystem
        );
    }

    _openEventDialog(ev) {
        if (!this._calManager?.isAvailable()) return;
        this._eventPanel?.close();
        this._eventPanel = new EventPanel(
            this._calManager, ev, null, this,
            () => { this._eventPanel = null; }, this._calendarSystem
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

    // Used by the settings menu's "Go to date" dialog.
    _goToDate(dt) {
        this._year = dt.get_year(); this._month = dt.get_month();
        this._selected = dt;
        this._updateMonthLabel();
        this._buildGrid();
        this._buildAgenda();
        this._calManager?.fetchMonth(this._year, this._month);
    }

    _updateMonthLabel() {
        const monthName = capitalize(GLib.DateTime.new_local(this._year, this._month, 1, 0, 0, 0).format('%b'));
        this._monthLbl.set_text(`${monthName} ${displayYear(this._year, this._calendarSystem)}`);
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

    // The full span of dates the currently rendered grid covers, leading and
    // trailing overflow days included — _firstCol/_numRows are set by the
    // last _buildGrid() call. Mirrors Itsycal's moveSelectionByDays:, which
    // checks the new selection against _dateGrid's first/last cell rather
    // than against the displayed month.
    _visibleDateRange() {
        const monthStart   = GLib.DateTime.new_local(this._year, this._month, 1, 0, 0, 0);
        const firstVisible = monthStart.add_days(-this._firstCol);
        const lastVisible  = firstVisible.add_days(this._numRows * 7 - 1);
        return {firstVisible, lastVisible};
    }

    _moveSelectionByDays(delta) {
        const sel = this._selected.add_days(delta);
        const {firstVisible, lastVisible} = this._visibleDateRange();
        this._selected = sel;

        // Only jump the displayed month once the selection moves off the
        // grid entirely — a day that's still visible via overflow (leading,
        // trailing, or a dragged-in extra week) just gets selected in place,
        // same as Itsycal.
        if (sel.compare(firstVisible) < 0 || sel.compare(lastVisible) > 0) {
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

// ── Settings menu (floating, non-modal PopupMenu-wise, but self-grabbed) ────
//
// Deliberately not a PopupMenu.PopupMenu/menuManager grab: menuManager closes
// any other menu it owns the instant a new one opens, which would force the
// calendar dropdown shut the moment this appears — not what we want, since
// the calendar should stay open behind it. Built the same way as EventPanel/
// GoToDatePanel instead — a floating box in uiGroup.
//
// It does still need its own Main.pushModal grab, though: `this.menu`'s own
// grab (see the open-state-changed handler below, "Capture phase on the
// menu's own actor, not the stage") means input while it's active is
// redelivered starting from ITS grab actor, not the stage — so without a
// competing grab of our own, a click on one of our rows is swallowed as a
// click-outside-of-this.menu (closing nothing visible, since we're not part
// of it) rather than ever reaching our button, and only a second click, once
// unrelated to the by-then-released grab, actually lands. Grabbing here (and
// listening on this._box's own 'captured-event', for the same reason) fixes
// that the same way this.menu's own keyboard handling already had to.
class SettingsMenuPanel {

    // items: {label, icon, action}[] rows in display order; `null` renders as
    // a separator. `action` is called once the panel has fully closed; a row
    // with `action: null` renders disabled (e.g. "Check for updates").
    constructor(anchorActor, items) {
        this._box = new St.BoxLayout({
            vertical: true,
            style_class: 'popup-menu-content litsycal-settings-menu',
            reactive: true,
        });

        for (const item of items) {
            if (item === null) {
                this._box.add_child(new St.Widget({style_class: 'litsycal-panel-sep'}));
                continue;
            }
            const btn = new St.Button({
                style_class: 'litsycal-panel-cal-option',
                x_expand: true,
                reactive: !!item.action,
            });
            const row = new St.BoxLayout({style_class: 'litsycal-settings-menu-row'});
            row.add_child(new St.Icon({
                icon_name: item.icon, icon_size: 16,
                style_class: 'litsycal-settings-menu-icon',
            }));
            row.add_child(new St.Label({text: item.label, y_align: Clutter.ActorAlign.CENTER}));
            btn.set_child(row);
            if (!item.action) {
                btn.add_style_pseudo_class('insensitive');
            } else {
                btn.connect('clicked', () => {
                    // Tearing this._box down from inside its own child's
                    // still-live 'clicked' handler is asking for trouble —
                    // finish the event first (same reasoning as the quit
                    // action's own idle_add deferral).
                    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                        this.close();
                        item.action();
                        return GLib.SOURCE_REMOVE;
                    });
                });
            }
            this._box.add_child(btn);
        }

        Main.layoutManager.uiGroup.add_child(this._box);
        this._grab = Main.pushModal(this._box, {actionMode: Shell.ActionMode.POPUP});

        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._position(anchorActor);
            return GLib.SOURCE_REMOVE;
        });

        this._eventId = this._box.connect('captured-event', (_actor, ev) => {
            if (ev.type() === Clutter.EventType.BUTTON_PRESS) {
                const [x, y] = ev.get_coords();
                const actor  = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y);
                if (actor && !this._box.contains(actor)) {
                    this.close();
                    return Clutter.EVENT_STOP;
                }
            } else if (ev.type() === Clutter.EventType.KEY_PRESS &&
                       ev.get_key_symbol() === Clutter.KEY_Escape) {
                this.close();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    _position(anchor) {
        const monitor = Main.layoutManager.primaryMonitor;
        const panelH  = Main.panel.get_height();
        const boxW    = this._box.get_width()  || 200;
        const boxH    = this._box.get_height() || 260;

        const [ax, ay] = anchor.get_transformed_position();
        const ah = anchor.get_height();

        let x = ax; // left-align with the anchor
        x = Math.max(monitor.x + 4, Math.min(x, monitor.x + monitor.width - boxW - 4));

        let y = ay + ah + 4;
        if (y + boxH > monitor.y + monitor.height - 4) y = ay - boxH - 4; // flip above if no room below
        y = Math.max(monitor.y + panelH + 4, y);

        this._box.set_position(Math.round(x), Math.round(y));
    }

    close() {
        if (this._eventId) { this._box?.disconnect(this._eventId); this._eventId = null; }
        if (this._grab)    { Main.popModal(this._grab); this._grab = null; }
        if (this._box) {
            Main.layoutManager.uiGroup.remove_child(this._box);
            this._box.destroy();
            this._box = null;
        }
    }
}

// ── Panel indicator ───────────────────────────────────────────────────────────

const LitsycalIndicator = GObject.registerClass(
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
            if (open && this._pinned) {
                // The calendar widget currently lives in the floating pinned
                // box, not in this menu item. Reparenting it back while
                // open() is still setting up its modal grab races that
                // setup and leaves the widget detached from the stage
                // (never actually mapped/shown, and stuck with a stale
                // pointer-grab ":insensitive" style). Defer the unpin to
                // the next idle, once the grab has settled.
                GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    if (this._pinned) this._unpinCalendar(false);
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
            (anchor) => this._openSettingsMenu(anchor),
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
            {label: _('About'), icon: 'help-about-symbolic',
             action: () => { this.menu.close(); this._openPrefsPage('about'); }},
            {label: _('Check for updates'), icon: 'software-update-available-symbolic', action: null},
            null,
            {label: _('Go to date…'), icon: 'go-jump-symbolic',
             action: () => this._openGoToDateDialog(anchorActor)},
            null,
            {label: _('Settings'), icon: 'preferences-system-symbolic',
             action: () => { this.menu.close(); this._openPrefsPage('general'); }},
            {label: _('Appearance'), icon: 'preferences-desktop-theme-symbolic',
             action: () => { this.menu.close(); this._openPrefsPage('appearance'); }},
            null,
            {label: _('Help'), icon: 'help-browser-symbolic', action: () => {
                this.menu.close();
                Gio.AppInfo.launch_default_for_uri('https://github.com/mlkonrad/litsycal/wiki', null);
            }},
            null,
            {label: _('Quit Litsycal'), icon: 'application-exit-symbolic', action: () => {
                this.menu.close();
                // Disabling from inside this handler would tear this actor
                // down mid-event; defer to the next idle tick.
                const uuid = this._uuid;
                GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    Main.extensionManager.disableExtension(uuid);
                    return GLib.SOURCE_REMOVE;
                });
            }},
        ]);
    }

    // Unlike the other settings-menu actions, this deliberately leaves the
    // calendar dropdown open: the date panel floats in front of it, and once
    // a date is picked the calendar (already open, or opened fresh if this
    // came from a right-click with it closed) jumps straight to it.
    _openGoToDateDialog(anchorActor) {
        this._goToDatePanel?.close();
        this._goToDatePanel = new GoToDatePanel(anchorActor, (dt) => {
            this._goToDatePanel = null;
            if (!dt) return;
            if (!this._menuIsOpen) this.menu.open();
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
        const calW = this._calWidget.get_width()
            || SIZE_MIN_WIDTHS[this._settings.get_int('calendar-size')] || 255;

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
        this._goToDatePanel?.close();
        this._goToDatePanel = null;
        this._settingsMenuPanel?.close();
        this._settingsMenuPanel = null;
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
