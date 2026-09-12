import St      from 'gi://St';
import GLib    from 'gi://GLib';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import Pango   from 'gi://Pango';
import Gio     from 'gi://Gio';
import Shell   from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {gettext as _, ngettext} from 'resource:///org/gnome/shell/extensions/extension.js';

import {CalendarManager}   from './calendarManager.js';
import {EventPanel, QuickAddPanel, confirmDeleteEvent} from './eventDialog.js';
import {OutlinePainter}    from './outlinePainter.js';
import {EventInfoPopover}  from './eventInfoPopover.js';
import {SettingsMenuPanel} from './settingsMenuPanel.js';
import {SearchPanel}       from './searchPanel.js';
import {
    capitalize, localeDayAbbrs, localeDayAbbrsShort,
    DAY_COL, SIZE_CLASSES, FONT_SIZE_CLASSES,
    MAX_EXTRA_WEEK_ROWS, OUTLINE_TOP_INSET,
    readAccent, accentAlpha, dateStr, daysInMonth, daysBetween, prevMonthOf,
    displayYear, isoWeekNumber, findMeetingUrl, meetingIsJoinable, formatEventWhen,
} from './helpers.js';

// ── Calendar widget ───────────────────────────────────────────────────────────

export const LitsycalCalendar = GObject.registerClass(
class LitsycalCalendar extends St.BoxLayout {
    _init(settings, openSettingsMenu, openCalendar, onPinToggle, onDataChanged, openGoToDate, quit) {
        super._init({vertical: true, style_class: 'litsycal-calendar'});

        this._settings         = settings;
        this._openSettingsMenu = openSettingsMenu;
        this._openCalendar     = openCalendar;
        this._onPinToggle      = onPinToggle;
        this._openGoToDate     = openGoToDate;
        this._quit             = quit;
        this._accent           = readAccent();

        const now      = GLib.DateTime.new_now_local();
        this._year     = now.get_year();
        this._month    = now.get_month();
        this._today    = now;
        this._selected = now;

        this._firstCol = 0;
        this._lastCol = 6;
        this._lastRow = 0;
        this._numRows = 1;

        this._firstDayOfWeek   = settings.get_int('first-day-of-week');
        this._shortDayNames    = settings.get_boolean('short-day-names');
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
        this._timezones        = settings.get_strv('timezones');
        this._timeFormat       = settings.get_string('time-format');
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
            settings.connect('changed::short-day-names', () => {
                this._shortDayNames = settings.get_boolean('short-day-names');
                this._buildDayNameRow(true);
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
                if (this._weekendColorMode === 'custom')
                    this._buildGrid();
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
            settings.connect('changed::timezones', () => {
                this._timezones = settings.get_strv('timezones');
                this._updateTimeZones();
            }),
            settings.connect('changed::time-format', () => {
                this._timeFormat = settings.get_string('time-format');
                this._updateTimeZones();
            }),
        ];

        this._iface    = new Gio.Settings({schema: 'org.gnome.desktop.interface'});
        this._accentId = this._iface.connect('changed::accent-color', () => {
            this._accent = readAccent();
            this._updateHeaderColors();
            this._buildGrid();
        });
        this._schemeId = this._iface.connect('changed::color-scheme', () => {
            if (this._theme === 'system')
                this._applyTheme();
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

        this._buildTimeZones();
        this._buildFooter();
        this._calManager.fetchMonth(this._year, this._month);
    }

    // ── Cleanup ───────────────────────────────────────────────────────────────

    destroy() {
        this._eventPanel?.close();
        this._eventPanel = null;
        this._eventContextMenu?.close();
        this._eventContextMenu = null;
        this._eventInfoPopover?.close();
        this._eventInfoPopover = null;
        this._searchPanel?.close();
        this._searchPanel = null;
        this._quickAddPanel?.close();
        this._quickAddPanel = null;
        this._cancelCellTooltip();
        if (this._dayInfoTimeoutId) {
            GLib.source_remove(this._dayInfoTimeoutId);
            this._dayInfoTimeoutId = null;
        }
        if (this._searchPopoverRetryId) {
            GLib.source_remove(this._searchPopoverRetryId);
            this._searchPopoverRetryId = null;
        }
        if (this._dragStartY !== undefined)
            this._endHandleDrag(this._resizeHandle);
        for (const id of this._sids)
            this._settings.disconnect(id);
        this._iface.disconnect(this._accentId);
        this._iface.disconnect(this._schemeId);
        this._calManager?.destroy();
        super.destroy();
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
        if (this._theme === 'dark')
            return true;
        if (this._theme === 'light')
            return false;
        return this._iface.get_string('color-scheme') === 'prefer-dark';
    }

    _updateHeaderColors() {
        this._dotBtn.style = `color: ${this._accent};`;
    }

    // calendar-size: 0=S, 1=S+, 2=M (no class — the base CSS values), 3=M+, 4=L
    _applySizeClass() {
        for (const cls of SIZE_CLASSES) {
            if (cls)
                this.remove_style_class_name(cls);
        }

        const cls = SIZE_CLASSES[this._calSize];
        if (cls)
            this.add_style_class_name(cls);
    }

    // font-size: 0=S, 1=M (no class — the base CSS values), 2=L
    _applyFontSizeClass() {
        for (const cls of FONT_SIZE_CLASSES) {
            if (cls)
                this.remove_style_class_name(cls);
        }

        const cls = FONT_SIZE_CLASSES[this._fontSize];
        if (cls)
            this.add_style_class_name(cls);
    }

    _applyTheme() {
        this._isDark = this._computeIsDark();
        this.remove_style_class_name('litsycal-theme-light');
        this.remove_style_class_name('litsycal-theme-dark');
        this.add_style_class_name(this._isDark ? 'litsycal-theme-dark' : 'litsycal-theme-light');
        this._painter.configure(this._isDark, this._highlightCols, OUTLINE_TOP_INSET[this._calSize]);
        if (this._prevBtn)
            this._updateHeaderColors();
        this._buildDayNameRow(true);
        this._buildGrid();
        if (this._agendaBox)
            this._buildAgenda();
        this._outline?.queue_repaint();
    }

    // ── Header ────────────────────────────────────────────────────────────────

    _buildHeader() {
        const row = new St.BoxLayout({style_class: 'litsycal-header'});

        this._monthLbl = new St.Label({style_class: 'litsycal-month-lbl', x_expand: true});

        this._prevBtn  = new St.Button({
            label: '‹', style_class: 'litsycal-nav-btn',
            accessible_name: _('Previous month'),
        });
        this._dotBtn   = new St.Button({
            label: '●', style_class: 'litsycal-nav-btn litsycal-dot-btn',
            accessible_name: _('Go to today'),
        });
        this._nextBtn  = new St.Button({
            label: '›', style_class: 'litsycal-nav-btn',
            accessible_name: _('Next month'),
        });

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
        const dayAbbrs    = this._shortDayNames ? localeDayAbbrsShort() : localeDayAbbrs();
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
        if (rebuild)
            this._calRight.insert_child_at_index(row, 0);
        else
            this._calRight.add_child(row);
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
        this._outline.connect('repaint', area => {
            const [w, h] = area.get_surface_size();
            if (w > 0 && h > 0 && this._numRows > 0) {
                this._painter.paint(area.get_context(), w, h,
                    this._numRows, this._firstCol, this._lastCol, this._lastRow);
            }
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
            if (event.get_button() !== Clutter.BUTTON_PRIMARY)
                return Clutter.EVENT_PROPAGATE;
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
        if (this._dragStartY === undefined || !this._dragRowHeight)
            return Clutter.EVENT_PROPAGATE;

        const delta  = event.get_coords()[1] - this._dragStartY;
        const rows   = Math.round(delta / this._dragRowHeight);
        const wanted = Math.min(MAX_EXTRA_WEEK_ROWS, Math.max(0, this._dragStartExtra + rows));

        if (wanted !== this._extraWeekRows)
            this._settings.set_int('extra-week-rows', wanted);
        return Clutter.EVENT_STOP;
    }

    _endHandleDrag(actor) {
        if (this._dragMotionId)  {
            actor.disconnect(this._dragMotionId);
            this._dragMotionId  = null;
        }
        if (this._dragReleaseId) {
            actor.disconnect(this._dragReleaseId);
            this._dragReleaseId = null;
        }
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
            const ds  = `${py}-${String(pm).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
            row.add_child(this._makeOverflow(day, ds));
            col++;
        }

        for (let d = 1; d <= total; d++) {
            const ds = `${this._year}-${String(this._month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
            const actualDay = (col + fd) % 7;
            const isWeekend = actualDay === 5 || actualDay === 6;
            row.add_child(this._makeCell(d, ds, ds === todayStr, ds === selStr, isWeekend));
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
        if (!this._showWeekNumbers)
            return;

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
        if (!this._agendaScroll)
            return;

        const monitor = Main.layoutManager.monitors[
            Main.layoutManager.findIndexForActor(this)
        ] ?? Main.layoutManager.primaryMonitor;
        // No monitor geometry yet — observed during mutter-devkit nested-session
        // startup, where extensions activate before layoutManager has
        // registered a monitor. _buildAgenda() (this method's other caller)
        // runs again on the next agenda rebuild (60s timer, month navigation,
        // menu open, ...), so skipping this pass just leaves the cap unset
        // until then rather than crashing extension activation outright.
        if (!monitor)
            return;
        const panelH = Main.panel.get_height();

        let othersHeight = 0;
        for (const child of this.get_children()) {
            if (child === this._agendaScroll)
                continue;
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
        if (isToday)
            sc += ' litsycal-today';
        else if (isSel)
            sc += ' litsycal-selected';

        const btn = new St.Button({style_class: sc, x_expand: true, track_hover: true});

        if (isToday)
            btn.style = `background-color: ${this._accent}; color: white;`;
        else if (isSel)
            btn.style = `background-color: ${accentAlpha(this._accent, 0.25)};`;
        else if (isWeekend && this._weekendColorMode === 'custom')
            btn.style = `color: ${this._weekendColor};`;
        else if (isWeekend && this._weekendColorMode === 'default')
            btn.add_style_class_name('litsycal-weekend');


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
                    if (!isToday)
                        dot.add_style_class_name('litsycal-event-dot-overflow');
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
            if (btn.hover)
                this._scheduleCellTooltip(ds, btn);
            else
                this._cancelCellTooltip();
        });

        // Tracked alongside real cells so a multi-day agenda event's hover
        // highlight (_highlightDateRange) still reaches days it spans into
        // an adjacent month, not just the active one.
        this._cellsByDate.set(ds, btn);
        return btn;
    }

    _makeCell(day, ds, isToday, isSel, isWeekend) {
        let sc = 'litsycal-day-btn';
        if (isToday)
            sc += ' litsycal-today';
        else if (isSel)
            sc += ' litsycal-selected';

        const btn = new St.Button({style_class: sc, x_expand: true, track_hover: true});

        if (isToday)
            btn.style = `background-color: ${this._accent}; color: white;`;
        else if (isSel)
            btn.style = `background-color: ${accentAlpha(this._accent, 0.25)};`;
        else if (isWeekend && this._weekendColorMode === 'custom')
            btn.style = `color: ${this._weekendColor};`;
        else if (isWeekend && this._weekendColorMode === 'default')
            btn.add_style_class_name('litsycal-weekend');


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
            if (btn.hover)
                this._scheduleCellTooltip(ds, btn);
            else
                this._cancelCellTooltip();
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
            if (!btn)
                continue; // day falls entirely outside the rendered grid (overflow cells are tracked here too)
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
        if (isToday)
            name += `, ${_('Today')}`;

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
        if (!anchorBtn.hover)
            return; // pointer left before the delay elapsed

        const [y, m, d] = ds.split('-').map(Number);
        const date = GLib.DateTime.new_local(y, m, d, 0, 0, 0);
        const evs  = this._calManager.getEventsForDate(ds);

        const box = new St.BoxLayout({
            vertical: true,
            style_class: 'popup-menu-content litsycal-cell-tooltip',
            // Painted at (0,0) until the idle-positioning callback below runs
            // a frame later — stay invisible until then so it doesn't flash
            // at the screen corner first. Opacity, not `visible`, so it stays
            // mapped/measurable in the meantime.
            opacity: 0,
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
            if (!this._tooltipBox)
                return GLib.SOURCE_REMOVE; // hidden again already

            const monitor = Main.layoutManager.monitors[
                Main.layoutManager.findIndexForActor(this)
            ] ?? Main.layoutManager.primaryMonitor;
            const panelH = Main.panel.get_height();
            const [ax, ay] = anchorBtn.get_transformed_position();
            const aw = anchorBtn.get_width();
            const boxW = box.get_width()  || 200;
            const boxH = box.get_height() || 60;

            let x = ax + aw + 8;
            if (x + boxW > monitor.x + monitor.width - 4)
                x = ax - boxW - 8;
            x = Math.max(monitor.x + 4, Math.min(x, monitor.x + monitor.width - boxW - 4));

            let posY = ay;
            posY = Math.max(monitor.y + panelH + 4, Math.min(posY, monitor.y + monitor.height - boxH - 4));

            box.set_position(x, posY);
            box.opacity = 255;
            return GLib.SOURCE_REMOVE;
        });
    }

    // ── Agenda ────────────────────────────────────────────────────────────────

    _buildAgenda() {
        this._agendaBox.destroy_all_children();
        // Rebuilt on every call, in agenda display order — first entry is
        // whatever ⌃⇧J ("open first active meeting") should trigger.
        this._joinButtons = [];

        const hidden = this._agendaDays <= 0;
        this._agendaScroll.visible = !hidden;
        this._agendaSep.visible    = !hidden;
        if (hidden) {
            this._updateAgendaMaxHeight();
            return;
        }

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
            if (ds === todayStr)
                dayLabel = _('Today');
            else if (ds === tomorrowStr)
                dayLabel = _('Tomorrow');
            else
                dayLabel = capitalize(day.format('%A'));

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
                    // Tagged so a click that lands on this row while an
                    // EventInfoPopover's backdrop is up can be traced back to
                    // the event it belongs to — see _eventButtonAt().
                    evtBtn._litsycalEvent = ev;
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

                    const addRow2LinkBtn = (iconName, accessibleName, uri) => {
                        const icon = new St.Icon({icon_name: iconName, style_class: 'litsycal-agenda-join-icon'});
                        icon.style = `color: ${ev.color};`;
                        const btn = new St.Button({
                            style_class: 'litsycal-agenda-join-btn', accessible_name: accessibleName, child: icon,
                        });
                        btn.connect('clicked', () => {
                            try {
                                Gio.AppInfo.launch_default_for_uri(uri, null);
                            } catch {}
                        });
                        row2.add_child(btn);
                        return btn;
                    };

                    const meetingUrl = findMeetingUrl(ev);
                    if (meetingUrl && meetingIsJoinable(ev)) {
                        this._joinButtons.push(
                            addRow2LinkBtn('camera-video-symbolic', _('Join meeting'), meetingUrl));
                    }

                    if (ev.url)
                        addRow2LinkBtn('web-browser-symbolic', _('Open link'), ev.url);

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
                    evtBtn.accessible_name = `${ev.title}, ${ev.time ?? _('All day')}${
                        ev.location ? `, ${ev.location}` : ''}`;
                    evtBtn.connect('clicked', () => this._openEventInfoPopover(evtBtn, ev));
                    evtBtn.connect('notify::hover', () => {
                        if (evtBtn.hover)
                            this._highlightDateRange(ev);
                        else
                            this._clearDateRangeHighlight();
                    });
                    // Right-click: same {label, icon, action} SettingsMenuPanel
                    // used for the panel icon/gear menu, offering the itsycal-
                    // style Open Calendar / Copy / Delete… trio for this event.
                    evtBtn.connect('button-press-event', (actor, event) => {
                        if (event.get_button() !== Clutter.BUTTON_SECONDARY)
                            return Clutter.EVENT_PROPAGATE;
                        this._openEventContextMenu(evtBtn, ev);
                        return Clutter.EVENT_STOP;
                    });

                    this._agendaBox.add_child(evtBtn);
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

        this._addBtn = new St.Button({
            label: '+', style_class: 'litsycal-footer-btn litsycal-add-btn',
            accessible_name: _('New event'),
        });
        this._addBtn.connect('clicked', () => this._openCreateDialog());

        const pinBtn = makeIconBtn('view-pin-symbolic', _('Pin calendar open'), true);
        pinBtn.connect('notify::checked', () => {
            if (this._suppressPinNotify)
                return;
            if (this._onPinToggle)
                this._onPinToggle(pinBtn.get_checked());
        });
        this._pinBtn = pinBtn;

        const syncBtn = makeIconBtn('view-refresh-symbolic', _('Sync calendars'));
        syncBtn.connect('clicked', () => {
            this._calManager?.refreshFromServer();
            this._calManager?.fetchMonth(this._year, this._month);
        });

        const calBtn = makeIconBtn('x-office-calendar-symbolic', _('Open Calendar app'));
        calBtn.connect('clicked', () => {
            if (this._openCalendar)
                this._openCalendar();
        });

        const gear = makeIconBtn('preferences-system-symbolic', _('Settings menu'));
        gear.connect('clicked', () => this._openSettingsMenu(gear));
        this._gearBtn = gear; // anchor for keyboard-triggered settings/go-to-date panels

        footer.add_child(this._addBtn);
        footer.add_child(new St.Widget({x_expand: true}));
        footer.add_child(pinBtn);
        footer.add_child(syncBtn);
        footer.add_child(calBtn);
        footer.add_child(gear);
        this.add_child(footer);
    }

    // Time zone clocks section — sits between the agenda and the footer,
    // hidden entirely when 'timezones' is empty. Rows are (re)built by
    // _updateTimeZones(), called here once and again on every relevant
    // settings change and by LitsycalIndicator's minute timer while the
    // calendar is visible (see indicator.js).
    _buildTimeZones() {
        this._tzSep = new St.Widget({style_class: 'litsycal-sep', visible: false});
        this.add_child(this._tzSep);

        this._tzBox = new St.BoxLayout({vertical: true, style_class: 'litsycal-tz-box', visible: false});
        this.add_child(this._tzBox);

        this._updateTimeZones();
    }

    // Rebuilds the time zone rows sorted west-to-east by current UTC offset
    // (accounting for DST, since this is always "right now"). Invalid ids
    // (already flagged in Preferences) are silently skipped.
    _updateTimeZones() {
        this._tzBox.destroy_all_children();

        const nowUtc = GLib.DateTime.new_now_utc();
        const zones = this._timezones
            .map(id => {
                const tz = GLib.TimeZone.new_identifier(id);
                if (!tz)
                    return null;
                const offset = tz.get_offset(tz.find_interval(GLib.TimeType.UNIVERSAL, nowUtc.to_unix()));
                return {id, tz, offset};
            })
            .filter(z => z)
            .sort((a, b) => a.offset - b.offset);

        this._tzSep.visible = zones.length > 0;
        this._tzBox.visible = zones.length > 0;
        if (!zones.length)
            return;

        // Reuses the agenda's own day-name/title classes (litsycal-agenda-*)
        // for typography, rather than hardcoding sizes here, so this section
        // matches the rest of the calendar's text and keeps tracking the
        // calendar-size preference's scaling automatically.
        this._tzBox.add_child(new St.Label({
            text: _('Time Zones'), style_class: 'litsycal-tz-title litsycal-agenda-day-name',
        }));
        for (const {id, tz} of zones) {
            const now  = GLib.DateTime.new_now(tz);
            const time = this._timeFormat === '12h' ? now.format('%-I:%M%P') : now.format('%H:%M');
            const city = id.split('/').pop().replace(/_/g, ' ');

            // Dotted leader between city and time, same left-label/spacer/
            // right-label layout the agenda's day-name/day-date header uses
            // — a clipped run of dots rather than a CSS border, since St's
            // theme engine has no track record of rendering dashed/dotted
            // borders anywhere in GNOME Shell's own stylesheets.
            const leader = new St.Label({
                text: '.'.repeat(200), x_expand: true, y_align: Clutter.ActorAlign.END,
                style_class: 'litsycal-tz-leader',
            });
            leader.clutter_text.set_line_wrap(false);
            leader.clip_to_allocation = true;

            const row = new St.BoxLayout({style_class: 'litsycal-tz-row'});
            row.add_child(new St.Label({text: city, style_class: 'litsycal-tz-city litsycal-agenda-title'}));
            row.add_child(leader);
            row.add_child(new St.Label({text: time, style_class: 'litsycal-tz-time litsycal-agenda-title'}));
            this._tzBox.add_child(row);
        }
    }

    // Keeps the footer pin toggle's visual state in sync when pinning/
    // unpinning happens programmatically (e.g. LitsycalIndicator force-
    // unpinning the calendar when the menu is reopened) rather than from a
    // direct click on this button.
    setPinned(pinned) {
        if (this._pinBtn.get_checked() === pinned)
            return;
        this._suppressPinNotify = true;
        this._pinBtn.set_checked(pinned);
        this._suppressPinNotify = false;
    }

    // ── Event panels ──────────────────────────────────────────────────────────

    _openCreateDialog() {
        if (!this._calManager?.isAvailable())
            return;
        this._eventPanel?.close();
        this._eventInfoPopover?.close();
        this._eventPanel = new EventPanel(
            this._calManager, null, this._selected, this,
            () => {
                this._eventPanel = null;
            }, this._calendarSystem
        );
    }

    // Ctrl+Shift+N: parse a one-liner into a draft, then open the same full
    // EventPanel _openCreateDialog does, pre-filled with it — never saves
    // directly from the one-liner. See QuickAddPanel/quickAddParser.js.
    _openQuickAdd() {
        if (!this._calManager?.isAvailable())
            return;
        this._quickAddPanel?.close();
        this._quickAddPanel = new QuickAddPanel(this, draft => {
            this._quickAddPanel = null;
            if (!draft)
                return; // cancelled
            this._eventPanel?.close();
            this._eventInfoPopover?.close();
            this._eventPanel = new EventPanel(
                this._calManager, null, this._selected, this,
                () => {
                    this._eventPanel = null;
                }, this._calendarSystem, draft
            );
        });
    }

    // Ctrl+F: search every connected calendar (not just the currently
    // displayed month — see CalendarManager.searchEvents). Selecting a
    // result navigates the grid to its date and opens the same read-only
    // info popover a normal agenda-row click does.
    _openSearch() {
        if (!this._calManager?.isAvailable())
            return;
        this._searchPanel?.close();
        this._searchPanel = new SearchPanel(this, this._calManager, ev => {
            this._searchPanel = null;
            if (!ev)
                return; // cancelled
            const [y, m, d] = ev.date.split('-').map(Number);
            this._goToDate(GLib.DateTime.new_local(y, m, d, 0, 0, 0));
            this._eventPanel?.close();
            this._openEventInfoPopoverForSearchResult(ev);
        });
    }

    // Anchors the popover to the actual rendered agenda row for `ev`, same
    // as a normal row click does — anchoring to `this` (the whole calendar
    // widget) instead positions the popover nowhere near anything
    // meaningful. _goToDate() just above may have navigated to a different
    // month, whose agenda is still rendering off stale/cached data for a
    // moment (fetchMonth's own fetch is async) before the real row exists,
    // so this retries briefly rather than giving up on the very first
    // (possibly too-early) look.
    _openEventInfoPopoverForSearchResult(ev, attemptsLeft = 10) {
        if (this._searchPopoverRetryId) {
            GLib.source_remove(this._searchPopoverRetryId);
            this._searchPopoverRetryId = null;
        }
        const btn = this._agendaBox.get_children().find(c => this._sameEvent(c._litsycalEvent, ev));
        if (btn) {
            this._openEventInfoPopover(btn, ev);
            return;
        }
        if (attemptsLeft <= 0) {
            this._openEventInfoPopover(this, ev); // never found one — better than nothing
            return;
        }
        this._searchPopoverRetryId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            this._searchPopoverRetryId = null;
            this._openEventInfoPopoverForSearchResult(ev, attemptsLeft - 1);
            return GLib.SOURCE_REMOVE;
        });
    }

    _openEventDialog(ev) {
        if (!this._calManager?.isAvailable())
            return;
        this._eventPanel?.close();
        this._eventInfoPopover?.close();
        this._eventPanel = new EventPanel(
            this._calManager, ev, null, this,
            () => {
                this._eventPanel = null;
            }, this._calendarSystem
        );
    }

    // ── Event info popover (left-click on an agenda row) ─────────────────────────
    //
    // itsycal's own agenda click behavior: a compact, read-only card next to the
    // clicked row (AgendaPopoverVC in AgendaViewController.m) rather than jumping
    // straight into the full edit form. Editing is still one step away via the
    // row's right-click menu's new Edit… entry, just not from this popover itself.
    // Clicking a row toggles: opens that event's popover, clicking the same row
    // again closes it, clicking a different row switches straight to that one.

    _openEventInfoPopover(anchorActor, ev) {
        this._eventInfoPopover?.close();
        this._eventContextMenu?.close();
        this._eventInfoPopover = new EventInfoPopover(
            this._calManager, ev, anchorActor,
            () => {
                this._eventInfoPopover = null;
            },
            (under, closingEvent) => {
                const btn = this._eventButtonAt(under);
                if (!btn)
                    return;
                // Re-clicking the same row that was already open is a
                // toggle: leave it closed rather than reopening it.
                if (this._sameEvent(btn._litsycalEvent, closingEvent))
                    return;
                this._openEventInfoPopover(btn, btn._litsycalEvent);
            },
            this._settings.get_int('font-size')
        );
    }

    // Identifies one specific event occurrence the same way delete/edit
    // already do elsewhere (uid + clientUid + recurrenceId) — title/date
    // aren't unique enough (two events can share a title; a recurring
    // series' own uid repeats across its occurrences, recurrenceId is what
    // tells those apart).
    _sameEvent(a, b) {
        return !!a && !!b && a.uid === b.uid && a.clientUid === b.clientUid &&
            (a.recurrenceId ?? null) === (b.recurrenceId ?? null);
    }

    // Walks up from `actor` (whatever the popover's backdrop found under an
    // outside click) looking for the agenda-row button it belongs to — a
    // click can land on a child of evtBtn (its title label, its time row,
    // …) rather than evtBtn itself, so this can't just check `actor`
    // directly. Returns null for a click on empty space or anything that
    // isn't an agenda row (in which case the popover just stays closed).
    _eventButtonAt(actor) {
        for (let a = actor; a; a = a.get_parent()) {
            if (a._litsycalEvent)
                return a;
        }

        return null;
    }

    // ── Event context menu (right-click on an agenda row) ───────────────────────
    //
    // Same {label, icon, action} SettingsMenuPanel used for the panel icon/gear
    // menu. Open Calendar/Copy/Delete… mirror itsycal's own agenda context-menu
    // trio (menuNeedsUpdate in itsycal's AgendaViewController.m); Edit… is a
    // litsycal-only addition — itsycal has no in-app event editing at all — since
    // clicking a row now opens the read-only info popover instead of this dialog.

    _openEventContextMenu(anchorActor, ev) {
        this._eventContextMenu?.close();
        this._eventInfoPopover?.close();
        this._eventContextMenu = new SettingsMenuPanel(anchorActor, [
            {
                label: _('Edit…'), icon: 'document-edit-symbolic',
                action: () => this._openEventDialog(ev),
            },
            null,
            {
                label: _('Open Calendar'), icon: 'x-office-calendar-symbolic',
                action: () => this._openCalendarAppAtEventDate(ev),
            },
            {
                label: _('Copy'), icon: 'edit-copy-symbolic',
                action: () => this._copyEventToClipboard(ev),
            },
            {
                label: _('Delete…'), icon: 'edit-delete-symbolic',
                action: () => this._deleteEventFromAgenda(ev),
            },
        ]);
    }

    // itsycal's showCalendarAppAtDate navigates the system calendar app
    // straight to the clicked event's date rather than just launching it.
    // gnome-calendar's own --date flag is the closest GNOME equivalent to
    // that AppleScript/URL-scheme navigation; fall back to a plain launch
    // (same as the footer's Open Calendar button) if that's not the
    // installed calendar app.
    //
    // gnome-calendar parses --date with evolution-data-server's
    // e_time_parse_date_and_time(), which tries strptime("%x", ...) against
    // the locale's own short-date order (MM/DD/YYYY for en_US, DD/MM/YYYY
    // elsewhere, ...) — it does NOT accept the ISO "YYYY-MM-DD" ev.date is
    // stored in. Reformat with GLib's own "%x" so it matches whatever order
    // strptime("%x") expects on this system; passing ev.date as-is silently
    // fails (gnome-calendar logs "Date ... is invalid" and opens on today).
    _openCalendarAppAtEventDate(ev) {
        try {
            const [y, m, d] = ev.date.split('-').map(Number);
            const dateArg = GLib.DateTime.new_local(y, m, d, 0, 0, 0).format('%x');
            Gio.Subprocess.new(['gnome-calendar', '--date', dateArg], Gio.SubprocessFlags.NONE);
        } catch {
            const app = Shell.AppSystem.get_default().lookup_app('org.gnome.Calendar.desktop');
            if (app)
                app.activate();
        }
    }

    // Mirrors itsycal's copyEventToPasteboard: title, then date/time, then
    // location (when present), one per line.
    _copyEventToClipboard(ev) {
        const lines = [ev.title, formatEventWhen(ev)];
        if (ev.location)
            lines.push(ev.location);
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, lines.join('\n'));
    }

    // Same confirm-then-delete flow as the event edit panel's own Delete
    // button (see eventDialog.js confirmDeleteEvent), just reached directly
    // from the agenda row without opening the panel first — mirroring
    // itsycal's deleteEvent, which is wired to both the popover's delete
    // button and this context-menu item alike.
    _deleteEventFromAgenda(ev) {
        confirmDeleteEvent(this._calManager, ev, err => {
            if (err)
                Main.notifyError(_('Litsycal'), err.message);
        });
    }

    // ── Navigation ────────────────────────────────────────────────────────────

    _shiftMonth(delta) {
        this._month += delta;
        if (this._month < 1)  {
            this._month = 12;
            this._year--;
        }
        if (this._month > 12) {
            this._month = 1;
            this._year++;
        }
        this._updateMonthLabel();
        this._buildGrid();
        this._calManager?.fetchMonth(this._year, this._month);
    }

    _goToday() {
        const now = GLib.DateTime.new_now_local();
        this._year = now.get_year();
        this._month = now.get_month();
        this._today = now;
        this._selected = now;
        this._updateMonthLabel();
        this._buildGrid();
        this._buildAgenda();
        this._calManager?.fetchMonth(this._year, this._month);
    }

    // Used by the settings menu's "Go to date" dialog.
    _goToDate(dt) {
        this._year = dt.get_year();
        this._month = dt.get_month();
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
    //
    // The rest of the bindings below round out Itsycal's own shortcut list
    // (mowglii.com/itsycal/help) that isn't day/week/month/year navigation:
    // #, P, W, . carry straight over unmodified. Itsycal's plain ⌃J/⌃K
    // (add/remove calendar weeks) also carries straight over — but its
    // Command-tier bindings (⌘, ⌘O ⌘N ⌘Q ⌥⌘R ⇧⌘T) have no Command key on
    // Linux, so they're remapped to Ctrl, the nearest GNOME equivalent; ⌘J
    // (open first active meeting) picks up an extra Shift on top of that
    // (→ Ctrl+Shift+J) purely to stay clear of the already-taken Ctrl+J.

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
        while (nm < 1)  {
            nm += 12;
            ny--;
        }
        while (nm > 12) {
            nm -= 12;
            ny++;
        }
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
    // ctrl/alt mirror `shift`: state of the two other modifiers used below.
    handleKeyPress(keyval, shift, ctrl, alt) {
        switch (keyval) {
        case Clutter.KEY_Left:
        case Clutter.KEY_h:
        case Clutter.KEY_H:
            if (shift)
                this._moveSelectionByMonths(-1);
            else
                this._moveSelectionByDays(-1);
            return true;
        case Clutter.KEY_Right:
        case Clutter.KEY_l:
        case Clutter.KEY_L:
            if (shift)
                this._moveSelectionByMonths(1);
            else
                this._moveSelectionByDays(1);
            return true;
        case Clutter.KEY_Up:
        case Clutter.KEY_k:
        case Clutter.KEY_K:
            // ⌃K (no Shift): remove one calendar week (⌃J's counterpart below).
            if (ctrl) {
                this._adjustExtraWeekRows(-1);
                return true;
            }
            if (shift)
                this._moveSelectionByYears(1);
            else
                this._moveSelectionByDays(-7);
            return true;
        case Clutter.KEY_Down:
        case Clutter.KEY_j:
        case Clutter.KEY_J:
            // ⌃⇧J: open the first active virtual meeting in the agenda
            // (Itsycal's ⌘J — bumped onto Shift so it doesn't collide
            // with plain ⌃J just below). ⌃J (no Shift): add one calendar week.
            if (ctrl && shift) {
                this._joinFirstMeeting();
                return true;
            }
            if (ctrl) {
                this._adjustExtraWeekRows(1);
                return true;
            }
            if (shift)
                this._moveSelectionByYears(-1);
            else
                this._moveSelectionByDays(7);
            return true;
        case Clutter.KEY_space:
            this._goToday();
            return true;
        case Clutter.KEY_numbersign:
            // Itsycal's #: today-offset and day-of-year, flashed in the
            // month label for a couple seconds.
            this._showDayInfo();
            return true;
        case Clutter.KEY_p:
        case Clutter.KEY_P:
            this._onPinToggle?.(!this._pinBtn.get_checked());
            return true;
        case Clutter.KEY_w:
        case Clutter.KEY_W:
            this._settings.set_boolean('show-week-numbers', !this._showWeekNumbers);
            return true;
        case Clutter.KEY_period:
            this._settings.set_boolean('show-event-location', !this._showEventLocation);
            return true;
        case Clutter.KEY_comma: // Ctrl+, (Itsycal's ⌘,): open Settings
            if (ctrl) {
                this._openSettingsMenu?.(this._gearBtn);
                return true;
            }
            return false;
        case Clutter.KEY_o:
        case Clutter.KEY_O: // Ctrl+O (Itsycal's ⌘O): open the default calendar app
            if (ctrl) {
                this._openCalendar?.();
                return true;
            }
            return false;
        case Clutter.KEY_f:
        case Clutter.KEY_F: // Ctrl+F: search events (not one of Itsycal's own shortcuts)
            if (ctrl) {
                this._openSearch();
                return true;
            }
            return false;
        case Clutter.KEY_n:
        case Clutter.KEY_N:
            // Ctrl+Shift+N: quick-add a one-liner. Checked before plain
            // Ctrl+N below since Shift+N produces KEY_N here too — same
            // ctrl-then-ctrl+shift ordering as Ctrl+J/Ctrl+Shift+J above.
            // Ctrl+N alone (Itsycal's ⌘N): create a new event via the full
            // form, unchanged.
            if (ctrl && shift) {
                this._openQuickAdd();
                return true;
            }
            if (ctrl) {
                this._openCreateDialog();
                return true;
            }
            return false;
        case Clutter.KEY_T: // Ctrl+Shift+T (Itsycal's ⇧⌘T): go to date
            if (ctrl && shift) {
                this._openGoToDate?.(this._gearBtn);
                return true;
            }
            return false;
        case Clutter.KEY_r: // Ctrl+Alt+R (Itsycal's ⌥⌘R): refresh events
            if (ctrl && alt) {
                this._calManager?.refreshFromServer();
                this._calManager?.fetchMonth(this._year, this._month);
                return true;
            }
            return false;
        case Clutter.KEY_q:
        case Clutter.KEY_Q: // Ctrl+Q (Itsycal's ⌘Q): quit Litsycal
            if (ctrl) {
                this._quit?.();
                return true;
            }
            return false;
        default:
            return false;
        }
    }

    // Adjusts the persisted extra-week-rows count (bound [0, MAX_EXTRA_WEEK_ROWS]),
    // same setting the resize handle below the grid drags. The changed::
    // listener above rebuilds the grid once this is written.
    _adjustExtraWeekRows(delta) {
        const wanted = Math.min(MAX_EXTRA_WEEK_ROWS, Math.max(0, this._extraWeekRows + delta));
        if (wanted !== this._extraWeekRows)
            this._settings.set_int('extra-week-rows', wanted);
    }

    // Clicks the first "join meeting" button in the current agenda, in
    // display order (mirrors Itsycal's clickFirstActiveZoomButton). Does
    // nothing if no event in the agenda has an active join button right now.
    _joinFirstMeeting() {
        this._joinButtons?.[0]?.emit('clicked');
    }

    // Mirrors Itsycal's showDateInfo: briefly swaps the month label for the
    // selected day's offset from today and its ordinal day-of-year, e.g.
    // "+5 ∕ 253", then restores the plain month label after a couple seconds.
    _showDayInfo() {
        if (this._dayInfoTimeoutId) {
            GLib.source_remove(this._dayInfoTimeoutId);
            this._dayInfoTimeoutId = null;
        }

        const diff = daysBetween(this._today, this._selected);
        const sign = diff >= 0 ? '+' : '−';
        this._monthLbl.set_text(`${sign}${Math.abs(diff)} ∕ ${this._selected.get_day_of_year()}`);

        this._dayInfoTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
            this._dayInfoTimeoutId = null;
            this._updateMonthLabel();
            return GLib.SOURCE_REMOVE;
        });
    }
});
