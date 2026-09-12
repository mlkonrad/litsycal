import St      from 'gi://St';
import GLib    from 'gi://GLib';
import Clutter from 'gi://Clutter';
import Shell   from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Shared base for GoToDatePanel, QuickAddPanel, and SearchPanel — three
// small floating text-entry panels that all opened the same way: their own
// Main.pushModal grab, Escape/click-outside via a captured-event listener,
// the same anchor-relative _position() math, and the same disconnect/
// popModal/destroy teardown in _finish(). Extracted here after they'd
// accumulated to three near-identical ~40-line copies of that boilerplate.
//
// EventInfoPopover and SettingsMenuPanel are NOT based on this: they have
// enough of their own shape (an arrow actor, a focus-navigable row list)
// that forcing them in would cost more than the duplication it removes.
//
// Subclasses: call `super(styleClass, defaultWidth, defaultHeight,
// anchorActor, onClose)`, override `_build()` to add content to `this._box`
// (name the main input `this._entry` — the base focuses it automatically
// once positioned), and call `this._finish(result)` to close with a result
// or `this._finish(null)` to cancel. Override `_onFinish()` for any of your
// own cleanup (timers, generation counters, ...) that needs to happen
// before teardown.
export class FloatingModalPanel {
    constructor(styleClass, defaultWidth, defaultHeight, anchorActor, onClose) {
        this._onClose       = onClose;
        this._defaultWidth  = defaultWidth;
        this._defaultHeight = defaultHeight;

        this._box = new St.BoxLayout({
            vertical: true,
            style_class: `popup-menu-content ${styleClass}`,
            reactive: true,
            // Hidden via opacity (not `visible`, which the modal grab below
            // needs the actor mapped for) until _position() places it.
            opacity: 0,
        });

        this._build();
        Main.layoutManager.uiGroup.add_child(this._box);

        // Needed because this can open while the calendar dropdown (a
        // PopupMenu) still holds its own modal grab: without a competing
        // grab here, input is redelivered starting from that grab's actor
        // rather than the stage, so this panel's own listeners below would
        // never see it — even a click on its own entry/button would be
        // swallowed as a click-outside-of-that-menu instead of reaching it.
        // See SettingsMenuPanel for the full explanation — same mechanism,
        // same fix.
        this._grab = Main.pushModal(this._box, {actionMode: Shell.ActionMode.POPUP});

        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._position(anchorActor);
            this._box.opacity = 255;
            this._entry?.grab_key_focus();
            return GLib.SOURCE_REMOVE;
        });

        this._eventId = this._box.connect('captured-event', (_actor, ev) => {
            if (ev.type() === Clutter.EventType.BUTTON_PRESS) {
                const [x, y] = ev.get_coords();
                const actor  = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y);
                if (actor && !this._box.contains(actor)) {
                    this._finish(null);
                    return Clutter.EVENT_STOP;
                }
            } else if (ev.type() === Clutter.EventType.KEY_PRESS &&
                       ev.get_key_symbol() === Clutter.KEY_Escape) {
                this._finish(null);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    // Subclasses must override to build their own content into this._box —
    // called from within this base constructor, before uiGroup.add_child.
    _build() {}

    // Subclasses may override for their own pre-teardown cleanup (debounce
    // timers, generation counters, ...) — called from _finish() while
    // this._box is still alive.
    _onFinish() {}

    _position(anchor) {
        const monitor = Main.layoutManager.primaryMonitor;
        const panelH  = Main.panel.get_height();
        const boxW    = this._box.get_width()  || this._defaultWidth;
        const boxH    = this._box.get_height() || this._defaultHeight;

        if (anchor) {
            const [ax, ay] = anchor.get_transformed_position();
            const aw = anchor.get_width();
            const ah = anchor.get_height();

            let x = ax + Math.round((aw - boxW) / 2);
            x = Math.max(monitor.x + 4, Math.min(x, monitor.x + monitor.width - boxW - 4));

            const y = Math.max(monitor.y + panelH + 4,
                Math.min(ay + ah + 6, monitor.y + monitor.height - boxH - 4));

            this._box.set_position(x, y);
        } else {
            this._box.set_position(
                monitor.x + Math.round((monitor.width  - boxW) / 2),
                monitor.y + panelH + Math.round((monitor.height - panelH) * 0.18)
            );
        }
    }

    _finish(result) {
        if (!this._box)
            return;
        this._onFinish();
        if (this._eventId) {
            this._box.disconnect(this._eventId);
            this._eventId = null;
        }
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        Main.layoutManager.uiGroup.remove_child(this._box);
        this._box.destroy();
        this._box = null;
        this._onClose(result);
    }

    close() {
        this._finish(null);
    }
}
