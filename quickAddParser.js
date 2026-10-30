import GLib from 'gi://GLib';

// Own domain-qualified gettext wrappers rather than importing from
// extension.js, and its own tiny dateStr rather than importing helpers.js
// (which imports gettext from a Shell-process-only resource path). This
// module has no Shell-process dependency at all and stays that way on
// purpose, so it can be unit-tested with plain `gjs`, no running Shell
// required.
function dateStr(dt) {
    return `${dt.get_year()}-${String(dt.get_month()).padStart(2, '0')}-${String(dt.get_day_of_month()).padStart(2, '0')}`;
}
const DOMAIN = 'litsycal@mlkonrad.github.com';
const _ = str => GLib.dgettext(DOMAIN, str);
// Named `pgettext`, not something like `C_`, on purpose: xgettext's default
// keyword list (since gettext 0.18, across every --language backend
// including JavaScript) already extracts a two-argument `pgettext(context,
// msgid)` call as a proper msgctxt+msgid pair with no extra --keyword flag
// needed - whatever plain `xgettext` invocation regenerates this project's
// .pot picks this up for free. Used below for the location marker ("at" as
// in "lunch at the cafe") vs. the time preposition ("at" as in "lunch at
// 3pm"): same English default text, but two independent translations,
// since e.g. Portuguese uses different words entirely for each ("local"/
// "em" vs. "às") rather than the one preposition English happens to use
// for both.
const pgettext = (context, str) => GLib.dpgettext2(DOMAIN, context, str) || str;

function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Finds `word` as a whole word (case-insensitive, Unicode-aware) anywhere in
// `text`; returns {before, after} (text with the word and its surrounding
// single space collapsed out) or null if not found.
function stripWord(text, word) {
    if (!word)
        return null;
    const re = new RegExp(`(^|\\s)${escapeRegExp(word)}(\\s|$)`, 'iu');
    const m = re.exec(text);
    if (!m)
        return null;
    const before = text.slice(0, m.index);
    const after  = text.slice(m.index + m[0].length);
    return {rest: `${before} ${after}`.replace(/\s+/g, ' ').trim()};
}

// One entry per day of the current locale's week, Monday(1)..Sunday(7) -
// matching GLib.DateTime.get_day_of_week() - each with that locale's full
// and abbreviated weekday name. No translation strings needed for this part
// (unlike today/tomorrow/next below): GLib already knows every locale's own
// weekday names, the same source helpers.js's localeDayAbbrs() uses for the
// grid's own weekday header.
function localeWeekdays() {
    // 2025-01-06 was a Monday.
    return Array.from({length: 7}, (_unused, i) => {
        const dt = GLib.DateTime.new_local(2025, 1, 6 + i, 0, 0, 0);
        return {dow: i + 1, full: dt.format('%A').toLowerCase(), abbr: dt.format('%a').toLowerCase()};
    });
}

function nextOccurrenceOf(dow, now) {
    let delta = dow - now.get_day_of_week();
    if (delta <= 0)
        delta += 7;
    return now.add_days(delta);
}

// Pulls a date out of `text`: today/tomorrow (translatable keywords), or a
// locale weekday name with an optional leading/trailing "next" (also
// translatable) meaning its next upcoming occurrence. Returns
// {date, rest} or null if nothing recognized.
function extractDate(text, now) {
    const todayHit = stripWord(text, _('today').toLowerCase());
    if (todayHit)
        return {date: dateStr(now), rest: todayHit.rest};

    const tomorrowHit = stripWord(text, _('tomorrow').toLowerCase());
    if (tomorrowHit)
        return {date: dateStr(now.add_days(1)), rest: tomorrowHit.rest};

    const nextWord = _('next').toLowerCase();
    for (const wd of localeWeekdays()) {
        const hit = stripWord(text, wd.full) ?? stripWord(text, wd.abbr);
        if (!hit)
            continue;
        // Drop an optional "next" before or after the weekday - it doesn't
        // change which date is meant.
        const withoutNext = stripWord(hit.rest, nextWord);
        return {date: dateStr(nextOccurrenceOf(wd.dow, now)), rest: withoutNext ? withoutNext.rest : hit.rest};
    }
    return null;
}

