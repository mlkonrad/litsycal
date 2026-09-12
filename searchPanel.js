import St      from 'gi://St';
import GLib    from 'gi://GLib';
import Pango   from 'gi://Pango';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {capitalize} from './helpers.js';
import {FloatingModalPanel} from './floatingPanel.js';

const DEBOUNCE_MS   = 250;
const MAX_RESULTS   = 50;

// Compact "Sep 12" / "Sep 12, 13:00" — formatEventWhen in helpers.js (full
// weekday + month + day + year) reads fine for one event in a popover, but
// is too long for a scrolling list of many search-result rows. The year is
// only added for a date outside the current one — search spans roughly
// ±1 year, wide enough that e.g. a yearly-recurring holiday can genuinely
// have two distinct same-day-and-month results a year apart, which read as
// unexplained duplicates without it.
function shortWhen(ev) {
    const [y, m, d] = ev.date.split('-').map(Number);
    const thisYear = GLib.DateTime.new_now_local().get_year();
    const pattern  = y === thisYear ? '%b %-d' : '%b %-d, %Y';
    const day = capitalize(GLib.DateTime.new_local(y, m, d, 0, 0, 0).format(pattern));
    if (ev.allDay || !ev.time)
        return day;
    return `${day}, ${ev.time.split(' - ')[0]}`;
}

// ── Event search (Ctrl+F) ────────────────────────────────────────────────────
//
// Floating panel — same Main.pushModal/Escape/click-outside pattern as
// GoToDatePanel/QuickAddPanel/SettingsMenuPanel (see SettingsMenuPanel's own
// comment for why a competing grab is needed here too, since this can open
// while the calendar dropdown still holds its own). Debounces typing before
// calling CalendarManager.searchEvents(), which queries every connected
// calendar directly rather than filtering whatever month happens to be
// cached for the grid — see that method's own comment for why.
export class SearchPanel extends FloatingModalPanel {
    // onClose is called exactly once, with the selected event on a result
    // click/Enter, or null on cancel (Escape / click outside).
    constructor(anchorActor, calManager, onClose) {
        super('litsycal-search-panel', 340, 140, anchorActor, onClose);
        this._calManager  = calManager;
        this._debounceId  = null;
        this._lastResults = [];
        // Guards the UI against a slow query's results landing after a
        // newer one already has — CalendarManager.searchEvents() has its
        // own such guard for query results, but debounced calls here race
        // independently of that, so this needs its own.
        this._searchGen = 0;
    }

    _build() {
        const box = this._box;

        box.add_child(new St.Label({text: _('Search events'), style_class: 'litsycal-goto-title'}));

        this._entry = new St.Entry({
            style_class: 'litsycal-panel-text-entry',
            hint_text: _('Type to search…'),
            x_expand: true,
            can_focus: true,
        });
        this._entry.clutter_text.connect('text-changed', () => this._onTextChanged());
        this._entry.clutter_text.connect('activate', () => {
            if (this._lastResults.length > 0)
                this._finish(this._lastResults[0]);
        });
        box.add_child(this._entry);

        this._resultsBox = new St.BoxLayout({
            vertical: true, x_expand: true, style_class: 'litsycal-search-results',
        });
        this._resultsScroll = new St.ScrollView({
            style_class: 'litsycal-search-results-scroll', x_expand: true,
        });
        this._resultsScroll.set_child(this._resultsBox);
        box.add_child(this._resultsScroll);

        this._emptyLbl = new St.Label({
            text: _('No matching events'), style_class: 'litsycal-search-empty', visible: false,
        });
        box.add_child(this._emptyLbl);
    }

    _onTextChanged() {
        if (this._debounceId) {
            GLib.source_remove(this._debounceId);
            this._debounceId = null;
        }
        if (!this._entry.get_text().trim()) {
            this._searchGen++; // invalidate any in-flight search
            this._showResults([]);
            return;
        }
        this._debounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DEBOUNCE_MS, () => {
            this._debounceId = null;
            this._runSearch();
            return GLib.SOURCE_REMOVE;
        });
    }

    _runSearch() {
        const gen   = ++this._searchGen;
        const query = this._entry.get_text();
        this._calManager.searchEvents(query, results => {
            if (gen !== this._searchGen || !this._box)
                return; // superseded by a newer search, or panel already closed
            this._showResults(results);
        });
    }

    _showResults(results) {
        this._lastResults = results;
        this._resultsBox.destroy_all_children();
        this._emptyLbl.visible = results.length === 0 && this._entry.get_text().trim().length > 0;

        for (const ev of results.slice(0, MAX_RESULTS)) {
            const btn = new St.Button({
                style_class: 'litsycal-search-result', x_expand: true, can_focus: true,
            });
            const row = new St.BoxLayout({vertical: true, x_expand: true});

            const titleRow = new St.BoxLayout({style_class: 'litsycal-panel-icon-row', x_expand: true});
            const dot = new St.Widget({style_class: 'litsycal-panel-dot'});
            dot.style = `background-color: ${ev.color};`;
            titleRow.add_child(dot);
            const titleLbl = new St.Label({
                text: ev.title || _('(No title)'),
                style_class: 'litsycal-search-result-title', x_expand: true,
            });
            titleLbl.clutter_text.set_line_wrap(false);
            titleLbl.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
            titleRow.add_child(titleLbl);
            row.add_child(titleRow);

            row.add_child(new St.Label({text: shortWhen(ev), style_class: 'litsycal-search-result-date'}));

            btn.set_child(row);
            btn.connect('clicked', () => this._finish(ev));
            this._resultsBox.add_child(btn);
        }
    }

    _onFinish() {
        if (this._debounceId) {
            GLib.source_remove(this._debounceId);
            this._debounceId = null;
        }
        this._searchGen++; // invalidate any in-flight search
    }
}
