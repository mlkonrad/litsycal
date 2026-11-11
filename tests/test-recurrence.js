// Pure-gjs tests for the recurring-event expansion and the reminder
// completion logic in recurrence.js.
// Run from the repo root with:
//   gjs -m tests/test-recurrence.js      (or: npm test)
// Prints PASS/FAIL per check and exits non-zero if any check fails.
//
// The override matching, date shifting and reminder logic need only ICalGLib. The
// expansion itself needs the ECal typelib, which CI doesn't install: when
// gi://ECal is missing, those checks print a SKIP line instead of failing.

import System from 'system';
import ICalGLib from 'gi://ICalGLib';

import {
    applyTaskCompletion, collectOverrideKeys, expandRecurring, instantKey, isDetached,
    makeTzResolver, nextTaskOccurrence, shiftFieldsToSeries,
} from '../recurrence.js';

let ECal = null;
try {
    ECal = (await import('gi://ECal')).default;
} catch {
    // Not installed (as on CI): the ECal checks below are skipped.
}

let failures = 0;
let total = 0;

const check = (label, actual, expected) => {
    total++;
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok)
        failures++;
    print(`${ok ? 'PASS' : 'FAIL'} ${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
};

const vevent = lines => ICalGLib.Component.new_from_string(['BEGIN:VEVENT', ...lines, 'END:VEVENT'].join('\r\n'));
const time = str => ICalGLib.Time.new_from_string(str);

const master = vevent([
    'UID:weekly-1',
    'SUMMARY:Weekly',
    'DTSTART;TZID=Europe/Berlin:20261104T100000',
    'DTEND;TZID=Europe/Berlin:20261104T110000',
    'RRULE:FREQ=WEEKLY',
    'EXDATE;TZID=Europe/Berlin:20261111T100000',
]);
// Replaces the 2026-11-18 occurrence; its RECURRENCE-ID is written in UTC
// on purpose, so matching must compare instants rather than digits.
const override = vevent([
    'UID:weekly-1',
    'SUMMARY:Weekly (moved)',
    'RECURRENCE-ID:20261118T090000Z',
    'DTSTART;TZID=Europe/Berlin:20261118T140000',
    'DTEND;TZID=Europe/Berlin:20261118T150000',
]);
const other = vevent(['UID:other', 'DTSTART:20261105T100000Z']);

// --- Detached occurrences and their keys ---

check('master is not detached', isDetached(ICalGLib, master), false);
check('override is detached', isDetached(ICalGLib, override), true);

const resolveTz = makeTzResolver(ICalGLib, master);
check('resolver finds a builtin zone', resolveTz('Europe/Berlin')?.get_location(), 'Europe/Berlin');
check('resolver returns null for an unknown zone', resolveTz('Not/AZone'), null);

check('instant key of a zoned time is its UTC instant',
    instantKey(ICalGLib, time('20261118T100000'), 'Europe/Berlin', resolveTz), '20261118T090000Z');
check('instant key of a UTC time is unchanged',
    instantKey(ICalGLib, time('20261118T090000Z'), null, resolveTz), '20261118T090000Z');
check('instant key of a date is its digits',
    instantKey(ICalGLib, time('20270120'), null, resolveTz), '20270120');
check('instant key of a floating time is its digits',
    instantKey(ICalGLib, time('20261118T100000'), null, resolveTz), '20261118T100000');
check('instant key keeps an unresolvable zone as digits',
    instantKey(ICalGLib, time('20261118T100000'), 'Not/AZone', resolveTz), '20261118T100000');

const keys = collectOverrideKeys(ICalGLib, [master, override, other]);
check('override keys only for series with a detached occurrence', [...keys.keys()], ['weekly-1']);
check('override key is the replaced instant', [...keys.get('weekly-1')], ['20261118T090000Z']);

// --- Editing from an occurrence shifts dates back onto the series ---

const fields = {title: 'x', date: '2026-11-25', endDate: '2026-11-25', hour: 10};
check('no shift for a non-generated event',
    shiftFieldsToSeries(fields, '2026-11-25', undefined), fields);
check('no shift on the series start itself',
    shiftFieldsToSeries(fields, '2026-11-25', '2026-11-25'), fields);
check('unchanged dates map back to the series start',
    shiftFieldsToSeries(fields, '2026-11-25', '2026-11-04'),
    {...fields, date: '2026-11-04', endDate: '2026-11-04'});
check('a date moved by one day moves the series by one day, across a month',
    shiftFieldsToSeries({...fields, date: '2026-12-02', endDate: '2026-12-03'}, '2026-12-01', '2026-11-03'),
    {...fields, date: '2026-11-04', endDate: '2026-11-05'});
check('a null endDate stays null',
    shiftFieldsToSeries({...fields, endDate: null}, '2026-11-25', '2026-11-04').endDate, null);

// --- Completing reminders ---

const vtodo = lines => ICalGLib.Component.new_from_string(['BEGIN:VTODO', 'UID:t', ...lines, 'END:VTODO'].join('\r\n'));
const propStr = (ic, kind) => ic.get_first_property(kind)?.as_ical_string().trim() ?? null;
const K = ICalGLib.PropertyKind;
const now = time('20261111T120000Z');

const plain = vtodo(['SUMMARY:Plain', 'DUE;VALUE=DATE:20261110', 'STATUS:NEEDS-ACTION']);
check('a non-repeating task has no next occurrence', nextTaskOccurrence(ICalGLib, plain), null);
applyTaskCompletion(ICalGLib, plain, true, now);
check('done sets STATUS COMPLETED', propStr(plain, K.STATUS_PROPERTY), 'STATUS:COMPLETED');
check('done sets PERCENT-COMPLETE 100', propStr(plain, K.PERCENTCOMPLETE_PROPERTY), 'PERCENT-COMPLETE:100');
check('done sets COMPLETED to now', propStr(plain, K.COMPLETED_PROPERTY), 'COMPLETED:20261111T120000Z');
check('done keeps DUE', propStr(plain, K.DUE_PROPERTY), 'DUE;VALUE=DATE:20261110');
applyTaskCompletion(ICalGLib, plain, true, now);
check('completing twice keeps one COMPLETED',
    plain.count_properties(K.COMPLETED_PROPERTY) + plain.count_properties(K.PERCENTCOMPLETE_PROPERTY), 2);
applyTaskCompletion(ICalGLib, plain, false, now);
check('undone sets NEEDS-ACTION', propStr(plain, K.STATUS_PROPERTY), 'STATUS:NEEDS-ACTION');
check('undone removes COMPLETED', propStr(plain, K.COMPLETED_PROPERTY), null);
check('undone sets PERCENT-COMPLETE 0', propStr(plain, K.PERCENTCOMPLETE_PROPERTY), 'PERCENT-COMPLETE:0');

const weekly = vtodo([
    'SUMMARY:Weekly', 'DTSTART;TZID=Europe/Berlin:20261104T090000', 'DUE;TZID=Europe/Berlin:20261104T100000',
    'RRULE:FREQ=WEEKLY;COUNT=5', 'EXDATE;TZID=Europe/Berlin:20261111T090000', 'STATUS:NEEDS-ACTION',
]);
applyTaskCompletion(ICalGLib, weekly, true, now);
check('a repeating task advances DTSTART past the EXDATE, keeping its TZID',
    propStr(weekly, K.DTSTART_PROPERTY), 'DTSTART;TZID=Europe/Berlin:20261118T090000');
check('DUE keeps its distance from DTSTART', propStr(weekly, K.DUE_PROPERTY), 'DUE;TZID=Europe/Berlin:20261118T100000');
check('COUNT shrinks by the occurrences passed over', propStr(weekly, K.RRULE_PROPERTY), 'RRULE:FREQ=WEEKLY;COUNT=3');
check('an advanced task stays to do', propStr(weekly, K.STATUS_PROPERTY), 'STATUS:NEEDS-ACTION');
check('an advanced task has no COMPLETED', propStr(weekly, K.COMPLETED_PROPERTY), null);

const dueOnly = vtodo(['SUMMARY:Monthly', 'DUE;VALUE=DATE:20260131', 'RRULE:FREQ=MONTHLY;INTERVAL=2']);
applyTaskCompletion(ICalGLib, dueOnly, true, now);
check('a task without DTSTART advances DUE itself', propStr(dueOnly, K.DUE_PROPERTY), 'DUE;VALUE=DATE:20260331');
check('a rule without COUNT stays without one', propStr(dueOnly, K.RRULE_PROPERTY), 'RRULE:FREQ=MONTHLY;INTERVAL=2');

const last = vtodo(['SUMMARY:Last', 'DUE;VALUE=DATE:20261110', 'RRULE:FREQ=DAILY;UNTIL=20261110']);
check('a series with no further occurrence has no next', nextTaskOccurrence(ICalGLib, last), null);
applyTaskCompletion(ICalGLib, last, true, now);
check('completing its last occurrence completes it for real', propStr(last, K.STATUS_PROPERTY), 'STATUS:COMPLETED');

const old = vtodo(['SUMMARY:Daily', 'DUE;VALUE=DATE:19850120', 'RRULE:FREQ=DAILY']);
applyTaskCompletion(ICalGLib, old, true, now);
check('an old daily task moves to the day after its DUE, not to today',
    propStr(old, K.DUE_PROPERTY), 'DUE;VALUE=DATE:19850121');

// --- Expansion (needs ECal) ---

const skip = label => print(`SKIP ${label}: gi://ECal not installed`);
const localTz = ICalGLib.Timezone.get_builtin_timezone('America/New_York');
const novStart = time('20261101T000000Z');
const decEnd = time('20261201T000000Z');

if (ECal) {
    const all = expandRecurring(ECal, ICalGLib, master, novStart, decEnd, localTz);
    check('expansion honors EXDATE, rids in the master zone',
        all.map(i => i.rid), ['20261104T100000', '20261118T100000', '20261125T100000']);
    check('instance end follows DTEND', all.map(i => i.end.as_ical_string())[0], '20261104T110000');

    const shown = expandRecurring(ECal, ICalGLib, master, novStart, decEnd, localTz, keys.get('weekly-1'));
    check('a detached occurrence suppresses the one it replaces',
        shown.map(i => i.rid), ['20261104T100000', '20261125T100000']);

    const birthday = vevent([
        'UID:bday', 'SUMMARY:Happy birthday!',
        'DTSTART;VALUE=DATE:19850120', 'DTEND;VALUE=DATE:19850121', 'RRULE:FREQ=YEARLY',
    ]);
    check('a yearly all-day series dates each year, not 1985',
        expandRecurring(ECal, ICalGLib, birthday, time('20270101T000000Z'), time('20290101T000000Z'), localTz)
            .map(i => [i.rid, i.end.as_ical_string()]),
        [['20270120', '20270121'], ['20280120', '20280121']]);

    const minutely = vevent(['UID:m', 'DTSTART:20261101T000000Z', 'RRULE:FREQ=MINUTELY']);
    check('a runaway rule is capped',
        expandRecurring(ECal, ICalGLib, minutely, novStart, decEnd, localTz).length, 1000);
} else {
    for (const label of ['expansion honors EXDATE', 'instance end follows DTEND',
        'a detached occurrence suppresses the one it replaces', 'a yearly all-day series',
        'a runaway rule is capped'])
        skip(label);
}

print(`\n${total - failures}/${total} checks passed`);
if (failures > 0)
    System.exit(1);
