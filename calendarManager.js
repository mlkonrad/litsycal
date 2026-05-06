import EDataServer from 'gi://EDataServer';
import ECal        from 'gi://ECal';
import ICalGLib    from 'gi://ICalGLib';
import GLib        from 'gi://GLib';

export class CalendarManager {

    constructor(onEventsChanged) {
        this._onEventsChanged = onEventsChanged;
        this._clients   = new Map();   // uid → {client, color, name}
        this._views     = new Map();   // uid → ECalClientView (live change listener)
        this._events    = [];
        this._registry  = null;
        this._year      = null;
        this._month     = null;
        this._available = false;
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
                } catch(e) {
                    logError(e, 'CalendarManager: registry init failed');
                }
            });
        } catch(_) {}
    }

    _loadSources() {
        if (!this._registry) return;
        const sources = this._registry.list_sources(EDataServer.SOURCE_EXTENSION_CALENDAR);
        for (const src of sources) {
            if (src.get_enabled() && !this._clients.has(src.get_uid()))
                this._connectSource(src);
        }
    }

    _connectSource(source) {
        if (!source.get_enabled()) return;
        if (!source.has_extension(EDataServer.SOURCE_EXTENSION_CALENDAR)) return;

        const uid    = source.get_uid();
        const calExt = source.get_extension(EDataServer.SOURCE_EXTENSION_CALENDAR);
        const color  = calExt.get_color?.() ?? '#3584e4';
        const name   = source.get_display_name();

        ECal.Client.connect(source, ECal.ClientSourceType.EVENTS, 10, null, (_obj, res) => {
            try {
                const client = ECal.Client.connect_finish(res);
                this._clients.set(uid, {client, color, name});
                if (this._year !== null) {
                    this._fetchFromClient(uid, this._year, this._month);
                    this._startView(uid, client);
                }
            } catch(_) {}
        });
    }

    _dropSource(uid) {
        this._stopView(uid);
        const entry = this._clients.get(uid);
        if (!entry) return;
        try { entry.client.disconnect(null); } catch(_) {}
        this._clients.delete(uid);
        this._events = this._events.filter(e => e.clientUid !== uid);
        this._onEventsChanged(this._events);
    }

    // ── Live view (change notifications) ──────────────────────────────────────

    _sexp() {
        const pad = n => String(n).padStart(2, '0');
        const nm  = this._month === 12 ? 1 : this._month + 1;
        const ny  = this._month === 12 ? this._year + 1 : this._year;
        return `(occur-in-time-range? ` +
               `(make-time "${this._year}${pad(this._month)}01T000000Z") ` +
               `(make-time "${ny}${pad(nm)}01T000000Z"))`;
    }

    _startView(uid, client) {
        client.get_view(this._sexp(), null, (_obj, res) => {
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
            } catch(_) {}
        });
    }

    _stopView(uid) {
        const view = this._views.get(uid);
        if (!view) return;
        try { view.stop(); } catch(_) {}
        this._views.delete(uid);
    }

    _restartViews() {
        for (const uid of this._views.keys()) this._stopView(uid);
        for (const [uid, {client}] of this._clients) this._startView(uid, client);
    }

    // ── Fetch ─────────────────────────────────────────────────────────────────

    fetchMonth(year, month) {
        this._year   = year;
        this._month  = month;
        this._events = [];
        if (this._clients.size === 0) { this._onEventsChanged([]); return; }
        this._restartViews();
        for (const uid of this._clients.keys())
            this._fetchFromClient(uid, year, month);
    }

    _fetchFromClient(uid, year, month) {
        const entry = this._clients.get(uid);
        if (!entry) return;
        const {client, color} = entry;

        const pad = n => String(n).padStart(2, '0');
        const nm  = month === 12 ? 1 : month + 1;
        const ny  = month === 12 ? year + 1 : year;
        const sexp = `(occur-in-time-range? ` +
                     `(make-time "${year}${pad(month)}01T000000Z") ` +
                     `(make-time "${ny}${pad(nm)}01T000000Z"))`;

        client.get_object_list_as_comps(sexp, null, (_obj, res) => {
            try {
                const [, comps] = client.get_object_list_as_comps_finish(res);
                this._ingestComps(comps ?? [], color, uid);
            } catch(_) {
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
                if (!tObj) continue;

                const y = tObj.get_year();
                const m = tObj.get_month();
                const d = tObj.get_day();
                const date = `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;

                const isAllDay = tObj.is_date();
                let time = null;
                if (!isAllDay) {
                    const pad = n => String(n).padStart(2, '0');
                    const startStr = `${pad(tObj.get_hour())}:${pad(tObj.get_minute())}`;
                    const eObj = comp.get_dtend()?.get_value();
                    const endStr = eObj && !eObj.is_date()
                        ? `${pad(eObj.get_hour())}:${pad(eObj.get_minute())}`
                        : null;
                    time = endStr ? `${startStr} - ${endStr}` : startStr;
                }

                let notes = null, url = null;
                try {
                    const ic = comp.get_icalcomponent?.();
                    if (ic) {
                        notes = ic.get_description?.() || null;
                        const up = ic.get_first_property?.(ICalGLib.PropertyKind.URL_PROPERTY);
                        url = up ? (up.get_value?.() || null) : null;
                        if (notes === '') notes = null;
                        if (url   === '') url   = null;
                    }
                } catch(_) {}

                this._events.push({date, title, time, color, allDay: isAllDay,
                                   uid: comp.get_uid(), clientUid, notes, url});
            } catch(_) {}
        }

        this._onEventsChanged(this._events);
    }

    // ── iCal builder ─────────────────────────────────────────────────────────

    _buildICal(uid, title, date, allDay, hour, minute, endHour, endMinute, endDate, notes, url) {
        const pad       = n => String(n).padStart(2, '0');
        const [y, m, d] = date.split('-').map(Number);
        const escDesc   = s => s.replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/,/g, '\\,');

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
            ...(notes ? [`DESCRIPTION:${escDesc(notes)}`] : []),
            ...(url   ? [`URL:${url}`]                    : []),
            'END:VEVENT',
        ].join('\r\n');
    }

    // ── Create ────────────────────────────────────────────────────────────────

    createEvent(title, date, allDay, hour, minute, endHour, endMinute, endDate,
                notes, url, sourceUid, onDone) {
        const entry = this._clients.get(sourceUid);
        if (!entry) { onDone?.(new Error('Calendar not connected')); return; }

        const icalStr = this._buildICal(
            GLib.uuid_string_random(), title, date, allDay,
            hour, minute, endHour, endMinute, endDate, notes, url
        );
        const ical = ICalGLib.Component.new_from_string(icalStr);
        entry.client.create_object(ical, ECal.OperationFlags.NONE, null, (_obj, res) => {
            try {
                entry.client.create_object_finish(res);
                onDone?.(null);
                if (this._year !== null)
                    this._fetchFromClient(sourceUid, this._year, this._month);
            } catch(e) { onDone?.(e); }
        });
    }

    // ── Update ────────────────────────────────────────────────────────────────

    updateEvent(uid, clientUid, props, onDone) {
        const entry = this._clients.get(clientUid);
        if (!entry) { onDone?.(new Error('Calendar not connected')); return; }

        const {title, date, allDay, hour, minute, endDate, endHour, endMinute, notes, url} = props;
        const icalStr = this._buildICal(
            uid, title, date, allDay, hour, minute, endHour, endMinute, endDate, notes, url
        );
        const ical = ICalGLib.Component.new_from_string(icalStr);
        entry.client.modify_object(ical, ECal.ObjModType.ALL, ECal.OperationFlags.NONE, null, (_obj, res) => {
            try {
                entry.client.modify_object_finish(res);
                onDone?.(null);
                if (this._year !== null)
                    this._fetchFromClient(clientUid, this._year, this._month);
            } catch(e) { onDone?.(e); }
        });
    }

    // ── Delete ────────────────────────────────────────────────────────────────

    deleteEvent(uid, clientUid, onDone) {
        const entry = this._clients.get(clientUid);
        if (!entry) { onDone?.(new Error('Calendar not connected')); return; }

        entry.client.remove_object(uid, null, ECal.ObjModType.ALL, ECal.OperationFlags.NONE, null, (_obj, res) => {
            try {
                entry.client.remove_object_finish(res);
                onDone?.(null);
                this._events = this._events.filter(e => !(e.uid === uid && e.clientUid === clientUid));
                this._onEventsChanged(this._events);
            } catch(e) { onDone?.(e); }
        });
    }

    // ── Accessors ─────────────────────────────────────────────────────────────

    isAvailable() { return this._available; }
    getEvents()   { return this._events; }
    getSources()  {
        return [...this._clients.entries()].map(([uid, {name, color}]) => ({uid, name, color}));
    }

    // ── Cleanup ───────────────────────────────────────────────────────────────

    destroy() {
        for (const uid of [...this._views.keys()]) this._stopView(uid);
        if (this._registry) {
            for (const id of [this._addedId, this._removedId, this._enabledId, this._disabledId])
                try { this._registry.disconnect(id); } catch(_) {}
        }
        for (const {client} of this._clients.values())
            try { client.disconnect(null); } catch(_) {}
        this._clients.clear();
        this._registry = null;
    }
}
