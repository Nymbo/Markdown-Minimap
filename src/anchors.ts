/**
 * Piecewise mapping between editor scroll pixels and minimap pixels.
 *
 * A single global ratio assumes the minimap's layout grows at the same rate as
 * the note's, which it does not: rendered Markdown and Live Preview lay out
 * every block slightly differently, and over a long note those differences
 * accumulate into hundreds of pixels of slider error. Instead, anchor the two
 * coordinate spaces to positions that exist in both — headings — and
 * interpolate between the surrounding pair.
 *
 * Anchors also sidestep CodeMirror's height estimates. Its heightmap is what
 * defines the scroll space at any instant, so a position read from it is exact
 * with respect to the current scroll position even while the estimate for
 * unmeasured lines is still settling.
 */

import type { EditorView } from "@codemirror/view";
import { clamp } from "./utils";

const ATX_HEADING = /^ {0,3}#{1,6}(\s|$)/;
const BLOCKQUOTE_PREFIX = /^ {0,3}> ?/;

/**
 * Source line numbers (1-based) of every ATX heading that Obsidian renders as
 * an <hN>, in document order. Blockquoted headings are included because they
 * render as headings too; fenced code and frontmatter are excluded via
 * `protectedLines`.
 */
export function collectHeadingLines(
    this: void,
    lines: string[],
    protectedLines: boolean[]
): number[] {
    const headings: number[] = [];

    for (let index = 0; index < lines.length; index++) {
        if (protectedLines[index]) continue;

        let text = lines[index];
        while (BLOCKQUOTE_PREFIX.test(text)) {
            text = text.replace(BLOCKQUOTE_PREFIX, "");
        }
        if (ATX_HEADING.test(text)) headings.push(index + 1);
    }

    return headings;
}

/** A position that exists in both coordinate spaces. */
export interface AnchorSample {
    editorY: number;
    minimapY: number;
}

/** Resolves the editor-space position of the heading at `index`. */
export type SampleResolver = (index: number) => AnchorSample | null;

function interpolate(
    this: void,
    value: number,
    lowFrom: number,
    highFrom: number,
    lowTo: number,
    highTo: number
) {
    const span = highFrom - lowFrom;
    if (span <= 0) return lowTo;
    const ratio = (value - lowFrom) / span;
    return lowTo + ratio * (highTo - lowTo);
}

export class HeadingAnchors {
    /** Source line number of each heading, ascending. */
    readonly lines: number[];
    /** Unscaled offset of each heading inside the minimap content, ascending. */
    readonly minimapY: number[];
    /** Document extents, used as the implicit first and last anchors. */
    private editorEnd = 0;
    private minimapEnd = 0;

    constructor(lines: number[], minimapY: number[]) {
        this.lines = lines;
        this.minimapY = minimapY;
    }

    get length() {
        return this.lines.length;
    }

    setDocumentExtent(editorEnd: number, minimapEnd: number) {
        this.editorEnd = Math.max(1, editorEnd);
        this.minimapEnd = Math.max(1, minimapEnd);
    }

    /**
     * Index of the last heading at or before `line`, or -1 when `line` sits
     * above the first heading.
     */
    indexForLine(line: number) {
        let low = 0;
        let high = this.lines.length - 1;
        let found = -1;
        while (low <= high) {
            const mid = (low + high) >> 1;
            if (this.lines[mid] <= line) {
                found = mid;
                low = mid + 1;
            } else {
                high = mid - 1;
            }
        }
        return found;
    }

    /** Index of the last heading at or before `y` in minimap space. */
    indexForMinimapY(y: number) {
        let low = 0;
        let high = this.minimapY.length - 1;
        let found = -1;
        while (low <= high) {
            const mid = (low + high) >> 1;
            if (this.minimapY[mid] <= y) {
                found = mid;
                low = mid + 1;
            } else {
                high = mid - 1;
            }
        }
        return found;
    }

    /**
     * The document start and end act as anchors either side of the headings, so
     * positions before the first and after the last heading stay bounded rather
     * than extrapolating off the end of the note.
     */
    private bracket(index: number, resolve: SampleResolver) {
        const start: AnchorSample = { editorY: 0, minimapY: 0 };
        const end: AnchorSample = {
            editorY: this.editorEnd,
            minimapY: this.minimapEnd,
        };

        const low = index < 0 ? start : resolve(index) ?? start;
        const high =
            index + 1 < this.lines.length ? resolve(index + 1) ?? end : end;

        // Guard against a non-monotonic pair, which would invert the segment.
        if (high.editorY <= low.editorY || high.minimapY <= low.minimapY) {
            return { low: start, high: end };
        }
        return { low, high };
    }

    editorToMinimap(editorY: number, line: number, resolve: SampleResolver) {
        const { low, high } = this.bracket(this.indexForLine(line), resolve);
        return interpolate(
            editorY,
            low.editorY,
            high.editorY,
            low.minimapY,
            high.minimapY
        );
    }

