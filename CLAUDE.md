# Litsycal dev notes

## Local install is a symlink

On this machine, `~/.local/share/gnome-shell/extensions/litsycal@mlkonrad.github.com`
is a **symlink** to this repo (not a copy). Editing files here is editing what
GNOME Shell loads — there is no separate deploy/copy step.

Do NOT run `cp -r` over that path (per the README's install instructions) —
that would replace the symlink with a real directory and silently break this
setup, bringing back the "edits don't show up" problem.

To reload after a code change (schema changes need the compile step too):

```bash
glib-compile-schemas schemas/ --strict   # only needed after editing schemas/*.xml
gnome-extensions disable litsycal@mlkonrad.github.com
gnome-extensions enable litsycal@mlkonrad.github.com
```

`schemas/gschemas.compiled` is generated and gitignored — always regenerate it
in place after touching the `.xml` schema, since GNOME reads it from here now.

## GNOME Shell module caching caveat

`disable`/`enable` does not reliably reload changed `extension.js` code in
every GNOME Shell session (observed on Shell 50 — the old module can stay
cached even across a clean disable/enable cycle). If behavior still looks
stale after reloading, a full log out/in is the sure fix — GNOME Shell can't
restart in place on Wayland like it can on X11 (`Alt+F2` → `r`).

## Fast iteration: nested devkit session (no logout needed)

`mutter-devkit` (installed on this machine, package `mutter-devkit`,
matches this machine's Shell 50) lets you spin up a throwaway nested Shell
that reads the same `~/.local/share/gnome-shell/extensions/` symlink and
the same dconf `enabled-extensions` list as the real session, without
touching it:

```bash
./scripts/dev-session.sh
```

This is a one-shot process — after editing JS, kill it (`Ctrl+C` or close
its window) and re-run the script to get a fresh interpreter with the new
code loaded. That's the same "JS can't be unloaded" constraint as the
caveat above; the nested session just makes paying that cost cheap (a few
seconds, not a full logout) instead of expensive. The script also disables
xdg-desktop-portal/Secret Service probing, which otherwise adds ~30s to
every launch.

Use this for iterating on JS logic and layout. Still fall back to a full
log out/in for anything that depends on the real session specifically
(actual notification daemon, real background apps/indicators, hardware,
lock screen) or if something looks stale in the nested session and you
need to rule out a devkit-specific quirk.

### The nested session has its own private evolution-data-server

`dev-session.sh` launches gnome-shell under `dbus-run-session`, which gives
the nested session its own isolated D-Bus session bus, separate from your
real login session's. Since EDS (evolution-source-registry,
evolution-calendar-factory) is D-Bus-activated per session bus, the nested
session gets its own separate EDS process — not the one your real session
already has running. Calendar *source config* (the `.source` files under
`~/.config/evolution/sources/`) is shared, so the nested session sees the
same calendars, but each EDS process keeps its own in-memory view of
backend data, refreshed only by its own live-update signals.

Practical effect: a calendar data change made against your real session
(adding/editing/deleting an event via GNOME Calendar, a script, or another
tool) is invisible to the nested session — its litsycal instance won't
live-update, because the write happened on a different EDS process it was
never notified by — even though a raw query against the *real* session's
EDS would show the change immediately. Confirmed for real testing the
attendee-colors feature (2026-09-12): a test event created against the
outer session's bus never appeared in the nested session's agenda; the
same event created against the nested session's own bus (its address is in
the nested `gnome-shell --devkit` process's environment as
`DBUS_SESSION_BUS_ADDRESS`, readable via `/proc/<pid>/environ` for a quick
one-off script) showed up live, no restart needed — proving litsycal's own
live-view refresh logic (`calendarManager.js`'s `_startView`) works fine;
the missed update was purely a which-EDS-process problem, not a litsycal
bug.

So: to test a calendar data change inside the nested session, either make
it through a client connected to the nested session's own bus, or just
restart the nested session (kill + re-run `dev-session.sh`) — a fresh
launch's EDS process reads the on-disk backend data fresh, same as the
"JS can't be unloaded" restart above but for data instead of code.

## Negative CSS margin corrupts St layout on this Shell version

Hit for real fixing the event info popover, 2026-09-12 (see CHANGELOG's
Unreleased/Fixed entry): a negative `margin` on an St widget's style class —
`.litsycal-info-popover-link-btn` had `margin: -2px -4px;`, meant to offset
extra `padding` for a bigger hover/click area — corrupts that widget's
`get_preferred_height()`/`get_height()` on this machine's GNOME Shell/Mutter
build (Shell 50 dev, `mutter-18`/`St-18` typelibs) to exactly `8589934592`
(2^33), regardless of the widget's actual content. Reproduced identically on
both `St.Button` and a plain `St.BoxLayout` — it's not a `St.Button`-specific
bug. A *hard* CSS `width`/`height` value on a widget is respected fine; a
*soft* `max-height` on an ancestor does **not** clamp this corrupted value —
it passes straight through. No JS exception is thrown anywhere, so this
class of bug is invisible to `journalctl` error-grepping; the corrupted
number just silently becomes the actor's real allocated size, blowing up
(or collapsing) whatever contains it.

If a popup/panel ever renders at a wildly wrong size again with nothing in
the logs, grep `stylesheet.css` for `margin: -` on the actor involved before
suspecting a JS logic bug. More generally, the fastest way to debug "insane
size, no exception" bugs in this project is live, on this machine's actual
running GNOME Shell (see "Local install is a symlink" above): temporarily
add `console.error()` calls logging `get_width()`/`get_height()` and each
child's `get_preferred_height()`, reload, ask for a repro click, then
`journalctl --user -b 0 | grep <marker>`. Stylesheet-only changes reload
reliably via plain disable/enable; JS module changes need the full log
out/in from the caveat above to be sure they took effect — don't trust a
disable/enable alone when chasing a change that doesn't seem to have landed.

## extensions.gnome.org review guidelines (publishing target)

Full guide: https://gjs.guide/extensions/review-guidelines/review-guidelines.html
GNOME also publishes a second, LLM-targeted checklist aimed specifically at
AI coding assistants working on GNOME Shell extensions:
https://gjs.guide/extensions/review-guidelines/best-practices.html
This project is being prepared for submission to the official EGO review, so
new code should keep meeting these — checked clean as of 2026-09-07:

- **Lifecycle discipline**: nothing gets created, connected, or scheduled at
  module scope — only in `enable()`. Everything created in `enable()` must be
  torn down in `disable()` (widgets destroyed, every `connect()` id explicitly
  disconnected, every `GLib.timeout_add*`/`source_remove`d, instance vars set
  back to `null`). `LitsycalExtension.enable/disable` in extension.js and the
  `_settings`/`_iface` id tracking + `destroy()` cleanup in `LitsycalIndicator`
  already follow this — keep new state on the same pattern.
- **No deprecated imports**: no `ByteArray`, `Lang`, or `Mainloop`. Use ESM
  `import`, GLib/GObject natively, `imports.byteArray` replacements, etc.
- **Don't mix process libraries**: no `Gtk`/`Gdk`/`Adw` in extension.js (Shell
  process) and no `St`/`Clutter`/`Meta` in prefs.js (separate process, GTK
  only). Keep that split when adding to either file. helpers.js is
  imported by Shell-process files (indicator.js, calendarWidget.js, etc.)
  but is NOT safe to import from prefs.js: its
  `import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js'`
  is a Shell-process-only resource path (prefs.js's own gettext comes from
  `resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js` — a
  different namespace). Importing helpers.js from prefs.js throws
  `ImportError: Unable to load file from: resource:///org/gnome/shell/
  extensions/extension.js` and breaks Preferences outright (hit for real
  building the second-time-zone feature, 2026-09-11) — any prefs-only logic
  belongs directly in prefs.js instead, even if it looks generic enough to
  share. Also note: `org.gnome.Shell.Extensions` (the prefs window's D-Bus
  service) caches its modules across `gnome-extensions prefs` invocations
  like gnome-shell itself does for extension.js — after fixing a prefs.js
  import bug, `pkill -f org.gnome.Shell.Extensions` before retesting, or the
  old broken import stays cached.
