# Changelog

All notable changes to Litsycal are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project doesn't yet use semantic version tags — entries are grouped by
release instead, numbered sequentially ([1], [2], [3], …). This counter is
maintained by hand here and is independent of `metadata.json` (which no
longer carries a `version` key — see that file's history for why).

## [Unreleased]

## [5] - 2026-09-12

### Added

- Appearance now has a "Short day names" toggle for the grid's weekday
  header row: single-letter labels (M T W T F S S) instead of the default
  three-letter abbreviations, derived from the same locale data so it works
  in any language (e.g. S T Q Q S S D for pt_BR) without new translation
  strings for the letters themselves.
- The event info popover's Notes text now splits around any URLs it
  contains (e.g. the "Join with Google Meet: <url>" boilerplate many
  calendar servers add) so each one renders as its own clickable row
  instead of inert text.

### Changed

- The agenda list's icon for a plain URL (as opposed to a detected meeting
  link) now sits inline with the time, coloured to match the event's own
  calendar — the same treatment the meeting-join icon already had, instead
  of a separate grey icon in its own column at the far right.

### Fixed

- Clicking an event with a meeting link, a URL, or a link embedded in its
  notes broke the event info popover: instead of the usual small card, it
  rendered as a hugely oversized, mostly-empty rectangle covering most of
  the screen. A negative CSS margin on the popover's link-row style class
  (`margin: -2px -4px`, meant to offset extra padding for a bigger hover
  area) corrupted that row's computed height on this Shell version — an
  underlying Clutter/St layout bug (reproducibly returns exactly 2^33
  regardless of content), not a logic error, and no exception was ever
  thrown. Removing the negative margin fixes it; see CLAUDE.md's dev notes
  for how this was tracked down.

## [4] - 2026-09-10

### Added

- Clicking an event in the agenda now opens a compact, read-only info
  popover next to the row — itsycal's own AgendaPopoverVC, ported — instead
  of jumping straight into the full edit form: title, date/time, location,
  recurrence, a Join meeting button when applicable, notes, and URL, with a
  small arrow pointing at the clicked row and a delete button. `Esc` closes
  it, `Backspace`/`Delete` deletes the event (with the same repeating-event
  confirmation prompt as the edit dialog's own Delete button), and clicking
  toggles it: clicking outside or on the same event again closes it,
  clicking a different event switches straight to that one's popover in
  the same click. Respects the font-size setting. Editing an event now
  lives one step further away, in the row's right-click menu's new Edit…
  entry. Documented in the wiki's Keyboard Shortcuts page.
- Rounded out the rest of Itsycal's keyboard shortcuts (mowglii.com/itsycal/help)
  on top of the existing h/j/k/l day/week/month/year navigation: `#` flashes
  the selected day's offset from today and day-of-year in the month label;
  `Ctrl+J`/`Ctrl+K` add/remove a calendar week row; `P` pins/unpins the
  calendar; `W` and `.` toggle week numbers and agenda event locations;
  `Ctrl+,` opens Settings; `Ctrl+O` opens the default calendar app; `Ctrl+N`
  creates a new event; `Ctrl+Shift+T` goes to a date; `Ctrl+Alt+R` refreshes
  events; `Ctrl+Q` quits Litsycal. Itsycal's Command-tier shortcuts move to
  Ctrl (no Command key on Linux); opening the first active meeting
  (Itsycal's `⌘J`) becomes `Ctrl+Shift+J` instead of plain `Ctrl+J`, which
  is already taken by add-week-row. Documented in the README and wiki's
  Keyboard Shortcuts sections.
- Settings menu (gear button in the calendar footer, or right-clicking the
  panel icon): About, Check for updates (not implemented yet), Go to date,
  Settings, Appearance, Help, and Quit Litsycal — each with a matching icon.
  The calendar dropdown stays open behind the menu; selecting About,
  Settings, Appearance, Help, or Quit closes it afterwards, while Go to date
  leaves it open and floats a small yyyy-mm-dd entry in front of it that
  jumps the calendar straight to that day. About, Settings, and Appearance
  each open the Preferences window on the matching tab; Help opens the
  project wiki.
- Resize handle below the calendar grid, mirroring Itsycal's own: drag it
  down to reveal up to five extra weeks of next month's dates (dragging
  back up hides them again). The chosen row count is remembered across
  month navigation and reopening the calendar.
- Calendar system preference (Gregorian/Buddhist): shows the year as
  Gregorian + 543 in the header, day-cell accessible names, and the event
  creation/editing date pickers. Only the displayed year changes — month
  and day layout, and the dates actually saved to events, stay Gregorian.
- Multi-day events now show a dot and an agenda entry on every day they
  span, not just their start day, mirroring Itsycal's own EventCenter,
  which walks each event's full date range rather than just its start date.
- Hovering a multi-day event in the agenda list now highlights every day it
  spans in the calendar grid above, using the same tint as a plain day-cell
  hover — mirrors Itsycal's `agendaHoveredOverRow`/`highlightCellsFromDate`.
- Overflow (adjacent-month) days now show event dots too, faded to signal
  they're outside the active month while keeping each event's own colour —
  matching Itsycal. They're fully interactive like a real day cell: hover
  tint, the hover-delay day tooltip, and click/keyboard selection. Selecting
  one mirrors Itsycal's `MoCalendar` exactly: the displayed month stays put
  and the selection lands on the visible overflow cell itself, only jumping
  months once navigation moves the selection off the whole rendered grid
  (not merely into a different calendar month).
- Two Appearance preferences for the agenda list, mirroring Itsycal: "Show
  event location" (on by default, matching the existing unconditional
  behaviour) hides each event's location row when off; "Show days with no
  events" (off by default) lists every day in the agenda range instead of
  skipping empty ones, matching Itsycal's `ShowLocation`/
  `ShowDaysWithNoEventsInAgenda`. The very first day in the range still
  always shows (with a "No events" label when empty), regardless of the
  latter setting — unchanged from litsycal's existing behaviour.
