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

import type { App, TFile } from "obsidian";
import type { EditorView } from "@codemirror/view";
import { clamp } from "./utils";

const ATX_HEADING = /^ {0,3}(#{1,6})(?:\s|$)/;
/** `===` or `---` alone on a line, which makes a heading of the paragraph above. */
const SETEXT_UNDERLINE = /^ {0,3}(=+|-+)[ \t]*$/;
/**
 * Markers that open a block of their own, so the line cannot be the text of a
 * setext heading.
 */
const BLOCK_OPENER =
    /^ {0,3}(?:>|[-+*](?:[ \t]|$)|\d{1,9}[.)](?:[ \t]|$)|#{1,6}(?:[ \t]|$)|<)/;

/** Heading source lines and their levels, in document order. */
export interface HeadingIndex {
    /** Source line numbers, 1-based. */
    lines: number[];
    /** Heading level 1-6, parallel to `lines`. */
    levels: number[];
}

/** Whether a line could be the text a setext underline promotes to a heading. */
function isParagraphText(this: void, text: string): boolean {
    if (text.trim() === "") return false;
    // Four spaces in is either indented code or a list item's continuation;
    // either way the line belongs to a block that already started.
    if (/^ {4}/.test(text)) return false;
    return !BLOCK_OPENER.test(text);
}

/**
 * Every heading Obsidian itself treats as one, in document order: ATX headings
 * at the top level of the document, and setext headings.
 *
 * "At the top level" is the part that is easy to get wrong. Markdown renders a
 * `#` inside a list item or a blockquote as an <hN> too, but Obsidian does not
 * count those as headings — they are absent from the outline and cannot be
 * folded — so counting them here would pair the panel's headings against a
 * different list than the note's and disable the pairing entirely. Only lines
 * whose `#` starts the line (indented no more than three spaces, behind no
 * `>` and no list marker) are headings, which is exactly the set the rendered
 * panel yields as direct children. Issue #13.
 *
 * Fenced code and frontmatter are excluded via `protectedLines`.
 *
 * The levels are what decides how far a folded heading reaches, so they are
 * collected here rather than re-derived from the text at the fold site.
 */
export function collectHeadings(
    this: void,
    lines: string[],
    protectedLines: boolean[]
): HeadingIndex {
    const index: HeadingIndex = { lines: [], levels: [] };

    for (let line = 0; line < lines.length; line++) {
        if (protectedLines[line]) continue;
        const text = lines[line];

        const atx = text.match(ATX_HEADING);
        if (atx) {
            index.lines.push(line + 1);
            index.levels.push(atx[1].length);
            continue;
        }

        const underline = text.match(SETEXT_UNDERLINE);
        if (!underline || line === 0) continue;
        if (protectedLines[line - 1] || !isParagraphText(lines[line - 1])) {
            continue;
        }
        // The underline promotes the whole paragraph above it, so the heading
        // begins at that paragraph's first line rather than at the line the
        // underline happens to sit under.
        let start = line - 1;
        while (
            start > 0 &&
            !protectedLines[start - 1] &&
            isParagraphText(lines[start - 1])
        ) {
            start--;
        }
        index.lines.push(start + 1);
        index.levels.push(underline[1][0] === "=" ? 1 : 2);
    }

    return index;
}

/**
 * Obsidian's own heading index for the file, in the same shape as
 * `collectHeadings` — but only when it still describes the text on screen.
 *
 * The cache is rebuilt after a save, so mid-edit it can be a revision behind
 * and its line numbers can point somewhere else entirely. Every entry is
 * therefore checked against the live source first, and one bad entry discards
 * the lot: the pairing is positional, so an index that is right about most of
 * the note is not usable.
 */
export function readCachedHeadings(
    this: void,
    app: App,
    file: TFile | null,
    markdown: string
): HeadingIndex | null {
    if (!file) return null;
    const cached = app.metadataCache.getFileCache(file)?.headings;
    if (!cached || cached.length === 0) return null;

    const lines = markdown.split(/\r?\n/);
    const index: HeadingIndex = { lines: [], levels: [] };
    for (const entry of cached) {
        const line = entry.position?.start?.line;
        const level = entry.level;
        if (typeof line !== "number" || line < 0 || line >= lines.length) {
            return null;
        }
        if (!(level >= 1 && level <= 6)) return null;

        const text = lines[line];
        const atx = text.match(ATX_HEADING);
        if (atx) {
            if (atx[1].length !== level) return null;
        } else if (level > 2 || !isParagraphText(text)) {
            // Anything the cache calls a heading that is not an ATX line here
            // can only be the text of a setext heading, which is levels 1-2.
            return null;
        }
        // The heading text is kept verbatim, syntax and all, so the source line
        // it came from still contains it.
        if (entry.heading.length > 0 && !text.includes(entry.heading)) {
            return null;
        }

        index.lines.push(line + 1);
        index.levels.push(level);
    }
    return index;
}

const RENDERED_HEADING_TAGS = new Set([
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
]);

/**
 * The panel's own headings, in document order, as the counterpart to
 * `collectHeadings`.
 *
 * Only direct children count. A heading nested inside a list item, a
 * blockquote, a callout or a transcluded note is still an <hN>, but it is not
 * one of the note's headings: Obsidian will not fold it and does not list it in
 * the outline. Matching those too made the panel's count exceed the source's,
 * and since a wrong pairing is worse than none, every fold and every anchor in
 * the note was dropped on the strength of one `- # heading`. Issue #13.
 */
export function collectRenderedHeadings(
    this: void,
    content: HTMLElement | null
): HTMLElement[] {
    if (!content) return [];
    const headings: HTMLElement[] = [];
    for (const child of Array.from(content.children)) {
        if (
            RENDERED_HEADING_TAGS.has(child.tagName) ||
            child.classList.contains("minimap-source-heading")
        ) {
            headings.push(child as HTMLElement);
        }
    }
    return headings;
}

/** A position that exists in both coordinate spaces. */
export interface AnchorSample {
    editorY: number;
    minimapY: number;
}

/** A source line whose panel position has been measured. */
interface Sample {
    /** Source line number, 1-based. */
    line: number;
    /** Unscaled offset of that line inside the minimap content. */
    y: number;
}

/**
 * Interleave two line-ordered anchor lists, keeping one sample per line.
 *
 * A line can hold several embeds, and the panel gives each its own height while
 * the source gives them all one line. Two samples on one line would ask the
 * mapping to divide by a segment of no height, so only the first is kept.
 *
 * Returns null when the two lists disagree about order: an inverted pairing is
 * worse than no image anchors at all, and the caller then keeps the headings.
 */
function mergeSamples(
    this: void,
    first: Sample[],
    second: Sample[]
): Sample[] | null {
    const merged: Sample[] = [];
    let a = 0;
    let b = 0;
    while (a < first.length || b < second.length) {
        const takeFirst =
            b >= second.length ||
            (a < first.length && first[a].line <= second[b].line);
        const next = takeFirst ? first[a++] : second[b++];
        const last = merged[merged.length - 1];
        if (last) {
            if (last.line === next.line) continue;
            if (next.y <= last.y) return null;
        }
        merged.push(next);
    }
    return merged;
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

/**
 * The panel's own image embeds, in document order, as the counterpart to
 * `collectImageLines`.
 *
 * Only a file drawn as an image counts, and only from the note being drawn: a
 * transcluded note brings its own images, which have no line in this note to be
 * paired with, and pairing them would shift every ordinal after them.
 */
export function collectRenderedImages(
    this: void,
    content: HTMLElement | null
): HTMLElement[] {
    if (!content) return [];
    const images: HTMLElement[] = [];
    content
        .querySelectorAll<HTMLElement>(".internal-embed.image-embed")
        .forEach((element) => {
            if (element.closest(".markdown-embed")) return;
            images.push(element);
        });
    return images;
}

export class LineAnchors {
    /** Source line number of each anchor, ascending. */
    readonly lines: number[];
    /** Unscaled offset of each anchor inside the minimap content, ascending. */
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
 * Owns the live side of the mapping: pairing the note's headings and image
 * embeds with the panel's, keeping that pairing valid as the panel reflows, and
 * resolving editor positions from CodeMirror on demand.
 */
export class AnchorTracker {
    private anchors: LineAnchors | null = null;
    private content: HTMLElement | null = null;
    private headingLines: number[] = [];
    private imageLines: number[] = [];
    private hiddenHeadings: ReadonlySet<number> = new Set();
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
     * Pair each source heading with the rendered heading at the same ordinal,
     * then do the same for the note's image embeds. A wrong pairing would be
     * worse than no anchors at all, so any sign the two lists disagree drops
     * back to the global ratio.
     *
     * `hiddenHeadings` holds the ordinals the panel has folded away. They are
     * dropped from the pairing rather than measured: a display:none heading
     * reports a zero rect, which reads as a position above its predecessor and
     * would fail the monotonic check, disabling anchoring for the whole note.
     * Dropping them is also the right answer — the editor has collapsed those
     * headings too, so the fold's opening and closing anchors bracket it.
     */
    capture(
        content: HTMLElement | null,
        headingLines: number[],
        imageLines: number[],
        scale: number,
        hiddenHeadings: ReadonlySet<number> = new Set()
    ) {
        this.content = content;
        this.headingLines = headingLines;
        this.imageLines = imageLines;
        this.hiddenHeadings = hiddenHeadings;
        this.scale = scale || 1;
        this.anchors = null;
        if (!content || headingLines.length === 0) return;
        // A hidden pane measures every rect at 0, which would yield a table of
        // zeroes that looks monotonic but maps everything to the top.
        if (content.clientWidth <= 0 || content.scrollHeight <= 1) return;

        // Rendered Markdown yields <hN>; Source mode yields one marked line per
        // heading. Both are in document order and pair with `headingLines`.
        const rendered = collectRenderedHeadings(content);
        if (rendered.length !== headingLines.length) return;

        const contentTop = content.getBoundingClientRect().top;
        let samples: Sample[] = [];
        let previous = -1;
        for (let index = 0; index < rendered.length; index++) {
            if (hiddenHeadings.has(index)) continue;
            const y =
                (rendered[index].getBoundingClientRect().top - contentTop) /
                this.scale;
            if (!Number.isFinite(y) || y < previous) return;
            previous = y;
            samples.push({ line: headingLines[index], y });
        }
        if (samples.length === 0) return;

        // Screenshots are where the panel and the editor disagree most: the
        // panel draws an image at its real height, while the editor's height
        // map carries only an estimate of it until that line scrolls into view.
        // Anchoring the images themselves keeps that disagreement inside one
        // image instead of letting it accumulate across a whole heading's span.
        const images = this.imageSamples(content, imageLines, contentTop);
        if (images.length > 0) {
            const merged = mergeSamples(samples, images);
            // Falling back to the headings is right: they are still correct as
            // far as they go, and this only costs the extra precision.
            if (merged) samples = merged;
        }

        this.anchors = new LineAnchors(
            samples.map((sample) => sample.line),
            samples.map((sample) => sample.y)
        );
        this.contentHeight = content.scrollHeight;
    }

    /**
     * The panel's image embeds as source-line samples, or none when they cannot
     * be paired with confidence.
     */
    private imageSamples(
        content: HTMLElement,
        imageLines: number[],
        contentTop: number
    ): Sample[] {
        if (imageLines.length === 0) return [];
        // A fold takes its elements out of the flow, so an image inside one
        // measures at the top of the pane and would invert its neighbours. The
        // heading anchors bracket the fold already; leave it to them.
        if (this.hiddenHeadings.size > 0) return [];
        const elements = collectRenderedImages(content);
        // One for one, or not at all. The pairing is positional, so an extra
        // image from somewhere the scan did not see — or a scan that counted
        // one the panel did not draw — puts every image after it on the wrong
        // line.
        if (elements.length !== imageLines.length) return [];
        const samples: Sample[] = [];
        for (let index = 0; index < elements.length; index++) {
            const y =
                (elements[index].getBoundingClientRect().top - contentTop) /
                this.scale;
            if (!Number.isFinite(y)) return [];
            samples.push({ line: imageLines[index], y });
        }
        return samples;
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
        this.capture(
            this.content,
            this.headingLines,
            this.imageLines,
            this.scale,
            this.hiddenHeadings
        );
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

    /**
     * The source line at a panel position, rather than a pixel in CodeMirror's
     * scroll space.
     *
     * A pixel is only meaningful while the editor's height map is right about
     * how tall the note is, and it is not: an image embed that has not been
     * rendered yet is estimated at a fraction of its height, so a jump measured
     * in pixels lands wherever the estimate happens to point. A line survives
     * that estimate — an image's whole estimated height maps back to the one
     * line that holds it — so a click can be expressed as a position the editor
     * scrolls to itself, re-measuring as it goes.
     */
    toEditorLine(minimapY: number): number | null {
        const editorView = this.editorView;
        if (!this.anchors || !editorView) return null;
        const editorY = this.anchors.minimapToEditor(minimapY, this.resolve);
        return this.lineAtEditorY(editorY, editorView);
    }
}
