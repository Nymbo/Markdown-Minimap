import { clamp, computedStyle, pixels, toPx } from "./utils";

/**
 * Measuring the note's own layout and mirroring it onto the panel.
 *
 * The minimap is only a faithful map if it wraps where the note wraps, so
 * width, margins, typography and code-block geometry are all read from the
 * live editor rather than assumed.
 */

/** Marks the view as having its text moved clear of the minimap. */
const SHIFTED_CLASS = "minimap-content-shifted";

export interface DocumentElements {
    scroller: HTMLElement | null;
    sizer: HTMLElement | null;
    text: HTMLElement | null;
}

/**
 * The elements that define the note's layout in the active mode: the scroller
 * supplies the file margins, the sizer the text width, and the text element the
 * typography.
 */
export function resolveDocumentElements(
    this: void,
    element: HTMLElement,
    readMode: boolean
): DocumentElements {
    const scope = readMode
        ? ".markdown-reading-view"
        : ".markdown-source-view";
    const sizer = element.querySelector<HTMLElement>(
        readMode ? `${scope} .markdown-preview-sizer` : `${scope} .cm-sizer`
    );
    return {
        scroller: element.querySelector<HTMLElement>(
            readMode ? `${scope} .markdown-preview-view` : `${scope} .cm-scroller`
        ),
        sizer,
        text: readMode
            ? sizer
            : element.querySelector<HTMLElement>(`${scope} .cm-content`),
    };
}

/** Space below the last line that exists only so you can scroll past the end. */
export function measureTrailingPadding(
    this: void,
    element: HTMLElement,
    readMode: boolean,
    scroller: HTMLElement | null
): number {
    const inner = readMode
        ? scroller?.querySelector<HTMLElement>(".markdown-preview-sizer")
        : element.querySelector<HTMLElement>(
              ".markdown-source-view .cm-content"
          );
    if (!inner) return 0;
    return pixels(computedStyle(inner)?.paddingBottom);
}

export interface MirrorOptions {
    element: HTMLElement;
    container: HTMLElement;
    content: HTMLElement;
    readMode: boolean;
    rawSourceMode: boolean;
    /** Page-space left edge of the visible minimap strip. */
    stripLeft: number;
    /** Whether to move the note's text clear of the minimap. */
    reserveSpace: boolean;
}

/** Width inside an element's own padding, which is where its text wraps. */
function innerWidth(this: void, element: HTMLElement | null): number {
    if (!element) return 0;
    const style = computedStyle(element);
    return (
        element.clientWidth -
        pixels(style?.paddingLeft) -
        pixels(style?.paddingRight)
    );
}

/**
 * The width the note's lines actually wrap at.
 *
 * Read from a rendered line rather than from the sizer. Obsidian's own styling
 * applies readable line length to the sizer, so on the default theme the two
 * agree — but a theme is free to leave the sizer at the pane's full width and
 * constrain the blocks inside it instead, which is what Minimal does. Trusting
 * the sizer there laid the panel out at nearly twice the note's width, so it
 * wrapped in different places and stopped being a map of the page.
 *
 * Code lines carry their own inset, and the header and pusher are not text, so
 * none of them speak for the note's width.
 */
function measureTextWidth(
    this: void,
    element: HTMLElement,
    readMode: boolean,
    sizer: HTMLElement | null
): number {
    if (readMode) {
        for (const child of Array.from(sizer?.children ?? [])) {
            if (
                child.classList.contains("markdown-preview-pusher") ||
                child.classList.contains("mod-header") ||
                child.classList.contains("mod-footer")
            ) {
                continue;
            }
            const width = innerWidth(child as HTMLElement);
            if (width > 0) return width;
        }
    } else {
        const line = element.querySelector<HTMLElement>(
            ".markdown-source-view .cm-line:not(.HyperMD-codeblock)"
        );
        const width = innerWidth(line);
        if (width > 0) return width;
    }
    // An empty note, or one with nothing but code in it, still needs a width.
    return innerWidth(sizer);
}

