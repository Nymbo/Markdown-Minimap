import type { EditorView } from "@codemirror/view";
import { getFrontmatterLineCount, getProtectedLines } from "./blank-lines";
import { collectHeadingLines } from "./anchors";

/**
 * Source mode prints the file verbatim, so the minimap does too.
 *
 * Running the Markdown renderer there produced lists, tables, callouts and
 * images the note never shows, which both looked wrong and inflated every
 * mapped position. One element per source line is simpler and exact: no
 * blank-line spacers and no frontmatter special case, because in Source mode a
 * blank line really is a line and frontmatter really is text.
 */

export type SourceLineKind = "text" | "heading" | "code" | "frontmatter";

export interface SourceLine {
    text: string;
    kind: SourceLineKind;
    /** Heading level 1-6, or 0 for every other kind. */
    level: number;
}

const BLOCKQUOTE_PREFIX = /^ {0,3}> ?/;

function headingLevel(this: void, line: string): number {
    let text = line;
    while (BLOCKQUOTE_PREFIX.test(text)) {
        text = text.replace(BLOCKQUOTE_PREFIX, "");
    }
    const match = text.match(/^ {0,3}(#{1,6})(?:\s|$)/);
    return match ? match[1].length : 1;
}

export function classifySourceLines(
    this: void,
    markdown: string
): SourceLine[] {
    const lines = markdown.split(/\r?\n/);
    const protectedLines = getProtectedLines(lines);
    const frontmatterLines = getFrontmatterLineCount(lines);
    const headings = new Set(collectHeadingLines(lines, protectedLines));

    return lines.map((text, index) => {
        const lineNumber = index + 1;
        if (lineNumber <= frontmatterLines) {
            return { text, kind: "frontmatter", level: 0 };
        }
        if (protectedLines[index]) {
            return { text, kind: "code", level: 0 };
        }
        if (headings.has(lineNumber)) {
            return { text, kind: "heading", level: headingLevel(text) };
        }
        return { text, kind: "text", level: 0 };
    });
}

export interface SourceLineDom {
    fragment: DocumentFragment;
    /** One element per source line, index 0 being line 1. */
    elements: HTMLElement[];
    /** Source line numbers of the headings, for anchor pairing. */
    headingLines: number[];
}

export function buildSourceLineDom(
    this: void,
    markdown: string
): SourceLineDom {
    const lines = classifySourceLines(markdown);
    const headingLines: number[] = [];
    const elements: HTMLElement[] = [];
    const fragment = activeDocument.createDocumentFragment();

    lines.forEach((line, index) => {
        const element = activeDocument.createElement("div");
        element.className = "minimap-source-line";
        if (line.kind === "heading") {
            element.classList.add(
                "minimap-source-heading",
                `mod-h${line.level}`
            );
            headingLines.push(index + 1);
        } else if (line.kind === "code") {
            element.classList.add("mod-code");
        } else if (line.kind === "frontmatter") {
            element.classList.add("mod-frontmatter");
        }
        // An empty div collapses to nothing; a zero-width space keeps the line
        // box so blank lines occupy their line, as they do in Source.
        element.textContent = line.text.length > 0 ? line.text : "\u200B";
        elements.push(element);
        fragment.appendChild(element);
    });

    return { fragment, elements, headingLines };
}

/**
 * Take each line's height from CodeMirror rather than trying to reproduce it.
 * The editor adds per-line padding and inline formatting spans that vary by
 * theme and line type, and its heightmap is in any case the authority for the
 * scroll space, so copying it is both exact and immune to theme styling.
 *
 * Returns the CodeMirror content height the copy was taken from, or null when
 * nothing was applied.
 */
export function applySourceLineHeights(
    this: void,
    elements: HTMLElement[],
    editorView: EditorView | null,
    appliedContentHeight: number
): number | null {
    const doc = editorView?.state.doc;
    if (!editorView || !doc) return null;
    // CodeMirror swaps estimates for measurements as lines are rendered, which
    // moves heights underneath us. Its total is a cheap signal that something
    // changed, so the full walk only runs when it has.
    if (editorView.contentHeight === appliedContentHeight) return null;

    for (let index = 0; index < elements.length; index++) {
        const lineNumber = index + 1;
        if (lineNumber > doc.lines) break;
        const height = editorView.lineBlockAt(doc.line(lineNumber).from).height;
        elements[index].style.height = `${Math.max(0, height)}px`;
    }

    return editorView.contentHeight;
}
