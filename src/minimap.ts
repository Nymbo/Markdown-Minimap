import { Component, MarkdownRenderer, MarkdownView } from "obsidian";
import { EditorView } from "@codemirror/view";
import type { BlankLineRun } from "./blank-lines";
import { prepareSections } from "./sections";
import type { RenderSection } from "./sections";
import {
    AnchorTracker,
    collectRenderedHeadings,
    readCachedHeadings,
} from "./anchors";
import type { ImageEmbed } from "./anchors";
import { mirrorCodeMetrics, mirrorDocumentMetrics } from "./document-metrics";
import {
    applyFoldsToPanel,
    readFoldHeads,
    resolveFoldRanges,
} from "./folds";
import {
    cloneMetadataWidget,
    findInlineTitle,
    findMetadataContainer,
    frontmatterSignature,
    renderFrontmatter,
} from "./frontmatter";
import { MinimapPointer } from "./pointer";
import type { PointerHost } from "./pointer";
import { applySourceLineHeights, planSourceLines } from "./source-view";
import type { HighlightCache } from "./source-view";
import { isPrismReady, warmPrism } from "./prism";
import {
    computeScrollMetrics,
    resolveDocumentHeights,
} from "./scroll-model";
import type { ScrollMetrics } from "./scroll-model";
import type { MarkdownMinimapSettings } from "./settings";
import type NoteMinimap from "./main";
import { clamp, computedStyle } from "./utils";

/**
 * A section of the note as drawn in the panel, kept so that an edit elsewhere
 * in the note can leave it exactly as it is.
 */
interface PanelSection {
    markdown: string;
    /** Zero-based first source line, as of the latest render. */
    start: number;
    runs: BlankLineRun[];
    /** The section's blank-line markers, parallel to `runs`. */
    markers: (HTMLElement | null)[];
    /**
     * Marks where the section begins in the panel; it runs to the next one.
     * Holding the section's nodes instead would go wrong the moment a post
     * processor swapped one of them for another, so a comment marks the place.
     * Comments take no part in layout and no part in sibling selectors.
     */
    sentinel: Comment;
    component: Component;
    /**
     * How the first section drew the properties, from `frontmatterSignature`;
     * empty for every other section.
     */
    frontmatter: string;
}

export class Minimap implements PointerHost {
    plugin: NoteMinimap;
    view: MarkdownView;
    element: HTMLElement;
    sourceView: HTMLElement;
    scroller: HTMLElement | null = null;
    container: HTMLDivElement | null = null;
    /** Positions and scales the panel; carries no Obsidian classes. */
    viewport: HTMLDivElement | null = null;
    content: HTMLDivElement | null = null;
    slider: HTMLDivElement | null = null;
    hitbox: HTMLDivElement | null = null;
    scale = 0.1;
    minimapOpacity = 1;
    panelTint = false;
    sliderOpacity = 0.3;
    sliderIdleOpacity = 0.09;
    topOffset = 0;
    bottomOffset = 0;
    scrollbarGutter = 14;
    minViewportHeight = 24;
    reserveSpace = false;
    centerOnClick = true;
    backgroundColor = "";
    renderVersion = 0;
    trailingSyncTimer = 0;
    /** Pending second measuring pass after a pane resize. */
    private resizeSettleTimer = 0;
    /** Pending first measuring pass, shared by every caller that asks for one. */
    private remeasureTimer = 0;
    private pendingRemeasure: Promise<void> | null = null;
    /**
     * What the panel on screen was rendered from. Rendering is by far the most
     * expensive thing the minimap does, and most requests for one change
     * nothing: switching tabs used to re-render both the note being left and
     * the note being opened, every time, however long they were.
     */
    private renderedSource: string | null = null;
    private renderedMode = "";
    private renderedPath = "";
    /** Set when something the panel shows has changed outside the note. */
    private renderStale = false;

    readonly anchors = new AnchorTracker();
    private readonly pointer = new MinimapPointer(this);
    /** The panel's rendered sections, in note order. */
    private sections: PanelSection[] = [];
    /** File and mode the sections were rendered for; reuse needs both. */
    private sectionsKey = "";
    /** Heading source lines from the last render, paired with the anchors. */
    private headingLines: number[] = [];
    /** Image embeds from the last render, paired with the panel's by name. */
    private imageEmbeds: ImageEmbed[] = [];
    /** Heading levels from the last render, parallel to `headingLines`. */
    private headingLevels: number[] = [];
    /** Source line count from the last render, bounding a fold to the end. */
    private lineCount = 0;
    /** Heading ordinals the panel has folded away. */
    private hiddenHeadings: ReadonlySet<number> = new Set();
    /** Fold heads the panel is currently mirroring, for change detection. */
    private foldSignature = "";
    private foldObserver: MutationObserver | null = null;
    private foldCheckTimer = 0;
    /** Whether a real code line has been measured for this view yet. */
    private codeMetricsMirrored = false;
    /** Source-mode line elements, index 0 being source line 1. */
    private sourceLineElements: HTMLElement[] = [];
    /**
     * What each of those elements was built from, and the file they belong to;
     * a line whose key is unchanged keeps its element.
     */
    private sourceLineKeys: string[] = [];
    private sourceLinesPath = "";
    private highlightCache: HighlightCache = new Map();
    /** CodeMirror content height the source line heights were copied from. */
    private appliedContentHeight = -1;
    /**
     * Whether the last metrics pass mapped through the anchors. The thumb's
     * position and the pointer's target have to come from the same mapping, so
     * this is what the pointer asks rather than whether anchors merely exist.
     */
    private anchorsInUse = false;

