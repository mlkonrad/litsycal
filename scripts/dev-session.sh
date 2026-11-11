#!/bin/sh -e
# Launches a nested GNOME Shell (Mutter Development Kit) for testing extension
# changes without logging out of the real session. See CLAUDE.md's "Fast
# iteration" section for why this is needed and what it does/doesn't cover.
#
# Each JS module change still requires killing and re-running this script -
# the JS engine can't unload a loaded module, so a fresh gnome-shell process
# is the only way to pick up new code (same reason a plain disable/enable is
# unreliable on this Shell version, see the module-caching caveat below).

export G_MESSAGES_DEBUG=all
export SHELL_DEBUG=all

# Skip xdg-desktop-portal / Secret Service probing, which otherwise adds
# ~30s of startup latency to every single iteration.
DEV_DBUS=/tmp/litsycal-dev-dbus
mkdir -p "$DEV_DBUS/dbus-1/services"
cat > "$DEV_DBUS/dbus-1/services/org.freedesktop.secrets.service" <<'EOF'
[D-BUS Service]
Name=org.freedesktop.secrets
Exec=/bin/false
EOF

# Cleanup: dbus-run-session only stops its dbus-daemon when gnome-shell exits
# normally. If the session is killed instead, the daemon and every
# bus-activated service (portals, gvfs, goa, evolution, ...) are reparented to
# systemd and live on. An orphaned xdg-desktop-portal once spun a full CPU core
# for hours that way. So the inner shell records the private bus address, and
# on exit we kill every process still carrying that address in its
# environment, then the daemon itself.
BUS_FILE=$(mktemp "${TMPDIR:-/tmp}/litsycal-dev-bus.XXXXXX")
RUN_PID=

cleanup() {
    trap - EXIT INT TERM HUP
    daemon=
    if [ -n "$RUN_PID" ]; then
        daemon=$(pgrep -P "$RUN_PID" -x dbus-daemon || true)
    fi
    addr=$(cat "$BUS_FILE" 2>/dev/null || true)
    if [ -n "$addr" ]; then
        for pid in $(pgrep -u "$(id -u)"); do
            if tr '\0' '\n' 2>/dev/null < "/proc/$pid/environ" |
                grep -qxF "DBUS_SESSION_BUS_ADDRESS=$addr"; then
                kill "$pid" 2>/dev/null || true
            fi
        done
    fi
    if [ -n "$daemon" ]; then
        kill $daemon 2>/dev/null || true
    fi
    if [ -n "$RUN_PID" ]; then
        kill "$RUN_PID" 2>/dev/null || true
    fi
    rm -f "$BUS_FILE"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

# Run in the background and wait, so a signal to this script runs the trap
# right away instead of after the nested shell exits.
env GTK_A11Y=none ADW_DISABLE_PORTAL=1 \
    XDG_DATA_DIRS="$DEV_DBUS:${XDG_DATA_DIRS:-/usr/local/share:/usr/share}" \
    dbus-run-session -- sh -c \
        'printf %s "$DBUS_SESSION_BUS_ADDRESS" > "$1"; exec gnome-shell --devkit --wayland' \
        sh "$BUS_FILE" &
RUN_PID=$!
status=0
wait "$RUN_PID" || status=$?
exit "$status"