// Pulls a time out of `text`, trying the most specific/least ambiguous
// shapes first. A bare number is only ever treated as an hour when it's
// unambiguous - via am/pm, a minutes component, or a preceding "at" - never
// on its own (so a title like "Room 5 cleanup" doesn't lose "5" to this).
// Returns {time: 'HH:MM', rest} or null.
function extractTime(text, atWord) {
    const to24h = (h, ampm) => {
        h %= 12;
        if ((ampm ?? '').toLowerCase() === 'pm')
            h += 12;
        return h;
    };
    const pad = n => String(n).padStart(2, '0');
    // Patterns below may swallow a leading "<at> " so it is not left
    // behind for extractLocation to pick up.
    const optAt = atWord ? `(?:${escapeRegExp(atWord)}\\s+)?` : '';
    // Named times can also start a range ("noon-1pm").
    const noonWord = _('noon').toLowerCase();
    const midnightWord = _('midnight').toLowerCase();
    const namedTime = `(?:${escapeRegExp(noonWord)}|${escapeRegExp(midnightWord)})`;

    // Range pass, first: a range gives its START time and is cut whole.
    // A bare start inherits the end's am/pm ("3-4pm" -> 15:00). A dotted
    // token still needs an am/pm or "<at>" anchor, so a bare decimal
    // range is left alone. A bare end likewise needs "<at>" right before
    // the range ("call at 9-10"); otherwise it has no time anchor of its
    // own ("Version 2-3", "Meet 3-4") and this pass skips it, so a real
    // anchored time later ("... at 5pm") can still win. An invalid start
    // or end skips this pass and lets the branches below decide.
    const rangeToken = `(?:${namedTime}|\\d{1,2}:\\d{2}(?::\\d{2})?\\s*(?:am|pm)?|\\d{1,2}\\.\\d{2}\\s*(?:am|pm)?|\\d{1,2}h(?:\\d{2})?|\\d{1,2}\\s*(?:am|pm)|\\d{1,2})`;
    const parseRangeToken = raw => {
        const token = raw.toLowerCase();
        if (token === noonWord)
            return {time: '12:00', ampm: null, dotted: false};
        if (token === midnightWord)
            return {time: '00:00', ampm: null, dotted: false};
        let m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?$/.exec(token);
        if (m) {
            const hour   = parseInt(m[1], 10);
            const minute = parseInt(m[2], 10);
            const second = m[3] ? parseInt(m[3], 10) : null;
            if (minute > 59 || (second !== null && second > 59) ||
                (m[4] ? hour < 1 || hour > 12 : hour > 23))
                return null;
            return {hour, minute, ampm: m[4] ?? null, dotted: false};
        }
        m = /^(\d{1,2})\.(\d{2})\s*(am|pm)?$/.exec(token);
        if (m) {
            const hour   = parseInt(m[1], 10);
            const minute = parseInt(m[2], 10);
            if (minute > 59 || (m[3] ? hour < 1 || hour > 12 : hour > 23))
                return null;
            return {hour, minute, ampm: m[3] ?? null, dotted: true};
        }
        m = /^(\d{1,2})h(\d{2})?$/.exec(token);
        if (m) {
            const hour   = parseInt(m[1], 10);
            const minute = m[2] ? parseInt(m[2], 10) : 0;
            if (hour > 23 || minute > 59)
                return null;
            return {time: `${pad(hour)}:${pad(minute)}`, ampm: null, dotted: false};
        }
        m = /^(\d{1,2})\s*(am|pm)$/.exec(token);
        if (m) {
            const hour = parseInt(m[1], 10);
            if (hour < 1 || hour > 12)
                return null;
            return {hour, minute: 0, ampm: m[2], dotted: false};
        }
        m = /^(\d{1,2})$/.exec(token);
        if (m) {
            const hour = parseInt(m[1], 10);
            if (hour > 23)
                return null;
            return {hour, minute: 0, ampm: null, dotted: false, bare: true};
        }
        return null;
    };
    const resolveRangeStart = (start, end, hasAt) => {
        // Bare end with no "<at>" before the range: no anchor, whatever
        // the start's shape (named included, e.g. "noon-3") - skip.
        if (end.bare && !hasAt)
            return null;
        const anchored = hasAt || start.ampm || end.ampm;
        if ((start.dotted && !start.ampm && !anchored) ||
            (end.dotted && !end.ampm && !anchored))
            return null;
        if (start.time)
            return start.time;
        if (start.ampm)
            return `${pad(to24h(start.hour, start.ampm))}:${pad(start.minute)}`;
        if (end.ampm) {
            if (start.hour < 1 || start.hour > 12)
                return null;
            return `${pad(to24h(start.hour, end.ampm))}:${pad(start.minute)}`;
        }
        return `${pad(start.hour)}:${pad(start.minute)}`;
    };
    const rangeAt = atWord ? `(${escapeRegExp(atWord)}\\s+)?` : '()';
    for (const m of text.matchAll(new RegExp(`\\b${rangeAt}(${rangeToken})\\s*[-–]\\s*(${rangeToken})\\b`, 'giu'))) {
        const start = parseRangeToken(m[2]);
        const end   = parseRangeToken(m[3]);
        if (!start || !end)
            continue;
        const time = resolveRangeStart(start, end, !!m[1]);
        if (time)
            return {time, rest: cut(text, m)};
    }

    // Range prefixes for the branches below: swallow "<start> -" so a
    // fallback match after the dash cuts the whole range.
    const namedRangePrefix = `(?:${namedTime}\\s*[-–]\\s*)?`;
    const rangePrefix = `(?:(?:\\d{1,2}\\s*(?:am|pm)?|${namedTime})\\s*[-–]\\s*)?`;
    const colonRangePrefix = `(?:(?:\\d{1,2}:\\d{2}(?::\\d{2})?\\s*(?:am|pm)?|\\d{1,2}\\s*(?:am|pm)?|${namedTime})\\s*[-–]\\s*)?`;
    const dottedRangePrefix = `(?:(?:\\d{1,2}\\.\\d{2}\\s*(?:am|pm)?|\\d{1,2}\\s*(?:am|pm)?|${namedTime})\\s*[-–]\\s*)?`;

    // Colon form; invalid candidates are skipped so a later valid one wins.
    for (const m of text.matchAll(new RegExp(`\\b${optAt}${colonRangePrefix}(\\d{1,2}):(\\d{2})(?::(\\d{2}))?\\s*(am|pm)?\\b`, 'giu'))) {
        const rawHour = parseInt(m[1], 10);
        const minute  = parseInt(m[2], 10);
        const second  = m[3] ? parseInt(m[3], 10) : null;
        const valid   = minute <= 59 && (second === null || second <= 59) &&
                        (m[4] ? rawHour >= 1 && rawHour <= 12 : rawHour <= 23);
        if (valid) {
            const hour = m[4] ? to24h(rawHour, m[4]) : rawHour;
            return {time: `${pad(hour)}:${pad(minute)}`, rest: cut(text, m)};
        }
    }

    // Dotted form needs am/pm or "<at>": a bare decimal is not a time.
    const dottedAt = atWord ? `(${escapeRegExp(atWord)}\\s+)?` : '()';
    for (const m of text.matchAll(new RegExp(`\\b${dottedAt}${dottedRangePrefix}(\\d{1,2})\\.(\\d{2})\\s*(am|pm)?\\b`, 'giu'))) {
        if (!m[1] && !m[4])
            continue;
        const rawHour = parseInt(m[2], 10);
        const minute  = parseInt(m[3], 10);
        const valid   = minute <= 59 &&
                        (m[4] ? rawHour >= 1 && rawHour <= 12 : rawHour <= 23);
        if (valid) {
            const hour = m[4] ? to24h(rawHour, m[4]) : rawHour;
            return {time: `${pad(hour)}:${pad(minute)}`, rest: cut(text, m)};
        }
    }

    // "15h30" 24-hour shorthand; invalid candidates are skipped as above.
    for (const cand of text.matchAll(new RegExp(`\\b${optAt}${namedRangePrefix}([01]?\\d|2[0-3])h(\\d{2})?\\b`, 'giu'))) {
        const minute = cand[2] ? parseInt(cand[2], 10) : 0;
        if (minute <= 59)
            return {time: `${pad(parseInt(cand[1], 10))}:${pad(minute)}`, rest: cut(text, cand)};
    }

    // Bare hour with am/pm; invalid candidates are skipped as above.
    for (const cand of text.matchAll(new RegExp(`\\b${optAt}${rangePrefix}(\\d{1,2})\\s*(am|pm)\\b`, 'giu'))) {
        const rawHour = parseInt(cand[1], 10);
        if (rawHour >= 1 && rawHour <= 12)
            return {time: `${pad(to24h(rawHour, cand[2]))}:00`, rest: cut(text, cand)};
    }

    // Named times: noon is 12:00, midnight is 00:00. One right after a
    // dash is a range end, not a time of its own: the range pass above
    // already took ranges with a valid start, so a rejected start must
    // not let the end be taken instead ("Meet 9.30-noon" has no time).
    for (const [word, time] of [[noonWord, '12:00'], [midnightWord, '00:00']]) {
        for (const m of text.matchAll(new RegExp(`\\b${optAt}${escapeRegExp(word)}\\b`, 'giu'))) {
            if (/[-–]\s*$/.test(text.slice(0, m.index)))
                continue;
            return {time, rest: cut(text, m)};
        }
    }

    // Bare hour only after "<at>". Lookaheads reject colon times,
    // names like "7-Eleven" and decimals like "8.30".
    if (atWord) {
        const m = new RegExp(`\\b${escapeRegExp(atWord)}\\s+(\\d{1,2})(?!\\s*[:\\-])(?!\\.\\d)\\b`, 'iu').exec(text);
        if (m) {
            const rawHour = parseInt(m[1], 10);
            if (rawHour <= 23)
                return {time: `${pad(rawHour)}:00`, rest: cut(text, m)};
        }
    }

    return null;

    function cut(t, match) {
        return `${t.slice(0, match.index)} ${t.slice(match.index + match[0].length)}`
            .replace(/\s+/g, ' ').trim();
    }
}

