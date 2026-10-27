import { clamp } from "./utils";

/**
 * The geometry that relates the editor's scroll space to the minimap panel.
 *
 * Kept free of the DOM deliberately: every input is a number the caller has
 * already measured, which makes the arithmetic here reviewable on its own and
 * keeps the measuring and the mapping from tangling together.
 */

export interface DocumentHeights {
    /** The full scroll range the editor actually offers. */
    effectiveScrollHeight: number;
    /** Minimap panel height, falling back to the editor's when unmeasurable. */
    contentHeight: number;
}

/**
 * The mapping covers the editor's whole scroll range, including the space
 * Obsidian adds for scrolling past the end of a note. Excluding it made the
 * thumb reach its stop while the editor kept scrolling, so wheel distance
 * stopped matching thumb travel near the bottom and the scroll felt sticky.
 * The panel carries a matching spacer so the two stay proportional.
 */
export function resolveDocumentHeights(
    this: void,
    clientHeight: number,
    scrollHeight: number,
    measuredContentHeight: number
): DocumentHeights {
    const effectiveScrollHeight = Math.max(clientHeight, scrollHeight);
    return {
        effectiveScrollHeight,
        // The panel's height differs from the editor's scroll height, so map
        // through its own measurement rather than assuming they match.
        contentHeight:
            measuredContentHeight > 1
                ? measuredContentHeight
                : effectiveScrollHeight,
    };
}

/**
 * How far either side of the viewport the thumb's height is averaged, in
 * screens, as far as the editor has measured. Wide enough that one tall block
 * barely moves it, narrow enough that it still tracks a long stretch drawn
 * denser or sparser than the editor.
 */
const THUMB_REACH = 2;

export interface ScrollMetricsInput {
    clientHeight: number;
    scrollHeight: number;
    scrollTop: number;
    containerHeight: number;
    topOffset: number;
    bottomOffset: number;
    effectiveScrollHeight: number;
    contentHeight: number;
    scale: number;
    minViewportHeight: number;
    /**
     * Maps an editor Y to an unscaled minimap Y. When null the mapping is a
     * single global ratio, which is all that reading view's virtualized
     * sections can support.
     */
    mapToMinimap: ((editorY: number) => number) | null;
    /**
     * The stretch of the editor's scroll space whose heights it has measured
     * rather than estimated, or null when that doesn't matter.
     */
    measuredRange?: [number, number] | null;
}

export interface ScrollMetrics {
    clientHeight: number;
    maxScroll: number;
    scrollTop: number;
    activeHeight: number;
    scaledDocumentHeight: number;
    docScale: number;
    minimapScrollOffset: number;
    sliderHeight: number;
    /** The thumb's top in panel pixels, before the panel's own pan. */
    mappedTop: number;
    /** The thumb's height before clamping, averaged as described above. */
    viewportExtent: number;
    usedAnchors: boolean;
}

export function computeScrollMetrics(
    this: void,
    input: ScrollMetricsInput
): ScrollMetrics {
    const clientHeight = Math.max(input.clientHeight, 1);
    const scrollHeight = Math.max(input.scrollHeight, clientHeight);
    const maxScroll = Math.max(0, scrollHeight - clientHeight);
    const scrollTop = clamp(input.scrollTop, 0, maxScroll);
    const availableHeight = Math.max(
        1,
        (input.containerHeight || clientHeight) -
            input.topOffset -
            input.bottomOffset
    );

    const scaledDocumentHeight = Math.max(1, input.contentHeight * input.scale);
    // Effective scale from editor pixels to minimap pixels.
    const docScale = scaledDocumentHeight / input.effectiveScrollHeight;

    const map = input.mapToMinimap;
    const toPanel = (editorY: number) =>
        map ? map(editorY) * input.scale : editorY * docScale;
    const viewTop = toPanel(scrollTop);
    const viewBottom = toPanel(scrollTop + clientHeight);

    // The thumb's height follows how densely the panel draws the note, but
    // averaged over the screens around the viewport rather than read from the
    // viewport alone. Wherever the panel and the editor lay a block out
    // differently — an embed, a table, HTML that Reading view and Live Preview
    // disagree about — the viewport's own slice of the panel grows and shrinks
    // as it passes, and a thumb sized to it stretched and squashed under the
    // pointer. Averaged, it changes too slowly to see.
    //
    // Only over what the editor has measured, though. Past the lines it has
    // rendered its heights are estimates — an image it hasn't displayed is a
    // fraction of its real height — and an average reaching into them would
    // move as each one is measured, which is the stutter over again.
    const reach = clientHeight * THUMB_REACH;
    const measured = input.measuredRange ?? [0, input.effectiveScrollHeight];
    const from = Math.min(
        scrollTop,
        Math.max(0, scrollTop - reach, measured[0])
    );
    const to = Math.max(
        scrollTop + clientHeight,
        Math.min(
            input.effectiveScrollHeight,
            scrollTop + clientHeight + reach,
            measured[1]
        )
    );
    const viewportExtent = Math.max(
        1,
        ((toPanel(to) - toPanel(from)) * clientHeight) / Math.max(1, to - from)
    );
    // Then placed within the viewport's slice of the panel: at its top when
    // the note is scrolled to the top, at its bottom when scrolled to the end,
    // and sliding between the two in between. Both ends stay exact, and the
    // thumb always sits over what is on screen.
    const travel = maxScroll > 0 ? scrollTop / maxScroll : 0;
    const mappedTop =
        viewTop + (viewBottom - viewTop - viewportExtent) * travel;

    const rawActiveHeight = Math.min(availableHeight, scaledDocumentHeight);
    const sliderHeight = Math.max(
        input.minViewportHeight || 24,
        Math.min(rawActiveHeight, viewportExtent)
    );
    const activeHeight = Math.max(rawActiveHeight, sliderHeight);
    const maxMinimapScroll = Math.max(0, scaledDocumentHeight - activeHeight);
    // Pan by the mapped position rather than the raw scroll ratio, so the panel
    // and the thumb stay consistent with each other.
    const panRatio = clamp(
        mappedTop / Math.max(1, scaledDocumentHeight - viewportExtent),
        0,
        1
    );

    return {
        clientHeight,
        maxScroll,
        scrollTop,
        activeHeight,
        scaledDocumentHeight,
        docScale,
        minimapScrollOffset: maxMinimapScroll * panRatio,
        sliderHeight,
        mappedTop,
        viewportExtent,
        usedAnchors: map !== null,
    };
}
