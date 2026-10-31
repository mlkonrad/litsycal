// Pure iCal build/parse logic, split out of calendarManager.js so it
// can be unit-tested with plain `gjs` (tests/test-ical.js): this module
// imports only GLib, never Shell-only modules or resources - same
// pattern as quickAddParser.js / timeInput.js. ICalGLib is not imported
// here at all: the libical typelib isn't guaranteed to be installed,
// and a static import would fail at module load on such a system (the
// #10 bug #12 fixed), so the functions that need it take it as a
// parameter from CalendarManager, which loads it lazily. Tests pass
// their own import. CalendarManager delegates to these functions;
// event objects and field objects keep the shapes it has always used.

import GLib from 'gi://GLib';

const pad = n => String(n).padStart(2, '0');

/**
 * @param {object} recurrence parsed recurrence (see parseRecurrence), or null
 * @returns {string[]} the RRULE line, or [] when there is none
 */
export function buildRRuleLine(recurrence) {
    if (!recurrence)
        return [];
    if (recurrence.raw)
        return [`RRULE:${recurrence.raw}`];

    let r = `FREQ=${recurrence.freq}`;
    if (recurrence.interval > 1)
        r += `;INTERVAL=${recurrence.interval}`;
    if (recurrence.until) {
        const [uy, um, ud] = recurrence.until.split('-').map(Number);
        // Re-emit the time-of-day the source UNTIL carried (see
        // parseRecurrence); only an absent untilTime gets the
        // historical end-of-day stamp. An invalid until/untilTime
        // must not reach the wire, and silently substituting a
        // different end would change the rule, so throw instead -
        // consistent with buildICal's 'Invalid date/time', which
        // createEvent/updateEvent surface via onDone.
        const untilTime = recurrence.untilTime ?? '235959Z';
        const [th, tm, ts] = [
            Number(untilTime.slice(0, 2)), Number(untilTime.slice(2, 4)), Number(untilTime.slice(4, 6)),
        ];
        if (![uy, um, ud].every(Number.isInteger) ||
            !/^\d{6}Z?$/.test(untilTime) ||
            !GLib.DateTime.new_utc(uy, um, ud, th, tm, ts))
            throw new Error('Invalid date/time');
        r += `;UNTIL=${uy}${pad(um)}${pad(ud)}T${untilTime}`;
    }
    return [`RRULE:${r}`];
}

/**
 * @param {object} alarm parsed alarm (see parseAlarm), or null
 * @returns {string[]} the VALARM block lines, or [] when there is none
 */
export function buildValarmLines(alarm) {
    if (!alarm)
        return [];
    if (alarm.raw)
        return alarm.raw.flatMap(block => block.split(/\r?\n/).filter(Boolean));

    const min = Math.trunc(alarm.minutesBefore);
    if (!Number.isFinite(min))
        return [];
    // A negative minutesBefore is an alarm *after* the start
    // (parsed from e.g. TRIGGER:PT10M): its duration is positive
    // and unsigned. Decomposing the signed value directly
    // produced invalid output like '-P-1DT-1H-10M', so decompose
    // the magnitude and pick the sign prefix from the original
    // value. Zero/positives unchanged.
    const absMin = Math.abs(min);
    const days  = Math.floor(absMin / 1440);
    const rem   = absMin % 1440;
    const hours = Math.floor(rem / 60);
    const mins  = rem % 60;
    let trigger = 'PT0M';
    if (min > 0)
        trigger = '-P';
    else if (min < 0)
        trigger = 'P';
    if (min !== 0) {
        if (days)
            trigger += `${days}D`;
        if (hours || mins)
            trigger += `T${hours ? `${hours}H` : ''}${mins ? `${mins}M` : ''}`;
    }
    return [
        'BEGIN:VALARM',
        'ACTION:DISPLAY',
        'DESCRIPTION:Reminder',
        `TRIGGER:${trigger}`,
        'END:VALARM',
    ];
}

/**
 * @param {string} uid the event UID
 * @param {object} fields title/date/allDay/hour/minute/endHour/endMinute/
 *   endDate/notes/url/location/recurrence/alarm, as CalendarManager's
 *   createEvent/updateEvent have always taken them
 * @returns {string} a complete VEVENT as iCal text (CRLF line endings)
 */
