import St      from 'gi://St';
import GLib    from 'gi://GLib';
import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Slider}  from 'resource:///org/gnome/shell/ui/slider.js';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {playSound} from './helpers.js';
import {FloatingModalPanel} from './floatingPanel.js';

const MIN_MINUTES = 1;
const MAX_MINUTES = 60;
const MAX_RECENTS = 5;

/**
 * Remaining seconds as "mm:ss" for the panel badge.
 *
 * @param {number} seconds
 */
export function formatTimerRemaining(seconds) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// Countdown timer (Itsycal's MenuTimer)
//
// The only state is the timer-end-time setting, a wall-clock end time in
// Unix seconds (0 = none), so a running timer survives a Shell restart,
// a screen lock (which disables extensions) and suspend: the remaining time
// is always recomputed as end - now. An end time that is already past when
// this is created (it ran out while litsycal was disabled) fires once, then
// clears. The 1 s tick only runs while a timer is active.
export class MenuTimer {
    // onTick(secondsLeft) is called every second while a timer runs, and
    // once whenever it starts, is cancelled or runs out (secondsLeft is null
    // then), so the indicator can redraw. It is passed the value rather than
    // reading it back, since the first call happens inside this constructor,
    // before the caller has stored the instance.
    constructor(settings, onTick) {
        this._settings = settings;
        this._onTick   = onTick;
        this._tickId   = null;

        settings.connectObject('changed::timer-end-time', () => this._sync(), this);
        this._sync();
    }

    // Seconds left, or null when no timer is running.
    remainingSeconds() {
        const end = this._settings.get_int64('timer-end-time');
        if (end <= 0)
            return null;
        const nowUs = GLib.get_real_time();
        return Math.max(0, Math.ceil((end * 1000000 - nowUs) / 1000000));
    }

    recentDurations() {
        return this._settings.get_value('timer-recent-durations').deepUnpack();
    }

    start(minutes) {
        const recents = [minutes, ...this.recentDurations().filter(m => m !== minutes)].slice(0, MAX_RECENTS);
        this._settings.set_value('timer-recent-durations', new GLib.Variant('ai', recents));
        const nowS = Math.floor(GLib.get_real_time() / 1000000);
        this._settings.set_int64('timer-end-time', nowS + minutes * 60);
    }

    cancel() {
        this._settings.set_int64('timer-end-time', 0);
    }

    _sync() {
        const left = this.remainingSeconds();
        if (left === 0) {
            this._expire();
            return;
        }
        if (left === null)
            this._stopTick();
        else
            this._startTick();
        this._onTick(left);
    }

    _startTick() {
        if (this._tickId) {
            GLib.source_remove(this._tickId);
            this._tickId = null;
        }
        this._tickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            const left = this.remainingSeconds();
            if (left === 0) {
                this._tickId = null;
                this._expire();
                return GLib.SOURCE_REMOVE;
            }
            this._onTick(left);
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopTick() {
        if (this._tickId) {
            GLib.source_remove(this._tickId);
            this._tickId = null;
        }
    }

    // Clearing the setting re-enters _sync(), which stops the tick and
    // redraws the badge without the timer.
    _expire() {
        this._settings.set_int64('timer-end-time', 0);
        playSound(this._settings.get_string('timer-sound-file'), 'alarm-clock-elapsed', 'Timer');
        Main.notify(_('Timer'), _('Time is up'));
    }

    destroy() {
        this._stopTick();
        this._settings.disconnectObject(this);
        this._settings = null;
        this._onTick   = null;
    }
}

// "Timer..." panel from the settings menu: a 1-60 minute slider, the recent
// durations as one-click buttons, and Start (plus Cancel Timer while one is
// running). onClose is called exactly once, with {minutes} to start a timer,
// {cancel: true} to stop the running one, or null when dismissed (Escape /
// click outside). It holds no sources or outside signals of its own: every
// handler is on a child of this._box, which the base _finish() destroys.
export class TimerPanel extends FloatingModalPanel {
    constructor(anchorActor, recents, running, onClose) {
        super('litsycal-timer-panel', 260, 140, anchorActor, onClose);

        // _build() runs inside the base constructor, before these arguments
        // can be stored, so the parts that depend on them are filled in here.
        const initial = recents[0] ?? 5;
        this._entry.value = (initial - MIN_MINUTES) / (MAX_MINUTES - MIN_MINUTES);
        this._syncMinutesLabel();

        for (const minutes of recents) {
            const btn = new St.Button({
                label: _('%d min').replace('%d', minutes),
                style_class: 'litsycal-panel-cancel-btn',
                can_focus: true,
            });
            btn.connectObject('clicked', () => this._finish({minutes}), this);
            this._recentsBox.add_child(btn);
        }
        this._recentsBox.visible = recents.length > 0;
        this._cancelBtn.visible  = running;
    }

    _build() {
        const box = this._box;

        box.add_child(new St.Label({text: _('Timer'), style_class: 'litsycal-goto-title'}));

        const row = new St.BoxLayout({style_class: 'litsycal-panel-row', x_expand: true});
        // Named _entry because FloatingModalPanel focuses this._entry once
        // the panel is positioned; the slider is this panel's main input.
        this._entry = new Slider(0);
        this._entry.y_align = Clutter.ActorAlign.CENTER;
        this._entry.connectObject('notify::value', () => this._syncMinutesLabel(), this);
        row.add_child(this._entry);
        this._minutesLbl = new St.Label({
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'litsycal-timer-minutes',
        });
        row.add_child(this._minutesLbl);
        box.add_child(row);

        this._recentsBox = new St.BoxLayout({style_class: 'litsycal-panel-btn-row', visible: false});
        box.add_child(this._recentsBox);

        const btnRow = new St.BoxLayout({style_class: 'litsycal-panel-btn-row', x_expand: true});
        btnRow.add_child(new St.Widget({x_expand: true}));
        this._cancelBtn = new St.Button({
            label: _('Cancel Timer'),
            style_class: 'litsycal-panel-cancel-btn',
            can_focus: true,
            visible: false,
        });
        this._cancelBtn.connectObject('clicked', () => this._finish({cancel: true}), this);
        btnRow.add_child(this._cancelBtn);
        const startBtn = new St.Button({label: _('Start'), style_class: 'litsycal-panel-save-btn', can_focus: true});
        startBtn.connectObject('clicked', () => this._finish({minutes: this._minutes()}), this);
        btnRow.add_child(startBtn);
        box.add_child(btnRow);

        // Enter starts the timer from anywhere in the panel except a focused
        // button, which St activates on its own. Escape and click-outside
        // stay with FloatingModalPanel's own handler on this same box.
        box.connectObject('captured-event', (_actor, ev) => {
            if (ev.type() !== Clutter.EventType.KEY_PRESS)
                return Clutter.EVENT_PROPAGATE;
            const sym = ev.get_key_symbol();
            if (sym !== Clutter.KEY_Return && sym !== Clutter.KEY_KP_Enter)
                return Clutter.EVENT_PROPAGATE;
            if (global.stage.get_key_focus() instanceof St.Button)
                return Clutter.EVENT_PROPAGATE;
            this._finish({minutes: this._minutes()});
            return Clutter.EVENT_STOP;
        }, this);
    }

    _minutes() {
        return MIN_MINUTES + Math.round(this._entry.value * (MAX_MINUTES - MIN_MINUTES));
    }

    _syncMinutesLabel() {
        this._minutesLbl.set_text(_('%d min').replace('%d', this._minutes()));
    }
}