/**
 * Left margin the note keeps whatever the shift works out to.
 *
 * The shift is capped at the gap that exists, which is the file margin, so
 * without a floor it takes the whole of it: the text starts flush against the
 * pane's edge and the note reads as having lost its left side. The floor costs
 * nothing in exchange — on any pane wide enough to matter the strip is far
 * wider than the margin, so the last sixteen pixels were never what decided
 * whether the text ran under it.
 */
const MINIMUM_LEFT_GAP = 16;

/**
 * How far the note's text should move so the space either side of it looks
 * even once the minimap has taken its strip.
 *
 * Both gaps are measured to the pane's own edges — the left one from the
 * scroller's border, the right one to the strip — and the shift is half their
 * difference, which is what makes them equal. Measuring the left gap from the
 * content box instead leaves the file margin out of the comparison, and the
 * file margin is usually the larger half of it: the text then reads as sitting
 * too far right even though the arithmetic balanced.
 *
 * That margin is also room the text can move into. Restricting the shift to
 * the centring margin alone left it pinned at zero whenever the line was wide
 * enough to fill the content box, which is the common case on a narrow pane at
 * high zoom, and the minimap simply covered the last few characters.
 *
 * The strip's position is measured rather than derived from its width: the
 * minimap container spans the whole view, while the text sits inside the
 * scroller's padding, so the two right edges do not coincide.
 *
 * Clamped to the gap that actually exists, so the text can never be pushed off
 * the pane's left edge and clipped — minus a floor, so it does not end up
 * sitting exactly on that edge either.
 *
 * The floor is measured from the sizer's own margin (`base`), not from the
 * centring worked out above. Those are not the same number: the line a width is
 * read from sits beside the gutter, so it is narrower than the sizer by the
 * gutter's width and its centring is correspondingly wider. Taking the floor
 * from that over-estimate let the sizer start half a gutter to the left of where
 * the arithmetic thought it was — negative — which cut the first characters off
 * every line that begins at the sizer's edge, the inline title among them.
 */
function reserveShift(
    this: void,
    scroller: HTMLElement | null,
    textWidth: number,
    stripLeft: number,
    base: number
): number {
    if (!scroller || textWidth <= 0 || stripLeft <= 0) return 0;
    const style = computedStyle(scroller);
    const rect = scroller.getBoundingClientRect();
    const paddingLeft = pixels(style?.paddingLeft);
    const paddingRight = pixels(style?.paddingRight);
    // clientWidth excludes the native scrollbar, the bounding rect does not.
    // Measuring the content edge from the rect would place it a scrollbar's
    // width too far right and skew the shift by half of that.
    const innerRight = rect.left + scroller.clientWidth;
    const available = scroller.clientWidth - paddingLeft - paddingRight;
    // Whatever readable line length leaves over; zero once the text is wide
    // enough to fill the content box.
    const centring = Math.max(0, (available - textWidth) / 2);
    const leftGap = paddingLeft + centring;
    const rightGap = stripLeft - (innerRight - paddingRight - centring);
    // How far the sizer can move before its own left edge crosses the floor.
    const room = paddingLeft + base;
    return clamp(
        (leftGap - rightGap) / 2,
        0,
        Math.max(0, room - MINIMUM_LEFT_GAP)
    );
}

/**
 * The margin the note's sizer centres itself with when left alone: half the
 * room left over once its own width is taken out of the space inside the
 * scroller's padding.
 *
 * Read from the sizer's own box rather than from the text width, so a line's
 * own inset does not creep into it — but read with the shift lifted, which is
 * the part that matters. The two margins written below are equal and opposite,
 * so they leave the sizer's width alone only while that width is the theme's
 * readable line length. Once the pane is narrow enough that the margins are
 * what the width is subtracted from, measuring the shifted sizer feeds this
 * number its own previous answer: the margins reproduce themselves exactly, so
 * a text column squeezed by one bad measurement mid-resize stays squeezed
 * through every later resize and only a refresh clears it. Issue #12.
 *
 * Lifting the class and restoring it without yielding costs one synchronous
 * layout and paints nothing in between.
 */
