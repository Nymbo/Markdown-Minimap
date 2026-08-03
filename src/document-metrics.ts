import { computedStyle, pixels } from "./utils";

/**
 * Measuring the note's own layout and mirroring it onto the panel.
 *
 * The minimap is only a faithful map if it wraps where the note wraps, so
 * width, margins, typography and code-block geometry are all read from the
 * live editor rather than assumed.
 */

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

    if (sizer) {
        const style = computedStyle(sizer);
        const width =
            sizer.clientWidth -
            pixels(style?.paddingLeft) -
            pixels(style?.paddingRight);
        // A hidden pane measures 0; keep the last good width.
        if (width > 0) {
            container.style.setProperty("--minimap-doc-width", `${width}px`);
        }
    }

    const paddingTop =
        pixels(computedStyle(scroller)?.paddingTop) +
        pixels(computedStyle(sizer)?.paddingTop);
    container.style.setProperty("--minimap-doc-padding-top", `${paddingTop}px`);
    // The file margin below the last line is part of the note's scrollable
    // height, and is not the scroll-past-end padding trimmed elsewhere, so the
    // panel needs its counterpart to end where the note ends.
    container.style.setProperty(
        "--minimap-doc-padding-bottom",
        `${pixels(computedStyle(scroller)?.paddingBottom)}px`
    );

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
        `${paddingLeft}px`
    );
    container.style.setProperty(
        "--minimap-code-padding-right",
        `${paddingRight}px`
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
