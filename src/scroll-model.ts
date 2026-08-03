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
    mappedTop: number;
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
    const mappedTop = map
        ? map(scrollTop) * input.scale
        : scrollTop * docScale;
    const mappedBottom = map
        ? map(scrollTop + clientHeight) * input.scale
        : (scrollTop + clientHeight) * docScale;
    // The thumb covers exactly the slice of the note the viewport shows, which
    // varies with content density once the mapping is piecewise.
    const viewportExtent = Math.max(1, mappedBottom - mappedTop);

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
