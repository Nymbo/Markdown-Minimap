import { collectHeadingLines } from "./anchors";

export interface BlankLineRun {
    markerClass: string;
    sourceLineNumbers: number[];
}

export interface BlankLineRenderData {
    markdown: string;
    runs: BlankLineRun[];
    frontmatterLineCount: number;
    /** Source line numbers of headings, for anchor-based scroll mapping. */
    headingLines: number[];
}

type Fence = {
    character: "`" | "~";
    length: number;
};

function getFence(this: void, line: string): Fence | null {
    let candidate = line;
    while (/^ {0,3}> ?/.test(candidate)) {
        candidate = candidate.replace(/^ {0,3}> ?/, "");
    }

    const match = candidate.match(/^ {0,3}(`{3,}|~{3,})/);
    if (!match) return null;

    return {
        character: match[1][0] as "`" | "~",
        length: match[1].length,
    };
}

/**
 * Number of source lines occupied by the YAML frontmatter block, delimiters
 * included. Zero when the note has no frontmatter or the block is unterminated.
 */
export function getFrontmatterLineCount(this: void, lines: string[]): number {
    if (lines.length === 0) return 0;
    if (lines[0].replace(/^\uFEFF/, "").trim() !== "---") return 0;

    for (let index = 1; index < lines.length; index++) {
        const line = lines[index].trim();
        if (line === "---" || line === "...") return index + 1;
    }

    return 0;
}

/**
 * Lines whose content must not be treated as Markdown structure: fenced code
 * blocks and frontmatter. Shared with anchor collection so a `#` inside a code
 * fence is never mistaken for a heading.
 */
export function getProtectedLines(this: void, lines: string[]): boolean[] {
    const protectedLines = Array.from(
        { length: lines.length },
        () => false
    );
    let fence: Fence | null = null;
    let inFrontmatter =
        lines.length > 0 && lines[0].replace(/^\uFEFF/, "").trim() === "---";

    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];

        if (inFrontmatter) {
            protectedLines[index] = true;
            if (
                index > 0 &&
                (line.trim() === "---" || line.trim() === "...")
            ) {
                inFrontmatter = false;
            }
            continue;
        }

        const lineFence = getFence(line);
        if (fence) {
            protectedLines[index] = true;
            if (
                lineFence?.character === fence.character &&
                lineFence.length >= fence.length
            ) {
                fence = null;
            }
            continue;
        }

        if (lineFence) {
            protectedLines[index] = true;
            fence = lineFence;
        }
    }

    return protectedLines;
}

/**
 * Obsidian's Markdown renderer intentionally collapses consecutive blank
 * source lines. Insert one inert marker for each collapsed run while retaining
 * the original Markdown rendering around it. The caller sizes each marker from
 * CodeMirror's measured source-line blocks.
 */
export function prepareBlankLineRuns(
    this: void,
    markdown: string
): BlankLineRenderData {
    const newline = markdown.includes("\r\n") ? "\r\n" : "\n";
    const lines = markdown.split(/\r?\n/);
    const protectedLines = getProtectedLines(lines);
    const output: string[] = [];
    const runs: BlankLineRun[] = [];

    for (let index = 0; index < lines.length; ) {
        if (protectedLines[index] || lines[index].trim() !== "") {
            output.push(lines[index]);
            index++;
            continue;
        }

        let end = index;
        while (
            end < lines.length &&
            !protectedLines[end] &&
            lines[end].trim() === ""
        ) {
            end++;
        }

        const isInternalRun = index > 0 && end < lines.length;
        const firstCollapsedLine = isInternalRun ? index + 1 : index;
        const sourceLineNumbers = Array.from(
            { length: Math.max(0, end - firstCollapsedLine) },
            (_, offset) => firstCollapsedLine + offset + 1
        );

        if (isInternalRun) output.push("");
        if (sourceLineNumbers.length > 0) {
            const markerClass = `markdown-minimap-blank-run-${runs.length}`;
            runs.push({ markerClass, sourceLineNumbers });
            output.push(
                `<div class="markdown-minimap-blank-run ${markerClass}" aria-hidden="true"></div>`
            );
            if (end < lines.length) output.push("");
        }

        index = end;
    }

    return {
        markdown: output.join(newline),
        runs,
        frontmatterLineCount: getFrontmatterLineCount(lines),
        headingLines: collectHeadingLines(lines, protectedLines),
    };
}
