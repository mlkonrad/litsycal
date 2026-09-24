// Time-of-day helpers for the event dialog's time fields. Times are carried
// around as minutes since midnight (0..1439) and stored as 'HH:MM'. Like
// quickAddParser.js, this module has no Shell-process dependency on purpose,
// so it can be unit-tested with plain `gjs`.

const pad = n => String(n).padStart(2, '0');

/**
 * @param {number} minutes minutes since midnight
 * @returns {string} 'HH:MM'
 */
export function toHHMM(minutes) {
    return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

/**
 * @param {string} str 'HH:MM' or 'H:MM'
 * @returns {number|null} minutes since midnight, or null if malformed
 */
export function fromHHMM(str) {
    const m = /^(\d{1,2}):(\d{2})$/.exec((str ?? '').trim());
    if (!m)
        return null;
    const h = parseInt(m[1], 10), min = parseInt(m[2], 10);
    if (h > 23 || min > 59)
        return null;
    return h * 60 + min;
}

/**
 * @param {number} minutes minutes since midnight
 * @param {string} timeFormat the 'time-format' setting, '24h' or '12h'
 * @returns {string} '14:05' or '2:05pm', same shapes as the rest of the UI
 */
export function formatTime(minutes, timeFormat) {
    const h = Math.floor(minutes / 60), min = minutes % 60;
    if (timeFormat !== '12h')
        return `${pad(h)}:${pad(min)}`;
    return `${h % 12 || 12}:${pad(min)}${h < 12 ? 'am' : 'pm'}`;
}

// Reads a typed time in whatever shape people tend to type one: "9", "09",
// "930", "0930", "9:30", "9.30", "9h30", "9h", "9:30pm", "9 pm", "9p",
// "21", "2130". Without am/pm the number is read as 24-hour; with it, the
// hour must be 1-12. Digits-only input of 3-4 characters splits as H:MM /
// HH:MM, never as a large hour.
/**
 * @param {string} text
 * @returns {number|null} minutes since midnight, or null if unrecognized
 */
export function parseTimeInput(text) {
    const s = (text ?? '').trim().toLowerCase().replace(/\s+/g, '');
    const m = /^(\d{1,4})(?:[:.h](\d{2})?)?(a|am|p|pm)?$/.exec(s);
    if (!m)
        return null;

    let digits = m[1];
    let minStr = m[2];
    if (minStr === undefined && digits.length > 2) {
        minStr = digits.slice(-2);
        digits = digits.slice(0, -2);
    } else if (minStr !== undefined && digits.length > 2) {
        return null;
    }

    let h = parseInt(digits, 10);
    const min = minStr === undefined ? 0 : parseInt(minStr, 10);
    if (min > 59)
        return null;

    const ampm = m[3];
    if (ampm) {
        if (h < 1 || h > 12)
            return null;
        h %= 12;
        if (ampm.startsWith('p'))
            h += 12;
    } else if (h > 23) {
        return null;
    }
    return h * 60 + min;
}

// A meeting's time span as one compact string: "3:00-4:30pm" (am/pm written
// once when both ends share it), "11:30am-1:00pm", "15:00-16:30". startDay/
// endDay are weekday labels for when the day matters; an endDay means the
// span crosses midnight, so both ends get written in full:
// "Mon 11:00pm - Tue 12:30am".
/**
 * @param {object} span
 * @param {number} span.startMin minutes since midnight
 * @param {number} span.endMin minutes since midnight
 * @param {string|null} [span.startDay] weekday label, or null to omit
 * @param {string|null} [span.endDay] weekday label when the end falls on a later day
 * @param {string} timeFormat the 'time-format' setting, '24h' or '12h'
 * @returns {string}
 */
export function formatTimeRange({startMin, endMin, startDay = null, endDay = null}, timeFormat) {
    const withDay = (day, text) => day ? `${day} ${text}` : text;
    let start = formatTime(startMin, timeFormat);
    const end = formatTime(endMin, timeFormat);
    if (endDay)
        return `${withDay(startDay, start)} – ${withDay(endDay, end)}`;
    if (startMin === endMin)
        return withDay(startDay, start);
    if (timeFormat === '12h' && (startMin < 720) === (endMin < 720))
        start = start.slice(0, -2);
    return withDay(startDay, `${start}–${end}`);
}
