// Pure-gjs tests for the iCal build/parse logic in ical.js.
// Run from the repo root with:
//   gjs -m tests/test-ical.js      (or: npm test)
// Prints PASS/FAIL per check and exits non-zero if any check fails.
//
// ical.js imports only GLib (ICalGLib is passed into the parse
// functions, imported directly here), never Shell-only modules, so it
// is imported directly here - the code being exercised is the code
// that ships, imported as a module, not extracted or copied.

import System from 'system';
import ICalGLib from 'gi://ICalGLib';

import {
    allDayEndDate, buildICal, buildRRuleLine, buildValarmLines,
    parseAlarm, parseRecurrence,
} from '../ical.js';

let failures = 0;
let total = 0;

const check = (label, actual, expected) => {
    total++;
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok)
        failures++;
    print(`${ok ? 'PASS' : 'FAIL'} ${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
};

const checkThrows = (label, fn) => {
    total++;
    let threw = false;
    try {
        fn();
    } catch {
        threw = true;
    }
    if (!threw)
        failures++;
    print(`${threw ? 'PASS' : 'FAIL'} ${label}: ${threw ? 'threw as expected' : 'did not throw'}`);
};

const parseIcal = str => ICalGLib.Component.new_from_string(str);
const veventWith = lines => parseIcal(['BEGIN:VEVENT', 'UID:test-1', ...lines, 'END:VEVENT'].join('\r\n'));
const baseFields = {
    title: 'Test', date: '2026-09-07', allDay: false, hour: 9, minute: 30,
    endHour: 10, endMinute: 30, endDate: null,
    notes: null, url: null, location: null, recurrence: null, alarm: null,
};
const dtendValueOf = icalStr => parseIcal(icalStr)
    .get_first_property(ICalGLib.PropertyKind.DTEND_PROPERTY)?.get_value()?.get_datetime();

// --- RRULE UNTIL: build -> parse, with and without a time-of-day ---

check('rrule build untilTime preserved',
    buildRRuleLine({freq: 'WEEKLY', interval: 1, until: '2025-12-31', untilTime: '100000Z'}),
    ['RRULE:FREQ=WEEKLY;UNTIL=20251231T100000Z']);
check('rrule build date-only until gets end-of-day',
    buildRRuleLine({freq: 'WEEKLY', interval: 1, until: '2025-12-31'}),
    ['RRULE:FREQ=WEEKLY;UNTIL=20251231T235959Z']);
checkThrows('rrule build bad untilTime rejected, never reaches the wire',
    () => buildRRuleLine({freq: 'WEEKLY', interval: 1, until: '2025-12-31', untilTime: 'TX'}));

const recWithTime = parseRecurrence(ICalGLib, veventWith(['RRULE:FREQ=WEEKLY;INTERVAL=2;UNTIL=20251231T100000Z']));
check('rrule parse freq', recWithTime.freq, 'WEEKLY');
check('rrule parse interval', recWithTime.interval, 2);
check('rrule parse until', recWithTime.until, '2025-12-31');
check('rrule parse untilTime', recWithTime.untilTime, '100000Z');
check('rrule roundtrip with time',
    buildRRuleLine(recWithTime),
    ['RRULE:FREQ=WEEKLY;INTERVAL=2;UNTIL=20251231T100000Z']);

const recDateOnly = parseRecurrence(ICalGLib, veventWith(['RRULE:FREQ=DAILY;UNTIL=20251231']));
check('rrule parse date-only until', recDateOnly.until, '2025-12-31');
check('rrule parse date-only has no untilTime', 'untilTime' in recDateOnly, false);
check('rrule roundtrip date-only',
    buildRRuleLine(recDateOnly),
    ['RRULE:FREQ=DAILY;UNTIL=20251231T235959Z']);

// --- Malformed RRULE parts: preserved raw, never re-emitted corrupted ---
//
// libical itself drops an RRULE it cannot parse (it becomes an
// X-LIC-ERROR property) and normalizes 'INTERVAL=2x' to 'INTERVAL=2'
// before parseRecurrence ever sees the string, so these cases can
// only reach the parser as a raw property value - which is how a
// backend that hands over the unparsed string would deliver them.
// Exercise that path with a stub component returning the raw text.

const fakeIc = raw => ({
    get_first_property: () => ({get_value_as_string: () => raw}),
});
check('rrule UNTIL=20240101TX preserved raw',
    parseRecurrence(ICalGLib, fakeIc('FREQ=WEEKLY;UNTIL=20240101TX')),
    {raw: 'FREQ=WEEKLY;UNTIL=20240101TX'});
check('rrule UNTIL with short time suffix preserved raw',
    parseRecurrence(ICalGLib, fakeIc('FREQ=WEEKLY;UNTIL=20240101T12345')),
    {raw: 'FREQ=WEEKLY;UNTIL=20240101T12345'});
check('rrule INTERVAL=2x preserved raw',
    parseRecurrence(ICalGLib, fakeIc('FREQ=WEEKLY;INTERVAL=2x')),
    {raw: 'FREQ=WEEKLY;INTERVAL=2x'});
check('rrule raw re-emitted verbatim',
    buildRRuleLine(parseRecurrence(ICalGLib, fakeIc('FREQ=WEEKLY;UNTIL=20240101TX'))),
    ['RRULE:FREQ=WEEKLY;UNTIL=20240101TX']);
// Shape-valid but semantically impossible UNTILs are {raw} too, not a
// normalized/re-emitted date (2025-02-30, hour 24).
check('rrule UNTIL=20250230 preserved raw',
    parseRecurrence(ICalGLib, fakeIc('FREQ=WEEKLY;UNTIL=20250230')),
    {raw: 'FREQ=WEEKLY;UNTIL=20250230'});
check('rrule UNTIL=20240101T246000Z preserved raw',
    parseRecurrence(ICalGLib, fakeIc('FREQ=WEEKLY;UNTIL=20240101T246000Z')),
    {raw: 'FREQ=WEEKLY;UNTIL=20240101T246000Z'});

// --- VALARM: negative (after start) and positive triggers ---

const triggerOf = alarm => buildValarmLines(alarm).find(l => l.startsWith('TRIGGER:'));
check('valarm before start', triggerOf({minutesBefore: 10}), 'TRIGGER:-PT10M');
check('valarm after start', triggerOf({minutesBefore: -10}), 'TRIGGER:PT10M');
check('valarm at start', triggerOf({minutesBefore: 0}), 'TRIGGER:PT0M');
check('valarm before, days+hours', triggerOf({minutesBefore: 1500}), 'TRIGGER:-P1DT1H');
check('valarm after, days+hours', triggerOf({minutesBefore: -1500}), 'TRIGGER:P1DT1H');
check('valarm non-finite dropped', buildValarmLines({minutesBefore: NaN}), []);

for (const min of [10, -10, 0, 1500]) {
    const ical = buildICal('test-1', {...baseFields, alarm: {minutesBefore: min}});
    check(`valarm roundtrip ${min}`, parseAlarm(ICalGLib, parseIcal(ical))?.minutesBefore, min);
}

// --- SUMMARY escaping: ';', newline, comma, backslash ---

const trickyTitle = 'A;B\nC,D\\E';
const escaped = buildICal('test-1', {...baseFields, title: trickyTitle});
check('summary escaped on one line',
    escaped.split('\r\n').find(l => l.startsWith('SUMMARY:')),
    'SUMMARY:A\\;B\\nC\\,D\\\\E');
check('summary parses back verbatim',
    parseIcal(escaped).get_first_property(ICalGLib.PropertyKind.SUMMARY_PROPERTY)?.get_value()?.get_text(),
    trickyTitle);

// A CR/LF in the URL must not inject extra iCal lines.
const injected = buildICal('test-1', {...baseFields, url: 'https://example.com/\r\nX-INJECT:1'});
check('url CR/LF stripped, no injected line',
    injected.split('\r\n').some(l => l.startsWith('X-INJECT')), false);

// --- All-day multi-day: DTEND exclusive, endDate is the last day ---

const allDay = buildICal('test-1', {
    ...baseFields, allDay: true, date: '2026-09-07', endDate: '2026-09-09',
});
check('all-day DTSTART', allDay.split('\r\n').find(l => l.startsWith('DTSTART')), 'DTSTART;VALUE=DATE:20260907');
check('all-day DTEND is day after last visible day',
    allDay.split('\r\n').find(l => l.startsWith('DTEND')), 'DTEND;VALUE=DATE:20260910');
check('all-day parse roundtrip: endDate = DTEND - 1',
    allDayEndDate(dtendValueOf(allDay), '2026-09-07'), '2026-09-09');

// All-day with endDate == start date is a single day (DTEND = start+1,
// no endDate parsed back) - the contract the event dialog's all-day
// toggle relies on when it resets a new event's end picker to the
// start date.
const allDaySingle = buildICal('test-1', {
    ...baseFields, allDay: true, date: '2026-09-07', endDate: '2026-09-07',
});
check('all-day single-day DTEND is start + 1',
    allDaySingle.split('\r\n').find(l => l.startsWith('DTEND')), 'DTEND;VALUE=DATE:20260908');
check('all-day single day has no endDate',
    allDayEndDate(dtendValueOf(allDaySingle), '2026-09-07'), null);

// --- Invalid date/time rejected by the builder ---

checkThrows('build rejects bogus date',
    () => buildICal('t', {...baseFields, date: 'bogus'}));
checkThrows('build rejects bogus hour',
    () => buildICal('t', {...baseFields, hour: 25}));
checkThrows('build rejects fractional hour',
    () => buildICal('t', {...baseFields, hour: 9.5}));
checkThrows('build rejects invalid recurrence until',
    () => buildICal('t', {
        ...baseFields,
        recurrence: {freq: 'WEEKLY', interval: 1, until: '2025-02-30'},
    }));
checkThrows('build rejects invalid recurrence untilTime',
    () => buildICal('t', {
        ...baseFields,
        recurrence: {freq: 'WEEKLY', interval: 1, until: '2025-12-31', untilTime: '246000Z'},
    }));

print(`${total - failures}/${total} checks passed`);
if (failures > 0)
    System.exit(1);
