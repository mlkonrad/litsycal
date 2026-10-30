// Pure-gjs tests for the Shell-independent parsers (quickAddParser.js and
// timeInput.js). Run with: gjs -m tests/test-quickadd-time.js
// Prints PASS/FAIL per check and exits non-zero if any check fails.

import System from 'system';

import {parseQuickAdd} from '../quickAddParser.js';
import {toHHMM, fromHHMM, formatTime, parseTimeInput} from '../timeInput.js';

let failures = 0;
let total = 0;

const check = (label, actual, expected) => {
    total++;
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok)
        failures++;
    print(`${ok ? 'PASS' : 'FAIL'} ${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
};

// parseQuickAdd: valid times are still extracted.
check('quickadd 15:30 time', parseQuickAdd('Dentist 15:30')?.time, '15:30');
check('quickadd 15:30 title', parseQuickAdd('Dentist 15:30')?.title, 'Dentist');
check('quickadd 3:30pm time', parseQuickAdd('Dentist 3:30pm')?.time, '15:30');
check('quickadd 3pm time', parseQuickAdd('Dentist 3pm')?.time, '15:00');
check('quickadd at 3 time', parseQuickAdd('Lunch at 3')?.time, '03:00');
check('quickadd at 3 title', parseQuickAdd('Lunch at 3')?.title, 'Lunch');

// parseQuickAdd: invalid times must not be extracted (regression: "99:99"
// used to become a bogus time instead of staying in the title).
check('quickadd 99:99 time', parseQuickAdd('Lunch 99:99')?.time, null);
check('quickadd 99:99 title', parseQuickAdd('Lunch 99:99')?.title, 'Lunch 99:99');
check('quickadd 99:30 time', parseQuickAdd('Lunch 99:30')?.time, null);
check('quickadd 99:30 title', parseQuickAdd('Lunch 99:30')?.title, 'Lunch 99:30');
check('quickadd 25:30 time', parseQuickAdd('Lunch 25:30')?.time, null);
check('quickadd 13pm time', parseQuickAdd('Party 13pm')?.time, null);
check('quickadd 13pm title', parseQuickAdd('Party 13pm')?.title, 'Party 13pm');
check('quickadd at 99 time', parseQuickAdd('Lunch at 99')?.time, null);
check('quickadd at 99:99 time', parseQuickAdd('Lunch at 99:99')?.time, null);
check('quickadd 23h60 time', parseQuickAdd('Meeting 23h60')?.time, null);
check('quickadd 15h30 time', parseQuickAdd('Meeting 15h30')?.time, '15:30');
check('quickadd invalid-then-valid colon time', parseQuickAdd('Lunch 99:99 15:30')?.time, '15:30');
check('quickadd invalid-then-valid ampm time', parseQuickAdd('Party 13pm 3pm')?.time, '15:00');
check('quickadd invalid-then-valid h time', parseQuickAdd('Meeting 12h60 14h30')?.time, '14:30');
check('quickadd at 99 location', parseQuickAdd('Lunch at 99')?.location, null);
check('quickadd at 13pm location', parseQuickAdd('Lunch at 13pm')?.location, null);
check('quickadd at 23h60 location', parseQuickAdd('Lunch at 23h60')?.location, null);
check('quickadd at 123pm location', parseQuickAdd('Lunch at 123pm')?.location, null);
check('quickadd at 13pm! location', parseQuickAdd('Lunch at 13pm!')?.location, null);
check('quickadd at 9.30am location', parseQuickAdd('Call at 9.30am')?.location, null);
check('quickadd at 6.45 location', parseQuickAdd('Flight at 6.45')?.location, null);
check('quickadd at 5-6pm location', parseQuickAdd('Meet at 5-6pm')?.location, null);
check('quickadd at 7-Eleven time', parseQuickAdd('Coffee at 7-Eleven')?.time, null);
check('quickadd at 7-Eleven title', parseQuickAdd('Coffee at 7-Eleven')?.title, 'Coffee');
check('quickadd at 7-Eleven location', parseQuickAdd('Coffee at 7-Eleven')?.location, '7-Eleven');
check('quickadd at 8.30 time', parseQuickAdd('Dinner at 8.30')?.time, '08:30');
// A bare dotted decimal is never a time: it needs am/pm or "at".
check('quickadd 9.30 bare dotted time', parseQuickAdd('Dentist 9.30')?.time, null);
check('quickadd 9.30 bare dotted title', parseQuickAdd('Dentist 9.30')?.title, 'Dentist 9.30');
check('quickadd at 9.30 time', parseQuickAdd('Dentist at 9.30')?.time, '09:30');
check('quickadd at 9.30 title', parseQuickAdd('Dentist at 9.30')?.title, 'Dentist');
check('quickadd 9.30am time', parseQuickAdd('Call 9.30am')?.time, '09:30');
check('quickadd 9.30am title', parseQuickAdd('Call 9.30am')?.title, 'Call');
// Decimals elsewhere survive in the title and don't block the real time.
check('quickadd Budget 1.50 at 3pm time', parseQuickAdd('Budget 1.50 at 3pm')?.time, '15:00');
check('quickadd Budget 1.50 at 3pm title', parseQuickAdd('Budget 1.50 at 3pm')?.title, 'Budget 1.50');
check('quickadd Room 4.12 at 3pm time', parseQuickAdd('Room 4.12 at 3pm')?.time, '15:00');
check('quickadd Room 4.12 at 3pm title', parseQuickAdd('Room 4.12 at 3pm')?.title, 'Room 4.12');
check('quickadd Buy 3.50 milk time', parseQuickAdd('Buy 3.50 milk')?.time, null);
check('quickadd Buy 3.50 milk title', parseQuickAdd('Buy 3.50 milk')?.title, 'Buy 3.50 milk');
check('quickadd range 3-4pm time', parseQuickAdd('meet 3-4pm')?.time, '15:00');
check('quickadd range 3-4pm title', parseQuickAdd('meet 3-4pm')?.title, 'meet');
check('quickadd range 3-4:30pm time', parseQuickAdd('meet 3-4:30pm')?.time, '15:00');
check('quickadd range 3-4:30pm title', parseQuickAdd('meet 3-4:30pm')?.title, 'meet');
check('quickadd range en-dash time', parseQuickAdd('meet 3–4pm')?.time, '15:00');
check('quickadd range en-dash title', parseQuickAdd('meet 3–4pm')?.title, 'meet');
check('quickadd range Standup time', parseQuickAdd('Standup 9:30am-10am')?.time, '09:30');
check('quickadd range Standup title', parseQuickAdd('Standup 9:30am-10am')?.title, 'Standup');
check('quickadd range bare-inherits time', parseQuickAdd('Call 9-10:30am')?.time, '09:00');
check('quickadd range bare-inherits title', parseQuickAdd('Call 9-10:30am')?.title, 'Call');
check('quickadd 9.30pm time', parseQuickAdd('Call 9.30pm')?.time, '21:30');
check('quickadd 9.30pm title', parseQuickAdd('Call 9.30pm')?.title, 'Call');
check('quickadd range dotted-bare time', parseQuickAdd('meet 3-4.30pm')?.time, '15:00');
check('quickadd range dotted-bare title', parseQuickAdd('meet 3-4.30pm')?.title, 'meet');
// A range gives its start time and is removed whole from the title.
check('quickadd range dotted-full time', parseQuickAdd('9.30-10.30am call')?.time, '09:30');
check('quickadd range dotted-full title', parseQuickAdd('9.30-10.30am call')?.title, 'call');
check('quickadd range colon-full time', parseQuickAdd('9:30-10:30am call')?.time, '09:30');
check('quickadd range colon-full title', parseQuickAdd('9:30-10:30am call')?.title, 'call');
check('quickadd range colon no-ampm time', parseQuickAdd('9:30-10:30 call')?.time, '09:30');
check('quickadd range colon no-ampm title', parseQuickAdd('9:30-10:30 call')?.title, 'call');
check('quickadd range dotted at-anchor time', parseQuickAdd('call at 9.30-10.30')?.time, '09:30');
check('quickadd range dotted at-anchor title', parseQuickAdd('call at 9.30-10.30')?.title, 'call');
// Every start shape works, including starts carrying am/pm and "h" forms.
check('quickadd range colon-ampm to ampm time', parseQuickAdd('Dentist 9:30am-10am')?.time, '09:30');
check('quickadd range colon-ampm to ampm title', parseQuickAdd('Dentist 9:30am-10am')?.title, 'Dentist');
check('quickadd range dotted-ampm to ampm time', parseQuickAdd('Dentist 9.30am-10am')?.time, '09:30');
check('quickadd range dotted-ampm to ampm title', parseQuickAdd('Dentist 9.30am-10am')?.title, 'Dentist');
check('quickadd range dotted-ampm full time', parseQuickAdd('Dentist 9.30am-10:30am')?.time, '09:30');
check('quickadd range dotted-ampm full title', parseQuickAdd('Dentist 9.30am-10:30am')?.title, 'Dentist');
check('quickadd range dotted to ampm time', parseQuickAdd('Call 9.30-10am')?.time, '09:30');
check('quickadd range dotted to ampm title', parseQuickAdd('Call 9.30-10am')?.title, 'Call');
check('quickadd range h time', parseQuickAdd('Call 15h-16h')?.time, '15:00');
check('quickadd range h title', parseQuickAdd('Call 15h-16h')?.title, 'Call');
check('quickadd range h-minutes time', parseQuickAdd('Call 15h30-16h30')?.time, '15:30');
check('quickadd range h-minutes title', parseQuickAdd('Call 15h30-16h30')?.title, 'Call');
check('quickadd Budget 1.50 time', parseQuickAdd('Budget 1.50')?.time, null);
check('quickadd Budget 1.50 title', parseQuickAdd('Budget 1.50')?.title, 'Budget 1.50');
// A dotted range with no am/pm and no "at" anchor stays in the title.
check('quickadd range dotted unanchored time', parseQuickAdd('9.30-10.30 call')?.time, null);
check('quickadd range dotted unanchored title', parseQuickAdd('9.30-10.30 call')?.title, '9.30-10.30 call');
// A bare-bare range with no "at" before it is not a time either: it
// must not fabricate an hour or steal a real anchored time after it.
check('quickadd range bare-bare then at 5pm time', parseQuickAdd('Version 2-3 at 5pm')?.time, '17:00');
check('quickadd range bare-bare then at 5pm title', parseQuickAdd('Version 2-3 at 5pm')?.title, 'Version 2-3');
check('quickadd range bare-bare people at 5pm time', parseQuickAdd('Team 3-4 people at 5pm')?.time, '17:00');
check('quickadd range bare-bare people at 5pm title', parseQuickAdd('Team 3-4 people at 5pm')?.title, 'Team 3-4 people');
check('quickadd range bare-bare alone time', parseQuickAdd('Meet 3-4')?.time, null);
check('quickadd range bare-bare alone title', parseQuickAdd('Meet 3-4')?.title, 'Meet 3-4');
// noon/midnight are times (12:00/00:00), never locations.
check('quickadd at noon time', parseQuickAdd('Lunch at noon')?.time, '12:00');
check('quickadd at noon title', parseQuickAdd('Lunch at noon')?.title, 'Lunch');
check('quickadd at noon location', parseQuickAdd('Lunch at noon')?.location, null);
check('quickadd at midnight time', parseQuickAdd('Lunch at midnight')?.time, '00:00');
check('quickadd at midnight title', parseQuickAdd('Lunch at midnight')?.title, 'Lunch');
check('quickadd 12.00 at noon time', parseQuickAdd('Lunch 12.00 at noon')?.time, '12:00');
check('quickadd 12.00 at noon title', parseQuickAdd('Lunch 12.00 at noon')?.title, 'Lunch 12.00');
check('quickadd 12.00 at noon location', parseQuickAdd('Lunch 12.00 at noon')?.location, null);
check('quickadd 3pm at noon location', parseQuickAdd('Lunch 3pm at noon')?.location, null);
// A range starting at noon/midnight gives that start, cut whole.
check('quickadd range noon-ampm time', parseQuickAdd('Meet at noon-1pm')?.time, '12:00');
check('quickadd range noon-ampm title', parseQuickAdd('Meet at noon-1pm')?.title, 'Meet');
check('quickadd range midnight-ampm time', parseQuickAdd('Meet at midnight-1am')?.time, '00:00');
check('quickadd range midnight-ampm title', parseQuickAdd('Meet at midnight-1am')?.title, 'Meet');
check('quickadd range noon-leading time', parseQuickAdd('noon-1pm meet')?.time, '12:00');
check('quickadd range noon-leading title', parseQuickAdd('noon-1pm meet')?.title, 'meet');
check('quickadd range noon-colon time', parseQuickAdd('Meet noon-1:30pm')?.time, '12:00');
check('quickadd range noon-colon title', parseQuickAdd('Meet noon-1:30pm')?.title, 'Meet');
// A range start carrying am/pm is cut whole too.
check('quickadd range ampm-ampm time', parseQuickAdd('12pm-1pm call')?.time, '12:00');
check('quickadd range ampm-ampm title', parseQuickAdd('12pm-1pm call')?.title, 'call');
check('quickadd range 3pm-4pm time', parseQuickAdd('3pm-4pm call')?.time, '15:00');
check('quickadd range 3pm-4pm title', parseQuickAdd('3pm-4pm call')?.title, 'call');
check('quickadd range 11am-12pm time', parseQuickAdd('11am-12pm call')?.time, '11:00');
check('quickadd range 11am-12pm title', parseQuickAdd('11am-12pm call')?.title, 'call');
check('quickadd range ampm-colon time', parseQuickAdd('3pm-4:30pm call')?.time, '15:00');
check('quickadd range ampm-colon title', parseQuickAdd('3pm-4:30pm call')?.title, 'call');
check('quickadd range ampm en-dash time', parseQuickAdd('Meet 12pm–1pm')?.time, '12:00');
check('quickadd range ampm en-dash title', parseQuickAdd('Meet 12pm–1pm')?.title, 'Meet');
// A range ending at noon/midnight gives its start, cut whole.
check('quickadd range noon-midnight time', parseQuickAdd('noon-midnight party')?.time, '12:00');
check('quickadd range noon-midnight title', parseQuickAdd('noon-midnight party')?.title, 'party');
check('quickadd range midnight-noon time', parseQuickAdd('midnight-noon sync')?.time, '00:00');
check('quickadd range midnight-noon title', parseQuickAdd('midnight-noon sync')?.title, 'sync');
check('quickadd range ampm-noon time', parseQuickAdd('12pm-noon call')?.time, '12:00');
check('quickadd range ampm-noon title', parseQuickAdd('12pm-noon call')?.title, 'call');
check('quickadd range ampm-midnight time', parseQuickAdd('1pm-midnight call')?.time, '13:00');
check('quickadd range ampm-midnight title', parseQuickAdd('1pm-midnight call')?.title, 'call');
check('quickadd range bare-noon time', parseQuickAdd('Meet 11-noon')?.time, '11:00');
check('quickadd range bare-noon title', parseQuickAdd('Meet 11-noon')?.title, 'Meet');
check('quickadd range ampm-noon start time', parseQuickAdd('Meet 11am-noon')?.time, '11:00');
check('quickadd range ampm-noon start title', parseQuickAdd('Meet 11am-noon')?.title, 'Meet');
// A rejected range start must not let the named end become the time:
// "9.30" has no am/pm or "at" anchor, so the range gives no time at all.
check('quickadd range dotted-noon rejected time', parseQuickAdd('Meet 9.30-noon')?.time, null);
check('quickadd range dotted-noon rejected title', parseQuickAdd('Meet 9.30-noon')?.title, 'Meet 9.30-noon');
check('quickadd range dotted-midnight rejected time', parseQuickAdd('Meet 9.30-midnight')?.time, null);
check('quickadd range dotted-midnight rejected title', parseQuickAdd('Meet 9.30-midnight')?.title, 'Meet 9.30-midnight');
check('quickadd range dotted-noon spaced rejected time', parseQuickAdd('Meet 9.30 - noon')?.time, null);
check('quickadd range dotted-noon spaced rejected title', parseQuickAdd('Meet 9.30 - noon')?.title, 'Meet 9.30 - noon');
check('quickadd range dotted-noon en-dash rejected time', parseQuickAdd('Meet 9.30–noon')?.time, null);
check('quickadd range dotted-noon en-dash rejected title', parseQuickAdd('Meet 9.30–noon')?.title, 'Meet 9.30–noon');
// ...but a valid start still gives its own time when the end is named.
check('quickadd range dotted-ampm-noon time', parseQuickAdd('Meet 9.30am-noon')?.time, '09:30');
check('quickadd range dotted-ampm-noon title', parseQuickAdd('Meet 9.30am-noon')?.title, 'Meet');
check('quickadd range colon-noon time', parseQuickAdd('Meet 9:30-noon')?.time, '09:30');
check('quickadd range colon-noon title', parseQuickAdd('Meet 9:30-noon')?.title, 'Meet');
// No dash, no range: a leading "Midnight" is title text and the later
// numeric time wins.
check('quickadd Midnight snack at 8pm time', parseQuickAdd('Midnight snack at 8pm')?.time, '20:00');
check('quickadd Midnight snack at 8pm title', parseQuickAdd('Midnight snack at 8pm')?.title, 'Midnight snack');
check('quickadd at 3. time', parseQuickAdd('Lunch at 3.')?.time, '03:00');
check('quickadd at 13pm) location', parseQuickAdd('Lunch at 13pm)')?.location, null);
check('quickadd Timer 12:30:45 time', parseQuickAdd('Timer 12:30:45')?.time, '12:30');
check('quickadd Timer 12:30:45 title', parseQuickAdd('Timer 12:30:45')?.title, 'Timer');
check('quickadd at Cafe Nero! location', parseQuickAdd('Lunch at Cafe Nero!')?.location, 'Cafe Nero!');
check('quickadd at 13:30pm time', parseQuickAdd('Lunch at 13:30pm')?.time, null);
check('quickadd at 13:30pm title', parseQuickAdd('Lunch at 13:30pm')?.title, 'Lunch at 13:30pm');
check('quickadd bare number kept', parseQuickAdd('Room 5 cleanup')?.title, 'Room 5 cleanup');
check('quickadd bare number time', parseQuickAdd('Room 5 cleanup')?.time, null);
check('quickadd empty', parseQuickAdd('   '), null);

// timeInput: toHHMM / fromHHMM / formatTime.
check('toHHMM 0', toHHMM(0), '00:00');
check('toHHMM 570', toHHMM(570), '09:30');
check('toHHMM 1439', toHHMM(1439), '23:59');
check('fromHHMM 9:30', fromHHMM('9:30'), 570);
check('fromHHMM 23:59', fromHHMM('23:59'), 1439);
check('fromHHMM 24:00', fromHHMM('24:00'), null);
check('fromHHMM 9:60', fromHHMM('9:60'), null);
check('fromHHMM junk', fromHHMM('junk'), null);
check('formatTime 24h', formatTime(930, '24h'), '15:30');
check('formatTime 12h pm', formatTime(930, '12h'), '3:30pm');
check('formatTime 12h midnight', formatTime(0, '12h'), '12:00am');

// timeInput: parseTimeInput.
check('parseTimeInput 9:30', parseTimeInput('9:30'), 570);
check('parseTimeInput 9:30pm', parseTimeInput('9:30pm'), 1290);
check('parseTimeInput 21:30', parseTimeInput('21:30'), 1290);
check('parseTimeInput 930', parseTimeInput('930'), 570);
check('parseTimeInput 99:99', parseTimeInput('99:99'), null);
check('parseTimeInput 24:00', parseTimeInput('24:00'), null);
check('parseTimeInput 13pm', parseTimeInput('13pm'), null);
check('parseTimeInput empty', parseTimeInput(''), null);

print(`${total - failures}/${total} checks passed`);
if (failures > 0)
    System.exit(1);