    constructor(
        plugin: NoteMinimap,
        view: MarkdownView,
        settings: MarkdownMinimapSettings
    ) {
        this.plugin = plugin;
        this.view = view;
        this.element = view.contentEl;
        const sourceView = this.element.querySelector<HTMLElement>(
            ".markdown-source-view"
        );
        if (!sourceView)
            throw new Error("Markdown Minimap requires a source view.");
        this.sourceView = sourceView;

        this.setupElements();
        this.observeFolds();
        this.updateSettings(settings);
        this.modeChange();

        if (this.hitbox) this.pointer.attach(this.hitbox);
    }

    // --- lifecycle -------------------------------------------------------

    setupElements() {
        this.element
            .querySelectorAll(
                ".minimap-container, .minimap-viewport, .minimap-content, .minimap-slider, .minimap-hitbox"
            )
            .forEach((e) => e.remove());

        const container = this.element.createDiv({ cls: "minimap-container" });
        this.container = container;
        // Ahead of the note rather than after it, where createDiv puts it.
        this.element.prepend(container);

        // The panel is positioned by this wrapper and rendered by the element
        // inside it, which is not a distinction the panel used to draw. The
        // rendered element wears Obsidian's own "markdown-preview-view" so the
        // note's Markdown styling applies to the copy — but Obsidian styles
        // that class too, `position: relative` among them, and on mobile a rule
        // of its own outranked the panel's `position: absolute`. The panel then
        // took its static position at the container's left edge, so instead of
        // being pinned to the right of the pane it landed a document-width in
        // from the left: mid-screen on a tablet in landscape, and drifting as
        // the note's width changed. Issue #11.
        //
        // Splitting the two means the placement no longer rides on a class
        // Obsidian is free to style. The wrapper carries a name nothing else
        // targets, and the rendered element inside it is in normal flow with no
        // offsets of its own, so a rule that moves it has nothing to move.
        this.viewport = container.createDiv({ cls: "minimap-viewport" });

        // "show-properties" is what re-enables Obsidian's own rule for the
        // properties widget; rendered Markdown hides it by default, so without
        // this the cloned properties collapse to zero height and render blank.
        this.content = this.viewport.createDiv({
            cls: [
                "minimap-content",
                "markdown-preview-view",
                "markdown-rendered",
                "show-properties",
            ],
        });

        this.slider = container.createDiv({ cls: "minimap-slider" });
        this.hitbox = container.createDiv({ cls: "minimap-hitbox" });
    }

    /**
     * Folding fires no event a plugin can subscribe to, so the panel watches for
     * the DOM churn a fold causes and re-reads Obsidian's own fold state when it
     * settles. The read is compared against a signature before any work is done,
     * which is what makes it safe to hang off a noisy observer: on a 6,000-line
     * note the read costs about 1.5ms, and only a genuine change gets past it.
     *
     * Neither root contains the panel, so the panel's own updates cannot feed
     * back into this.
     */
    private observeFolds() {
        this.foldObserver = new MutationObserver(this.onPossibleFoldChange);
        const options: MutationObserverInit = {
            childList: true,
            subtree: true,
            attributes: true,
            // Collapsing a heading or the properties widget toggles a class;
            // folding in the editor swaps the lines out. Watching both covers
            // every mode without needing to know which one is showing.
            attributeFilter: ["class"],
        };
        // The whole source view, not just the editor's content: the properties
        // widget sits outside it, so collapsing the properties went unnoticed.
        this.foldObserver.observe(this.sourceView, options);
        const readingView = this.element.querySelector<HTMLElement>(
            ".markdown-reading-view"
        );
        if (readingView) this.foldObserver.observe(readingView, options);
    }

    private onPossibleFoldChange = () => {
        window.clearTimeout(this.foldCheckTimer);
        this.foldCheckTimer = window.setTimeout(this.checkFolds, 200);
    };

    private checkFolds = () => {
        if (this.syncFoldState()) void this.onResize();
    };

    /**
     * Re-read the note's fold state and fold the panel to match. Returns
     * whether anything actually moved, so the caller can decide whether a
     * re-measure is warranted.
     *
     * Called from the scroll settle and from `onResize` as well as from the
     * observer, because the observer alone is not enough: CodeMirror only
     * renders near the viewport, so folding a section that is already below it
     * changes the editor's height without touching a single node the observer
     * can see.
     */
    private syncFoldState(): boolean {
        if (!this.content) return false;
        // Collapsing the properties widget changes its height without changing
        // anything the Markdown renderer produced, so re-pin rather than
        // re-render the whole note. Checked before the signature, since the
        // widget can also be resized by editing a property.
        const resized = this.syncFrontmatterHeight();
        const heads = readFoldHeads(this.view);
        const signature = heads.join(",");
        if (signature === this.foldSignature) return resized;
        this.foldSignature = signature;
        this.applyFolds(heads);
        return true;
    }

    /**
     * Source mode needs none of this: every line takes its height straight from
     * CodeMirror, which has already collapsed the folded ones.
     */
    private applyFolds(foldHeads: number[]) {
        if (this.isRawSourceMode()) {
            this.hiddenHeadings = new Set();
            return;
        }
        const ranges = resolveFoldRanges(
            foldHeads,
            this.headingLines,
            this.headingLevels,
            this.lineCount
        );
        this.hiddenHeadings = applyFoldsToPanel(
            this.content,
            this.headingLines,
            ranges
        );
    }

