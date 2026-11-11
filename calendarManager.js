import GLib from 'gi://GLib';
import Gio  from 'gi://Gio';

import {MAX_EXTRA_WEEK_ROWS} from './helpers.js';
import {allDayEndDate, buildICal, parseAlarm, parseRecurrence} from './ical.js';
import {applyTaskCompletion, collectOverrideKeys, expandRecurring, isDetached} from './recurrence.js';

// Evolution Data Server typelibs (EDataServer/ECal/ICalGLib) aren't
// guaranteed to be installed - a static top-level import throws at module
// load and takes down the whole extension, so they're loaded lazily by
// _loadBackends() below (same pattern as Geoclue/GWeather in prefs.js).
// Every use below only runs once these are non-null (see _loadBackends()).
// The static ical.js import above is safe on such a system: it imports
// only GLib and receives ICalGLib as a function parameter instead, and so
// does recurrence.js (which receives ECal too).
let EDataServer = null;
let ECal = null;
let ICalGLib = null;

// How often the registry's private main context is run (see _initRegistry()):
// quickly until the registry exists, so calendars load without delay, then
// every few seconds - how soon calendars added, removed, enabled or disabled
// elsewhere show up here. Event changes don't wait on this; they arrive
// through the clients' own views on the Shell's main context.
const REGISTRY_STARTUP_PUMP_MS  = 100;
const REGISTRY_PUMP_INTERVAL_S  = 5;

// EDS calendar backends report colour in whatever format they like - hex,
// "rgb(r,g,b)"/"rgba(r,g,b,a)" (Google's backend, after a colour change), or
// occasionally a named CSS colour. Normalizing to hex here, once, gives every
// consumer downstream (day-cell dots, agenda pills, the event dialog's
// calendar picker) one predictable format.
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
    return color; // named colour or unrecognized format - CSS still accepts it
}

