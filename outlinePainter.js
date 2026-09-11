// ── Outline painter ───────────────────────────────────────────────────────────

export class OutlinePainter {
    configure(isDark, highlightCols, topInset = 4) {
        this._isDark        = isDark;
        this._highlightCols = highlightCols;
        this._topInset      = topInset;
    }

    paint(cr, w, h, numRows, firstCol, lastCol, lastRow) {
        const cw    = w / 7;
        const dark  = this._isDark;
        // Vertical breathing room so the outline doesn't clip day numbers.
        // A row's own height shrinks a lot at the smaller calendar sizes,
        // but the (fixed-size) event-dot strip under the number doesn't —
        // so a small cell has far less slack above its number than a
        // medium/large one. A single constant inset that clears the number
        // comfortably at Medium ends up overlapping it at Small, so the
        // caller scales this down for the compact sizes (see INSET_BY_SIZE).
        const INSET = this._topInset;

        for (const col of this._highlightCols) {
            cr.rectangle(col * cw, INSET, cw, h - 2 * INSET);
            cr.setSourceRGBA(dark ? 1 : 0, dark ? 1 : 0, dark ? 1 : 0, dark ? 0.07 : 0.06);
            cr.fill();
        }

        const r  = 6;
        const ch = (h - 2 * INSET) / numRows;
        const fc = firstCol;
        const lc = lastCol;
        const lr = lastRow;

        const SPACING = 4;
        const rowGap  = i => i * ch + INSET + SPACING * (i / numRows - 0.5);
        const C = (px, py, dx, dy) =>
            cr.curveTo(px, py, px, py, px + r * dx, py + r * dy);

        const [ar, ag, ab] = dark ? [1, 1, 1] : [0, 0, 0];
        cr.setLineWidth(2.5);
        cr.setSourceRGBA(ar, ag, ab, dark ? 0.38 : 0.28);

        const top    = INSET;
        const bottom = (lr + 1) * ch + INSET;
        const stepY  = rowGap(lr);
        const notchY = rowGap(1);

        cr.moveTo(fc * cw + r, top);
        cr.lineTo(7 * cw - r, top);
        C(7 * cw, top, 0, +1);

        if (lc < 6) {
            cr.lineTo(7 * cw, stepY - r);
            C(7 * cw, stepY, -1, 0);
            cr.lineTo((lc + 1) * cw + r, stepY);
            C((lc + 1) * cw, stepY, 0, +1);
            cr.lineTo((lc + 1) * cw, bottom - r);
            C((lc + 1) * cw, bottom, -1, 0);
        } else {
            cr.lineTo(7 * cw, bottom - r);
            C(7 * cw, bottom, -1, 0);
        }

        cr.lineTo(r, bottom);
        C(0, bottom, 0, -1);

        if (fc > 0) {
            cr.lineTo(0, notchY + r);
            C(0, notchY, +1, 0);
            cr.lineTo(fc * cw - r, notchY);
            C(fc * cw, notchY, 0, -1);
            cr.lineTo(fc * cw, top + r);
            C(fc * cw, top, +1, 0);
        } else {
            cr.lineTo(0, top + r);
            C(0, top, +1, 0);
        }

        cr.lineTo(fc * cw + r, top);
        cr.closePath();
        cr.stroke();
        cr.$dispose();
    }
}