    /**
     * Re-measure the note's properties and resize the panel's copy to match.
     * The clone is replaced as well as re-sized so a collapsed widget reads as
     * collapsed rather than as its own top few rows behind a clip.
     */
    private syncFrontmatterHeight(): boolean {
        const wrapper = this.content?.querySelector<HTMLElement>(
            ".markdown-minimap-properties"
        );
        if (!wrapper) return false;
        const widget = findMetadataContainer(
            this.element,
            this.isReadModeActive()
        );
        if (!widget || widget.offsetHeight <= 0) return false;

        const height = `${widget.offsetHeight}px`;
        if (wrapper.style.height === height) return false;

        wrapper.style.height = height;
        const existing = wrapper.firstElementChild;
        if (existing?.classList.contains("metadata-container")) {
            existing.replaceWith(cloneMetadataWidget(widget));
        }
        return true;
    }

    destroy() {
        this.renderVersion++; // invalidate any in-flight render
        window.clearTimeout(this.trailingSyncTimer);
        window.clearTimeout(this.resizeSettleTimer);
        window.clearTimeout(this.remeasureTimer);
        this.pendingRemeasure = null;
        window.clearTimeout(this.foldCheckTimer);
        this.foldObserver?.disconnect();
        this.foldObserver = null;
        this.scroller?.removeEventListener("scroll", this.onScroll);
        this.pointer.detach(this.hitbox);

        this.clearSections();
        this.container?.remove();
        this.element.style.removeProperty("--minimap-content-shift");
        this.element.style.removeProperty("--minimap-sizer-margin-left");
        this.element.style.removeProperty("--minimap-sizer-margin-right");
        this.element.classList.remove("minimap-content-shifted");

        this.container = null;
        this.viewport = null;
        this.content = null;
        this.slider = null;
        this.hitbox = null;
        this.scroller = null;
        this.anchors.clear();
    }

    // --- settings --------------------------------------------------------

    updateSettings(settings: MarkdownMinimapSettings) {
        this.scale = settings.scale;
        this.minimapOpacity = settings.minimapOpacity;
        this.panelTint = settings.panelTint;
        this.sliderOpacity = settings.sliderOpacity;
        this.sliderIdleOpacity = settings.sliderIdleOpacity;
        this.topOffset = settings.topOffset;
        this.bottomOffset = settings.bottomOffset;
        this.scrollbarGutter = settings.scrollbarGutter;
        this.minViewportHeight = settings.minViewportHeight;
        this.reserveSpace = settings.reserveSpace;
        this.centerOnClick = settings.centerOnClick;

        this.backgroundColor = this.panelBackground();

        this.updateSettingsInCSS();
        void this.onResize();
    }

    /**
     * The panel's background: the pane's own colour, or a wash when the tint is
     * on.
     *
     * Untinted, the panel is a sheet of the pane's colour, which over the pane
     * itself is invisible. The pane's colour is the wrong one to tint with: the
     * panel lies directly on top of it, and a colour blended with itself at any
     * alpha leaves it exactly as it was, so the setting had nothing to change.
     * A wash of the theme's text colour always contrasts with the pane behind
     * it — lighter on a dark theme, darker on a light one — which is what makes
     * the panel read as a panel rather than as a gap.
     *
     * The wash is a fixed colour: how much of it shows is the panel's `opacity`,
     * set alongside, rather than an alpha baked in here. Left as `color-mix` so
     * the browser resolves whatever syntax a theme writes its colours in, and a
     * theme that defines neither variable leaves the panel untinted instead of
     * painting it black, which is what reading a transparent colour produced.
     */
    private panelBackground(): string {
        if (!this.panelTint) return "var(--background-primary, transparent)";
        return "color-mix(in srgb, var(--text-normal, #888888) 15%, var(--background-primary, transparent))";
    }

    updateSettingsInCSS() {
        if (this.container) {
            this.container.style.setProperty("--scale", String(this.scale));
            this.container.style.setProperty(
                "--minimap-top-offset",
                `${this.topOffset || 0}px`
            );
            this.container.style.setProperty(
                "--minimap-bottom-offset",
                `${this.bottomOffset || 0}px`
            );
            this.container.style.setProperty(
                "--minimap-scrollbar-gutter",
                `${this.scrollbarGutter || 0}px`
            );
            // The thumb has three states, so the settings are published as
            // variables the stylesheet resolves rather than a fixed opacity.
            // An inline opacity here would override every one of them.
            this.container.style.setProperty(
                "--minimap-slider-opacity",
                String(this.sliderOpacity)
            );
            this.container.style.setProperty(
                "--minimap-slider-idle-opacity",
                String(this.sliderIdleOpacity)
            );
        }
        if (this.content) {
            this.content.style.backgroundColor = this.backgroundColor;
            // The whole panel fades, not just the sheet behind it: a background
            // alpha left the map's own text and images at full strength, which
            // read as someone else's block sitting over the note. `opacity` is
            // the only property that reaches the rendered copy as well — a
            // background colour cannot, by definition, touch its children.
            this.content.style.opacity = String(
                clamp(this.minimapOpacity, 0, 1)
            );
        }
        // The reserve is measured, so it is recomputed with the rest of the
        // document metrics rather than written directly from the setting.
        this.syncDocumentMetrics();
    }

    /**
     * Page-space left edge of the visible minimap strip. Measured from the
     * hitbox, which is the strip: deriving it from the doc width and scale
     * would ignore that the container spans the whole view rather than the
     * scroller's content box.
     */
    getStripLeft() {
        const rect = this.hitbox?.getBoundingClientRect();
        return rect && rect.width > 0 ? rect.left : 0;
    }

    // --- mode and scroller ------------------------------------------------