// Pulls a trailing "<location marker> <place>" clause out of `text` - the
// marker is deliberately its own translation (see the pgettext comment up top),
// independent of the time preposition above. Takes the LAST match so a
// location clause always wins over an earlier, coincidental use of the same
// word elsewhere in the title. Returns {location, rest} or null.
function extractLocation(text, locationWord) {
    const re = new RegExp(`(^|\\s)${escapeRegExp(locationWord)}\\s+(.+)$`, 'iu');
    const m = re.exec(text);
    if (!m || !m[2].trim())
        return null;
    const location = m[2].trim();
    // A time-like token ("at 99", "at 13pm") is a failed time, not a
    // place. Trailing punctuation is ignored only for this check.
    const timeLike = location.replace(/[!?.,()-]+$/, '');
    if (/^(?:\d+|\d+:\d{2}(?::\d{2})?\s*(?:am|pm)?|\d+\.\d+\s*(?:am|pm)?|\d+\s*(?:am|pm)|\d+h\d{0,2}\s*(?:am|pm)?)$/iu.test(timeLike))
        return null;
    // noon/midnight are times, never places.
    if ([_('noon').toLowerCase(), _('midnight').toLowerCase()].includes(timeLike.toLowerCase()))
        return null;
    return {location, rest: text.slice(0, m.index).trim()};
}

