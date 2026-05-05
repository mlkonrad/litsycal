# Litsycal

A compact calendar indicator for the GNOME panel, inspired by [Itsycal](https://github.com/sfsam/itsycal) for macOS.

![Litsycal logo](litsycal-logo.svg)

## About

Litsycal brings the simplicity of Itsycal to Linux. Click the panel indicator to reveal a small monthly calendar. No frills, no clutter.

**Supported GNOME Shell versions:** 48, 49, 50

## Installation

1. Clone the repository:
   ```bash
   git clone git@github.com:mlkonrad/litsycal.git
   ```

2. Copy to your GNOME extensions directory:
   ```bash
   cp -r litsycal ~/.local/share/gnome-shell/extensions/litsycal@mlkonrad.github.com
   ```

3. Compile the settings schema:
   ```bash
   glib-compile-schemas ~/.local/share/gnome-shell/extensions/litsycal@mlkonrad.github.com/schemas/
   ```

4. Restart GNOME Shell and enable the extension:
   ```bash
   gnome-extensions enable litsycal@mlkonrad.github.com
   ```

## Credits

Litsycal is a Linux port of **[Itsycal](https://github.com/sfsam/itsycal)**, a tiny menu bar calendar for macOS created by **[sfsam](https://github.com/sfsam)**. The original concept, design, and inspiration all belong to him.

- Original project: https://github.com/sfsam/itsycal
- Original author's website: http://www.mowglii.com/itsycal

## License

MIT License — see [LICENSE](LICENSE) for details.

The original Itsycal is also released under the MIT License.
