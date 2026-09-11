import St      from 'gi://St';
import GLib    from 'gi://GLib';
import Clutter from 'gi://Clutter';
import Shell   from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// ── Settings menu (floating, non-modal PopupMenu-wise, but self-grabbed) ────
//
// Deliberately not a PopupMenu.PopupMenu/menuManager grab: menuManager closes
// any other menu it owns the instant a new one opens, which would force the
// calendar dropdown shut the moment this appears — not what we want, since
// the calendar should stay open behind it. Built the same way as EventPanel/
// GoToDatePanel instead — a floating box in uiGroup.
//
// It does still need its own Main.pushModal grab, though: `this.menu`'s own
// grab (see the open-state-changed handler below, "Capture phase on the
// menu's own actor, not the stage") means input while it's active is
// redelivered starting from ITS grab actor, not the stage — so without a
// competing grab of our own, a click on one of our rows is swallowed as a
// click-outside-of-this.menu (closing nothing visible, since we're not part
// of it) rather than ever reaching our button, and only a second click, once
// unrelated to the by-then-released grab, actually lands. Grabbing here (and
// listening on this._box's own 'captured-event', for the same reason) fixes
// that the same way this.menu's own keyboard handling already had to.
export class SettingsMenuPanel {
    // items: {label, icon, action}[] rows in display order; `null` renders as
    // a separator. `action` is called once the panel has fully closed; a row
    // with `action: null` renders disabled.
    constructor(anchorActor, items) {
        this._box = new St.BoxLayout({
            vertical: true,
            style_class: 'popup-menu-content litsycal-settings-menu',
            reactive: true,
            // See _showCellTooltip's box for why: hidden via opacity (not
            // `visible`, which the modal grab below needs the actor mapped
            // for) until _position() below places it, so it never paints at
            // its pre-layout (0,0) default first.
            opacity: 0,
        });

        // Rows with an action, in display order — what arrow-key navigation
        // moves through. Disabled (action-less) rows are skipped since
        // there's nothing to activate on them.
        this._focusable  = [];
        this._focusIndex = -1;

        for (const item of items) {
            if (item === null) {
                this._box.add_child(new St.Widget({style_class: 'litsycal-panel-sep'}));
                continue;
            }
            const btn = new St.Button({
                style_class: 'litsycal-panel-cal-option',
                x_expand: true,
                reactive: !!item.action,
            });
            const row = new St.BoxLayout({
                style_class: 'litsycal-settings-menu-row',
                x_expand: true,
            });
            row.add_child(new St.Icon({
                icon_name: item.icon, icon_size: 16,
                style_class: 'litsycal-settings-menu-icon',
            }));
            row.add_child(new St.Label({text: item.label, y_align: Clutter.ActorAlign.CENTER}));
            btn.set_child(row);
            if (!item.action) {
                btn.add_style_pseudo_class('insensitive');
            } else {
                btn.connect('clicked', () => {
                    // Tearing this._box down from inside its own child's
                    // still-live 'clicked' handler is asking for trouble —
                    // finish the event first (same reasoning as the quit
                    // action's own idle_add deferral).
                    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                        this.close();
                        item.action();
                        return GLib.SOURCE_REMOVE;
                    });
                });
                // Keep the keyboard-navigated row in sync with whatever the
                // mouse is over, so the two selection mechanisms never show
                // two different rows highlighted at once.
                btn.connect('notify::hover', () => {
                    if (btn.hover)
                        this._setFocusIndex(this._focusable.indexOf(btn));
                });
                this._focusable.push(btn);
            }
            this._box.add_child(btn);
        }

        Main.layoutManager.uiGroup.add_child(this._box);
        this._grab = Main.pushModal(this._box, {actionMode: Shell.ActionMode.POPUP});

        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._position(anchorActor);
            this._box.opacity = 255;
            // No actor here actually holds Clutter key focus — the modal
            // grab above delivers key events to this._box regardless (see
            // the captured-event handler below) — so keyboard selection is
            // tracked by hand via a pseudo-class rather than real focus.
            this._setFocusIndex(0);
            return GLib.SOURCE_REMOVE;
        });

        this._eventId = this._box.connect('captured-event', (_actor, ev) => {
            if (ev.type() === Clutter.EventType.BUTTON_PRESS) {
                const [x, y] = ev.get_coords();
                const actor  = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y);
                if (actor && !this._box.contains(actor)) {
                    this.close();
                    return Clutter.EVENT_STOP;
                }
            } else if (ev.type() === Clutter.EventType.KEY_PRESS) {
                switch (ev.get_key_symbol()) {
                case Clutter.KEY_Escape:
                    this.close();
                    return Clutter.EVENT_STOP;
                case Clutter.KEY_Up:
                    this._setFocusIndex(this._focusIndex - 1);
                    return Clutter.EVENT_STOP;
                case Clutter.KEY_Down:
                    this._setFocusIndex(this._focusIndex + 1);
                    return Clutter.EVENT_STOP;
                case Clutter.KEY_Return:
                case Clutter.KEY_KP_Enter:
                case Clutter.KEY_space:
                    this._focusable[this._focusIndex]?.emit('clicked', 1);
                    return Clutter.EVENT_STOP;
                }
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    // Moves the keyboard selection to index `i` (wrapping around), updating
    // the visual highlight. `i` is a plain index into this._focusable, not
    // clamped by the caller.
    _setFocusIndex(i) {
        if (this._focusable.length === 0)
            return;
        i = (i + this._focusable.length) % this._focusable.length;
        if (i === this._focusIndex)
            return;
        this._focusable[this._focusIndex]?.remove_style_pseudo_class('focus');
        this._focusIndex = i;
        this._focusable[this._focusIndex]?.add_style_pseudo_class('focus');
    }

    _position(anchor) {
        const monitor = Main.layoutManager.primaryMonitor;
        const panelH  = Main.panel.get_height();
        const boxW    = this._box.get_width()  || 200;
        const boxH    = this._box.get_height() || 260;

        const [ax, ay] = anchor.get_transformed_position();
        const ah = anchor.get_height();

        let x = ax; // left-align with the anchor
        x = Math.max(monitor.x + 4, Math.min(x, monitor.x + monitor.width - boxW - 4));

        let y = ay + ah + 4;
        if (y + boxH > monitor.y + monitor.height - 4)
            y = ay - boxH - 4; // flip above if no room below
        y = Math.max(monitor.y + panelH + 4, y);

        this._box.set_position(Math.round(x), Math.round(y));
    }

    close() {
        if (this._eventId) {
            this._box?.disconnect(this._eventId);
            this._eventId = null;
        }
        if (this._grab)    {
            Main.popModal(this._grab);
            this._grab = null;
        }
        if (this._box) {
            Main.layoutManager.uiGroup.remove_child(this._box);
            this._box.destroy();
            this._box = null;
        }
    }
}