export function buildICal(uid, fields) {
    const {
        title, date, allDay, hour, minute, endHour, endMinute, endDate,
        notes, url, location, recurrence, alarm,
    } = fields;
    const [y, m, d] = (date ?? '').split('-').map(Number);
    if (![y, m, d].every(Number.isFinite))
        throw new Error('Invalid date');
    const escText = s => s.replace(/\\/g, '\\\\').replace(/\r\n|\r|\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');

    let dtLines;
    if (allDay) {
        // DTEND is exclusive, so it's the day after the last visible
        // day: endDate (when it's past the start) else the start
        // itself. Through GLib so month/year boundaries roll over,
        // in UTC so no DST shift applies.
        const [ly, lm, ld] = (endDate && endDate > date ? endDate : date).split('-').map(Number);
        if (![ly, lm, ld].every(Number.isFinite))
            throw new Error('Invalid date');
        const startDay = GLib.DateTime.new_utc(y, m, d, 0, 0, 0);
        const lastDay  = GLib.DateTime.new_utc(ly, lm, ld, 0, 0, 0);
        if (!startDay || !lastDay)
            throw new Error('Invalid date');
        const next = lastDay.add_days(1);
        if (!next)
            throw new Error('Invalid date');
        dtLines = [
            `DTSTART;VALUE=DATE:${y}${pad(m)}${pad(d)}`,
            `DTEND;VALUE=DATE:${next.get_year()}${pad(next.get_month())}${pad(next.get_day_of_month())}`,
        ];
    } else {
        // Tagged with the system's own timezone rather than left floating:
        // CalendarManager's parse shows/edits times as local wall-clock
        // digits, and a floating DTSTART/DTEND is reinterpreted as *each
        // viewer's own* local time by other clients - silently shifting
        // the instant for anyone not in this machine's timezone. An
        // explicit TZID keeps the instant fixed no matter who views it.
        const tzid = GLib.TimeZone.new_local().get_identifier();
        const [ey, em2, ed2] = (endDate ?? date).split('-').map(Number);
        if (![ey, em2, ed2].every(Number.isFinite))
            throw new Error('Invalid date');
        // Integers only: a fractional hour (9.5) would otherwise be
        // truncated by GLib yet stringified verbatim below ('T9.53000').
        const validTime = (v, max) => Number.isInteger(v) && v >= 0 && v <= max;
        if (!validTime(hour, 23) || !validTime(minute, 59) ||
            !validTime(endHour, 23) || !validTime(endMinute, 59))
            throw new Error('Invalid time');
        if (!GLib.DateTime.new_local(y, m, d, hour, minute, 0) ||
            !GLib.DateTime.new_local(ey, em2, ed2, endHour, endMinute, 0))
            throw new Error('Invalid date or time');
        dtLines = [
            `DTSTART;TZID=${tzid}:${y}${pad(m)}${pad(d)}T${pad(hour)}${pad(minute)}00`,
            `DTEND;TZID=${tzid}:${ey}${pad(em2)}${pad(ed2)}T${pad(endHour)}${pad(endMinute)}00`,
        ];
    }

    return [
        'BEGIN:VEVENT',
        `UID:${uid}`,
        `SUMMARY:${escText(title ?? '')}`,
        ...dtLines,
        ...notes    ? [`DESCRIPTION:${escText(notes)}`] : [],
        ...url      ? [`URL:${url.replace(/[\r\n]+/g, '')}`] : [],
        ...location ? [`LOCATION:${escText(location)}`] : [],
        ...buildRRuleLine(recurrence),
        ...buildValarmLines(alarm),
        'END:VEVENT',
    ].join('\r\n');
}

// Only understands a plain FREQ/INTERVAL/UNTIL rule (what our UI can build).
// Anything else (BYDAY, COUNT, multiple rules, ...) is kept as raw text so
// editing an unrelated field never silently discards it.
/**
 * @param {object} ICalGLib the libical typelib, passed in (see header)
 * @param {ICalGLib.Component} ic the VEVENT's ical component
 * @returns {object|null} {freq, interval, until, untilTime?}, {raw}, or null
 */
export function parseRecurrence(ICalGLib, ic) {
    const prop = ic.get_first_property(ICalGLib.PropertyKind.RRULE_PROPERTY);
    if (!prop)
        return null;
    try {
        const raw   = prop.get_value_as_string();
        const parts = Object.fromEntries(raw.split(';').map(kv => kv.split('=')));
        const isSimple = Object.keys(parts).every(k => ['FREQ', 'INTERVAL', 'UNTIL'].includes(k)) &&
                          ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(parts.FREQ);
        if (!isSimple)
            return {raw};
        // A malformed UNTIL/INTERVAL falls back to {raw}, preserving
        // the original rule untouched instead of re-emitting it
        // corrupted. UNTIL's suffix after T, when present, must be a
        // valid time (/^\d{6}Z?$/, e.g. '100000Z'); 'UNTIL=20240101TX'
        // or 'INTERVAL=2x' are not - parseInt alone would tolerate
        // the latter and silently change the rule.
        if (parts.UNTIL && !/^\d{8}(T\d{6}Z?)?$/.test(parts.UNTIL))
            return {raw};
        // Shape alone is not enough: '20250230' and 'T246000Z' pass
        // the regex above but are not real dates/times. GLib returns
        // null for those (month 13, Feb 30, hour 24, min/sec 60), so
        // reuse it as the semantic check - likewise {raw} below.
        // Note: {raw} is only reachable when the raw RRULE string
        // reaches this parser; via libical's parsed property an
        // unparseable RRULE is already dropped upstream (X-LIC-ERROR).
        if (parts.UNTIL) {
            const [th, tm, ts] = parts.UNTIL.includes('T')
                ? [Number(parts.UNTIL.slice(9, 11)), Number(parts.UNTIL.slice(11, 13)), Number(parts.UNTIL.slice(13, 15))]
                : [0, 0, 0];
            if (!GLib.DateTime.new_utc(
                Number(parts.UNTIL.slice(0, 4)), Number(parts.UNTIL.slice(4, 6)),
                Number(parts.UNTIL.slice(6, 8)), th, tm, ts))
                return {raw};
        }
        let interval = 1;
        if (parts.INTERVAL !== undefined) {
            if (!/^\d+$/.test(parts.INTERVAL))
                return {raw};
            interval = parseInt(parts.INTERVAL, 10);
            if (!Number.isFinite(interval) || interval < 1)
                return {raw};
        }

        const until = parts.UNTIL
            ? `${parts.UNTIL.slice(0, 4)}-${parts.UNTIL.slice(4, 6)}-${parts.UNTIL.slice(6, 8)}`
            : null;
        // Preserve UNTIL's time-of-day suffix (e.g. '100000Z') when
        // the source rule has one: the UI's until picker only edits
        // the date, and buildRRuleLine() re-emits this suffix with
        // whatever date is current then. Date-only UNTILs stay
        // suffix-less and keep the historical end-of-day behaviour
        // there.
        const tIdx = parts.UNTIL?.indexOf('T') ?? -1;
        const untilTime = tIdx >= 0 && parts.UNTIL.slice(tIdx + 1)
            ? parts.UNTIL.slice(tIdx + 1)
            : null;
        const rec = {freq: parts.FREQ, interval, until};
        if (untilTime)
            rec.untilTime = untilTime;
        return rec;
    } catch {
        return {raw: prop.get_value_as_string() ?? ''};
    }
}

function allValarmBlocks(ICalGLib, ic) {
    const blocks = [];
    let v = ic.get_first_component(ICalGLib.ComponentKind.VALARM_COMPONENT);
    while (v) {
        blocks.push(v.as_ical_string().trim());
        v = ic.get_next_component(ICalGLib.ComponentKind.VALARM_COMPONENT);
    }
    return blocks;
}

// Only understands a single DISPLAY alarm with a relative (before-start)
// duration trigger (what our UI can build). Anything else (multiple
// alarms, absolute triggers, EMAIL/AUDIO actions, ...) is kept as raw
// VALARM blocks so editing an unrelated field never silently discards it.
/**
 * @param {object} ICalGLib the libical typelib, passed in (see header)
 * @param {ICalGLib.Component} ic the VEVENT's ical component
 * @returns {object|null} {minutesBefore}, {raw}, or null
 */
export function parseAlarm(ICalGLib, ic) {
    const n = ic.count_components(ICalGLib.ComponentKind.VALARM_COMPONENT);
    if (n === 0)
        return null;
    if (n > 1)
        return {raw: allValarmBlocks(ICalGLib, ic)};

    const valarm = ic.get_first_component(ICalGLib.ComponentKind.VALARM_COMPONENT);
    try {
        const actionProp = valarm.get_first_property(ICalGLib.PropertyKind.ACTION_PROPERTY);
        const action     = actionProp?.get_value_as_string() ?? '';
        const trigProp = valarm.get_first_property(ICalGLib.PropertyKind.TRIGGER_PROPERTY);
        if (!trigProp || action !== 'DISPLAY')
            return {raw: allValarmBlocks(ICalGLib, ic)};

        // A relative trigger's raw form is a DURATION ("-PT10M", "PT0S", ...);
        // an absolute one is a DATE-TIME. dur.is_null_duration() can't tell
        // "explicitly zero" from "unset", so classify by raw form instead.
        const raw = trigProp.get_value_as_string() ?? '';
        if (!/^[+-]?P/i.test(raw))
            return {raw: allValarmBlocks(ICalGLib, ic)};

        const dur = trigProp.get_trigger().get_duration();
        return {minutesBefore: Math.round(-dur.as_int() / 60)};
    } catch {
        return {raw: allValarmBlocks(ICalGLib, ic)};
    }
}

// All-day DTEND;VALUE=DATE is exclusive: the last visible day is
// DTEND - 1. Only a span past the start day earns an endDate
// (DTEND = start+1 is a plain 1-day event); the returned endDate
// is that last visible day.
/**
 * @param {ICalGLib.Time|null} dtendValue the DTEND value, if any
 * @param {string} date the event's start date, 'YYYY-MM-DD'
 * @returns {string|null} the last visible day, or null for a 1-day event
 */
export function allDayEndDate(dtendValue, date) {
    if (!dtendValue?.is_date())
        return null;
    const last = GLib.DateTime.new_utc(
        dtendValue.get_year(), dtendValue.get_month(), dtendValue.get_day(), 0, 0, 0)?.add_days(-1);
    if (!last)
        return null;
    const lastStr = `${last.get_year()}-${pad(last.get_month())}-${pad(last.get_day_of_month())}`;
    return lastStr > date ? lastStr : null;
}