- **No unnecessary try/catch or optional-chaining guards**: don't wrap
  standard GObject/GLib methods (`destroy()`, `connect()`, `disconnect()`,
  `abort()`, `GLib.Source.remove()`) in try/catch, and don't `?.()`-guard a
  call to a method that's guaranteed to exist on the object's type — both
  read as defensive padding to reviewers. Already audited in this repo
  (commit b4321e9, 2026-09-11) and found NOT to be violations — don't
  re-flag these without new evidence:
  - `calendarManager.js` try/catches around EDS client `.disconnect(null)`
    and registry `.disconnect(id)` — an already-torn-down EDS/D-Bus-backed
    client can genuinely throw on disconnect, unlike a plain
    GObject.disconnect().
  - `calendarManager.js` optional-chaining on ICalGLib getters
    (`get_description?.()`, `get_first_property?.(...)`, etc.) — these read
    optional iCal fields (VALARM, RRULE, URL, RECURRENCE-ID) that legitimately
    may be absent depending on the calendar data and evolution-data-server
    version, not guaranteed-present built-ins.
  - `Gio.Subprocess`/`Gio.AppInfo.launch_default_for_uri` calls in
    eventDialog.js/eventInfoPopover.js/calendarWidget.js/prefs.js wrapped in
    try/catch — launching an external app/URI handler can fail for real
    reasons (app not installed, invalid URI), unlike a GObject method call.
  A try/catch around a call that can genuinely throw is fine either way —
  keep the short comment explaining why, as these already do.