function baseSizerMargin(
    this: void,
    element: HTMLElement,
    scroller: HTMLElement | null,
    sizer: HTMLElement | null
): number {
    if (!scroller || !sizer) return 0;
    const style = computedStyle(scroller);
    const available =
        scroller.clientWidth -
        pixels(style?.paddingLeft) -
        pixels(style?.paddingRight);
    if (available <= 0) return 0;

    const shifted = element.classList.contains(SHIFTED_CLASS);
    if (shifted) element.classList.remove(SHIFTED_CLASS);
    const width = sizer.getBoundingClientRect().width;
    if (shifted) element.classList.add(SHIFTED_CLASS);

    if (width <= 0) return 0;
    return Math.max(0, (available - width) / 2);
}

/**
 * Move the note's text clear of the minimap, by margin rather than by
 * transform.
 *
 * A transform on the sizer makes it the containing block for everything
 * absolutely positioned inside it, and Obsidian's find-in-note overlay places
 * its match boxes in coordinates measured against the scroller. In Reading view
 * that put every highlight a centring margin away from the text it was marking.
 * Equal and opposite margins move the same box the same distance without
 * claiming its descendants' coordinate space, and leave the sizer's width
 * untouched, so nothing rewraps either.
 */
function applyContentShift(
    this: void,
    element: HTMLElement,
    shift: number,
    base: number
): void {
    if (shift <= 0) {
        element.style.removeProperty("--minimap-content-shift");
        element.style.removeProperty("--minimap-sizer-margin-left");
        element.style.removeProperty("--minimap-sizer-margin-right");
        element.classList.remove(SHIFTED_CLASS);
        return;
    }
    element.style.setProperty("--minimap-content-shift", toPx(shift));
    element.style.setProperty(
        "--minimap-sizer-margin-left",
        toPx(base - shift)
    );
    element.style.setProperty(
        "--minimap-sizer-margin-right",
        toPx(base + shift)
    );
    element.classList.add(SHIFTED_CLASS);
}

/**
 * The panel's counterpart to the contentless space below the note's last line —
 * the file margin plus the room Obsidian leaves for scrolling past the end.
 *
 * Copying those pixels across verbatim looks right and is not: the panel does
 * not lay content out at the same height the note does, so a verbatim margin is
 * the one stretch of the panel drawn at a different scale from everything above
 * it. The thumb changes size as it crosses into it — growing where the panel
 * runs shorter than the note, shrinking where it runs taller — over the last
 * viewport-height of the scroll, which is where it is most visible.
 *
 * Scaling it by the ratio the panel actually achieves makes the whole panel one
 * consistent picture of the note, so the thumb keeps its size to the bottom.
 * The ratio is bounded because a pane mid-layout can report nonsense, and an
 * absurd margin is worse than a verbatim one.
 */
function scaleTrailingSpace(
    this: void,
    content: HTMLElement,
    scroller: HTMLElement | null,
    editorTrailing: number
): number {
    if (editorTrailing <= 0 || !scroller) return Math.max(0, editorTrailing);

    const applied = pixels(computedStyle(content)?.paddingBottom);
    const panelContent = content.scrollHeight - applied;
    const editorContent = scroller.scrollHeight - editorTrailing;
    if (panelContent <= 0 || editorContent <= 0) return editorTrailing;

    return editorTrailing * clamp(panelContent / editorContent, 0.25, 4);
}

/**
 * Rendering at the pane's full width made lines wrap at different points than
 * the note itself, so the panel takes the note's width, margins and typography.
 */