    // Ask the view for its mode instead of inferring it from layout; a
    // hidden tab measures 0 everywhere and would misread as reading mode.
    isReadModeActive() {
        return this.view.getMode() === "preview";
    }

    // Source mode with Live Preview off prints the file verbatim: no rendered
    // embeds, no widgets. Live Preview and reading view both render them.
    isRawSourceMode() {
        return (
            !this.isReadModeActive() &&
            !this.sourceView.classList.contains("is-live-preview")
        );
    }

    // Scope to the reading view so we never match the minimap's own
    // content div, which also carries .markdown-preview-view.
    getExpectedScroller() {
        return this.element.querySelector<HTMLElement>(
            this.isReadModeActive()
                ? ".markdown-reading-view .markdown-preview-view"
                : ".cm-scroller"
        );
    }

    modeChange() {
        // The two modes need different code metrics, and the reading view
        // needs none at all.
        this.codeMetricsMirrored = false;
        this.syncScroller();
    }

    // Instances created while their tab was hidden may track a stale
    // element; re-resolve before measuring so the scroll listener always
    // follows the live scroller.
    syncScroller() {
        const next = this.getExpectedScroller();
        if (next === this.scroller) return;
        this.scroller?.removeEventListener("scroll", this.onScroll);
        this.scroller = next;
        if (this.scroller) {
            this.scroller.addEventListener("scroll", this.onScroll);
            void this.onResize();
        }
    }

    getEditorView() {
        const editorElement =
            this.sourceView.querySelector<HTMLElement>(".cm-editor");
        return editorElement ? EditorView.findFromDOM(editorElement) : null;
    }

    /** Distance from the scroller's scroll origin to the CodeMirror content. */
    getEditorContentOffset() {
        const cmContent =
            this.sourceView.querySelector<HTMLElement>(".cm-content");
        if (!cmContent || !this.scroller) return 0;
        return (
            cmContent.getBoundingClientRect().top -
            this.scroller.getBoundingClientRect().top +
            this.scroller.scrollTop
        );
    }

    // --- measurement ------------------------------------------------------

    syncDocumentMetrics() {
        if (!this.container || !this.content) return;
        mirrorDocumentMetrics({
            element: this.element,
            container: this.container,
            content: this.content,
            readMode: this.isReadModeActive(),
            rawSourceMode: this.isRawSourceMode(),
            stripLeft: this.getStripLeft(),
            reserveSpace: this.reserveSpace,
        });
        this.syncCodeBlockMetrics();
    }

    syncCodeBlockMetrics() {
        if (!this.content || !this.container) return;
        // Reading view renders the same markup the minimap does, and Source
        // mode has no rendered code blocks to correct.
        if (this.isReadModeActive() || this.isRawSourceMode()) {
            this.content.classList.remove("minimap-mirror-code");
            this.codeMetricsMirrored = false;
            return;
        }
        if (this.codeMetricsMirrored) return;
        this.codeMetricsMirrored = mirrorCodeMetrics(
            this.sourceView,
            this.container,
            this.content
        );
    }

    // A hidden or not-yet-rendered pane measures 0 everywhere, which is
    // indistinguishable from "the note genuinely shows no properties".
    isPaneMeasurable() {
        const scroller = this.getExpectedScroller();
        return !!scroller && scroller.clientHeight > 0;
    }

    // Obsidian's "Properties in document" setting, used only to break the tie
    // when the pane cannot be measured.
    getPropertiesDisplayMode() {
        const vault = this.plugin.app.vault as unknown as {
            getConfig?: (key: string) => unknown;
        };
        const mode = vault.getConfig?.("propertiesInDocument");
        return typeof mode === "string" ? mode : "visible";
    }

    /**
     * Size every section's blank-line markers from CodeMirror's line blocks.
     * Run over the whole panel on every render, not just the sections that were
     * redrawn: an edit above a section moves its lines, and the editor's
     * estimates for them settle into measurements over time.
     */
    private applyBlankLineHeights(editorView: EditorView | null) {
        const doc = editorView?.state.doc;
        let fallback = 24;
        if (!editorView || !doc) {
            const editorLine =
                this.sourceView.querySelector<HTMLElement>(".cm-line");
            const measured = Number.parseFloat(
                computedStyle(editorLine)?.lineHeight ?? ""
            );
            if (Number.isFinite(measured)) fallback = measured;
        }

        for (const section of this.sections) {
            section.runs.forEach((run, index) => {
                const marker = section.markers[index];
                if (!marker) return;
                let height = 0;
                if (editorView && doc) {
                    for (const local of run.sourceLineNumbers) {
                        const lineNumber = section.start + local;
                        if (lineNumber > doc.lines) continue;
                        height += editorView.lineBlockAt(
                            doc.line(lineNumber).from
                        ).height;
                    }
                } else {
                    height = run.sourceLineNumbers.length * fallback;
                }
                marker.style.height = `${Math.max(0, height)}px`;
            });
        }
    }

    /** Unload every rendered section, leaving their nodes to the caller. */
    private clearSections() {
        for (const section of this.sections) section.component.unload();
        this.sections = [];
        this.sectionsKey = "";
    }

    // --- rendering --------------------------------------------------------