// Parses a quick-add one-liner into a draft for EventPanel: whatever's
// recognized comes out as date/time/location, and everything left over
// (after removing those) becomes the title. Returns null only for
// empty/whitespace-only input - anything else always yields at least a
// title, even if nothing else was recognized, so the caller can open
// EventPanel prefilled with just that rather than silently doing nothing.
/**
 * @param {string} text
 */
export function parseQuickAdd(text) {
    let remaining = (text ?? '').trim();
    if (!remaining)
        return null;

    const now = GLib.DateTime.new_now_local();

    const dateHit = extractDate(remaining, now);
    let date = null;
    if (dateHit) {
        date      = dateHit.date;
        remaining = dateHit.rest;
    }

    const atTimeWord = pgettext('quick-add: time preposition, e.g. "lunch at 3pm"', 'at').toLowerCase();
    const timeHit = extractTime(remaining, atTimeWord);
    let time = null;
    if (timeHit) {
        time      = timeHit.time;
        remaining = timeHit.rest;
    }

    const locationWord = pgettext('quick-add: location marker, e.g. "lunch at the cafe"', 'at').toLowerCase();
    const locationHit = extractLocation(remaining, locationWord);
    let location = null;
    if (locationHit) {
        location  = locationHit.location;
        remaining = locationHit.rest;
    }

    return {title: remaining.trim(), date, time, location};
}
