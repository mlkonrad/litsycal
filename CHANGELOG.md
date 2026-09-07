# Changelog

All notable changes to Litsycal are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project doesn't yet use semantic version tags — entries are grouped by
release instead; see `metadata.json`'s `version` field for the current
GNOME Extensions build number.

## [Unreleased]

### Added

- Keyboard navigation inside the open calendar: arrow keys (and vi-style
  `h`/`j`/`k`/`l`) move the selected day, Shift moves by month/year, and
  Space jumps to today. Documented in the README's new Keyboard Shortcuts
  section.

### Fixed

- The in-calendar key listener never actually fired: it was attached to
  `global.stage`, but the popup's modal grab scopes event delivery to the
  menu's own actor, so the listener needed to move there instead.
- Bare `Down` (with or without Shift) can never reach the calendar at all —
  GNOME Shell's `PopupMenu` reserves that keysym for its own accessibility
  keynav whenever a menu drops down from the top panel, and consumes it
  before any of the extension's own handlers run. `j`/`Shift+J` are the
  reliable way to trigger that direction now.
- `Shift+Up`/`Shift+Down` moved through years in the opposite direction from
  what was intended (`Shift+Up` now goes forward a year, `Shift+Down`/
  `Shift+J` back).

## [1] - Initial release

- Compact monthly calendar dropdown from the GNOME panel indicator, in the
  style of Itsycal.
- Live calendar integration via Evolution Data Server (EDS), with
  real-time updates as events change.
- Week agenda list showing event times, locations, and meeting-join links,
  scaled to the calendar size.
- Event creation and editing via GNOME Calendar (opened directly, or via a
  D-Bus `open-event` call for existing events).
- Per-calendar visibility toggle, event-dot toggle, and right-click panel
  menu (Preferences / Quit).
- Configurable agenda range, optional ISO week-number column, and hover
  tooltip preview on day cells.
- Multiple panel badge styles (number, calendar, text, and dark variants)
  with a configurable date/time pattern.
- Multi-monitor support.
- Configurable global keyboard shortcut to toggle the popup.
- Internationalization via gettext, including a Brazilian Portuguese
  translation.

[Unreleased]: https://github.com/mlkonrad/litsycal/compare/dbfda84...HEAD
[1]: https://github.com/mlkonrad/litsycal/commit/dbfda84