    /**
     * Source mode's minimap is the source text, one element per line, sized by
     * the same CSS variables Obsidian's own Source-mode styling resolves. No
     * Markdown renderer is involved, so nothing appears that the note does not
     * show, and blank lines and frontmatter need no special handling.
     *
     * Lines the edit did not touch keep their elements. Rebuilding every line
     * of a long note on each pause in typing was the slowest render of the
     * three modes, mostly in laying the new elements out again.
     */
    renderSourceText() {
        const file = this.view.file;
        if (!file || !this.content) return;

        const source = this.view.getViewData();
        this.renderStale = false;
        const plan = planSourceLines(source, this.highlightCache);
        this.highlightCache = plan.highlightCache;

        const reuse =
            this.content.classList.contains("minimap-content-source") &&
            this.sourceLinesPath === file.path;
        const previous = reuse ? this.sourceLineKeys : [];
        const old = reuse ? this.sourceLineElements : [];
        const next = plan.keys;
        let head = 0;
        while (
            head < previous.length &&
            head < next.length &&
            previous[head] === next[head]
        ) {
            head++;
        }
        let tail = 0;
        while (
            tail < previous.length - head &&
            tail < next.length - head &&
            previous[previous.length - 1 - tail] ===
                next[next.length - 1 - tail]
        ) {
            tail++;
        }

        const built: HTMLElement[] = [];
        for (let index = head; index < next.length - tail; index++) {
            built.push(plan.build(index));
        }
        const fragment = activeDocument.createDocumentFragment();
        fragment.append(...built);

        if (!reuse) {
            this.clearSections();
            this.content.empty();
            this.content.classList.add("minimap-content-source");
            this.content.appendChild(fragment);
        } else {
            for (const element of old.slice(head, old.length - tail)) {
                element.remove();
            }
            this.content.insertBefore(
                fragment,
                tail > 0 ? old[old.length - tail] : null
            );
        }
        this.syncInlineTitle(file.basename);

        this.sourceLineElements = [
            ...old.slice(0, head),
            ...built,
            ...old.slice(old.length - tail),
        ];
        this.sourceLineKeys = next;
        this.sourceLinesPath = file.path;
        this.appliedContentHeight = -1;
        this.refreshSourceLineHeights();

        this.imageEmbeds = [];
        this.headingLines = plan.headingLines;
        this.headingLevels = plan.headingLevels;
        this.lineCount = next.length;
        this.afterRender();
        this.recordRender(source, "source", file.path);

        // Obsidian only loads Prism when it first renders a code block, so a
        // session spent in Source mode may not have it yet and the code above
        // will have drawn the note's code flat. Fetch it and draw once more.
        // The re-render finds Prism loaded, so this cannot repeat.
        if (plan.prismPending) {
            void warmPrism(this.plugin.app).then(() => {
                if (!this.content || !isPrismReady()) return;
                if (!this.isRawSourceMode()) return;
                this.renderSourceText();
            });
        }
    }

    private refreshSourceLineHeights() {
        const applied = applySourceLineHeights(
            this.sourceLineElements,
            this.getEditorView(),
            this.appliedContentHeight
        );
        if (applied !== null) this.appliedContentHeight = applied;
    }

    /** Which of the three renderings the note currently calls for. */
    private renderMode() {
        if (this.isReadModeActive()) return "preview";
        return this.isRawSourceMode() ? "source" : "live";
    }

    /**
     * Whether the panel already shows what a render would produce now: the
     * same text, in the same mode, with nothing it embeds changed since.
     *
     * A render made while the pane could not be measured never counts. It left
     * out what only measurement can decide — the inline title, the height of
     * the properties — so the first look at the pane has to redo it.
     */
    isRenderCurrent() {
        return (
            !this.renderStale &&
            this.renderedSource !== null &&
            this.renderedMode === this.renderMode() &&
            this.renderedPath === this.view.file?.path &&
            this.renderedSource === this.view.getViewData()
        );
    }

    /** Something the panel draws, such as an embedded note, has changed. */
    markStale() {
        this.renderStale = true;
    }

    /**
     * Record what was just rendered, so an identical request can be skipped.
     * Only once the pane can be measured; see `isRenderCurrent`.
     */
    private recordRender(source: string, mode: string, path: string) {
        const measurable = this.isPaneMeasurable();
        this.renderedSource = measurable ? source : null;
        this.renderedMode = mode;
        this.renderedPath = path;
    }

