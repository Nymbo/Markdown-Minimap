import { collectHeadings } from "./anchors";
import type { BlankLineRun } from "./blank-lines";
import {
    collapseBlankLines,
    getFrontmatterLineCount,
    getProtectedLines,
} from "./blank-lines";

/**
 * Cutting the note into sections that can be rendered one at a time.
 *
 * Rendering the whole note is what the panel costs: on a 60,000-word note
 * about half a second of blocked UI, every time typing paused. An edit only
 * ever touches one stretch of the note, so the panel keeps each section's
 * rendered output and redraws only the sections whose text changed — usually
 * one, in about a millisecond.
 *
 * That is only sound where rendering the sections separately produces exactly
 * what rendering the note would. Each section therefore begins at a heading
 * that nothing above it can still be open around, and a note using anything
 * that is resolved across the whole document is not cut at all.
 */

/** One independently rendered stretch of the note. */
export interface RenderSection {
    /** Zero-based index of the section's first source line. */
    start: number;
    /** Markdown handed to the renderer, blank-line markers included. */
    markdown: string;
    /** Blank-line runs, numbered from the section's own first line. */
    runs: BlankLineRun[];
}

export interface SectionedNote {
    sections: RenderSection[];
    frontmatterLineCount: number;
    /** Source line numbers of headings, for anchor-based scroll mapping. */
    headingLines: number[];
    /** Heading levels, parallel to `headingLines`, for resolving fold extents. */
    headingLevels: number[];
    /** Total source lines, which bounds a fold that reaches the end. */
    lineCount: number;
}

/**
 * A heading at the very start of the line: not inside a list item, a quote or
 * indented code, all of which need the line indented or prefixed.
 */
const SECTION_HEADING = /^#{1,6}(?:[ \t]|$)/;

/**
 * Constructs resolved across the whole note. A footnote is numbered by its
 * place in the note and listed at the end of it; a reference link is defined
 * anywhere and used anywhere. Rendered in pieces, either would come out wrong.
 */
const FOOTNOTE = /\[\^[^\]\n]*\]|\^\[/;
const LINK_REFERENCE = /^ {0,3}\[[^\]\n]+\]:/;

/** HTML blocks that run to a closing marker rather than to a blank line. */
const RAW_HTML_BLOCKS: { open: RegExp; close: RegExp }[] = [
    { open: /^ {0,3}<!--/, close: /-->/ },
    {
        open: /^ {0,3}<(?:script|pre|style|textarea)(?:[\s>]|$)/i,
        close: /<\/(?:script|pre|style|textarea)>/i,
    },
    { open: /^ {0,3}<\?/, close: /\?>/ },
    { open: /^ {0,3}<!\[CDATA\[/, close: /\]\]>/ },
    { open: /^ {0,3}<![A-Za-z]/, close: />/ },
];

function countOf(this: void, text: string, token: string): number {
    let count = 0;
    for (
        let index = text.indexOf(token);
        index !== -1;
        index = text.indexOf(token, index + token.length)
    ) {
        count++;
    }
    return count;
}

/**
 * Zero-based lines each section starts at; always begins with 0.
 *
 * A line starts a section when it is a heading at the start of the line,
 * follows a blank line, and sits outside every construct that can span one:
 * fenced code and frontmatter, an Obsidian `%%` comment, a `$$` math block,
 * and the HTML blocks that run to a closing marker. The blank line is what
 * ends any other HTML block, and a heading cannot continue a paragraph, a list
 * or a quote, so nothing above the cut can reach past it.
 *
 * Anything uncertain is resolved towards not cutting. A missed cut only costs
 * a larger section to redraw; a wrong one would draw the note wrongly.
 */
export function findSectionStarts(
    this: void,
    lines: string[],
    protectedLines: boolean[]
): number[] {
    const starts = [0];
    let comment = false;
    let math = false;
    let rawClose: RegExp | null = null;

    for (let index = 0; index < lines.length; index++) {
        if (protectedLines[index]) continue;
        const line = lines[index];

        if (FOOTNOTE.test(line) || LINK_REFERENCE.test(line)) return [0];

        if (
            index > 0 &&
            !comment &&
            !math &&
            !rawClose &&
            SECTION_HEADING.test(line) &&
            lines[index - 1].trim() === "" &&
            !protectedLines[index - 1]
        ) {
            starts.push(index);
        }

        // Pairs on one line open and close; only an odd count leaves one open.
        if (countOf(line, "%%") % 2 === 1) comment = !comment;
        if (countOf(line, "$$") % 2 === 1) math = !math;
        if (rawClose) {
            if (rawClose.test(line)) rawClose = null;
        } else {
            for (const block of RAW_HTML_BLOCKS) {
                const open = block.open.exec(line);
                if (!open) continue;
                const rest = line.slice(open.index + open[0].length);
                if (!block.close.test(rest)) rawClose = block.close;
                break;
            }
        }
    }

    return starts;
}

/**
 * The note as sections ready to render, plus the heading index the panel pairs
 * against. Blank lines are collapsed per section, with each section's markers
 * numbered from its own start, so a section's text — and so whether it needs
 * redrawing — depends only on what is in it.
 */
export function prepareSections(
    this: void,
    markdown: string
): SectionedNote {
    const newline = markdown.includes("\r\n") ? "\r\n" : "\n";
    const lines = markdown.split(/\r?\n/);
    const protectedLines = getProtectedLines(lines);
    const starts = findSectionStarts(lines, protectedLines);

    const sections: RenderSection[] = starts.map((start, index) => {
        const last = index === starts.length - 1;
        const end = last ? lines.length : starts[index + 1];
        const collapsed = collapseBlankLines(
            lines.slice(start, end),
            protectedLines.slice(start, end),
            last
        );
        return {
            start,
            markdown: collapsed.output.join(newline),
            runs: collapsed.runs,
        };
    });

    const headings = collectHeadings(lines, protectedLines);
    return {
        sections,
        frontmatterLineCount: getFrontmatterLineCount(lines),
        headingLines: headings.lines,
        headingLevels: headings.levels,
        lineCount: lines.length,
    };
}