- **No lifecycle guard flags**: don't add booleans like `this._destroyed` to
  prevent post-destroy races — null out the instance var on cleanup instead
  and let that be the guard (already the pattern everywhere in this repo).
- **`destroy()` order**: remove timeouts/GLib sources first, then disconnect
  signals, then release other resources, then call `super.destroy()` last.
  Override `destroy()` directly on GObject-derived widgets rather than
  connecting to the `destroy` signal (already true everywhere in this repo).
- **Icons and progress**: use `Gtk.Image`/`St.Icon` for icons (never emoji
  glyphs), and shell widgets (`St.Bin`, GNOME's bar-level widget) for
  progress, not ASCII bars.
- **Comments**: no trivial comments that just restate what the next line of
  JS does — matches this project's existing no-comments-unless-non-obvious
  rule above the fold in this file.
- **Settings pairing**: `settings-schema` in metadata.json is paired with a
  parameterless `this.getSettings()` call — already true in extension.js and
  prefs.js; don't reintroduce the old schema-path-argument form.
- **Structural**: keep `enable()`/`disable()` adjacent in extension.js for
  easy diffing, keep the entry-point file small with logic split into
  single-responsibility modules (already the shape of this repo), avoid
  unjustified method aliases, and co-locate a timeout's removal check
  immediately before the line that creates its replacement (see the
  `_dayInfoTimeoutId` pattern in calendarWidget.js).
- **AI-generated code notices**: this checklist asks AI assistants to flag
  AI-authored code with a comment unless the human author understands the
  JavaScript, and for an author who does understand it to strip such
  comments before EGO upload. Not applicable here as a literal comment (the
  user reads and directs every change), but keep the intent: don't let
  generated code ship without the user having actually reviewed it.
- **No `eval`, no obfuscated/minified code, no bundled binaries**. If a build
  step is ever introduced, ship readable transpiled output, not minified.
- **No telemetry/tracking of users**, no clipboard access without declaring
  it, no sharing data with third parties without explicit user action.
- **Logging**: keep `console.log`/`print` out of normal operation (currently
  zero in the codebase) — noisy logging is a rejection reason.
- **metadata.json**: uuid must stay in the `litsycal@mlkonrad.github.com` form
  (no `gnome.org` namespace — already fine); `shell-version` should list
  stable versions plus at most one unreleased/dev version, trimmed as new
  Shell versions ship; only necessary keys. Don't hand-set a `version` key —
  it's marked Deprecated in the guide ("set for internal use by
  extensions.gnome.org"); EGO assigns it on upload.
- **GSettings schema id** must stay under the `org.gnome.shell.extensions.*`
  base (already true: `org.gnome.shell.extensions.litsycal`).
- **`GObject.Object.run_dispose()`** must not be called without a documented
  reason — currently unused, keep it that way unless justified in a comment.
- Code must be genuinely functional (not a stub) and avoid interfering with
  other extensions or the shell's own systems.
- **Unnecessary files**: the guide's Recommendations discourage shipping
  `.po`/`.pot` files, build/install scripts, and unused media — a reviewer
  *may* reject for an unreasonable amount of unnecessary data. If the EGO
  upload is a zip of the whole repo rather than hand-picked files, exclude
  `.git`, `.github`, `CLAUDE.md`, `po/` (source `.po`/`.pot`/`LINGUAS`),
  `screenshot.png`, `package.json`/`package-lock.json` (dev-only, just the
  `eslint` devDependency + lint script — no build/bundle step), and
  `eslint.config.js` (lint config, also dev-only); keep only the compiled
  `locale/pt_BR/LC_MESSAGES/*.mo`, which is what actually ships at runtime.
- **Licensing**: `LICENSE` is MIT (Marlon Konrad, 2026), reproduces Itsycal's
  original MIT notice (Sanjay Madan, 2016 — litsycal ports/adapts parts of
  its design and behavior, e.g. `_makeOverflow`'s `MoCalCell` comment and
  `_updateAgendaMaxHeight`'s `agendaMaxPossibleHeight` comment in
  extension.js, so MIT's "include the original notice" condition applies),
  and adds an explicit grant permitting extensions.gnome.org/GNOME Foundation
  to distribute under GPL-2.0-or-later-compatible terms — the pattern the
  guide describes for permissively-licensed extension code. Keep all three
  sections if LICENSE is ever regenerated/reformatted.
- **Naming**: "Litsycal" echoes "Itsycal" closely enough (same product
  category, near-identical name, README/LICENSE assert direct lineage) that
  it was worth clearing with the original author before wider distribution —
  Sanjay Madan approved the name and the "port of Itsycal" framing directly
  (contacted by email 2026-09-08, approval received same day). The email
  thread is the written record — check that if this ever needs revisiting.
- Before submitting: run through metadata.json shell-version pruning, confirm
  `schemas/gschemas.compiled` isn't committed stale, confirm no unnecessary
  files are in the upload, and skim for any new `enable()`-time side effects
  introduced since the last review pass.
