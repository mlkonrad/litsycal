import EDataServer from 'gi://EDataServer';
import ECal        from 'gi://ECal';
import ICalGLib    from 'gi://ICalGLib';
import GLib        from 'gi://GLib';

// EDS calendar backends report colour in whatever format they like — hex,
// "rgb(r,g,b)"/"rgba(r,g,b,a)" (Google's backend switched to this after a
// colour change), or occasionally a named CSS colour. Normalizing to hex
// here, once, means every consumer downstream (day-cell dots, agenda pills,
// the event dialog's calendar picker, prefs.js's row) gets one predictable
// format instead of each needing to tolerate every backend's quirks — see
// the Pango-markup title that silently went blank on "rgb(...)" before this.
function normalizeColor(color, fallback = '#3584e4') {
    if (!color)
        return fallback;
    if (/^#[0-9a-f]{3,8}$/i.test(color))
        return color;
    const m = color.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
    if (m) {
        const hex = n => Number(n).toString(16).padStart(2, '0');
        return `#${hex(m[1])}${hex(m[2])}${hex(m[3])}`;
    }
    return color; // named colour or unrecognized format — CSS still accepts it
}

export class CalendarManager {
    constructor(settings, onEventsChanged) {
        this._settings  = settings;
        this._onEventsChanged = onEventsChanged;
        this._clients   = new Map();   // uid → {client, color, name}
        this._views     = new Map();   // uid → ECalClientView (live change listener)
        this._events    = [];
        this._byDate    = new Map();   // dateStr → Event[] (sorted, kept in sync with _events)
        this._registry  = null;
        this._year      = null;
        this._month     = null;
        this._available = false;
        this._disabled  = new Set(settings.get_strv('disabled-calendars'));
        this._disabledCalsSettingsId = settings.connect('changed::disabled-calendars', () => {
            this._disabled = new Set(settings.get_strv('disabled-calendars'));
            this._reindex();
            this._onEventsChanged(this._events);
        });
        this._initRegistry();
    }

    // ── Init ──────────────────────────────────────────────────────────────────

    _initRegistry() {
        try {
            EDataServer.SourceRegistry.new(null, (_obj, res) => {
                try {
                    this._registry  = EDataServer.SourceRegistry.new_finish(res);
                    this._available = true;
                    this._loadSources();

                    this._addedId    = this._registry.connect('source-added',
                        (_r, src) => this._connectSource(src));
                    this._removedId  = this._registry.connect('source-removed',
                        (_r, src) => this._dropSource(src.get_uid()));
                    this._enabledId  = this._registry.connect('source-enabled',
                        (_r, src) => this._connectSource(src));
                    this._disabledId = this._registry.connect('source-disabled',
                        (_r, src) => this._dropSource(src.get_uid()));
                } catch (e) {
                    logError(e, 'CalendarManager: registry init failed');
                }
            });
        } catch (e) {
            logError(e, 'CalendarManager: failed to start registry lookup');
        }
    }

    _loadSources() {
        if (!this._registry)
            return;
        const sources = this._registry.list_sources(EDataServer.SOURCE_EXTENSION_CALENDAR);
        for (const src of sources) {
            if (src.get_enabled() && !this._clients.has(src.get_uid()))
                this._connectSource(src);
        }
    }

    _connectSource(source) {
        if (!source.get_enabled())
            return;
        if (!source.has_extension(EDataServer.SOURCE_EXTENSION_CALENDAR))
            return;

        const uid    = source.get_uid();
        const calExt = source.get_extension(EDataServer.SOURCE_EXTENSION_CALENDAR);
        const color  = normalizeColor(calExt.get_color?.());
        const name   = source.get_display_name();

        ECal.Client.connect(source, ECal.ClientSourceType.EVENTS, 10, null, (_obj, res) => {
            try {
                const client = ECal.Client.connect_finish(res);
                this._clients.set(uid, {client, color, name});
                if (this._year !== null) {
                    this._fetchFromClient(uid, this._year, this._month);
                    this._startView(uid, client);
                }
            } catch (e) {
                logError(e, `CalendarManager: failed to connect to calendar source '${name}' (${uid})`);
            }
        });
    }

    _dropSource(uid) {
        this._stopView(uid);
        const entry = this._clients.get(uid);
        if (!entry)
            return;
        try {
            entry.client.disconnect(null);
        } catch {} // already gone; nothing actionable
        this._clients.delete(uid);
        this._events = this._events.filter(e => e.clientUid !== uid);
        this._reindex();
        this._onEventsChanged(this._events);
    }

    // ── Live view (change notifications) ──────────────────────────────────────

    _startView(uid, client) {
        client.get_view(this._rangeSexp(this._year, this._month), null, (_obj, res) => {
            try {
                const [, view] = client.get_view_finish(res);
                const refresh = () => {
                    if (this._year !== null)
                        this._fetchFromClient(uid, this._year, this._month);
                };
                view.connect('objects-added',    refresh);
                view.connect('objects-modified',  refresh);
                view.connect('objects-removed',   refresh);
                view.start();
                this._views.set(uid, view);
            } catch (e) {
                logError(e, `CalendarManager: failed to start live view for source ${uid}`);
            }
        });
    }

    _stopView(uid) {
        const view = this._views.get(uid);
        if (!view)
            return;
        try {
            view.stop();
        } catch {} // stop() can throw if the view is already stopped
        this._views.delete(uid);
    }

    _restartViews() {
        for (const uid of this._views.keys())
            this._stopView(uid);
        for (const [uid, {client}] of this._clients)
            this._startView(uid, client);
    }

    // ── Fetch ─────────────────────────────────────────────────────────────────

    fetchMonth(year, month) {
        this._year   = year;
        this._month  = month;
        this._events = [];
        if (this._clients.size === 0) {
            this._onEventsChanged([]);
            return;
        }
        this._restartViews();
        for (const uid of this._clients.keys())
            this._fetchFromClient(uid, year, month);
    }

    // Grid overflow buffer: the calendar can show up to 6 leading days from
    // the previous month (a partial first row) and, on the trailing side, up
    // to 6 days filling a partial last row plus MAX_EXTRA_WEEK_ROWS
    // dragged-in extra weeks (see extension.js's resize handle and
    // schemas/…gschema.xml's extra-week-rows max — keep these in sync).
    // Fetching only makes sense in whole-day units, so this pads a bit past
    // the exact worst case rather than tracking it to the day.
    _rangeSexp(year, month) {
        const MAX_EXTRA_WEEK_ROWS   = 5;
        const LEADING_OVERFLOW_DAYS  = 7;
        const TRAILING_OVERFLOW_DAYS = 7 + MAX_EXTRA_WEEK_ROWS * 7;

        const monthStart = GLib.DateTime.new_local(year, month, 1, 0, 0, 0);
        const rangeStart = monthStart.add_days(-LEADING_OVERFLOW_DAYS);
        const rangeEnd   = monthStart.add_months(1).add_days(TRAILING_OVERFLOW_DAYS);
        const stamp = dt => `${dt.get_year()}${String(dt.get_month()).padStart(2, '0')}` +
                             `${String(dt.get_day_of_month()).padStart(2, '0')}T000000Z`;
        return '(occur-in-time-range? ' +
               `(make-time "${stamp(rangeStart)}") ` +
               `(make-time "${stamp(rangeEnd)}"))`;
    }

    _fetchFromClient(uid, year, month) {
        const entry = this._clients.get(uid);
        if (!entry)
            return;
        const {client, color} = entry;

        const sexp = this._rangeSexp(year, month);

        client.get_object_list_as_comps(sexp, null, (_obj, res) => {
            try {
                const [, comps] = client.get_object_list_as_comps_finish(res);
                this._ingestComps(comps ?? [], color, uid);
            } catch (e) {
                logError(e, `CalendarManager: failed to fetch events for source ${uid}`);
                this._onEventsChanged(this._events);
            }
        });
    }

    _ingestComps(comps, color, clientUid) {
        this._events = this._events.filter(e => e.clientUid !== clientUid);

        for (const comp of comps) {
            try {
                const title  = comp.get_summary()?.get_value() ?? '';
                const tObj   = comp.get_dtstart()?.get_value();
                if (!tObj)
                    continue;

                const y = tObj.get_year();
                const m = tObj.get_month();
                const d = tObj.get_day();
                const date = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

                const isAllDay = tObj.is_date();
                let time = null;
                let endDate = null;
                if (!isAllDay) {
                    const pad = n => String(n).padStart(2, '0');
                    const startStr = `${pad(tObj.get_hour())}:${pad(tObj.get_minute())}`;
                    const eObj = comp.get_dtend()?.get_value();
                    const endStr = eObj && !eObj.is_date()
                        ? `${pad(eObj.get_hour())}:${pad(eObj.get_minute())}`
                        : null;
                    time = endStr ? `${startStr} - ${endStr}` : startStr;

                    if (eObj) {
                        const eDate = `${eObj.get_year()}-${String(eObj.get_month()).padStart(2, '0')}-${String(eObj.get_day()).padStart(2, '0')}`;
                        if (eDate !== date)
                            endDate = eDate;
                    }
                }

                let notes = null, url = null, location = null, recurrence = null, alarm = null,
                    recurrenceId = null;
                try {
                    const ic = comp.get_icalcomponent?.();
                    if (ic) {
                        notes = ic.get_description?.() || null;
                        const up = ic.get_first_property?.(ICalGLib.PropertyKind.URL_PROPERTY);
                        url = up ? up.get_value_as_string?.() || null : null;
                        location = ic.get_location?.() || null;
                        if (notes    === '')
                            notes    = null;
                        if (url      === '')
                            url      = null;
                        if (location === '')
                            location = null;

                        recurrence = this._parseRecurrence(ic);
                        alarm      = this._parseAlarm(ic);

                        // Present only on one occurrence of a recurring series (never
                        // on the master) — identifies which occurrence this is, so a
                        // "delete this event only" can target it specifically.
                        const ridProp = ic.get_first_property?.(ICalGLib.PropertyKind.RECURRENCEID_PROPERTY);
                        recurrenceId = ridProp ? ridProp.get_value_as_string?.() || null : null;
                    }
                } catch {} // notes/url/location/etc are optional extras; missing data is expected

                this._events.push({
                    date, title, time, color, allDay: isAllDay, endDate,
                    uid: comp.get_uid(), clientUid, notes, url,
                    location, recurrence, alarm, recurrenceId,
                });
            } catch (e) {
                logError(e, `CalendarManager: failed to parse calendar component ${comp.get_uid?.() ?? '?'}`);
            }
        }

        this._reindex();
        this._onEventsChanged(this._events);
    }

    // Only understands a plain FREQ/INTERVAL/UNTIL rule (what our UI can build).
    // Anything else (BYDAY, COUNT, multiple rules, ...) is kept as raw text so
    // editing an unrelated field never silently discards it.
    _parseRecurrence(ic) {
        const prop = ic.get_first_property?.(ICalGLib.PropertyKind.RRULE_PROPERTY);
        if (!prop)
            return null;
        try {
            const raw   = prop.get_value_as_string();
            const parts = Object.fromEntries(raw.split(';').map(kv => kv.split('=')));
            const isSimple = Object.keys(parts).every(k => ['FREQ', 'INTERVAL', 'UNTIL'].includes(k)) &&
                              ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(parts.FREQ);
            if (!isSimple)
                return {raw};

            const until = parts.UNTIL
                ? `${parts.UNTIL.slice(0, 4)}-${parts.UNTIL.slice(4, 6)}-${parts.UNTIL.slice(6, 8)}`
                : null;
            return {freq: parts.FREQ, interval: parts.INTERVAL ? parseInt(parts.INTERVAL) : 1, until};
        } catch {
            return {raw: prop.get_value_as_string?.() ?? ''};
        }
    }

    // Only understands a single DISPLAY alarm with a relative (before-start)
    // duration trigger (what our UI can build). Anything else (multiple
    // alarms, absolute triggers, EMAIL/AUDIO actions, ...) is kept as raw
    // VALARM blocks so editing an unrelated field never silently discards it.
    _parseAlarm(ic) {
        const n = ic.count_components?.(ICalGLib.ComponentKind.VALARM_COMPONENT) ?? 0;
        if (n === 0)
            return null;
        if (n > 1)
            return {raw: this._allValarmBlocks(ic)};

        const valarm = ic.get_first_component(ICalGLib.ComponentKind.VALARM_COMPONENT);
        try {
            const actionProp = valarm.get_first_property?.(ICalGLib.PropertyKind.ACTION_PROPERTY);
            const action     = actionProp?.get_value_as_string?.() ?? '';
            const trigProp = valarm.get_first_property?.(ICalGLib.PropertyKind.TRIGGER_PROPERTY);
            if (!trigProp || action !== 'DISPLAY')
                return {raw: this._allValarmBlocks(ic)};

            // A relative trigger's raw form is a DURATION ("-PT10M", "PT0S", ...);
            // an absolute one is a DATE-TIME. dur.is_null_duration() can't tell
            // "explicitly zero" from "unset", so classify by raw form instead.
            const raw = trigProp.get_value_as_string?.() ?? '';
            if (!/^[+-]?P/i.test(raw))
                return {raw: this._allValarmBlocks(ic)};

            const dur = trigProp.get_trigger().get_duration();
            return {minutesBefore: Math.round(-dur.as_int() / 60)};
        } catch {
            return {raw: this._allValarmBlocks(ic)};
        }
    }

    _allValarmBlocks(ic) {
        const blocks = [];
        let v = ic.get_first_component(ICalGLib.ComponentKind.VALARM_COMPONENT);
        while (v) {
            blocks.push(v.as_ical_string().trim());
            v = ic.get_next_component(ICalGLib.ComponentKind.VALARM_COMPONENT);
        }
        return blocks;
    }

    // ── Index ─────────────────────────────────────────────────────────────────

    _reindex() {
        this._byDate = new Map();
        for (const ev of this._events) {
            if (this._disabled.has(ev.clientUid))
                continue;
            for (const ds of this.datesSpanned(ev)) {
                let bucket = this._byDate.get(ds);
                if (!bucket) {
                    bucket = [];
                    this._byDate.set(ds, bucket);
                }
                bucket.push(ev);
            }
        }
        for (const bucket of this._byDate.values()) {
            bucket.sort((a, b) => {
                if (a.allDay && !b.allDay)
                    return -1;
                if (!a.allDay && b.allDay)
                    return  1;
                return (a.time ?? '').localeCompare(b.time ?? '');
            });
        }
    }

    getEventsForDate(ds) {
        return this._byDate.get(ds) ?? [];
    }

    // Dates (YYYY-MM-DD, inclusive) a multi-day event's dot/agenda entry
    // — and its calendar-grid hover highlight — should appear under: every
    // day it spans, not just its start day. Mirrors Itsycal's EventCenter,
    // which walks each event's date range and adds it to every day's
    // bucket rather than just the start date. Public because the hover
    // highlight (extension.js) needs the identical range.
    datesSpanned(ev) {
        if (!ev.endDate || ev.endDate === ev.date)
            return [ev.date];

        // An event ending exactly at midnight (e.g. 22:00 → 00:00 next day)
        // occupies zero minutes of its DTEND date — treat the day before as
        // the last spanned day. Mirrors Itsycal's identical fixup ("Fixup
        // for endDates that are at midnight") in its hover-highlight code.
        let lastDate = ev.endDate;
        if (ev.time?.split(' - ')[1]?.trim() === '00:00') {
            const [ey, em, ed] = ev.endDate.split('-').map(Number);
            const prev = GLib.DateTime.new_local(ey, em, ed, 0, 0, 0).add_days(-1);
            lastDate = `${prev.get_year()}-${String(prev.get_month()).padStart(2, '0')}-${String(prev.get_day_of_month()).padStart(2, '0')}`;
            if (lastDate === ev.date)
                return [ev.date];
        }

        const [sy, sm, sd] = ev.date.split('-').map(Number);
        let cur = GLib.DateTime.new_local(sy, sm, sd, 0, 0, 0);
        const dates = [];
        const MAX_SPAN_DAYS = 366; // guard against malformed/absurd ranges
        for (let i = 0; i < MAX_SPAN_DAYS; i++) {
            const ds = `${cur.get_year()}-${String(cur.get_month()).padStart(2, '0')}-${String(cur.get_day_of_month()).padStart(2, '0')}`;
            dates.push(ds);
            if (ds === lastDate)
                break;
            cur = cur.add_days(1);
        }
        return dates;
    }

    // ── iCal builder ─────────────────────────────────────────────────────────

    _buildRRuleLine(recurrence) {
        if (!recurrence)
            return [];
        if (recurrence.raw)
            return [`RRULE:${recurrence.raw}`];

        const pad = n => String(n).padStart(2, '0');
        let r = `FREQ=${recurrence.freq}`;
        if (recurrence.interval > 1)
            r += `;INTERVAL=${recurrence.interval}`;
        if (recurrence.until) {
            const [uy, um, ud] = recurrence.until.split('-').map(Number);
            r += `;UNTIL=${uy}${pad(um)}${pad(ud)}T235959Z`;
        }
        return [`RRULE:${r}`];
    }

    _buildValarmLines(alarm) {
        if (!alarm)
            return [];
        if (alarm.raw)
            return alarm.raw.flatMap(block => block.split(/\r?\n/).filter(Boolean));

        const min = alarm.minutesBefore;
        const days  = Math.floor(min / 1440);
        const rem   = min % 1440;
        const hours = Math.floor(rem / 60);
        const mins  = rem % 60;
        let trigger = min === 0 ? 'PT0M' : '-P';
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

    _buildICal(uid, fields) {
        const {
            title, date, allDay, hour, minute, endHour, endMinute, endDate,
            notes, url, location, recurrence, alarm,
        } = fields;
        const pad       = n => String(n).padStart(2, '0');
        const [y, m, d] = date.split('-').map(Number);
        const escText   = s => s.replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/,/g, '\\,');

        let dtLines;
        if (allDay) {
            dtLines = [
                `DTSTART;VALUE=DATE:${y}${pad(m)}${pad(d)}`,
                `DTEND;VALUE=DATE:${y}${pad(m)}${pad(d + 1)}`,
            ];
        } else {
            const [ey, em2, ed2] = (endDate ?? date).split('-').map(Number);
            dtLines = [
                `DTSTART:${y}${pad(m)}${pad(d)}T${pad(hour)}${pad(minute)}00`,
                `DTEND:${ey}${pad(em2)}${pad(ed2)}T${pad(endHour)}${pad(endMinute)}00`,
            ];
        }

        return [
            'BEGIN:VEVENT',
            `UID:${uid}`,
            `SUMMARY:${title}`,
            ...dtLines,
            ...notes    ? [`DESCRIPTION:${escText(notes)}`] : [],
            ...url      ? [`URL:${url}`]                    : [],
            ...location ? [`LOCATION:${escText(location)}`] : [],
            ...this._buildRRuleLine(recurrence),
            ...this._buildValarmLines(alarm),
            'END:VEVENT',
        ].join('\r\n');
    }

    // ── Create ────────────────────────────────────────────────────────────────

    createEvent(fields, sourceUid, onDone) {
        const entry = this._clients.get(sourceUid);
        if (!entry) {
            onDone?.(new Error('Calendar not connected'));
            return;
        }

        const icalStr = this._buildICal(GLib.uuid_string_random(), fields);
        const ical = ICalGLib.Component.new_from_string(icalStr);
        entry.client.create_object(ical, ECal.OperationFlags.NONE, null, (_obj, res) => {
            try {
                entry.client.create_object_finish(res);
                onDone?.(null);
                if (this._year !== null)
                    this._fetchFromClient(sourceUid, this._year, this._month);
            } catch (e) {
                onDone?.(e);
            }
        });
    }

    // ── Update ────────────────────────────────────────────────────────────────

    updateEvent(uid, clientUid, fields, onDone) {
        const entry = this._clients.get(clientUid);
        if (!entry) {
            onDone?.(new Error('Calendar not connected'));
            return;
        }

        const icalStr = this._buildICal(uid, fields);
        const ical = ICalGLib.Component.new_from_string(icalStr);
        entry.client.modify_object(ical, ECal.ObjModType.ALL, ECal.OperationFlags.NONE, null, (_obj, res) => {
            try {
                entry.client.modify_object_finish(res);
                onDone?.(null);
                if (this._year !== null)
                    this._fetchFromClient(clientUid, this._year, this._month);
            } catch (e) {
                onDone?.(e);
            }
        });
    }

    // ── Delete ────────────────────────────────────────────────────────────────

    // opts: {scope: 'ALL' | 'THIS' | 'FUTURE', recurrenceId}. scope defaults to
    // 'ALL' (the whole series, or a non-recurring event); 'THIS'/'FUTURE' need
    // recurrenceId to identify which occurrence.
    deleteEvent(uid, clientUid, opts, onDone) {
        const entry = this._clients.get(clientUid);
        if (!entry) {
            onDone?.(new Error('Calendar not connected'));
            return;
        }

        const {scope = 'ALL', recurrenceId = null} = opts ?? {};
        const modType = {
            ALL:    ECal.ObjModType.ALL,
            THIS:   ECal.ObjModType.THIS,
            FUTURE: ECal.ObjModType.THIS_AND_FUTURE,
        }[scope] ?? ECal.ObjModType.ALL;
        const rid = scope === 'ALL' ? null : recurrenceId;

        entry.client.remove_object(uid, rid, modType, ECal.OperationFlags.NONE, null, (_obj, res) => {
            try {
                entry.client.remove_object_finish(res);
                onDone?.(null);
                this._events = this._events.filter(e => !(e.uid === uid && e.clientUid === clientUid &&
                    (rid == null || e.recurrenceId === rid)));
                this._reindex();
                this._onEventsChanged(this._events);
            } catch (e) {
                onDone?.(e);
            }
        });
    }

    // ── Accessors ─────────────────────────────────────────────────────────────

    isAvailable() {
        return this._available;
    }

    getEvents()   {
        return this._events;
    }

    getSources()  {
        return [...this._clients.entries()]
            .filter(([uid]) => !this._disabled.has(uid))
            .map(([uid, {name, color}]) => ({uid, name, color}));
    }

    // ── Cleanup ───────────────────────────────────────────────────────────────

    destroy() {
        if (this._disabledCalsSettingsId) {
            this._settings.disconnect(this._disabledCalsSettingsId);
            this._disabledCalsSettingsId = null;
        }
        for (const uid of [...this._views.keys()])
            this._stopView(uid);
        if (this._registry) {
            for (const id of [this._addedId, this._removedId, this._enabledId, this._disabledId]) {
                try {
                    this._registry.disconnect(id);
                } catch {}
            }
        }
        for (const {client} of this._clients.values()) {
            try {
                client.disconnect(null);
            } catch {}
        }
        this._clients.clear();
        this._registry = null;
    }
}
