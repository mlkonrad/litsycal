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
                const time = isAllDay ? null
                    : `${String(tObj.get_hour()).padStart(2,'0')}:${String(tObj.get_minute()).padStart(2,'0')}`;

                this._events.push({date, title, time, color, allDay: isAllDay,
                                   uid: comp.get_uid(), clientUid});
            } catch(_) {}
        }

        this._onEventsChanged(this._events);
    }

    // ── Create ────────────────────────────────────────────────────────────────

    createEvent(title, date, allDay, hour, minute, sourceUid, onDone) {
        const entry = this._clients.get(sourceUid);
        if (!entry) { onDone?.(new Error('Calendar not connected')); return; }

        const pad       = n => String(n).padStart(2, '0');
        const [y, m, d] = date.split('-').map(Number);

        let icalStr;
        if (allDay) {
            icalStr = [
                'BEGIN:VEVENT',
                `UID:${GLib.uuid_string_random()}`,
                `SUMMARY:${title}`,
                `DTSTART;VALUE=DATE:${y}${pad(m)}${pad(d)}`,
                `DTEND;VALUE=DATE:${y}${pad(m)}${pad(d + 1)}`,
                'END:VEVENT',
            ].join('\r\n');
        } else {
            const eh = (hour + (minute === 0 ? 1 : 0)) % 24;
            const em = minute === 0 ? 0 : minute;
            icalStr = [
                'BEGIN:VEVENT',
                `UID:${GLib.uuid_string_random()}`,
                `SUMMARY:${title}`,
                `DTSTART:${y}${pad(m)}${pad(d)}T${pad(hour)}${pad(minute)}00`,
                `DTEND:${y}${pad(m)}${pad(d)}T${pad(eh)}${pad(em)}00`,
                'END:VEVENT',
            ].join('\r\n');
        }

        const ical = ICalGLib.Component.new_from_string(icalStr);
        entry.client.create_object(ical, ECal.OperationFlags.NONE, null, (_obj, res) => {
            try {
                entry.client.create_object_finish(res);
                onDone?.(null);
                // View signals will auto-refresh; also force fetch as fallback
                if (this._year !== null)
                    this._fetchFromClient(sourceUid, this._year, this._month);
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
