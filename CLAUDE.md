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
