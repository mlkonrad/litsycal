// Pure-gjs tests for the recurring-event expansion in recurrence.js.
// Run from the repo root with:
//   gjs -m tests/test-recurrence.js      (or: npm test)
// Prints PASS/FAIL per check and exits non-zero if any check fails.
//
// The override matching and date shifting need only ICalGLib. The
// expansion itself needs the ECal typelib, which CI doesn't install: when
// gi://ECal is missing, those checks print a SKIP line instead of failing.

import System from 'system';
import ICalGLib from 'gi://ICalGLib';

import {
    collectOverrideKeys, expandRecurring, instantKey, isDetached,
    makeTzResolver, shiftFieldsToSeries,
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