- Right-clicking an agenda event now opens a context menu — Open Calendar,
  Copy, Delete… — mirroring Itsycal's agenda context menu
  (`AgendaViewController.menuNeedsUpdate:`). Open Calendar launches
  `gnome-calendar --date` on the event's own date rather than just the app
  (Itsycal's `showCalendarAppAtDate:`); Copy writes the title, date/time, and
  location to the clipboard (Itsycal's `copyEventToPasteboard:`); Delete…
  reuses the same this-event/all-events confirmation as the event edit
  panel's own Delete button (Itsycal's `deleteEvent:`/
  `agendaWantsToDeleteEvent:`), now factored out into a shared
  `confirmDeleteEvent` helper so both places stay in sync.

### Changed

- The gear button in the calendar footer and right-clicking the panel icon
  now both open the new settings menu above instead of jumping straight to
  the Preferences window.
- Preferences window widened slightly (480px → 600px) so its General/
  Appearance/About tab switcher stays in the header instead of collapsing to
  a bottom bar — libadwaita's own responsive behaviour, not something this
  project controls directly, but the extra width keeps clear of the
  breakpoint.

### Fixed

- The event dialog's Ends date reverted to the start date every time a
  multi-day event was reopened, even though the correct end date was saved
  and shown correctly elsewhere (e.g. GNOME Calendar). The calendar reader
  parsed `DTEND`'s time but never its date, so the dialog had nothing but
  the start date to fall back to.
- A calendar row in Preferences → Calendars could render completely blank
  (no colour dot, no name) if its source reported colour as `rgb(...)`
  rather than hex — valid everywhere else in the app, but rejected by the
  Pango markup the row's title was built from, which silently dropped the
  whole title. The colour dot is now its own widget, parsed with
  `Gdk.RGBA` (hex, `rgb()`/`rgba()`/`hsl()`, and named colours all work),
  so the title text can't be taken down by an unexpected colour format.
- Calendar source colour is now normalized to hex once, right where it's
  read from EDS, instead of every consumer needing to tolerate whatever
  format a given backend hands back (this is what let Google's `rgb(...)`
  colour reach the Preferences title in the first place).
- Pinning the calendar (the pin button in its footer) would visibly shrink
  and shift it: its width was measured right after detaching it from the
  open popup, when it briefly reads as 0 (no layout pass yet), and its
  position was re-derived from the panel button's coordinates rather than
  reused from where it was already showing. Both are now captured from the
  calendar's actual on-screen size and position just before the detach.
- Every floating popup (settings menu, event edit panel, go-to-date panel,
  delete confirmation, day-cell hover tooltip) briefly flashed its shadow at
  the screen's top-left corner when opened. Each is added to the screen
  before its real position can be computed (that needs a layout pass to know
  the popup's size first), so it was visible at its pre-layout `(0, 0)`
  default for a frame. Each now starts at `opacity: 0` and only becomes
  visible once actually positioned.
- Pressing Escape in the event edit panel (or its delete confirmation) closed
  the whole calendar dropdown instead of just that panel, and afterwards
  every keyboard shortcut went dead until the extension was reloaded. Two
  compounding bugs: Escape was only listened for on `global.stage`, which
  the calendar dropdown's own modal grab intercepts before it gets there, so
  its built-in close-on-Escape fired instead; and the callback that clears
  the calendar's reference to the closed panel only ran on a successful
  save/delete, not on a plain cancel, so that stale reference permanently
  blocked the in-calendar keyboard handler. Both panels now take their own
  competing modal grab (matching the settings/go-to-date panels) and notify
  their caller from a single always-runs `close()`.
- An agenda event's right-click "Open Calendar" always opened GNOME Calendar
  on today's date instead of the event's date. It passed the event date in
  ISO `YYYY-MM-DD` to `gnome-calendar --date`, but that flag is parsed with
  evolution-data-server's `e_time_parse_date_and_time()`, which expects the
  locale's own short-date order (`MM/DD/YYYY` for en_US, `DD/MM/YYYY`
  elsewhere, ...) — the ISO string never matched, so gnome-calendar silently
  fell back to today. The date is now formatted with GLib's own `%x` first,
  matching whatever order `gnome-calendar` itself expects on the running
  system.

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

[Unreleased]: https://github.com/mlkonrad/litsycal/compare/d257c22...HEAD
[5]: https://github.com/mlkonrad/litsycal/compare/b9c302f...d257c22
[4]: https://github.com/mlkonrad/litsycal/compare/776d203...b9c302f
[3]: https://github.com/mlkonrad/litsycal/compare/9c3a415...776d203
[2]: https://github.com/mlkonrad/litsycal/compare/dbfda84...9c3a415
[1]: https://github.com/mlkonrad/litsycal/commit/dbfda84