    /**
     * Render the note into the scaled minimap panel, redrawing only the
     * sections whose text has changed since the last render.
     *
     * Blank-line markers retain the source's vertical spacing without replacing
     * Obsidian's rendered Markdown output.
     */
    async render() {
        const renderVersion = ++this.renderVersion;
        const file = this.view.file;
        if (!file || !this.content) return;

        if (this.isRawSourceMode()) {
            this.renderSourceText();
            return;
        }
        this.content.classList.remove("minimap-content-source");
        this.sourceLineElements = [];
        this.sourceLineKeys = [];

        const mode = this.renderMode();
        const source = this.view.getViewData();
        // A change to something the note embeds can sit in any section, so
        // nothing already drawn can be trusted.
        const stale = this.renderStale;
        // Cleared before the await, so a change that lands while this render
        // is in flight still marks the result stale.
        this.renderStale = false;
        const note = prepareSections(source, mode === "live");
        const editorView = this.getEditorView();
        const frontmatterOptions = () => ({
            element: this.element,
            readMode: this.isReadModeActive(),
            editorView,
            lineCount: note.frontmatterLineCount,
            paneMeasurable: this.isPaneMeasurable(),
            displayMode: this.getPropertiesDisplayMode(),
        });

        // Sections are only reusable in a panel drawn from the same file in the
        // same mode: a link resolves against the file, and the modes size
        // blank lines and properties differently.
        const key = `${mode}\n${file.path}`;
        const previous =
            !stale && key === this.sectionsKey ? this.sections : [];
        const next = note.sections;
        // The first section draws the properties from a measurement, not from
        // the text, so it is redrawn when that measurement would now come out
        // differently even if the text has not changed.
        const firstReusable =
            previous.length > 0 &&
            previous[0].frontmatter ===
                frontmatterSignature(frontmatterOptions());
        // Nor does a section move into or out of first place without a redraw,
        // since the first place is the one that draws properties.
        const reusable = (from: number, to: number) =>
            previous[from].markdown === next[to].markdown &&
            (from === 0 || to === 0
                ? from === 0 && to === 0 && firstReusable
                : true);
        let head = 0;
        while (
            head < previous.length &&
            head < next.length &&
            reusable(head, head)
        ) {
            head++;
        }
        let tail = 0;
        while (
            tail < previous.length - head &&
            tail < next.length - head &&
            reusable(previous.length - 1 - tail, next.length - 1 - tail)
        ) {
            tail++;
        }

        const fresh = next
            .slice(head, next.length - tail)
            .map((section) => this.createSection(section));
        try {
            await Promise.all(
                fresh.map(({ section, host }) =>
                    MarkdownRenderer.render(
                        this.plugin.app,
                        section.markdown,
                        host,
                        file.path,
                        section.component
                    )
                )
            );
        } catch {
            for (const { section } of fresh) section.component.unload();
            this.renderStale = true;
            return;
        }

        // A newer render started (or we were destroyed) while awaiting
        if (renderVersion !== this.renderVersion || !this.content) {
            for (const { section } of fresh) section.component.unload();
            return;
        }

        // Only the first section can hold the frontmatter.
        if (head === 0 && fresh.length > 0) {
            const options = frontmatterOptions();
            fresh[0].section.frontmatter = frontmatterSignature(options);
            renderFrontmatter({ ...options, rendered: fresh[0].host });
        }

        const kept = previous.slice(0, head);
        const following = previous.slice(previous.length - tail);
        const insertBefore = following[0]?.sentinel ?? null;
        if (previous.length === 0) {
            // Nothing carries over, including anything a different mode or
            // file left behind.
            this.clearSections();
            this.content.empty();
        } else {
            const replaced = previous.slice(head, previous.length - tail);
            for (const section of replaced) section.component.unload();
            // The replaced sections are contiguous: everything from the first
            // one's sentinel up to the first section that stays.
            let node: ChildNode | null = replaced[0]?.sentinel ?? null;
            while (node && node !== insertBefore) {
                const after: ChildNode | null = node.nextSibling;
                node.remove();
                node = after;
            }
        }

        const fragment = activeDocument.createDocumentFragment();
        for (const { section, host } of fresh) {
            section.markers = section.runs.map((run) =>
                host.querySelector<HTMLElement>(`.${run.markerClass}`)
            );
            fragment.appendChild(section.sentinel);
            while (host.firstChild) fragment.appendChild(host.firstChild);
        }
        this.content.insertBefore(fragment, insertBefore);

        this.sections = [
            ...kept,
            ...fresh.map(({ section }) => section),
            ...following,
        ];
        this.sections.forEach((section, index) => {
            section.start = next[index].start;
        });
        this.sectionsKey = key;
        this.syncInlineTitle(file.basename);

        // Reading view collapses consecutive blank lines, so reproducing them
        // there would add height the note does not have. Only the editing
        // modes actually show them.
        if (!this.isReadModeActive()) this.applyBlankLineHeights(editorView);

        this.applyHeadingIndex(note.headingLines, note.headingLevels);
        this.imageEmbeds = note.imageEmbeds;
        this.lineCount = note.lineCount;
        this.afterRender();
        this.recordRender(source, mode, file.path);
    }

    /** A section ready to render into its own detached host. */
    private createSection(source: RenderSection) {
        const component = new Component();
        component.load();
        const section: PanelSection = {
            markdown: source.markdown,
            start: source.start,
            runs: source.runs,
            markers: [],
            sentinel: activeDocument.createComment("minimap-section"),
            component,
            frontmatter: "",
        };
        return { section, host: activeDocument.createElement("div") };
    }

    /**
     * Adopt the scanned heading index, or Obsidian's own if the scan and the
     * panel disagree about how many headings the note has.
     *
     * The pairing is by ordinal, so a disagreement means every ordinal is
     * suspect and both the folds and the anchors switch off for the whole note.
     * That cliff is the real cost of a missed heading, and the metadata cache
     * is a good second opinion precisely when the scanner has been surprised:
     * it is what Obsidian folds and outlines from. It lags the editor by a save
     * though, so it is checked against the live text before it is trusted, and
     * only used when it resolves the disagreement rather than merely differing.
     * Issue #13.
     */
    private applyHeadingIndex(lines: number[], levels: number[]) {
        this.headingLines = lines;
        this.headingLevels = levels;

        const rendered = collectRenderedHeadings(this.content).length;
        if (rendered === lines.length) return;

        const cached = readCachedHeadings(
            this.plugin.app,
            this.view.file,
            this.view.getViewData()
        );
        if (!cached || cached.lines.length !== rendered) return;

        this.headingLines = cached.lines;
        this.headingLevels = cached.levels;
    }

    /**
     * Put the inline title at the top of the panel if the note shows one, and
     * take it out if it does not. Re-checked on every render, since a render
     * may keep everything else.
     */
    private syncInlineTitle(basename: string) {
        if (!this.content) return;
        this.content
            .querySelectorAll(":scope > .minimap-inline-title")
            .forEach((title) => title.remove());
        const inlineTitle = findInlineTitle(
            this.element,
            this.isReadModeActive()
        );
        if (!inlineTitle || inlineTitle.offsetHeight <= 0) return;
        const title = this.content.createDiv({
            cls: ["inline-title", "minimap-inline-title"],
            text: basename,
        });
        this.content.prepend(title);
    }

