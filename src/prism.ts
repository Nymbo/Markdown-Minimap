import { Component, MarkdownRenderer } from "obsidian";
import type { App } from "obsidian";

/**
 * Reading view colours code because Obsidian runs it through Prism, which
 * wraps each token in `<span class="token keyword">` and friends. Those class
 * names resolve to the theme's own `--code-*` variables anywhere in the
 * document, the minimap panel included, so the panel can reach the exact
 * colours Reading view shows by using the exact tokenizer it uses. Source mode
 * highlights the same code through CodeMirror instead, but only for the lines
 * near the viewport — no use to a panel that draws the whole note at once.
 */

interface PrismToken {
    type: string;
    alias?: string | string[];
    content: PrismContent;
}

type PrismContent = string | PrismToken | Array<string | PrismToken>;

interface Prism {
    languages: Record<string, unknown>;
    tokenize(text: string, grammar: object): Array<string | PrismToken>;
}

/** A stretch of code sharing one set of Prism classes. */
export interface CodeRun {
    text: string;
    /** Prism class list, or null for text no token covers. */
    className: string | null;
}

/**
 * Prism is a property of the window Obsidian itself loaded it into, which is
 * the main one. A minimap in a popout resolves `activeWindow` to that popout,
 * so it is checked first for correctness and the main window kept as the
 * fallback that actually holds Prism there.
 */
function getPrism(this: void): Prism | null {
    const scopes = [
        activeWindow as unknown as { Prism?: Prism } | undefined,
        window as unknown as { Prism?: Prism },
    ];
    for (const scope of scopes) {
        const prism = scope?.Prism;
        if (prism && prism.languages && typeof prism.tokenize === "function") {
            return prism;
        }
    }
    return null;
}

export function isPrismReady(this: void): boolean {
    return getPrism() !== null;
}

function flattenTokens(
    this: void,
    nodes: Array<string | PrismToken>,
    inherited: string | null,
    out: CodeRun[]
) {
    for (const node of nodes) {
        if (typeof node === "string") {
            // Text a token encloses but does not itself mark keeps that
            // token's colour, exactly as it does nested in Prism's output.
            if (node) out.push({ text: node, className: inherited });
            continue;
        }

        const classes = ["token", node.type];
        if (node.alias) {
            if (Array.isArray(node.alias)) classes.push(...node.alias);
            else classes.push(node.alias);
        }
        const className = classes.join(" ");

        if (typeof node.content === "string") {
            if (node.content) {
                out.push({ text: node.content, className });
            }
            continue;
        }
        // Prism nests spans, and the innermost one wins on screen, so a leaf
        // carries only its own classes rather than the whole chain's.
        flattenTokens(
            Array.isArray(node.content) ? node.content : [node.content],
            className,
            out
        );
    }
}

/**
 * One run list per line, with neighbours sharing a class merged into a single
 * run. Prism emits punctuation a character at a time, and every run becomes an
 * element: on a 900-line block the merge removes roughly a fifth of them, and
 * building those elements is most of what a Source-mode render costs.
 */
function splitRunsIntoLines(this: void, runs: CodeRun[]): CodeRun[][] {
    const lines: CodeRun[][] = [[]];
    for (const run of runs) {
        const parts = run.text.split("\n");
        for (let index = 0; index < parts.length; index++) {
            if (index > 0) lines.push([]);
            if (!parts[index]) continue;

            const line = lines[lines.length - 1];
            const previous = line[line.length - 1];
            if (previous && previous.className === run.className) {
                previous.text += parts[index];
            } else {
                line.push({ text: parts[index], className: run.className });
            }
        }
    }
    return lines;
}

/**
 * Tokenize `code` and return one run list per line, or null when it cannot be
 * highlighted — no Prism yet, no language on the fence, or a language Prism
 * has no grammar for, which covers `dataviewjs`, `mermaid` and every plain
 * fence. Callers fall back to the flat text those cases have always shown.
 */
export function highlightCode(
    this: void,
    code: string,
    language: string
): CodeRun[][] | null {
    if (!language) return null;
    const prism = getPrism();
    if (!prism) return null;

    const grammar = prism.languages[language];
    if (!grammar || typeof grammar !== "object") return null;

    try {
        const tokens = prism.tokenize(code, grammar);
        const runs: CodeRun[] = [];
        flattenTokens(tokens, null, runs);
        return splitRunsIntoLines(runs);
    } catch {
        // A grammar can throw on input it was not written for. The note still
        // has to draw, so this is a fallback rather than a failure.
        return null;
    }
}

let warming: Promise<void> | null = null;

/**
 * Obsidian loads Prism the first time it renders a code block, so it is simply
 * absent in a session spent entirely in Source mode — where the minimap is the
 * only thing that wants it. Rendering one offscreen brings it in. Once per
 * session, and the result is never inspected: callers ask whether Prism is
 * there afterwards, not whether this worked.
 */
export function warmPrism(this: void, app: App): Promise<void> {
    if (getPrism()) return Promise.resolve();
    if (warming === null) {
        warming = (async () => {
            const component = new Component();
            component.load();
            // Never attached, so which window's document it belongs to is moot.
            const host = createDiv();
            try {
                await MarkdownRenderer.render(
                    app,
                    "```js\n0\n```",
                    host,
                    "",
                    component
                );
            } catch {
                // Nothing to recover: Prism is either there now or it is not.
            } finally {
                component.unload();
            }
        })();
    }
    return warming;
}
