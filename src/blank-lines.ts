export interface BlankLineRun {
    markerClass: string;
    /**
     * The blank lines the marker stands in for, 1-based and counted from the
     * first line of the text that was collapsed — the whole note, or one
     * section of it.
     */
    sourceLineNumbers: number[];
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

export interface FencedCodeBlock {
    /** Zero-based index of the opening fence line. */
    open: number;
    /**
     * Zero-based index of the closing fence line, or `lines.length` when the
     * fence is never closed — which is what the editor shows while one is
     * still being typed.
     */
    close: number;
    /**
     * First word of the info string, lowercased, or empty when the fence
     * carries none. Empty as well for a fence inside a blockquote: every line
     * of that block still starts with `>`, which is not part of the code and
     * would be tokenized as if it were.
     */
    language: string;
}

const FENCE_INFO = /^ {0,3}(?:`{3,}|~{3,})\s*([^\s`{]+)/;

function getFenceLanguage(this: void, line: string): string {
    if (/^ {0,3}> ?/.test(line)) return "";
    const match = line.match(FENCE_INFO);
    return match ? match[1].toLowerCase() : "";
}

/**
 * Extents and languages of the note's fenced code blocks, so the minimap can
 * highlight what is inside them. Uses the same fence walk as
 * `getProtectedLines` so the two always agree about where a block starts and
 * ends; frontmatter is skipped because it is not a fence.
 */
export function getFencedCodeBlocks(
    this: void,
    lines: string[]
): FencedCodeBlock[] {
    const blocks: FencedCodeBlock[] = [];
    let fence: Fence | null = null;
    let open = 0;
    let language = "";

    for (
        let index = getFrontmatterLineCount(lines);
        index < lines.length;
        index++
    ) {
        const lineFence = getFence(lines[index]);

        if (fence) {
            if (
                lineFence?.character === fence.character &&
                lineFence.length >= fence.length
            ) {
                blocks.push({ open, close: index, language });
                fence = null;
            }
            continue;
        }

        if (lineFence) {
            fence = lineFence;
            open = index;
            language = getFenceLanguage(lines[index]);
        }
    }

    if (fence) blocks.push({ open, close: lines.length, language });

    return blocks;
}

/**
 * Obsidian's Markdown renderer intentionally collapses consecutive blank
 * source lines. Insert one inert marker for each collapsed run while retaining
 * the original Markdown rendering around it. The caller sizes each marker from
 * CodeMirror's measured source-line blocks.
 *
 * `endsDocument` is false for a section that the rest of the note follows. A
 * blank run at its end is then not trailing space but the gap before the next
 * section's heading, and is collapsed exactly as it would be mid-note.
 */
export function collapseBlankLines(
    this: void,
    lines: string[],
    protectedLines: boolean[],
    endsDocument = true
): { output: string[]; runs: BlankLineRun[] } {
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

        const isInternalRun =
            index > 0 && (end < lines.length || !endsDocument);
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

    return { output, runs };
}