    private afterRender() {
        this.syncDocumentMetrics();
        // A re-render rebuilds the panel from the full note, so the note's
        // collapsed sections have to be folded back out of it before anything
        // measures the result.
        const foldHeads = readFoldHeads(this.view);
        this.foldSignature = foldHeads.join(",");
        this.applyFolds(foldHeads);
        this.anchors.capture(
            this.content,
            this.headingLines,
            this.imageEmbeds,
            this.scale,
            this.hiddenHeadings
        );
        void this.onResize();
    }

    // --- scroll sync ------------------------------------------------------

    // CodeMirror's scrollHeight is an estimate that settles shortly after a
    // jump, so re-sync once more after scrolling stops.
    onScroll = () => {
        this.updateSliderScroll();
        window.clearTimeout(this.trailingSyncTimer);
        this.trailingSyncTimer = window.setTimeout(this.settleAfterScroll, 350);
    };

    // Refreshing every line height is too costly per scroll event, so it waits
    // for scrolling to stop. Anchors keep the headings exact meanwhile; only
    // positions within a heading's span drift until this runs.
    settleAfterScroll = () => {
        if (this.isRawSourceMode()) this.refreshSourceLineHeights();
        this.checkFolds();
        this.settleJump();
        this.updateSliderScroll();
    };

    /**
     * Put a click's target exactly on the line it asked for, once the editor
     * has finished measuring.
     *
     * `scrollIntoView` aims with the height map it has: for the stretch below
     * the viewport those are estimates, and an image it has not drawn yet is a
     * fraction of its height. The target therefore lands hundreds of pixels
     * below the top — still on screen, so CodeMirror is satisfied — and the
     * measurements that arrive afterwards do not move it back. Now that the
     * target and everything above it have been measured, one correction puts it
     * where the click asked.
     */
    private pendingJump: { pos: number; center: boolean; passes: number; until: number } | null =
        null;

    private settleJump() {
        const jump = this.pendingJump;
        if (!jump) return;
        if (Date.now() > jump.until || jump.passes >= 3) {
            this.pendingJump = null;
            return;
        }
        const scroller = this.getScroller();
        const view = this.getEditorView();
        if (!scroller || !view) {
            this.pendingJump = null;
            return;
        }
        const block = view.lineBlockAt(jump.pos);
        const top = block.top + this.getEditorContentOffset();
        const wanted = jump.center
            ? top - (scroller.clientHeight - block.height) / 2
            : top;
        const maxScroll = Math.max(
            0,
            scroller.scrollHeight - scroller.clientHeight
        );
        const delta =
            clamp(wanted, 0, maxScroll) - Math.round(scroller.scrollTop);
        if (Math.abs(delta) <= 1) {
            this.pendingJump = null;
            return;
        }
        jump.passes++;
        scroller.scrollTop = clamp(scroller.scrollTop + delta, 0, maxScroll);
    }

    /**
     * Schedule a measuring pass. Requests arriving while one is already pending
     * join it rather than queueing their own: a render, a mode change and the
     * constructor can each ask within the same few milliseconds, and every
     * pass forces a layout of the whole panel, which on a long note is the
     * expensive part. The pass runs after the latest of them anyway, so it
     * sees everything each of them asked about.
     */
    onResize(): Promise<void> {
        if (this.pendingRemeasure !== null) return this.pendingRemeasure;
        this.pendingRemeasure = new Promise<void>((resolve) => {
            // Wait for Obsidian's editor layout pass before measuring scroll
            // dimensions; immediate reads can be stale after mode or pane
            // changes.
            this.remeasureTimer = window.setTimeout(() => {
                this.remeasureTimer = 0;
                this.pendingRemeasure = null;
                this.remeasure();
                // A pane that has not finished settling — a window still
                // animating out of maximize, an edge being dragged, a sidebar
                // collapsing — reports geometry belonging to a layout it has
                // already left. Measuring once and trusting it is what left the
                // panel sized for the old pane until someone pressed refresh,
                // so take one more reading after it quietens. Issue #12.
                window.clearTimeout(this.resizeSettleTimer);
                this.resizeSettleTimer = window.setTimeout(
                    this.remeasure,
                    400
                );
                resolve();
            }, 300);
        });
        return this.pendingRemeasure;
    }

    /** One full measuring pass over the note's layout. */
    private remeasure = () => {
        if (!this.content) return;
        this.syncDocumentMetrics();
        // CodeMirror replaces its height estimates with measurements as lines
        // are rendered, so refresh from it before re-anchoring.
        if (this.isRawSourceMode()) this.refreshSourceLineHeights();
        // Fold the panel before it is measured, not after. Direct rather than
        // via checkFolds, which would call back into here.
        this.syncFoldState();
        // Layout may have shifted every heading, so re-measure the anchors
        // before they are used to place the slider.
        this.anchors.capture(
            this.content,
            this.headingLines,
            this.imageEmbeds,
            this.scale,
            this.hiddenHeadings
        );
        // Sync now and once more after CodeMirror's height estimate settles.
        this.onScroll();
    };

