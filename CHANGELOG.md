# Changelog

All notable changes to Litsycal are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project doesn't yet use semantic version tags — entries are grouped by
release instead; see `metadata.json`'s `version` field for the current
GNOME Extensions build number.

## [Unreleased]

### Added

- Resize handle below the calendar grid, mirroring Itsycal's own: drag it
  down to reveal up to five extra weeks of next month's dates (dragging
  back up hides them again). The chosen row count is remembered across
  month navigation and reopening the calendar.
- Calendar system preference (Gregorian/Buddhist): shows the year as
  Gregorian + 543 in the header, day-cell accessible names, and the event
  creation/editing date pickers. Only the displayed year changes — month
  and day layout, and the dates actually saved to events, stay Gregorian.

## [3] - 2026-09-08

### Added

- Font size preference: an S/M/L slider (alongside the existing calendar
  Size slider) that scales all popup text independently of the calendar's
  button/grid dimensions.

### Changed

- Default calendar text size increased slightly for readability.
- Week numbers in the week-number gutter are now bold.

### Fixed

- Week-number gutter alignment: the `sm-plus` and `md-plus` calendar sizes
  had no dedicated gutter width/font-size rules and silently fell back to
  the base (`md`) values, throwing off the column's proportions at those two
  sizes. Every size class now scales the gutter in step with the day-name
  column.
- Week numbers sat at the grid row's raw geometric center, while day numbers
  sit slightly above it (the number+dot-row stack is centered as a group,
  and the reserved dot-row space below the number pulls that group's center
  down). Each week-number cell now reproduces the same number+dot-row
  composition as a day cell, so it lines up with the day numbers instead of
  the row's midpoint.
- The week-number gutter had no row-to-row spacing while the grid itself
  spaces its rows 4px apart, so each gutter cell drifted another 4px out of
  line with its row — barely visible on row one, worst by the last row.
  Matching that spacing on the gutter fixed the drift but also inserted an
  extra gap between the top spacer and row one (where the real grid has
  none), pushing every row down by one gap too many. Nesting the row cells
  in their own box, spaced to match the grid, fixes both: no gap before row
  one, matching 4px between every row after.

## [2] - 2026-09-07

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

[Unreleased]: https://github.com/mlkonrad/litsycal/compare/776d203...HEAD
[3]: https://github.com/mlkonrad/litsycal/compare/9c3a415...776d203
[2]: https://github.com/mlkonrad/litsycal/compare/dbfda84...9c3a415
[1]: https://github.com/mlkonrad/litsycal/commit/dbfda84
