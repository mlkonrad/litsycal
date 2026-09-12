import St      from 'gi://St';
import GLib    from 'gi://GLib';
import Clutter from 'gi://Clutter';
import Pango   from 'gi://Pango';
import Gio     from 'gi://Gio';
import Shell   from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {confirmDeleteEvent} from './eventDialog.js';
import {
    formatEventWhen, recurrenceSummary, findMeetingUrl, meetingIsJoinable, FONT_SIZE_CLASSES,
    URL_REGEXP,
} from './helpers.js';

// ── Event info popover ───────────────────────────────────────────────────────
//
// itsycal's AgendaPopoverVC, ported: a compact, read-only card showing an
// event's details, opened right next to the clicked agenda row with a small
// diamond "arrow" pointing at it — the itsycal-style popover the row's click
// now opens instead of the full edit form. Built the same hand-rolled way as
// EventPanel/SettingsMenuPanel (own Main.pushModal grab, own click-outside/
// Escape handling) for the same reason: it opens while the calendar dropdown
// (a PopupMenu) still holds its own grab — see SettingsMenuPanel below for the
// full explanation of why that needs a competing grab here too.
export class EventInfoPopover {
    // onClose is called exactly once, however the popover ends up closing —
    // deleted, dismissed via Escape, or force-closed by the watchdog below.
    // onOutsideClick, if given, is called (after the popover has already
    // closed) as (actorUnderClick, thisPopoversEvent) with whatever actor
    // was actually under an outside click and the event this popover was
    // showing — see this._backdrop below — so a click on a different agenda
    // row can open its popover in the same click rather than requiring a
    // second one, while a second click on the *same* row's event (the
    // caller compares actorUnderClick's event against thisPopoversEvent)
    // just leaves it closed instead of reopening — a toggle.
    // fontSize is the raw 'font-size' setting value (0=S, 1=M, 2=L) — this
    // popover lives in Main.layoutManager.uiGroup, a sibling of the calendar
    // widget rather than a descendant of it, so it doesn't inherit the
    // litsycal-font-sm/-lg class LitsycalCalendar._applyFontSizeClass()
    // applies to itself; it has to apply the same class to its own box.
    constructor(calManager, ev, anchorActor, onClose, onOutsideClick, fontSize) {
        this._calManager    = calManager;
        this._event         = ev;
        this._onClose       = onClose;
        this._onOutsideClick = onOutsideClick;

        this._root = new St.Widget();
        Main.layoutManager.uiGroup.add_child(this._root);

        // The arrow: a plain square, rotated 45° into a diamond. Added to
        // this._root before this._box so the box (opaque, painted after)
        // covers the half of the diamond that overlaps it, leaving only the
        // outward-pointing triangle visible — the standard CSS/GUI
        // speech-bubble-arrow trick, done here with real actor z-order
        // instead of CSS since St has no z-index/clip-to-sibling concept.
        // Hidden via opacity (not `visible`, which the modal grab below
        // needs the actor mapped for) until _position() below places it.
        this._arrow = new St.Widget({style_class: 'litsycal-info-popover-arrow', opacity: 0});
        this._arrow.set_pivot_point(0.5, 0.5);
        this._arrow.rotation_angle_z = 45;
        this._root.add_child(this._arrow);

        // Use popup-menu-content so background/text follow the user's shell
        // theme, same as EventPanel — the arrow's fill is read from this
        // box's own resolved theme in the idle_add below, once it applies.
        // litsycal-font-sm/-lg (see the constructor comment above) makes
        // this respect the font-size setting the same way the main calendar
        // widget does; fontSize 1 (Medium) needs no extra class.
        const fontSizeCls = FONT_SIZE_CLASSES[fontSize] ?? null;
        this._box = new St.BoxLayout({
            vertical: true,
            style_class: `popup-menu-content litsycal-info-popover${
                fontSizeCls ? ` ${fontSizeCls}` : ''}`,
            reactive: true,
            opacity: 0,
        });
        this._root.add_child(this._box);

        this._build();

        // See SettingsMenuPanel's own this._grab comment for why this needs
        // a competing grab of its own rather than relying on the calendar
        // dropdown's.
        this._grab = Main.pushModal(this._root, {actionMode: Shell.ActionMode.POPUP});

        // Safety net: unconditionally force this._grab to release after a
        // while no matter what, regardless of whether Escape/backdrop-click/
        // delete ever fire correctly. This popover held a stuck
        // Main.pushModal() grab and locked up all desktop input twice during
        // development, each time requiring a hard reset — click-outside and
        // Escape/Backspace/Delete are now on a proven-reliable path (see
        // this._btnKeyId/this._backdrop below), but this stays in as cheap
        // insurance against ever regressing back to that failure mode. Long
        // enough that it never fires in normal use (reading a popover for
        // over a minute shouldn't auto-dismiss it).
        this._watchdogId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 60, () => {
            // Don't force through a live delete confirmation — it has its
            // own, separately-scoped grab/close logic; just check back later.
            if (this._confirmOverlay)
                return GLib.SOURCE_CONTINUE;
            this._watchdogId = null;
            this.close();
            return GLib.SOURCE_REMOVE;
        });

