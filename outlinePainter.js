// Outline painter

export class OutlinePainter {
    configure(isDark, highlightCols, topInset = 4) {
        this._isDark        = isDark;
        this._highlightCols = highlightCols;
        this._topInset      = topInset;
    }

    paint(ctx, width, height, numRows, firstCol, lastCol, lastRow) {
        const cellWidth = width / 7;
        const dark      = this._isDark;
        const shade     = dark ? 1 : 0;
        // Vertical breathing room so the outline doesn't clip day numbers.
        // A row's own height shrinks a lot at the smaller calendar sizes,
        // but the (fixed-size) event-dot strip under the number doesn't -
        // so a small cell has far less slack above its number than a
        // medium/large one. A single constant inset that clears the number
        // comfortably at Medium ends up overlapping it at Small, so the
        // caller scales this down for the compact sizes (see OUTLINE_TOP_INSET
        // in helpers.js).
        const INSET = this._topInset;

        for (const col of this._highlightCols) {
            ctx.rectangle(col * cellWidth, INSET, cellWidth, height - 2 * INSET);
            ctx.setSourceRGBA(shade, shade, shade, dark ? 0.07 : 0.06);
            ctx.fill();
        }

        const radius     = 6;
        const cellHeight = (height - 2 * INSET) / numRows;

        const SPACING = 4;
        const rowBoundaryY = row => row * cellHeight + INSET + SPACING * (row / numRows - 0.5);
        // Rounded corner at (atX, atY), leaving it towards (dirX, dirY).
        const corner = (atX, atY, dirX, dirY) =>
            ctx.curveTo(atX, atY, atX, atY, atX + radius * dirX, atY + radius * dirY);

        ctx.setLineWidth(2.5);
        ctx.setSourceRGBA(shade, shade, shade, dark ? 0.38 : 0.28);

        const top        = INSET;
        const bottom     = (lastRow + 1) * cellHeight + INSET;
        const stepY      = rowBoundaryY(lastRow);
        const notchY     = rowBoundaryY(1);
        const right      = 7 * cellWidth;
        const firstX     = firstCol * cellWidth;
        const afterLastX = (lastCol + 1) * cellWidth;

        ctx.moveTo(firstX + radius, top);
        ctx.lineTo(right - radius, top);
        corner(right, top, 0, +1);

        if (lastCol < 6) {
            ctx.lineTo(right, stepY - radius);
            corner(right, stepY, -1, 0);
            ctx.lineTo(afterLastX + radius, stepY);
            corner(afterLastX, stepY, 0, +1);
            ctx.lineTo(afterLastX, bottom - radius);
            corner(afterLastX, bottom, -1, 0);
        } else {
            ctx.lineTo(right, bottom - radius);
            corner(right, bottom, -1, 0);
        }

        ctx.lineTo(radius, bottom);
        corner(0, bottom, 0, -1);

        if (firstCol > 0) {
            ctx.lineTo(0, notchY + radius);
            corner(0, notchY, +1, 0);
            ctx.lineTo(firstX - radius, notchY);
            corner(firstX, notchY, 0, -1);
            ctx.lineTo(firstX, top + radius);
            corner(firstX, top, +1, 0);
        } else {
            ctx.lineTo(0, top + radius);
            corner(0, top, +1, 0);
        }

        ctx.lineTo(firstX + radius, top);
        ctx.closePath();
        ctx.stroke();
        ctx.$dispose();
    }
}
