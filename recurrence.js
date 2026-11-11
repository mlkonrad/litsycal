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
//
// Repeating reminders (VTODO) aren't expanded: like Evolution and Itsycal,
// a reminder shows at its current DUE only, and completing it moves that
// DUE on to the next occurrence (see applyTaskCompletion).

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

// Plenty for a daily series started decades ago; a guard, not a limit any
// real reminder reaches.
const MAX_TASK_ITERATIONS = 100000;

/**
 * The occurrence a repeating reminder moves to when it's completed: the
 * first one after its current start (DTSTART, or DUE without one), skipping
 * EXDATEs. DUE keeps its distance from DTSTART. A COUNT in the rule shrinks
 * by the occurrences passed over, since the series restarts from the new
 * start. Computed with libical's RecurIterator alone: tasks aren't expanded
 * into instances like events are, and this needs no ECal or D-Bus call.
 *
 * @param {object} ICalGLib the libical typelib, passed in (see header)
 * @param {ICalGLib.Component} ic the VTODO
 * @returns {{dtstart: ICalGLib.Time|null, due: ICalGLib.Time, count: number|null}|null}
 *   the next start/due and new COUNT, or null when the series has ended or
 *   the task doesn't repeat
 */
export function nextTaskOccurrence(ICalGLib, ic) {
    const rruleProp = ic.get_first_property(ICalGLib.PropertyKind.RRULE_PROPERTY);
    const dueProp   = ic.get_first_property(ICalGLib.PropertyKind.DUE_PROPERTY);
    if (!rruleProp || !dueProp)
        return null;
    const due = dueProp.get_due();
    const dtstartProp = ic.get_first_property(ICalGLib.PropertyKind.DTSTART_PROPERTY);
    const dtstart = dtstartProp?.get_dtstart() ?? null;
    const seed = dtstart ?? due;

    const exdates = new Set();
    let ex = ic.get_first_property(ICalGLib.PropertyKind.EXDATE_PROPERTY);
    while (ex) {
        exdates.add(ex.get_exdate().as_ical_string());
        ex = ic.get_next_property(ICalGLib.PropertyKind.EXDATE_PROPERTY);
    }

    const rule = rruleProp.get_rrule();
    const it = ICalGLib.RecurIterator.new(rule, seed);
    for (let passed = 0; passed < MAX_TASK_ITERATIONS; passed++) {
        const occ = it.next();
        if (!occ || occ.is_null_time())
            return null;
        if (occ.compare(seed) <= 0 || exdates.has(occ.as_ical_string()))
            continue;
        let nextDue = occ;
        if (dtstart) {
            const seconds = due.subtract(dtstart).as_int();
            nextDue = occ.clone();
            if (nextDue.is_date())
                nextDue.adjust(Math.round(seconds / 86400), 0, 0, 0);
            else
                nextDue.adjust(0, 0, 0, seconds);
        }
        const count = rule.get_count();
        return {dtstart: dtstart ? occ : null, due: nextDue, count: count > 0 ? count - passed : null};
    }
    return null;
}

function replaceProperty(ic, kind, prop) {
    let old = ic.get_first_property(kind);
    while (old) {
        ic.remove_property(old);
        old = ic.get_first_property(kind);
    }
    if (prop)
        ic.add_property(prop);
}

/**
 * Marks a reminder done or not done, in place. Done sets STATUS COMPLETED,
 * PERCENT-COMPLETE 100 and COMPLETED; not done reverses all three. A
 * repeating reminder isn't completed at all: it moves on to its next
 * occurrence (see nextTaskOccurrence) and stays to do, as in Evolution and
 * Itsycal. Only once its series has ended is it completed for real.
 *
 * @param {object} ICalGLib the libical typelib, passed in (see header)
 * @param {ICalGLib.Component} ic the VTODO
 * @param {boolean} done whether the reminder is being completed
 * @param {ICalGLib.Time} now the completion time, in UTC
 */
export function applyTaskCompletion(ICalGLib, ic, done, now) {
    const next = done ? nextTaskOccurrence(ICalGLib, ic) : null;
    if (next) {
        ic.get_first_property(ICalGLib.PropertyKind.DUE_PROPERTY).set_due(next.due);
        if (next.dtstart)
            ic.get_first_property(ICalGLib.PropertyKind.DTSTART_PROPERTY).set_dtstart(next.dtstart);
        if (next.count !== null) {
            const rruleProp = ic.get_first_property(ICalGLib.PropertyKind.RRULE_PROPERTY);
            const rule = rruleProp.get_rrule();
            rule.set_count(next.count);
            rruleProp.set_rrule(rule);
        }
        done = false;
    }
    ic.set_status(done ? ICalGLib.PropertyStatus.COMPLETED : ICalGLib.PropertyStatus.NEEDSACTION);
    replaceProperty(ic, ICalGLib.PropertyKind.PERCENTCOMPLETE_PROPERTY,
        ICalGLib.Property.new_percentcomplete(done ? 100 : 0));
    replaceProperty(ic, ICalGLib.PropertyKind.COMPLETED_PROPERTY,
        done ? ICalGLib.Property.new_completed(now) : null);
}