    /**
     * `scrollTopOverride` asks "what would the geometry be if we scrolled
     * there", which the pointer needs because the panel pans with the scroll
     * position. Everything else it reads — the anchors, the content offset —
     * is independent of where the editor currently sits.
     */
    getScrollMetrics(scrollTopOverride?: number): ScrollMetrics {
        const scroller = this.scroller;
        const clientHeight = Math.max(scroller?.clientHeight ?? 1, 1);
        const scrollHeight = Math.max(
            scroller?.scrollHeight ?? clientHeight,
            clientHeight
        );
        const heights = resolveDocumentHeights(
            clientHeight,
            scrollHeight,
            this.content?.scrollHeight ?? 0
        );

        this.anchors.revalidate(heights.contentHeight);
        // Reading view virtualizes its sections, so anchors never apply there.
        const editorView = this.getEditorView();
        const contentOffset = this.getEditorContentOffset();
        const usable =
            !this.isReadModeActive() &&
            this.anchors.prepare(
                editorView,
                contentOffset,
                heights.effectiveScrollHeight,
                heights.contentHeight
            );
        this.anchorsInUse = usable;
        // The lines CodeMirror has rendered are the ones whose heights it has
        // measured; everywhere else it is estimating.
        let measuredRange: [number, number] | null = null;
        if (usable && editorView) {
            const { from, to } = editorView.viewport;
            measuredRange = [
                editorView.lineBlockAt(from).top + contentOffset,
                editorView.lineBlockAt(to).bottom + contentOffset,
            ];
        }

        return computeScrollMetrics({
            clientHeight,
            scrollHeight,
            scrollTop: scrollTopOverride ?? scroller?.scrollTop ?? 0,
            containerHeight: this.container?.clientHeight ?? 0,
            topOffset: this.topOffset || 0,
            bottomOffset: this.bottomOffset || 0,
            effectiveScrollHeight: heights.effectiveScrollHeight,
            contentHeight: heights.contentHeight,
            scale: this.scale,
            minViewportHeight: this.minViewportHeight,
            mapToMinimap: usable ? this.anchors.toMinimap : null,
            measuredRange,
        });
    }

    updateSliderScroll = () => {
        if (
            !this.container ||
            !this.viewport ||
            !this.content ||
            !this.slider ||
            !this.hitbox
        )
            return;
        this.syncScroller();
        if (!this.scroller) return;
        // A hidden pane measures 0 everywhere; keep the last geometry and
        // re-sync once the pane becomes visible again.
        if (!this.scroller.isConnected || this.scroller.clientHeight === 0)
            return;
        // Cheap until it succeeds, then a no-op: picks up the editor's code
        // metrics as soon as a code block scrolls into the rendered window,
        // instead of leaving them unmirrored until the next resize.
        if (!this.codeMetricsMirrored) this.syncCodeBlockMetrics();

        const metrics = this.getScrollMetrics();
        const sliderTop =
            (this.topOffset || 0) +
            clamp(
                metrics.mappedTop - metrics.minimapScrollOffset,
                0,
                Math.max(0, metrics.activeHeight - metrics.sliderHeight)
            );

        this.viewport.style.top = `${
            (this.topOffset || 0) - metrics.minimapScrollOffset
        }px`;
        this.slider.style.top = `${sliderTop}px`;
        this.slider.style.height = `${metrics.sliderHeight}px`;
        this.hitbox.style.height = `${metrics.activeHeight}px`;
    };

    // --- PointerHost ------------------------------------------------------

    getScroller() {
        this.syncScroller();
        return this.scroller;
    }

    /**
     * Answers with the same mapping that placed the thumb, or null so the
     * caller falls back to the global ratio.
     *
     * Asking whether anchors merely exist is not the same question. The panel
     * still has headings to anchor to in reading view, but the thumb is placed
     * by the global ratio there because reading view virtualizes its sections —
     * and the anchors are never prepared, so their document extent stays zero
     * and every position maps to the top of the note. Clicking the minimap in
     * reading view therefore jumped to the top, and dragging fought the thumb.
     */
    mapToEditor(minimapY: number): number | null {
        return this.anchorsInUse ? this.anchors.toEditor(minimapY) : null;
    }

    /**
     * Take the editor to the position drawn at `localY`, as a document
     * position rather than a scroll offset.
     *
     * Writing `scrollTop` directly is only accurate while CodeMirror's height
     * map is, and for the stretch of the note it has not rendered yet it is
     * not: an image embed is estimated at a fraction of its real height, so a
     * note whose height is mostly images has a scroll space far shorter than
     * the one the panel draws. A click there would land thousands of pixels
     * short. Handing CodeMirror a position instead lets it scroll and re-measure
     * until the target is in view.
     *
     * Returns false when there is nothing better than the pixel mapping:
     * reading view, or no anchors.
     */
    jumpToPosition(
        localY: number,
        metrics: ScrollMetrics,
        center: boolean
    ): boolean {
        if (!this.anchorsInUse) return false;
        const editorView = this.getEditorView();
        if (!editorView) return false;
        // The panel is taller than the track on a long note, so it slides up as
        // the note scrolls. A click names what is drawn under the pointer now,
        // which is `localY` plus however far the panel has slid.
        const contentY =
            (localY + metrics.minimapScrollOffset) /
            Math.max(this.scale, 0.001);
        const pos = this.anchors.toEditorPosition(contentY);
        if (pos === null) return false;
        editorView.dispatch({
            effects: EditorView.scrollIntoView(pos, {
                y: center ? "center" : "start",
            }),
        });
        // The editor measures the stretch it just jumped into before the click
        // can be judged; put the target exactly where it was asked for once
        // that has happened.
        this.pendingJump = {
            pos,
            center,
            passes: 0,
            until: Date.now() + 2500,
        };
        return true;
    }

    onScrolled() {
        this.updateSliderScroll();
    }
}