// An EDS call cut short by destroy() cancelling this._cancellable: not a
// failure worth logging, and there's nothing left for its callback to update.
function isCancelled(e) {
    return e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

export class CalendarManager {
    constructor(settings, onEventsChanged) {
        this._settings  = settings;
        this._onEventsChanged = onEventsChanged;
        this._clients   = new Map();   // uid -> {client, color, name, kind: 'events'|'tasks'}
        this._views     = new Map();   // uid -> {view} (live change listener)
        this._viewTokens = new Map();  // uid -> latest view request; see _startView()
        this._cancellable = new Gio.Cancellable();
        this._events    = [];
        this._byDate    = new Map();   // dateStr -> Event[] (sorted, kept in sync with _events)
        this._registry    = null;
        this._registryContext        = null;
        this._registryStartupPumpId  = null;
        this._registryPumpId         = null;
        this._year        = null;
        this._month       = null;
        this._available   = false;
        this._searchToken = 0; // see searchEvents() - discards stale/out-of-order results
        this._fetchToken  = 0; // see fetchMonth() - discards a superseded batch's stale onDone
        this._disabled  = new Set(settings.get_strv('disabled-calendars'));
        this._readReminderSettings();
        const reindex = () => {
            this._reindex();
            this._onEventsChanged(this._events);
        };
        settings.connectObject(
            'changed::disabled-calendars', () => {
                this._disabled = new Set(settings.get_strv('disabled-calendars'));
                reindex();
            },
            'changed::show-reminders', () => {
                this._readReminderSettings();
                reindex();
            },
            'changed::show-completed-reminders', () => {
                this._readReminderSettings();
                reindex();
            },
            'changed::show-overdue-reminders', () => {
                this._readReminderSettings();
                reindex();
            },
            this);
        // GNOME Shell doesn't disable extensions before it exits, so
        // destroy() never runs then. The registry is freed during GJS's own
        // teardown instead, and its dispose dispatches whatever it still has
        // queued (see _initRegistry()) - which must not reach our handlers
        // while GJS is shutting down.
        global.connectObject('shutdown', () => this._registry?.disconnectObject(this), this);
        this._loadBackends();
    }

    _readReminderSettings() {
        this._showReminders          = this._settings.get_boolean('show-reminders');
        this._showCompletedReminders = this._settings.get_boolean('show-completed-reminders');
        this._showOverdueReminders   = this._settings.get_boolean('show-overdue-reminders');
    }

    // Init

    // Loads the optional Evolution Data Server typelibs dynamically: on a
    // system without them (e.g. Debian without evolution-data-server) the
    // import fails, and a static import would have taken down the whole
    // extension before any code ran. On failure _available stays false -
    // the calendar grid, badge and clocks keep working without events, and
    // isAvailable() already blocks create/search/edit in calendarWidget.js.
    // Never throws.
    async _loadBackends() {
        try {
            const [eds, ecal, ical] = await Promise.all([
                import('gi://EDataServer'),
                import('gi://ECal'),
                import('gi://ICalGLib'),
            ]);
            EDataServer = eds.default;
            ECal = ecal.default;
            ICalGLib = ical.default;
        } catch (e) {
            logError(e, 'CalendarManager: Evolution Data Server libraries not found - calendar events unavailable');
            return;
        }
        if (this._cancellable.is_cancelled())
            return;
        this._initRegistry();
    }

    // The registry lives on a private main context, not the Shell's.
    // ESourceRegistry dispatches its signals (and its ESources') on whatever
    // context was thread-default when it was created, and its dispose drains
    // that same context. On the Shell's context, that drain ran from
    // whichever GC finally freed the registry - at Shell exit, GJS's own
    // teardown, where it dispatched GJS's promise-queue child source, whose
    // callback is NULL, and gnome-shell segfaulted on every logout. On a
    // private context the drain only ever runs EDS's own callbacks. Nothing
    // runs that context for us, so _pumpRegistry() does, on a timer.
    // Only the registry itself belongs on the private context: ECal clients
    // connected from its callbacks are pinned to the Shell's context in
    // _connectSource().
    _initRegistry() {
        this._registryContext = new GLib.MainContext();
        this._registryContext.push_thread_default();
        EDataServer.SourceRegistry.new(this._cancellable, (_obj, res) => {
            // Already removed when this arrives from destroy()'s last pump.
            if (this._registryStartupPumpId) {
                GLib.source_remove(this._registryStartupPumpId);
                this._registryStartupPumpId = null;
            }
            try {
                this._registry  = EDataServer.SourceRegistry.new_finish(res);
                if (this._registryPumpId) {
                    GLib.source_remove(this._registryPumpId);
                    this._registryPumpId = null;
                }
                this._registryPumpId = GLib.timeout_add_seconds(
                    GLib.PRIORITY_DEFAULT, REGISTRY_PUMP_INTERVAL_S, () => {
                        this._pumpRegistry();
                        return GLib.SOURCE_CONTINUE;
                    });
                this._available = true;

                this._registry.connectObject(
                    'source-added', (_r, src) => this._connectSource(src),
                    'source-removed', (_r, src) => this._dropSource(src.get_uid()),
                    'source-enabled', (_r, src) => this._connectSource(src),
                    'source-disabled', (_r, src) => this._dropSource(src.get_uid()),
                    this);
                this._loadSources();
            } catch (e) {
                if (!isCancelled(e))
                    logError(e, 'CalendarManager: registry init failed');
            }
        });
        this._registryContext.pop_thread_default();
        if (this._registryStartupPumpId) {
            GLib.source_remove(this._registryStartupPumpId);
            this._registryStartupPumpId = null;
        }
        this._registryStartupPumpId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, REGISTRY_STARTUP_PUMP_MS, () => {
                this._pumpRegistry();
                return GLib.SOURCE_CONTINUE;
            });
    }

    // Dispatches whatever the registry has queued on its private context.
    _pumpRegistry() {
        // _initRegistry() may never have run (backends failed to load, or
        // destroy() beat the async load) - nothing to pump then.
        if (!this._registryContext)
            return;
        while (this._registryContext.pending())
            this._registryContext.iteration(false);
    }

    _loadSources() {
        if (!this._registry)
            return;
        const sources = [
            ...this._registry.list_sources(EDataServer.SOURCE_EXTENSION_CALENDAR),
            ...this._registry.list_sources(EDataServer.SOURCE_EXTENSION_TASK_LIST),
        ];
        for (const src of sources) {
            if (src.get_enabled() && !this._clients.has(src.get_uid()))
                this._connectSource(src);
        }
    }

    // Calendars give events, task lists give reminders. EDS keeps the two in
    // separate sources; one that somehow carries both is read as a calendar,
    // since clients are keyed by source uid.
    _connectSource(source) {
        if (!source.get_enabled())
            return;
        let kind, extName, sourceType;
        if (source.has_extension(EDataServer.SOURCE_EXTENSION_CALENDAR)) {
            kind = 'events';
            extName = EDataServer.SOURCE_EXTENSION_CALENDAR;
            sourceType = ECal.ClientSourceType.EVENTS;
        } else if (source.has_extension(EDataServer.SOURCE_EXTENSION_TASK_LIST)) {
            kind = 'tasks';
            extName = EDataServer.SOURCE_EXTENSION_TASK_LIST;
            sourceType = ECal.ClientSourceType.TASKS;
        } else {
            return;
        }

        const uid    = source.get_uid();
        const color  = normalizeColor(source.get_extension(extName).get_color());
        const name   = source.get_display_name();

        // A client dispatches everything (this callback included) on the
        // context that is thread-default when it's created. This can run
        // from the registry's creation callback, which GTask invokes with
        // the registry's private context pushed as thread-default (see
        // _initRegistry()), so the Shell's context is pushed explicitly.
        const shellContext = GLib.MainContext.default();
        shellContext.push_thread_default();
        ECal.Client.connect(source, sourceType, 10, this._cancellable, (_obj, res) => {
            try {
                const client = ECal.Client.connect_finish(res);
                this._clients.set(uid, {client, color, name, kind});
                if (this._year !== null) {
                    this._fetchFromClient(uid, this._year, this._month);
                    this._startView(uid, client);
                }
            } catch (e) {
                if (!isCancelled(e))
                    logError(e, `CalendarManager: failed to connect to calendar source '${name}' (${uid})`);
            }
        });
        shellContext.pop_thread_default();
    }

    _dropSource(uid) {
        this._stopView(uid);
        if (!this._clients.delete(uid))
            return;
        this._events = this._events.filter(e => e.clientUid !== uid);
        this._reindex();
        this._onEventsChanged(this._events);
    }

    // Live view (change notifications)

    // get_view() is async, so two quick month changes can leave two requests
    // for the same source in flight. Every start/stop bumps that source's
    // token, and a response for an older token is dropped instead of
    // replacing (and leaking) the view that should stay.
    _startView(uid, client) {
        const token = this._bumpViewToken(uid);
        const sexp = this._sexpFor(this._clients.get(uid).kind, this._year, this._month);
        client.get_view(sexp, this._cancellable, (_obj, res) => {
            try {
                const [, view] = client.get_view_finish(res);
                if (token !== this._viewTokens.get(uid))
                    return;
                const refresh = () => {
                    if (this._year !== null)
                        this._fetchFromClient(uid, this._year, this._month);
                };
                view.connectObject(
                    'objects-added', refresh,
                    'objects-modified', refresh,
                    'objects-removed', refresh,
                    this);
                this._views.set(uid, {view});
                view.start();
            } catch (e) {
                if (!isCancelled(e))
                    logError(e, `CalendarManager: failed to start live view for source ${uid}`);
            }
        });
    }

    _stopView(uid) {
        this._bumpViewToken(uid);
        const entry = this._views.get(uid);
        if (!entry)
            return;
        entry.view.disconnectObject(this);
        try {
            entry.view.stop();
        } catch {} // stop() can throw if the view is already stopped
        this._views.delete(uid);
    }

    _bumpViewToken(uid) {
        const token = (this._viewTokens.get(uid) ?? 0) + 1;
        this._viewTokens.set(uid, token);
        return token;
    }

    _restartViews() {
        for (const uid of this._views.keys())
            this._stopView(uid);
        for (const [uid, {client}] of this._clients)
            this._startView(uid, client);
    }

    // Manual refresh (Ctrl+Alt+R)
    // fetchMonth() below only re-reads whatever EDS already has cached
    // locally - it never asks a backend like Google's own to go check for
    // anything new; EDS polls that on its own schedule (commonly ~30 min),
    // so a plain fetchMonth() right after a remote change can visibly do
    // nothing. This asks each backend that supports it to sync now; any
    // resulting changes land in EDS's cache and reach us automatically via
    // the live view's own 'objects-added'/'objects-modified' signals
    // (_startView above), so there's no need to re-fetch here ourselves.
    refreshFromServer() {
        for (const {client} of this._clients.values()) {
            if (!client.check_refresh_supported())
                continue;
            client.refresh(this._cancellable, (obj, res) => {
                try {
                    obj.refresh_finish(res);
                } catch (e) {
                    if (!isCancelled(e))
                        logError(e, 'CalendarManager: refresh failed');
                }
            });
        }
    }

    // Fetch

    // onDone, if given, fires once every connected client has responded to
    // this specific call - not on the general live-update path (source
    // added/changed events also call _fetchFromClient for just one client,
    // without this aggregation). _fetchToken guards against a batch from a
    // superseded fetchMonth call (e.g. the user navigated to another month
    // again before this one's clients all finished) still counting down and
    // firing a stale onDone.
    fetchMonth(year, month, onDone) {
        this._year   = year;
        this._month  = month;
        this._events = [];
        const token = ++this._fetchToken;
        if (this._clients.size === 0) {
            this._onEventsChanged([]);
            onDone?.();
            return;
        }
        this._restartViews();
        const state = {pending: this._clients.size};
        for (const uid of this._clients.keys()) {
            this._fetchFromClient(uid, year, month, () => {
                if (token !== this._fetchToken)
                    return;
                state.pending--;
                if (state.pending === 0)
                    onDone?.();
            });
        }
    }

    // Search (independent of the month cache above)
    //
    // A one-off query across every connected calendar, over a wide-but-bounded
    // time window (+/-1 year - wide enough to find "that thing from a few
    // months back" without an unbounded query against a backend with years
    // of history). EDS does the text filtering itself (the (contains? ...)
    // clauses below run server/backend-side), so this stays fast even with
    // several calendars - never touches this._events/_byDate, the grid's own
    // month cache, so it can't disturb whatever's currently displayed.
    //
    // callback(events) fires once, with every match across every source,
    // sorted by date/time. Stale results - a slower-to-respond earlier
    // search finishing after a newer one already has - are silently
    // discarded via _searchToken rather than clobbering fresher results.
    //
    // A repeating series is one hit, dated at its first occurrence: search
    // returns the master components as-is, without the expansion
    // _ingestComps() does for the month view.
    searchEvents(text, callback) {
        const token = ++this._searchToken;
        const query = (text ?? '').trim();
        // Same disabled-calendar exclusion as getSources()/_reindex() - a
        // calendar the user hid shouldn't resurface through search, letting
        // a result navigate to and open an event from it anyway.
        // Reminders aren't searched, as in Itsycal.
        const uids = [...this._clients.keys()].filter(uid =>
            !this._disabled.has(uid) && this._clients.get(uid).kind === 'events');
        if (!query || uids.length === 0) {
            callback([]);
            return;
        }

        const now   = GLib.DateTime.new_now_local();
        const start = now.add_years(-1);
        const end   = now.add_years(1);
        const needle = this._escapeSexpString(query);
        const sexp = '(and ' +
            `(occur-in-time-range? (make-time "${this._stamp(start)}") (make-time "${this._stamp(end)}")) ` +
            '(or ' +
            `(contains? "summary" "${needle}") ` +
            `(contains? "description" "${needle}") ` +
            `(contains? "location" "${needle}")))`;

        // {pending, results} is one shared, mutable object rather than two
        // separate outer variables closed over from inside a loop - see
        // _searchClient below, called once per source instead of defining
        // the completion closure directly in this loop.
        const state = {pending: uids.length, results: []};
        for (const uid of uids)
            this._searchClient(uid, sexp, token, state, callback);
    }

    _searchClient(uid, sexp, token, state, callback) {
        const {client, color} = this._clients.get(uid);
        client.get_object_list_as_comps(sexp, this._cancellable, (_obj, res) => {
            if (token !== this._searchToken)
                return; // superseded by a newer search - drop this result
            try {
                const [, comps] = client.get_object_list_as_comps_finish(res);
                for (const comp of comps ?? []) {
                    const ev = this._parseComp(comp, color, uid);
                    if (ev)
                        state.results.push(ev);
                }
            } catch (e) {
                if (isCancelled(e))
                    return;
                logError(e, `CalendarManager: search failed for source ${uid}`);
            }
            state.pending--;
            if (state.pending === 0) {
                state.results.sort((a, b) => `${a.date} ${a.time ?? ''}`.localeCompare(`${b.date} ${b.time ?? ''}`));
                callback(state.results);
            }
        });
    }

    // Lisp string-literal escaping for the search text embedded above -
    // correctness (a title containing a literal `"` would otherwise corrupt
    // the S-expression), not a security boundary.
    _escapeSexpString(s) {
        return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    }

    _stamp(dt) {
        return `${dt.get_year()}${String(dt.get_month()).padStart(2, '0')}` +
               `${String(dt.get_day_of_month()).padStart(2, '0')}T000000Z`;
    }

    // Grid overflow buffer: the calendar can show up to 6 leading days from
    // the previous month (a partial first row) and, on the trailing side, up
    // to 6 days filling a partial last row plus MAX_EXTRA_WEEK_ROWS
    // dragged-in extra weeks (see calendarWidget.js's resize handle).
    // Fetching only makes sense in whole-day units, so this pads a bit past
    // the exact worst case rather than tracking it to the day.
    _rangeBounds(year, month) {
        const LEADING_OVERFLOW_DAYS  = 7;
        const TRAILING_OVERFLOW_DAYS = 7 + MAX_EXTRA_WEEK_ROWS * 7;

        const monthStart = GLib.DateTime.new_local(year, month, 1, 0, 0, 0);
        return {
            start: monthStart.add_days(-LEADING_OVERFLOW_DAYS),
            end:   monthStart.add_months(1).add_days(TRAILING_OVERFLOW_DAYS),
        };
    }

    _rangeSexp(year, month) {
        const {start, end} = this._rangeBounds(year, month);
        return '(occur-in-time-range? ' +
               `(make-time "${this._stamp(start)}") ` +
               `(make-time "${this._stamp(end)}"))`;
    }

    // A task list is read whole (#t) and filtered in JS: lists are small,
    // and an overdue reminder is due before the fetched range, which
    // occur-in-time-range? would leave out.
    _sexpFor(kind, year, month) {
        return kind === 'tasks' ? '#t' : this._rangeSexp(year, month);
    }

    // onDone (optional) fires once this one client's fetch finishes, success
    // or failure - used by fetchMonth() above to know when every client in
    // one batch has responded. Every other caller (live-update refetch of
    // a single client) just omits it.
    _fetchFromClient(uid, year, month, onDone) {
        const entry = this._clients.get(uid);
        if (!entry) {
            onDone?.();
            return;
        }
        const {client, color, kind, name} = entry;

        const sexp = this._sexpFor(kind, year, month);

        client.get_object_list_as_comps(sexp, this._cancellable, (_obj, res) => {
            try {
                const [, comps] = client.get_object_list_as_comps_finish(res);
                if (kind === 'tasks')
                    this._ingestTasks(comps ?? [], color, uid, name);
                else
                    this._ingestComps(comps ?? [], color, uid, year, month);
            } catch (e) {
                if (isCancelled(e))
                    return;
                logError(e, `CalendarManager: failed to fetch events for source ${uid}`);
                this._onEventsChanged(this._events);
            }
            onDone?.();
        });
    }

    // A recurring master is expanded into one event per occurrence in the
    // fetched range (see recurrence.js), over the same range the query
    // itself used. A detached occurrence that was moved out of that range
    // isn't returned by the query, so the slot it left still shows the
    // generated occurrence until the series is fetched for a range that
    // includes the moved one.
    _ingestComps(comps, color, clientUid, year, month) {
        this._events = this._events.filter(e => e.clientUid !== clientUid);

        const {start, end} = this._rangeBounds(year, month);
        const rangeStart = ICalGLib.Time.new_from_string(this._stamp(start));
        const rangeEnd   = ICalGLib.Time.new_from_string(this._stamp(end));
        const ics = comps.map(c => c.get_icalcomponent()).filter(Boolean);
        const overrides = collectOverrideKeys(ICalGLib, ics);
        const localTz = this._resolveLocalTimezone();

        for (const comp of comps) {
            const ic = comp.get_icalcomponent();
            if (!ic || !comp.has_recurrences() || isDetached(ICalGLib, ic)) {
                const ev = this._parseComp(comp, color, clientUid);
                if (ev)
                    this._events.push(ev);
                continue;
            }
            let instances;
            try {
                instances = expandRecurring(ECal, ICalGLib, ic, rangeStart, rangeEnd, localTz,
                    overrides.get(comp.get_uid()));
            } catch (e) {
                logError(e, `CalendarManager: failed to expand recurring event ${comp.get_uid() ?? '?'}`);
                continue;
            }
            const master = this._parseComp(comp, color, clientUid);
            for (const instance of instances) {
                const ev = this._parseComp(comp, color, clientUid, instance);
                if (ev)
                    this._events.push({...ev, seriesDate: master?.date ?? null});
            }
        }

        this._reindex();
        this._onEventsChanged(this._events);
    }

    _ingestTasks(comps, color, clientUid, listName) {
        this._events = this._events.filter(e => e.clientUid !== clientUid);
        for (const comp of comps) {
            const task = this._parseTask(comp, color, clientUid, listName);
            if (task)
                this._events.push(task);
        }
        this._reindex();
        this._onEventsChanged(this._events);
    }

    // A reminder in the same shape as an event (so the grid, agenda and
    // info popover take it as one), plus kind 'task', completed and
    // listName. Dated by DUE: one without DUE is skipped, since only dated
    // reminders are shown, as in Itsycal. A repeating one shows at its
    // current DUE only (see recurrence.js).
    _parseTask(comp, color, clientUid, listName) {
        try {
            const due = comp.get_due();
            const tDue = due?.get_value();
            if (!tDue)
                return null;
            const {date, time, allDay, originalTzid} = this._timesFromIcal(tDue, due.get_tzid(), null, null);
            const ic = comp.get_icalcomponent();
            const completed = ic.get_status() === ICalGLib.PropertyStatus.COMPLETED ||
                !!ic.get_first_property(ICalGLib.PropertyKind.COMPLETED_PROPERTY);
            return {
                kind: 'task', date, title: comp.get_summary()?.get_value() ?? '', time, color, allDay,
                endDate: null, uid: comp.get_uid(), clientUid, notes: null, url: null, originalTzid,
                location: null, recurrence: parseRecurrence(ICalGLib, ic), alarm: null,
                recurrenceId: null, attendees: [], completed, listName,
            };
        } catch (e) {
            logError(e, `CalendarManager: failed to parse task ${comp.get_uid() ?? '?'}`);
            return null;
        }
    }

    // The system's local timezone as an ICalGLib.Timezone usable with
    // convert_to_zone(). Re-resolved per call rather than cached on `this`
    // - it's a cheap in-process libical lookup, and caching would risk a
    // stale zone if the system timezone changes while litsycal keeps
    // running.
    _resolveLocalTimezone() {
        const localId = GLib.TimeZone.new_local().get_identifier();
        return ICalGLib.Timezone.get_builtin_timezone(localId);
    }

    // Converts a non-floating ICalGLib.Time to the system's local
    // wall-clock time. Returns null (caller keeps the original,
    // unconverted value) when the TZID can't be resolved to a real zone
    // (e.g. a non-IANA Windows/Exchange zone name) or the local zone
    // itself can't be resolved - same "leave it as-is" behavior this data
    // already got everywhere before timezone conversion existed, rather
    // than guessing.
    _convertToLocal(tObj, tzid, localTz) {
        if (!localTz)
            return null;
        if (tObj.is_utc())
            return tObj.convert_to_zone(localTz);
        const srcTz = ICalGLib.Timezone.get_builtin_timezone(tzid);
        if (!srcTz)
            return null;
        tObj.set_timezone(srcTz);
        return tObj.convert_to_zone(localTz);
    }

    // DTSTART/DTEND from EDS carry the event's original TZID (or are
    // UTC/floating); converted to local wall-clock time here so every
    // consumer of the returned `date`/`time` fields gets a correct time for
    // free, instead of the organizer's raw digits silently mislabeled as the
    // viewer's local time. tStart/tEnd are modified in place.
    _timesFromIcal(tStart, tzid, tEnd, eTzid) {
        const isAllDay = tStart.is_date();
        let originalTzid = null;
        let localTz = null;
        if (!isAllDay && (tzid || tStart.is_utc())) {
            localTz = this._resolveLocalTimezone();
            const converted = this._convertToLocal(tStart, tzid, localTz);
            // Only report an originalTzid (and only display the converted
            // digits) when conversion actually succeeded - otherwise
            // tStart still holds the raw, unconverted digits and labeling
            // them as "originally scheduled in <tzid>" would misrepresent a
            // conversion that never happened. Plain UTC times (a trailing
            // Z) get no originalTzid: many CalDAV/ICS feeds store every
            // event that way, so it says nothing about the zone it was
            // planned in.
            if (converted) {
                if (!tStart.is_utc())
                    originalTzid = tzid;
                tStart = converted;
            }
        }

        const pad = n => String(n).padStart(2, '0');
        const dateOf = t => `${t.get_year()}-${pad(t.get_month())}-${pad(t.get_day())}`;
        const date = dateOf(tStart);

        let time = null;
        let endDate = null;
        if (!isAllDay) {
            const startStr = `${pad(tStart.get_hour())}:${pad(tStart.get_minute())}`;
            if (tEnd && !tEnd.is_date() && (eTzid || tEnd.is_utc())) {
                localTz ??= this._resolveLocalTimezone();
                tEnd = this._convertToLocal(tEnd, eTzid, localTz) ?? tEnd;
            }
            const endStr = tEnd && !tEnd.is_date()
                ? `${pad(tEnd.get_hour())}:${pad(tEnd.get_minute())}`
                : null;
            time = endStr ? `${startStr} - ${endStr}` : startStr;

            if (tEnd && dateOf(tEnd) !== date)
                endDate = dateOf(tEnd);
        } else {
            // All-day DTEND;VALUE=DATE is exclusive (see allDayEndDate in
            // ical.js): the last visible day is DTEND - 1, and only a span
            // past the start day earns an endDate.
            endDate = allDayEndDate(tEnd, date);
        }
        return {date, time, endDate, allDay: isAllDay, originalTzid};
    }

    // Shared by _ingestComps (month cache) and searchEvents (a separate,
    // one-off query - see below) so both build the exact same event shape
    // from a raw ECal component. `instance` ({start, end, rid} from
    // expandRecurring) dates one occurrence of a recurring master in place
    // of its DTSTART/DTEND; its times are still in the master's zones, so
    // the master's TZIDs apply to them. Returns null (logging) rather than
    // throwing on a single malformed component, so one bad event never
    // takes down a whole batch.
    _parseComp(comp, color, clientUid, instance = null) {
        try {
            const title = comp.get_summary()?.get_value() ?? '';
            const dtstart = comp.get_dtstart();
            const dtend = comp.get_dtend();
            const tStart = instance?.start ?? dtstart?.get_value();
            if (!tStart)
                return null;
            const tEnd = instance ? instance.end : dtend?.get_value();
            const {date, time, endDate, allDay: isAllDay, originalTzid} =
                this._timesFromIcal(tStart, dtstart?.get_tzid() ?? null, tEnd, dtend?.get_tzid() ?? null);

            let notes = null, url = null, location = null, recurrence = null, alarm = null,
                recurrenceId = null, attendees = [];
            const ic = comp.get_icalcomponent();
            if (ic) {
                notes = ic.get_description() || null;
                const up = ic.get_first_property(ICalGLib.PropertyKind.URL_PROPERTY);
                url = up ? up.get_value_as_string() || null : null;
                location = ic.get_location() || null;
                if (notes    === '')
                    notes    = null;
                if (url      === '')
                    url      = null;
                if (location === '')
                    location = null;

                recurrence = parseRecurrence(ICalGLib, ic);
                alarm      = parseAlarm(ICalGLib, ic);
                attendees  = this._parseAttendees(ic);

                // Identifies which occurrence of a recurring series this is,
                // so a "delete this event only" can target it specifically:
                // a detached occurrence's own RECURRENCE-ID, or a generated
                // occurrence's start (see expandRecurring). Null on a master.
                const ridProp = ic.get_first_property(ICalGLib.PropertyKind.RECURRENCEID_PROPERTY);
                recurrenceId = instance?.rid ?? (ridProp ? ridProp.get_value_as_string() || null : null);
            }

            return {
                date, title, time, color, allDay: isAllDay, endDate,
                uid: comp.get_uid(), clientUid, notes, url, originalTzid,
                location, recurrence, alarm, recurrenceId, attendees,
            };
        } catch (e) {
            logError(e, `CalendarManager: failed to parse calendar component ${comp.get_uid() ?? '?'}`);
            return null;
        }
    }

    // Read-only display data - only CN (display name) and PARTSTAT (RSVP
    // status) per ATTENDEE. Never fed back into a save: editing an event
    // patches only the fields our dialog exposes onto the live component
    // (see _applyFieldsToIcal below), so attendee data always stays
    // whatever the server last sent, untouched by us.
    _parseAttendees(ic) {
        const attendees = [];
        let prop = ic.get_first_property(ICalGLib.PropertyKind.ATTENDEE_PROPERTY);
        while (prop) {
            const email = (prop.get_value_as_string() ?? '').replace(/^mailto:/i, '');
            const cn        = prop.get_parameter_as_string('CN') || null;
            const partstat  = (prop.get_parameter_as_string('PARTSTAT') || '').toUpperCase();
            attendees.push({name: cn || email.split('@')[0], email, partstat});
            prop = ic.get_next_property(ICalGLib.PropertyKind.ATTENDEE_PROPERTY);
        }
        return attendees;
    }

    // Index

    _isShown(ev) {
        if (this._disabled.has(ev.clientUid))
            return false;
        if (ev.kind !== 'task')
            return true;
        return this._showReminders && (this._showCompletedReminders || !ev.completed);
    }

    _reindex() {
        this._byDate = new Map();
        for (const ev of this._events) {
            if (!this._isShown(ev))
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

    // Incomplete reminders due before todayStr ('YYYY-MM-DD'), oldest first.
    getOverdueTasks(todayStr) {
        if (!this._showOverdueReminders)
            return [];
        return this._events
            .filter(ev => ev.kind === 'task' && !ev.completed && ev.date < todayStr && this._isShown(ev))
            .sort((a, b) => `${a.date} ${a.time ?? ''}`.localeCompare(`${b.date} ${b.time ?? ''}`));
    }

    // Dates (YYYY-MM-DD, inclusive) a multi-day event's dot/agenda entry
    // - and its calendar-grid hover highlight - should appear under: every
    // day it spans, not just its start day. Mirrors Itsycal's EventCenter,
    // which walks each event's date range and adds it to every day's
    // bucket rather than just the start date. Public because the hover
    // highlight (calendarWidget.js) needs the identical range.
    datesSpanned(ev) {
        if (!ev.endDate || ev.endDate === ev.date)
            return [ev.date];
        // A malformed end before the start would otherwise fabricate a
        // full MAX_SPAN_DAYS of buckets without ever hitting lastDate.
        if (ev.endDate < ev.date)
            return [ev.date];

        // An event ending exactly at midnight (e.g. 22:00 -> 00:00 next day)
        // occupies zero minutes of its DTEND date - treat the day before as
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

    // Create

    createEvent(fields, sourceUid, onDone) {
        const entry = this._clients.get(sourceUid);
        if (!entry) {
            onDone?.(new Error('Calendar not connected'));
            return;
        }

        let ical;
        try {
            // new_from_string inside the try too: a binding throw there
            // must report via onDone, never escape synchronously.
            ical = ICalGLib.Component.new_from_string(
                buildICal(GLib.uuid_string_random(), fields));
        } catch (e) {
            onDone?.(e);
            return;
        }
        if (!ical) {
            onDone?.(new Error('Invalid calendar data'));
            return;
        }
        entry.client.create_object(ical, ECal.OperationFlags.NONE, this._cancellable, (_obj, res) => {
            try {
                entry.client.create_object_finish(res);
                onDone?.(null);
                if (this._year !== null)
                    this._fetchFromClient(sourceUid, this._year, this._month);
            } catch (e) {
                if (!isCancelled(e))
                    onDone?.(e);
            }
        });
    }

    // Update

    // Replaces just the properties our Edit dialog exposes (SUMMARY, DTSTART/
    // DTEND, DESCRIPTION, LOCATION, URL, RRULE, VALARMs) on the live component,
    // leaving everything else (ORGANIZER, ATTENDEE, SEQUENCE, conferencing
    // data, ...) untouched. Rebuilding the whole VEVENT from only our fields
    // and PUTting that as a full replacement would drop those other
    // properties, which Google's CalDAV backend rejects for meeting events
    // with a 409 (Conflict) - it won't accept a modification that strips a
    // meeting's organizer/attendees/conferencing structure.
    _applyFieldsToIcal(ical, fields) {
        const newIcal = ICalGLib.Component.new_from_string(buildICal(ical.get_uid(), fields));
        if (!newIcal)
            throw new Error('Invalid calendar data');

        for (const kind of [
            ICalGLib.PropertyKind.SUMMARY_PROPERTY,
            ICalGLib.PropertyKind.DTSTART_PROPERTY,
            ICalGLib.PropertyKind.DTEND_PROPERTY,
            // RFC 5545 forbids DTEND and DURATION coexisting. The
            // rebuilt component never carries DURATION, so listing it
            // here only strips a stale one from an externally-created
            // event - the new DTEND above then stands alone.
            ICalGLib.PropertyKind.DURATION_PROPERTY,
            ICalGLib.PropertyKind.DESCRIPTION_PROPERTY,
            ICalGLib.PropertyKind.LOCATION_PROPERTY,
            ICalGLib.PropertyKind.URL_PROPERTY,
            ICalGLib.PropertyKind.RRULE_PROPERTY,
        ])
            this._replaceProperties(ical, newIcal, kind);

        let oldAlarm = ical.get_first_component(ICalGLib.ComponentKind.VALARM_COMPONENT);
        while (oldAlarm) {
            ical.remove_component(oldAlarm);
            oldAlarm = ical.get_first_component(ICalGLib.ComponentKind.VALARM_COMPONENT);
        }
        let newAlarm = newIcal.get_first_component(ICalGLib.ComponentKind.VALARM_COMPONENT);
        while (newAlarm) {
            ical.add_component(newAlarm.clone());
            newAlarm = newIcal.get_next_component(ICalGLib.ComponentKind.VALARM_COMPONENT);
        }
    }

    _replaceProperties(dest, src, kind) {
        let old = dest.get_first_property(kind);
        while (old) {
            dest.remove_property(old);
            old = dest.get_first_property(kind);
        }
        let prop = src.get_first_property(kind);
        while (prop) {
            dest.add_property(prop.clone());
            prop = src.get_next_property(kind);
        }
    }

    updateEvent(uid, clientUid, fields, onDone) {
        const entry = this._clients.get(clientUid);
        if (!entry) {
            onDone?.(new Error('Calendar not connected'));
            return;
        }

        entry.client.get_object(uid, null, this._cancellable, (_obj, res) => {
            let ical;
            try {
                [, ical] = entry.client.get_object_finish(res);
            } catch (e) {
                if (!isCancelled(e))
                    onDone?.(e);
                return;
            }

            try {
                this._applyFieldsToIcal(ical, fields);
            } catch (e) {
                onDone?.(e);
                return;
            }
            entry.client.modify_object(ical, ECal.ObjModType.ALL, ECal.OperationFlags.NONE, this._cancellable, (_obj2, res2) => {
                try {
                    entry.client.modify_object_finish(res2);
                    onDone?.(null);
                    if (this._year !== null)
                        this._fetchFromClient(clientUid, this._year, this._month);
                } catch (e) {
                    if (!isCancelled(e))
                        onDone?.(e);
                }
            });
        });
    }

    // Reminders

    // Fetches the task, marks it done or not done in place (see
    // applyTaskCompletion: a repeating one moves on to its next occurrence
    // instead), and saves it. ECal.util_mark_task_complete_sync() would do
    // the same, but with blocking timezone lookups on the Shell's thread.
    setTaskCompleted(uid, clientUid, done, onDone) {
        const entry = this._clients.get(clientUid);
        if (!entry) {
            onDone?.(new Error('Calendar not connected'));
            return;
        }

        entry.client.get_object(uid, null, this._cancellable, (_obj, res) => {
            let ical;
            try {
                [, ical] = entry.client.get_object_finish(res);
                applyTaskCompletion(ICalGLib, ical, done,
                    ICalGLib.Time.new_current_with_zone(ICalGLib.Timezone.get_utc_timezone()));
            } catch (e) {
                if (!isCancelled(e))
                    onDone?.(e);
                return;
            }
            entry.client.modify_object(ical, ECal.ObjModType.ALL, ECal.OperationFlags.NONE, this._cancellable, (_obj2, res2) => {
                try {
                    entry.client.modify_object_finish(res2);
                    onDone?.(null);
                    if (this._year !== null)
                        this._fetchFromClient(clientUid, this._year, this._month);
                } catch (e) {
                    if (!isCancelled(e))
                        onDone?.(e);
                }
            });
        });
    }

    // Delete

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
        if ((scope === 'THIS' || scope === 'FUTURE') && !recurrenceId) {
            onDone?.(new Error('Missing recurrence id'));
            return;
        }
        const modType = {
            ALL:    ECal.ObjModType.ALL,
            THIS:   ECal.ObjModType.THIS,
            FUTURE: ECal.ObjModType.THIS_AND_FUTURE,
        }[scope] ?? ECal.ObjModType.ALL;
        const rid = scope === 'ALL' ? null : recurrenceId;

        // FUTURE also drops the series' later occurrences, by date; the live
        // view's refetch then corrects anything this local guess got wrong.
        const sameSeries = e => e.uid === uid && e.clientUid === clientUid;
        const fromDate = this._events.find(e => sameSeries(e) && e.recurrenceId === rid)?.date ?? null;
        const isRemoved = e => sameSeries(e) && (rid == null || e.recurrenceId === rid ||
            (scope === 'FUTURE' && fromDate !== null && e.date >= fromDate));

        entry.client.remove_object(uid, rid, modType, ECal.OperationFlags.NONE, this._cancellable, (_obj, res) => {
            try {
                entry.client.remove_object_finish(res);
                onDone?.(null);
                this._events = this._events.filter(e => !isRemoved(e));
                this._reindex();
                this._onEventsChanged(this._events);
            } catch (e) {
                if (!isCancelled(e))
                    onDone?.(e);
            }
        });
    }

    // Accessors

    isAvailable() {
        return this._available;
    }

    getEvents()   {
        return this._events;
    }

    // Calendars only: this backs the event form's calendar picker.
    getSources()  {
        return [...this._clients.entries()]
            .filter(([uid, {kind}]) => !this._disabled.has(uid) && kind === 'events')
            .map(([uid, {name, color}]) => ({uid, name, color}));
    }

    // Backs the New Event form's default calendar (see EventPanel's
    // constructor and _save() in eventDialog.js) - remembers whichever
    // calendar was picked last time, rather than always defaulting to
    // whatever getSources() happens to list first.
    getLastEventSourceUid() {
        return this._settings.get_string('last-event-calendar-uid');
    }

    setLastEventSourceUid(uid) {
        this._settings.set_string('last-event-calendar-uid', uid);
    }

    // Cleanup

    destroy() {
        if (this._registryStartupPumpId) {
            GLib.source_remove(this._registryStartupPumpId);
            this._registryStartupPumpId = null;
        }
        if (this._registryPumpId) {
            GLib.source_remove(this._registryPumpId);
            this._registryPumpId = null;
        }
        // Keeps every in-flight EDS call from calling back into this manager
        // (and the calendar widget behind it) after teardown.
        this._cancellable.cancel();
        this._settings.disconnectObject(this);
        global.disconnectObject(this);
        for (const uid of [...this._views.keys()])
            this._stopView(uid);
        if (this._registry) {
            this._registry.disconnectObject(this);
            this._registry = null;
        }
        // One last run, now that everything above is cancelled and
        // disconnected: a registry creation still in flight then completes
        // (with CANCELLED) instead of sitting queued on a context nobody
        // runs anymore, keeping itself and the registry alive.
        this._pumpRegistry();
        this._registryContext = null;
        this._clients.clear();
    }
}