    minimapToEditor(minimapY: number, resolve: SampleResolver) {
        const { low, high } = this.bracket(
            this.indexForMinimapY(minimapY),
            resolve
        );
        return interpolate(
            minimapY,
            low.minimapY,
            high.minimapY,
            low.editorY,
            high.editorY
        );
    }
}

/**
 * Owns the live side of the mapping: pairing headings between the note and the
 * panel, keeping that pairing valid as the panel reflows, and resolving editor
 * positions from CodeMirror on demand.
 */
export class AnchorTracker {
    private anchors: HeadingAnchors | null = null;
    private content: HTMLElement | null = null;
    private headingLines: number[] = [];
    private scale = 1;
    /** Panel height the current pairing was measured against. */
    private contentHeight = 0;
    private editorView: EditorView | null = null;
    private editorContentOffset = 0;

    get active() {
        return this.anchors !== null;
    }

    get length() {
        return this.anchors?.length ?? 0;
    }

    clear() {
        this.anchors = null;
    }

    /**
     * Pair each source heading with the rendered heading at the same ordinal.
     * A wrong pairing would be worse than no anchors at all, so any sign the
     * two lists disagree drops back to the global ratio.
     */
    capture(content: HTMLElement | null, headingLines: number[], scale: number) {
        this.content = content;
        this.headingLines = headingLines;
        this.scale = scale || 1;
        this.anchors = null;
        if (!content || headingLines.length === 0) return;
        // A hidden pane measures every rect at 0, which would yield a table of
        // zeroes that looks monotonic but maps everything to the top.
        if (content.clientWidth <= 0 || content.scrollHeight <= 1) return;

        // Rendered Markdown yields <hN>; Source mode yields one marked line per
        // heading. Both are in document order and pair with `headingLines`.
        const rendered = Array.from(
            content.querySelectorAll<HTMLElement>(
                "h1,h2,h3,h4,h5,h6,.minimap-source-heading"
            )
        );
        if (rendered.length !== headingLines.length) return;

        const contentTop = content.getBoundingClientRect().top;
        const minimapY: number[] = [];
        let previous = -1;
        for (const heading of rendered) {
            const y =
                (heading.getBoundingClientRect().top - contentTop) / this.scale;
            if (!Number.isFinite(y) || y < previous) return;
            previous = y;
            minimapY.push(y);
        }

        this.anchors = new HeadingAnchors(headingLines, minimapY);
        this.contentHeight = content.scrollHeight;
    }

    /**
     * Anchor positions are only valid for the layout they were measured in.
     * Code-metric mirroring, a theme change or a pane resize can all reflow the
     * panel afterwards, so re-measure whenever its height moves rather than
     * waiting for the next render.
     */
    revalidate(contentHeight: number) {
        if (!this.anchors) return;
        if (contentHeight === this.contentHeight) return;
        this.capture(this.content, this.headingLines, this.scale);
    }

    /**
     * Prepare for a mapping pass. Returns false when the global ratio should be
     * used instead — reading view virtualizes its sections, so headings outside
     * the rendered window have no measurable position to anchor to.
     */
    prepare(
        editorView: EditorView | null,
        editorContentOffset: number,
        effectiveScrollHeight: number,
        contentHeight: number
    ): boolean {
        this.editorView = editorView;
        this.editorContentOffset = editorContentOffset;
        if (!this.anchors || this.anchors.length === 0 || !editorView) {
            return false;
        }
        this.anchors.setDocumentExtent(effectiveScrollHeight, contentHeight);
        return true;
    }

    private resolve = (index: number): AnchorSample | null => {
        const anchors = this.anchors;
        const editorView = this.editorView;
        if (!anchors || !editorView) return null;
        const line = anchors.lines[index];
        const doc = editorView.state.doc;
        if (!line || line > doc.lines) return null;
        return {
            editorY:
                editorView.lineBlockAt(doc.line(line).from).top +
                this.editorContentOffset,
            minimapY: anchors.minimapY[index],
        };
    };

    private lineAtEditorY(editorY: number, editorView: EditorView) {
        const docY = clamp(
            editorY - this.editorContentOffset,
            0,
            Math.max(0, editorView.contentHeight - 1)
        );
        return editorView.state.doc.lineAt(
            editorView.lineBlockAtHeight(docY).from
        ).number;
    }

    toMinimap = (editorY: number): number => {
        const editorView = this.editorView;
        if (!this.anchors || !editorView) return editorY;
        return this.anchors.editorToMinimap(
            editorY,
            this.lineAtEditorY(editorY, editorView),
            this.resolve
        );
    };

    toEditor(minimapY: number): number {
        if (!this.anchors) return minimapY;
        return this.anchors.minimapToEditor(minimapY, this.resolve);
    }
}
