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

## extensions.gnome.org review guidelines (publishing target)

Full guide: https://gjs.guide/extensions/review-guidelines/review-guidelines.html
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
  only). Keep that split when adding to either file.
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
  `.git`, `.github`, `CLAUDE.md`, `po/` (source `.po`/`.pot`/`LINGUAS`), and
  `screenshot.png`; keep only the compiled `locale/pt_BR/LC_MESSAGES/*.mo`,
  which is what actually ships at runtime.
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
