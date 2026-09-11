import GLib from 'gi://GLib';
import Gio  from 'gi://Gio';

import {gettext as _, ngettext} from 'resource:///org/gnome/shell/extensions/extension.js';

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * @param {string} s
 */
export function capitalize(s) {
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

// Format datetime pattern but capitalize locale word tokens (%a %b %A %B)
/**
 * @param {GLib.DateTime} dt
 * @param {string} pattern
 */
export function formatPattern(dt, pattern) {
    let p = pattern;
    for (const token of ['%A', '%B', '%a', '%b']) {
        const val = dt.format(token);
        if (val)
            p = p.split(token).join(capitalize(val));
    }
    return dt.format(p) ?? '';
}

/**
 * @returns {string[]}
 */
export function localeDayAbbrs() {
    return Array.from({length: 7}, (unused, i) =>
        capitalize(GLib.DateTime.new_local(2025, 1, 6 + i, 0, 0, 0).format('%a'))
    );
}

// First letter of each locale weekday abbreviation, e.g. M T W T F S S
// (S T Q Q S S D for pt_BR) — matches the single-char labels already used
// for the highlight-days picker in prefs.js.
/**
 * @returns {string[]}
 */
export function localeDayAbbrsShort() {
    return localeDayAbbrs().map(s => s.charAt(0));
}

export const DAY_COL = {mo: 0, tu: 1, we: 2, th: 3, fr: 4, sa: 5, su: 6};

// calendar-size index -> style class (index 2 "Medium" is the base CSS, no class needed).
export const SIZE_CLASSES = ['litsycal-size-sm', 'litsycal-size-sm-plus', null, 'litsycal-size-md-plus', 'litsycal-size-lg'];
export const SIZE_MIN_WIDTHS = [220, 238, 255, 285, 315]; // must match the widths above

// font-size index -> style class (index 1 "Medium" is the base CSS, no class needed).
export const FONT_SIZE_CLASSES = ['litsycal-font-sm', null, 'litsycal-font-lg'];
// Must match schemas/…gschema.xml's extra-week-rows <range max="…">.
export const MAX_EXTRA_WEEK_ROWS = 5;
// Outline top inset per calendar-size — see OutlinePainter.paint(). The line
// should sit close under the weekday-name row and clear of the day numbers
// (Itsycal draws it flush with the cell's top edge, inset 0) — Small's own
// cell is so short that even a couple of extra px reads as "line hugging
// the numbers, far from the weekday row" instead.
export const OUTLINE_TOP_INSET = [0, 2, 4, 4, 4];

// ── Accent colour ─────────────────────────────────────────────────────────────

export const ACCENT_MAP = {
    blue: '#3584e4', teal: '#2190a4', green: '#3a944a', yellow: '#c88800',
    orange: '#e66100', red: '#e62d42', pink: '#d56199', purple: '#9141ac', slate: '#6f8396',
};

/**
 * @returns {string}
 */
export function readAccent() {
    try {
        const s = new Gio.Settings({schema: 'org.gnome.desktop.interface'});
        return ACCENT_MAP[s.get_string('accent-color')] ?? ACCENT_MAP.blue;
    } catch {
        return ACCENT_MAP.blue;
    }
}

/**
 * @param {string} hex
 * @param {number} a
 */
export function accentAlpha(hex, a) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${a})`;
}

// ── Date helpers ──────────────────────────────────────────────────────────────

/**
 * @param {GLib.DateTime} dt
 */
export function dateStr(dt) {
    return `${dt.get_year()}-${String(dt.get_month()).padStart(2, '0')}-${String(dt.get_day_of_month()).padStart(2, '0')}`;
}

/**
 * @param {number} year
 * @param {number} month
 */
export function daysInMonth(year, month) {
    const nm = month === 12 ? 1 : month + 1, ny = month === 12 ? year + 1 : year;
    return GLib.DateTime.new_local(ny, nm, 1, 0, 0, 0).add_days(-1).get_day_of_month();
}

// Whole calendar days between two GLib.DateTime instants (b - a), independent
// of any DST shift that falls between them: rounding to the nearest day
// absorbs the up-to-±1h wall-clock drift a single transition introduces.
/**
 * @param {GLib.DateTime} a
 * @param {GLib.DateTime} b
 */
export function daysBetween(a, b) {
    return Math.round(b.difference(a) / (24 * 60 * 60 * 1000000));
}

/**
 * @param {number} year
 * @param {number} month
 */
export function prevMonthOf(year, month) {
    return month === 1 ? [year - 1, 12] : [year, month - 1];
}

// Buddhist Era year = Gregorian + 543. Months/days/leap years are identical
// between the two calendars, so this only ever touches the printed year —
// every date computation elsewhere in this file stays Gregorian.
const BUDDHIST_ERA_OFFSET = 543;

/**
 * @param {number} gregorianYear
 * @param {string} calendarSystem
 */
export function displayYear(gregorianYear, calendarSystem) {
    return calendarSystem === 'buddhist' ? gregorianYear + BUDDHIST_ERA_OFFSET : gregorianYear;
}

// ISO 8601 week number: shift to the Thursday of the same week (whose year
// determines the ISO week-year at year boundaries), then week = ceil(day-of-year / 7).
/**
 * @param {GLib.DateTime} dt
 */
export function isoWeekNumber(dt) {
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
/**
 * @param {object} ev
 */
export function findMeetingUrl(ev) {
    for (const text of [ev.url, ev.location, ev.notes]) {
        if (!text)
            continue;
        const urls = text.match(/https?:\/\/[^\s<>"']+/gi) ?? [];
        for (const url of urls) {
            if (MEETING_PATTERNS.some(re => re.test(url)))
                return url;
        }
    }
    return null;
}

/**
 * @param {object} ev
 */
function eventTimeRange(ev) {
    if (ev.allDay || !ev.time)
        return null;
    const [y, m, d] = ev.date.split('-').map(Number);
    const [startStr, endStr] = ev.time.split(' - ');
    const [sh, sm] = startStr.split(':').map(Number);
    const start = GLib.DateTime.new_local(y, m, d, sh, sm, 0);
    let end;
    if (endStr) {
        const [eh, em] = endStr.trim().split(':').map(Number);
        end = GLib.DateTime.new_local(y, m, d, eh, em, 0);
        if (end.compare(start) < 0)
            end = end.add_days(1); // crosses midnight
    } else {
        end = start.add_hours(1);
    }
    return {start, end};
}

// Mirrors Itsycal: the join button appears from 15 minutes before an event
// starts through its end. All-day events (and events with unparsable times)
// are treated as joinable any time, since there's no meaningful window.
/**
 * @param {object} ev
 */
export function meetingIsJoinable(ev) {
    const range = eventTimeRange(ev);
    if (!range)
        return true;
    const now = GLib.DateTime.new_now_local();
    return now.compare(range.start.add_minutes(-15)) >= 0 && now.compare(range.end) <= 0;
}

// Human date(+time) string for an event, e.g. "Monday, September 7, 2026,
// 23:00 - 00:00" (or a date range for multi-day events, or "All day" with no
// time). Shared by the agenda row's Copy action and the event info popover.
/**
 * @param {object} ev
 */
export function formatEventWhen(ev) {
    const [y, m, d] = ev.date.split('-').map(Number);
    let when = capitalize(GLib.DateTime.new_local(y, m, d, 0, 0, 0).format('%A, %B %-d, %Y'));
    if (ev.endDate && ev.endDate !== ev.date) {
        const [ey, em, ed] = ev.endDate.split('-').map(Number);
        when += ` – ${capitalize(GLib.DateTime.new_local(ey, em, ed, 0, 0, 0).format('%A, %B %-d, %Y'))}`;
    }
    when += `, ${ev.time ?? _('All day')}`;
    return when;
}

// Short recurrence summary for the event info popover, matching the wording
// eventDialog.js's own Repeat dropdown uses for the same presets (see
// REPEAT_PRESETS there) so the two never disagree on phrasing. Recurrences
// outside that simple FREQ/INTERVAL set (stored as {raw}) fall back to a
// generic label rather than trying to describe arbitrary BYDAY/COUNT rules.
/**
 * @param {object} recurrence
 */
export function recurrenceSummary(recurrence) {
    if (!recurrence)
        return null;
    if (recurrence.raw || !recurrence.freq)
        return _('Repeats');
    const interval = recurrence.interval || 1;
    if (interval === 1) {
        return {
            DAILY:   _('Every day'),
            WEEKLY:  _('Every week'),
            MONTHLY: _('Every month'),
            YEARLY:  _('Every year'),
        }[recurrence.freq] ?? _('Repeats');
    }
    const template = {
        DAILY:   ngettext('Every %d day',   'Every %d days',   interval),
        WEEKLY:  ngettext('Every %d week',  'Every %d weeks',  interval),
        MONTHLY: ngettext('Every %d month', 'Every %d months', interval),
        YEARLY:  ngettext('Every %d year',  'Every %d years',  interval),
    }[recurrence.freq];
    return template ? template.replace('%d', String(interval)) : _('Repeats');
}
