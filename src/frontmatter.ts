import type { EditorView } from "@codemirror/view";

/**
 * Obsidian's Markdown renderer emits frontmatter as a hidden <pre> and never
 * builds the properties widget, so properties would occupy space in the note
 * and none in the minimap. This reproduces them and pins the block to the
 * height they actually occupy.
 */

export interface FrontmatterMeasurement {
    height: number;
    widget: HTMLElement | null;
}

function scopeFor(this: void, readMode: boolean) {
    return readMode ? ".markdown-reading-view" : ".markdown-source-view";
}

export function findMetadataContainer(
    this: void,
    element: HTMLElement,
    readMode: boolean
) {
    return element.querySelector<HTMLElement>(
        `${scopeFor(readMode)} .metadata-container`
    );
}

/**
 * Only mirror the inline title when the note actually shows one, otherwise the
 * minimap gains a title's worth of height the note does not have.
 */
export function findInlineTitle(
    this: void,
    element: HTMLElement,
    readMode: boolean
) {
    return element.querySelector<HTMLElement>(
        `${scopeFor(readMode)} .inline-title`
    );
}

/**
 * How much vertical space the note's frontmatter occupies right now. "Properties
 * in document" decides which half contributes: the widget has height and the
 * source lines are collapsed, or the reverse.
 */
export function measureFrontmatter(
    this: void,
    element: HTMLElement,
    readMode: boolean,
    editorView: EditorView | null,
    lineCount: number
): FrontmatterMeasurement {
    const widget = findMetadataContainer(element, readMode);
    const widgetHeight = widget?.offsetHeight ?? 0;
    if (widgetHeight > 0) return { height: widgetHeight, widget };

    if (readMode) {
        const yaml = element.querySelector<HTMLElement>(
            ".markdown-reading-view .markdown-preview-sizer pre.frontmatter"
        );
        return { height: yaml?.offsetHeight ?? 0, widget: null };
    }

    const doc = editorView?.state.doc;
    if (!editorView || !doc) return { height: 0, widget: null };

    let height = 0;
    for (
        let lineNumber = 1;
        lineNumber <= Math.min(lineCount, doc.lines);
        lineNumber++
    ) {
        height += editorView.lineBlockAt(doc.line(lineNumber).from).height;
    }
    return { height, widget: null };
}

/**
 * A copy of the note's properties widget, inert. Whatever state the widget is
 * in — collapsed, expanded, mid-edit — the clone carries it, so the panel shows
 * the note's properties rather than a reconstruction of them.
 */
export function cloneMetadataWidget(
    this: void,
    widget: HTMLElement
): HTMLElement {
    const clone = widget.cloneNode(true) as HTMLElement;
    clone.removeAttribute("id");
    clone.querySelectorAll("[contenteditable]").forEach((node) => {
        node.removeAttribute("contenteditable");
    });
    clone.querySelectorAll("[tabindex]").forEach((node) => {
        node.setAttribute("tabindex", "-1");
    });
    return clone;
}

export interface FrontmatterOptions {
    /** The rendered Markdown, before it is moved into the panel. */
    rendered: HTMLElement;
    element: HTMLElement;
    readMode: boolean;
    editorView: EditorView | null;
    lineCount: number;
    /** False when every height reads 0 because the pane is not rendered. */
    paneMeasurable: boolean;
    /** Obsidian's "Properties in document" setting. */
    displayMode: string;
}

/**
 * Which of `renderFrontmatter`'s outcomes applies right now, as a string that
 * changes whenever the outcome would. The panel keeps its first section across
 * renders, and that is where the properties are: this is how it notices the
 * note now shows them differently — the widget where there was raw YAML, or a
 * measured height where the pane had none — without redrawing that section on
 * every edit. The widget's own height is left out; `syncFrontmatterHeight`
 * follows that without a redraw.
 */
export function frontmatterSignature(
    this: void,
    options: Omit<FrontmatterOptions, "rendered">
): string {
    if (options.lineCount <= 0) return "none";
    const measurement = measureFrontmatter(
        options.element,
        options.readMode,
        options.editorView,
        options.lineCount
    );
    if (measurement.height <= 0) {
        return options.paneMeasurable || options.displayMode === "hidden"
            ? "removed"
            : "unmeasured";
    }
    return measurement.widget ? "widget" : `yaml:${measurement.height}`;
}

export function renderFrontmatter(
    this: void,
    options: FrontmatterOptions
): void {
    const { rendered, element, readMode, editorView, lineCount } = options;
    const yaml = rendered.querySelector<HTMLElement>("pre.frontmatter");
    if (lineCount <= 0) {
        yaml?.remove();
        return;
    }

    const measurement = measureFrontmatter(
        element,
        readMode,
        editorView,
        lineCount
    );
    // What the note actually shows decides this, not the setting: raw Source
    // mode prints the YAML verbatim even when "Properties in document" is
    // Hidden. The setting only breaks the tie for a pane that cannot be
    // measured, where every height reads 0 regardless.
    if (measurement.height <= 0) {
        if (options.paneMeasurable || options.displayMode === "hidden") {
            yaml?.remove();
            return;
        }
    }

    // Moved to the front once filled; see the end of this function.
    const wrapper = rendered.createDiv({
        cls: "markdown-minimap-properties",
        attr: { "aria-hidden": "true" },
    });
    // Only pin the height when the note could actually be measured. A pane that
    // is hidden or has not rendered yet measures 0, and forcing that would
    // erase the properties instead of reserving their space.
    if (measurement.height > 0) {
        wrapper.style.height = `${measurement.height}px`;
    }

    if (measurement.widget) {
        yaml?.remove();
        wrapper.appendChild(cloneMetadataWidget(measurement.widget));
    } else if (yaml) {
        yaml.style.removeProperty("display");
        wrapper.appendChild(yaml);
    }

    rendered.prepend(wrapper);
}