export function mirrorDocumentMetrics(
    this: void,
    options: MirrorOptions
): void {
    const { element, container, content, readMode, rawSourceMode } = options;
    const { scroller, sizer, text } = resolveDocumentElements(
        element,
        readMode
    );

    const textWidth = measureTextWidth(element, readMode, sizer);
    // A hidden pane measures 0; keep the last good width.
    if (textWidth > 0) {
        container.style.setProperty("--minimap-doc-width", toPx(textWidth));
    }

    // Bind the track to the editor's visible height. Left to `height: 100%` it
    // resolves against a taller ancestor, putting the end of the track below
    // the window where the pointer cannot reach it.
    if (scroller && scroller.clientHeight > 0) {
        container.style.setProperty(
            "--minimap-track-height",
            `${scroller.clientHeight}px`
        );
    }

    const paddingTop =
        pixels(computedStyle(scroller)?.paddingTop) +
        pixels(computedStyle(sizer)?.paddingTop);
    // Written on the panel itself rather than published as a variable: see
    // the stylesheet for why the panel's contents must not inherit anything
    // that moves this often.
    content.style.paddingTop = toPx(paddingTop);
    // The file margin below the last line, and the room Obsidian leaves for
    // scrolling past the end, are both part of the scroll range the thumb
    // travels. The panel needs its own counterpart rather than the mapping
    // pretending they are not there.
    const editorTrailing =
        pixels(computedStyle(scroller)?.paddingBottom) +
        measureTrailingPadding(element, readMode, scroller);
    content.style.paddingBottom = toPx(
        scaleTrailingSpace(content, scroller, editorTrailing)
    );

    // Published on the view element, not the panel, so it survives re-renders.
    // A background tab measures every rect at 0, which reads as "no strip to
    // move clear of" and would retract the shift from every tab navigated away
    // from. The note then painted unshifted on the way back and slid into place
    // once the measurement landed, which is what the shift looked like moving.
    // Treated as unmeasurable instead, the last shift simply stands.
    if (options.stripLeft > 0 || !options.reserveSpace) {
        // Measured once and handed to both: the shift is capped against this
        // margin, and this is the margin the sizer is then given.
        const base = baseSizerMargin(element, scroller, sizer);
        const shift = options.reserveSpace
            ? reserveShift(scroller, textWidth, options.stripLeft, base)
            : 0;
        applyContentShift(element, shift, base);
    }

    // Themes commonly scope line height to selectors the panel does not match,
    // so mirror the resolved values instead of relying on class inheritance.
    const textStyle = computedStyle(text);
    const lineHeight = Number.parseFloat(textStyle?.lineHeight ?? "");
    const fontSize = Number.parseFloat(textStyle?.fontSize ?? "");
    content.style.lineHeight = Number.isFinite(lineHeight)
        ? `${lineHeight}px`
        : "";
    content.style.fontSize = Number.isFinite(fontSize) ? `${fontSize}px` : "";
    // Source mode reproduces the editor's own text, so it must use the editor's
    // font rather than the one rendered Markdown would pick.
    content.style.fontFamily = rawSourceMode
        ? textStyle?.fontFamily ?? ""
        : "";
}

/**
 * Rendered code blocks and Live Preview's code lines do not agree: the rendered
 * <pre> is inset on both sides and uses the body line height, while a code line
 * is inset only on the left and uses the code line height. The stylesheet
 * already covers the common case; this refines it for themes that differ.
 *
 * Returns whether a measurement was taken, so the caller can stop retrying.
 */
export function mirrorCodeMetrics(
    this: void,
    sourceView: HTMLElement,
    container: HTMLElement,
    content: HTMLElement
): boolean {
    // Code lines only exist while a block is inside CodeMirror's rendered
    // window, so this may legitimately find nothing and be retried later.
    const codeLine = sourceView.querySelector<HTMLElement>(
        ".cm-line.HyperMD-codeblock"
    );
    if (!codeLine || codeLine.clientWidth <= 0) return false;

    const style = computedStyle(codeLine);
    const paddingLeft = pixels(style?.paddingLeft);
    const innerWidth =
        codeLine.clientWidth - paddingLeft - pixels(style?.paddingRight);
    if (innerWidth <= 0) return false;

    const paddingRight = Math.max(
        0,
        content.clientWidth - innerWidth - paddingLeft
    );
    container.style.setProperty(
        "--minimap-code-padding-left",
        toPx(paddingLeft)
    );
    container.style.setProperty(
        "--minimap-code-padding-right",
        toPx(paddingRight)
    );
    const codeLineHeight = Number.parseFloat(style?.lineHeight ?? "");
    container.style.setProperty(
        "--minimap-code-line-height",
        Number.isFinite(codeLineHeight) ? `${codeLineHeight}px` : "normal"
    );
    const codeFontSize = Number.parseFloat(style?.fontSize ?? "");
    if (Number.isFinite(codeFontSize)) {
        container.style.setProperty(
            "--minimap-code-font-size",
            `${codeFontSize}px`
        );
    }
    content.classList.add("minimap-mirror-code");
    return true;
}