        // Defer positioning until after layout pass so actor size is known.
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._position(anchorActor);
            const bg = this._box.get_theme_node().get_background_color();
            this._arrow.set_style(
                `background-color: rgba(${bg.red}, ${bg.green}, ${bg.blue}, ${bg.alpha / 255});`);
            this._box.opacity   = 255;
            this._arrow.opacity = 255;
            this._deleteBtn.grab_key_focus();
            return GLib.SOURCE_REMOVE;
        });

        // Established by direct instrumentation (see project memory
        // litsycal-modal-grab-pitfall / this session's history), not theory:
        // under this competing Main.pushModal() grab, NOTHING reaches
        // capture-phase 'captured-event' listeners — not on this._root, not
        // on this._box, not on global.stage itself, regardless of focus.
        // The only delivery path that ever actually fires is a plain
        // (bubble-phase) signal connected directly to the specific actor
        // that was clicked or currently holds key focus. Both mechanisms
        // below are built on that one proven-working path, not on capture
        // phase or a second stage-level listener.

        // Escape/Backspace/Delete: a plain 'key-press-event' on this._deleteBtn
        // itself, which holds real key focus (grabbed above) — not captured-
        // event on an ancestor, which the instrumentation showed never fires.
        this._btnKeyId = this._deleteBtn.connect('key-press-event', (_actor, event) => {
            if (this._confirmOverlay)
                return Clutter.EVENT_PROPAGATE; // let it handle its own keys
            const sym = event.get_key_symbol();
            if (sym === Clutter.KEY_Escape) {
                this.close();
                return Clutter.EVENT_STOP;
            }
            // Backspace/Delete deletes, like itsycal's own popover
            // (AgendaPopoverVC.btnDelete.keyEquivalent is backspace).
            if (sym === Clutter.KEY_BackSpace || sym === Clutter.KEY_Delete) {
                this._deleteBtn.emit('clicked', 1);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        // Click-outside: a full-stage, invisible, reactive backdrop — a real
        // actor inside our own grabbed subtree, added to this._root BEFORE
        // this._arrow/this._box so it sits behind them in z-order. A click
        // anywhere on screen picks whichever reactive actor is topmost at
        // that point: this._box (or its children) when it lands on the
        // popover itself, this backdrop everywhere else — and since it's a
        // genuine pick target being clicked directly, its own plain
        // 'button-press-event' is the same proven-working delivery path as
        // Escape above, not a global/stage-level listener trying to observe
        // clicks that land elsewhere.
        this._backdrop = new St.Widget({reactive: true, opacity: 0});
        this._backdrop.set_position(0, 0);
        this._backdrop.set_size(global.stage.width, global.stage.height);
        this._root.insert_child_at_index(this._backdrop, 0);
        this._backdropId = this._backdrop.connect('button-press-event', (_actor, event) => {
            if (this._confirmOverlay)
                return Clutter.EVENT_PROPAGATE; // let it handle its own clicks
            // Resolve what's actually under the click before tearing
            // anything down: with the backdrop itself excluded, picking
            // falls through to whatever real actor is there (another agenda
            // row, or nothing) — this is a synchronous geometry query, not
            // event delivery, so it works fine even though nothing besides a
            // plain signal on the exact clicked actor is ever *delivered* an
            // event under this grab (see the comment above this._btnKeyId).
            const [x, y] = event.get_coords();
            this._backdrop.reactive = false;
            const under = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y);
            this._backdrop.reactive = true;
            const onOutsideClickCb = this._onOutsideClick;
            const closingEvent   = this._event; // so the caller can tell "reopen this" from "toggle closed"
            this.close();
            onOutsideClickCb?.(under, closingEvent);
            return Clutter.EVENT_STOP;
        });
    }

    _build() {
        const ev  = this._event;
        const box = this._box;

        // ── Header: colored dot, title, delete button ────────────────────────
        const header = new St.BoxLayout({style_class: 'litsycal-panel-icon-row', x_expand: true});
        header.add_child(new St.Widget({
            style_class: 'litsycal-panel-dot',
            style: `background-color: ${ev.color};`,
            y_align: Clutter.ActorAlign.START,
        }));
        const titleLbl = new St.Label({
            text: ev.title || _('(No title)'),
            style_class: 'litsycal-info-popover-title',
            x_expand: true,
        });
        titleLbl.clutter_text.set_line_wrap(true);
        titleLbl.clutter_text.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
        header.add_child(titleLbl);

        this._deleteBtn = new St.Button({
            style_class: 'litsycal-info-popover-delete-btn',
            accessible_name: _('Delete event'),
            child: new St.Icon({icon_name: 'edit-delete-symbolic', icon_size: 14}),
            y_align: Clutter.ActorAlign.START,
            can_focus: true,
        });
        this._deleteBtn.connect('clicked', () => this._confirmDelete());
        header.add_child(this._deleteBtn);
        box.add_child(header);

        // ── Duration ───────────────────────────────────────────────────────
        const whenLbl = new St.Label({text: formatEventWhen(ev), style_class: 'litsycal-info-popover-text'});
        whenLbl.clutter_text.set_line_wrap(true);
        whenLbl.clutter_text.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
        box.add_child(whenLbl);

        const addIconRow = (iconName, text) => {
            const row = new St.BoxLayout({style_class: 'litsycal-panel-icon-row'});
            row.add_child(new St.Icon({
                icon_name: iconName, icon_size: 14,
                style_class: 'litsycal-info-popover-icon', y_align: Clutter.ActorAlign.START,
            }));
            const lbl = new St.Label({text, style_class: 'litsycal-info-popover-text', x_expand: true});
            lbl.clutter_text.set_line_wrap(true);
            lbl.clutter_text.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
            row.add_child(lbl);
            box.add_child(row);
        };

        // ── Location / recurrence ─────────────────────────────────────────
        if (ev.location)
            addIconRow('mark-location-symbolic', ev.location);

        const recurrence = recurrenceSummary(ev.recurrence);
        if (recurrence)
            addIconRow('media-playlist-repeat-symbolic', recurrence);

        const addLinkRow = (iconName, labelText, uri, accessibleName) => {
            const btn = new St.Button({
                style_class: 'litsycal-info-popover-link-btn', x_expand: true,
                accessible_name: accessibleName, can_focus: true,
            });
            const row = new St.BoxLayout({style_class: 'litsycal-panel-icon-row'});
            row.add_child(new St.Icon({
                icon_name: iconName, icon_size: 14, style_class: 'litsycal-info-popover-icon',
            }));
            const lbl = new St.Label({text: labelText, style_class: 'litsycal-info-popover-text', x_expand: true});
            lbl.clutter_text.set_line_wrap(false);
            lbl.clutter_text.set_ellipsize(Pango.EllipsizeMode.MIDDLE);
            row.add_child(lbl);
            btn.set_child(row);
            btn.connect('clicked', () => {
                try {
                    Gio.AppInfo.launch_default_for_uri(uri, null);
                } catch {}
            });
            box.add_child(btn);
        };

        // ── Join meeting (same detection as the agenda row's own button) ───
        const meetingUrl = findMeetingUrl(ev);
        if (meetingUrl && meetingIsJoinable(ev))
            addLinkRow('camera-video-symbolic', _('Join meeting'), meetingUrl, _('Join meeting'));

        // ── Notes / URL ────────────────────────────────────────────────────
        if (ev.notes || ev.url)
            box.add_child(new St.Widget({style_class: 'litsycal-panel-sep'}));

        if (ev.notes) {
            const addTextChunk = text => {
                if (!text)
                    return;
                const lbl = new St.Label({text, style_class: 'litsycal-info-popover-text'});
                lbl.clutter_text.set_line_wrap(true);
                lbl.clutter_text.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
                box.add_child(lbl);
            };
            // Split on embedded links (e.g. the "Join with Google Meet: <url>"
            // boilerplate calendar servers add to notes) so each one renders
            // as its own clickable row instead of inert text.
            const urlRe = new RegExp(URL_REGEXP.source, URL_REGEXP.flags);
            let lastIndex = 0;
            let match;
            while ((match = urlRe.exec(ev.notes))) {
                addTextChunk(ev.notes.slice(lastIndex, match.index));
                addLinkRow('web-browser-symbolic', match[0], match[0], _('Open link'));
                lastIndex = urlRe.lastIndex;
            }
            addTextChunk(ev.notes.slice(lastIndex));
        }

        if (ev.url)
            addLinkRow('web-browser-symbolic', ev.url, ev.url, _('Open link'));
    }

    // Same confirm-then-delete flow as the event edit panel's own Delete
    // button (eventDialog.js EventPanel._confirmDelete/confirmDeleteEvent) —
    // itsycal wires its popover's delete button to the exact same delete
    // path as its agenda context menu's Delete item.
    _confirmDelete() {
        confirmDeleteEvent(this._calManager, this._event, err => {
            if (err) {
                Main.notifyError(_('Litsycal'), err.message);
                return;
            }
            this.close();
        }, overlay => {
            this._confirmOverlay = overlay;
        });
    }

    // Anchors to the clicked agenda row: opens to whichever side of it has
    // room (preferring the left, itsycal's own convention), with the arrow
    // vertically centered on the row and clamped clear of the box's own
    // rounded corners.
    _position(anchor) {
        const monitor = Main.layoutManager.primaryMonitor;
        const panelH  = Main.panel.get_height();
        const boxW    = this._box.get_width()  || 320;
        const boxH    = this._box.get_height() || 160;
        const ARROW   = 14;
        const GAP     = 8;
        const CORNER  = 16;

        const [ax, ay] = anchor.get_transformed_position();
        const aw = anchor.get_width();
        const ah = anchor.get_height();
        const anchorCenterY = ay + ah / 2;

        let onLeft = true;
        let x = ax - boxW - GAP - ARROW / 2;
        if (x < monitor.x + 4) {
            onLeft = false;
            x = ax + aw + GAP + ARROW / 2;
        }
        x = Math.max(monitor.x + 4, Math.min(x, monitor.x + monitor.width - boxW - 4));

        let y = Math.round(anchorCenterY - boxH / 2);
        const minY = monitor.y + panelH + 4;
        const maxY = monitor.y + monitor.height - boxH - 4;
        y = Math.max(minY, Math.min(y, maxY));

        this._box.set_position(Math.round(x), y);

        let arrowY = Math.round(anchorCenterY - ARROW / 2);
        arrowY = Math.max(y + CORNER, Math.min(arrowY, y + boxH - CORNER - ARROW));
        const arrowX = onLeft
            ? Math.round(x + boxW - ARROW / 2)  // straddles the box's right edge
            : Math.round(x - ARROW / 2);        // straddles the box's left edge
        this._arrow.set_position(arrowX, arrowY);
    }

    close() {
        if (this._watchdogId) {
            GLib.source_remove(this._watchdogId);
            this._watchdogId = null;
        }
        if (this._confirmOverlay) {
            Main.layoutManager.uiGroup.remove_child(this._confirmOverlay);
            this._confirmOverlay.destroy();
            this._confirmOverlay = null;
        }
        if (this._btnKeyId)  {
            this._deleteBtn?.disconnect(this._btnKeyId);
            this._btnKeyId  = null;
        }
        if (this._backdropId) {
            this._backdrop?.disconnect(this._backdropId);
            this._backdropId = null;
        }
        if (this._grab)    {
            Main.popModal(this._grab);
            this._grab = null;
        }
        if (this._root) {
            Main.layoutManager.uiGroup.remove_child(this._root);
            this._root.destroy();
            this._root = null;
        }
        this._onClose?.();
    }
}
