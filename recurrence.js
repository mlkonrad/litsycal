// Recurring-event expansion, split out of calendarManager.js so it can be
// unit-tested with plain `gjs` (tests/test-recurrence.js). Like ical.js it
// imports only GLib: ECal and ICalGLib aren't guaranteed to be installed,
// so CalendarManager passes in the typelibs it loaded lazily, and the
// tests pass their own imports.
//
// EDS's get_object_list_as_comps() returns a recurring series as one
// master component, dated at its first DTSTART. Each occurrence that falls
// in the fetched range is generated here, in-process, with
// ECal.recur_generate_instances_sync() - no extra D-Bus round trips. An
// occurrence that was edited on its own arrives as a separate "detached"
// component carrying RECURRENCE-ID; it is shown as its own event, and the
// generated occurrence it replaces is skipped.

import GLib from 'gi://GLib';

// A guard against a pathological rule (FREQ=MINUTELY, say) flooding the
// agenda: far more than any real series has within the fetched range.
const MAX_INSTANCES_PER_SERIES = 1000;

/**
 * Resolves a TZID the way EDS itself would without a D-Bus lookup: libical's
 * built-in IANA zones first, then any VTIMEZONE embedded in the component or
 * the VCALENDAR around it.
 *
 * @param {object} ICalGLib the libical typelib, passed in (see header)
 * @param {ICalGLib.Component} ic the component whose times are resolved
 * @returns {Function} tzid -> ICalGLib.Timezone, or null when unknown
 */
export function makeTzResolver(ICalGLib, ic) {
    return tzid => {
        if (!tzid)
            return null;
        const builtin = ICalGLib.Timezone.get_builtin_timezone(tzid);
        if (builtin)
            return builtin;
        for (let c = ic; c; c = c.get_parent()) {
            const tz = c.get_timezone(tzid);
            if (tz)
                return tz;
        }
        return null;
    };
}

/**
 * A comparison key for one occurrence's start: the instant in UTC when the
 * time has a zone, otherwise its plain digits (dates and floating times).
 * A detached occurrence's RECURRENCE-ID and the generated occurrence it
 * replaces may be written in different zones, so their raw digits alone
 * can't be compared.
 *
 * @param {object} ICalGLib the libical typelib, passed in (see header)
 * @param {ICalGLib.Time} time the occurrence's start
 * @param {string|null} tzid the TZID parameter the time was written with
 * @param {Function} resolveTz see makeTzResolver
 * @returns {string} the key
 */
export function instantKey(ICalGLib, time, tzid, resolveTz) {
    if (time.is_date() || time.is_utc())
        return time.as_ical_string();
    const t = time.clone();
    if (!t.get_timezone()) {
        const tz = resolveTz(tzid);
        if (!tz)
            return t.as_ical_string();
        t.set_timezone(tz);
    }
    return t.convert_to_zone(ICalGLib.Timezone.get_utc_timezone()).as_ical_string();
}

/**
 * @param {object} ICalGLib the libical typelib, passed in (see header)
 * @param {ICalGLib.Component} ic a VEVENT
 * @returns {boolean} whether it is a detached occurrence (has RECURRENCE-ID)
 */
export function isDetached(ICalGLib, ic) {
    return !!ic.get_first_property(ICalGLib.PropertyKind.RECURRENCEID_PROPERTY);
}

/**
 * Collects, per series uid, the keys (see instantKey) of every occurrence a
 * detached component replaces.
 *
 * @param {object} ICalGLib the libical typelib, passed in (see header)
 * @param {ICalGLib.Component[]} ics the fetched VEVENTs, masters included
 * @returns {Map<string, Set<string>>} uid -> replaced occurrence keys
 */
export function collectOverrideKeys(ICalGLib, ics) {
    const byUid = new Map();
    for (const ic of ics) {
        const prop = ic.get_first_property(ICalGLib.PropertyKind.RECURRENCEID_PROPERTY);
        if (!prop)
            continue;
        const key = instantKey(ICalGLib, prop.get_recurrenceid(),
            prop.get_parameter_as_string('TZID'), makeTzResolver(ICalGLib, ic));
        const uid = ic.get_uid();
        if (!byUid.has(uid))
            byUid.set(uid, new Set());
        byUid.get(uid).add(key);
    }
    return byUid;
}

/**
 * Generates the occurrences of a recurring master within [rangeStart,
 * rangeEnd), minus the ones a detached component replaces.
 *
 * Each result's `rid` is the occurrence's start digits in the master's own
 * zone, as libical writes them (as_ical_string() before any conversion to
 * local time). That is the form EDS's remove_object() matches a
 * RECURRENCE-ID against for "this" and "this and future" deletes; the
 * viewer's local digits would name an occurrence that doesn't exist
 * whenever the master's zone differs from the local one.
 *
 * @param {object} ECal the ECal typelib, passed in (see header)
 * @param {object} ICalGLib the libical typelib, passed in (see header)
 * @param {ICalGLib.Component} ic the master VEVENT
 * @param {ICalGLib.Time} rangeStart inclusive range start
 * @param {ICalGLib.Time} rangeEnd exclusive range end
 * @param {ICalGLib.Timezone|null} localTz zone for floating times
 * @param {Set<string>} [skipKeys] see collectOverrideKeys
 * @returns {{start: ICalGLib.Time, end: ICalGLib.Time, rid: string}[]}
 *   occurrence start/end, still in the master's zone
 */
export function expandRecurring(ECal, ICalGLib, ic, rangeStart, rangeEnd, localTz, skipKeys = new Set()) {
    const resolveTz = makeTzResolver(ICalGLib, ic);
    const instances = [];
    ECal.recur_generate_instances_sync(ic, rangeStart, rangeEnd, (_ic, start, end) => {
        if (!skipKeys.has(instantKey(ICalGLib, start, null, resolveTz)))
            instances.push({start, end, rid: start.as_ical_string()});
        return instances.length < MAX_INSTANCES_PER_SERIES;
    }, resolveTz, localTz, null);
    return instances;
}

const dayNumber = ds => {
    const [y, m, d] = ds.split('-').map(Number);
    return Math.round(GLib.DateTime.new_utc(y, m, d, 0, 0, 0).to_unix() / 86400);
};

const fromDayNumber = n => {
    const dt = GLib.DateTime.new_from_unix_utc(n * 86400);
    const pad = v => String(v).padStart(2, '0');
    return `${dt.get_year()}-${pad(dt.get_month())}-${pad(dt.get_day_of_month())}`;
};

/**
 * Edits made from one occurrence still apply to the whole series (see
 * CalendarManager.updateEvent), and the edit form shows that occurrence's
 * dates. Saving them unchanged as the series' DTSTART would move the whole
 * series to start at that occurrence, dropping every earlier one. This
 * moves the form's dates back by the occurrence's distance from the series
 * start, so only a date the user actually changed shifts the series.
 *
 * @param {object} fields the edit form's fields (see buildICal)
 * @param {string} occurrenceDate the occurrence's date, 'YYYY-MM-DD'
 * @param {string|null|undefined} seriesDate the series' first date, or
 *   nothing when the event isn't a generated occurrence
 * @returns {object} fields, with date/endDate shifted when needed
 */
export function shiftFieldsToSeries(fields, occurrenceDate, seriesDate) {
    if (!seriesDate || seriesDate === occurrenceDate)
        return fields;
    const delta = dayNumber(seriesDate) - dayNumber(occurrenceDate);
    const shift = ds => ds ? fromDayNumber(dayNumber(ds) + delta) : ds;
    return {...fields, date: shift(fields.date), endDate: shift(fields.endDate)};
}
