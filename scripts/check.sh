#!/bin/sh -e
# Runs the same checks as .github/workflows/ci.yml, locally. Used by the
# pre-push hook (.githooks/pre-push) and safe to run by hand any time —
# `./scripts/check.sh`. Keep this in sync with ci.yml's steps; it exists so
# a lint/syntax/translation regression is caught before a push, not after,
# in an environment (like this one, historically) where CI itself was the
# only place ESLint ever actually ran. See CLAUDE.md's "Pre-push checks"
# section for how this came about.
cd "$(dirname "$0")/.."

echo "== Compile schemas (strict, dry-run) =="
glib-compile-schemas schemas/ --strict --dry-run

echo "== ESLint (GNOME Shell ruleset) =="
npm run lint

echo "== Syntax-check JS =="
cat > /tmp/litsycal-check-syntax.js <<'EOF'
const fname = ARGV[0];
const [, bytes] = imports.gi.GLib.file_get_contents(fname);
const text = imports.byteArray.toString(bytes);
try {
    Reflect.parse(text, {target: 'module'});
} catch (e) {
    printerr(`Syntax error in ${fname}: ${e}`);
    imports.system.exit(1);
}
EOF
for f in *.js; do
    gjs /tmp/litsycal-check-syntax.js "$f"
done
rm -f /tmp/litsycal-check-syntax.js

echo "== Validate translations =="
for po in po/*.po; do
    msgfmt --check "$po" -o /dev/null
done

echo "== Validate POT =="
msgfmt --check-format po/*.pot -o /dev/null

echo "All checks passed."
