import { Component, MarkdownRenderer, MarkdownView } from "obsidian";
import { EditorView } from "@codemirror/view";
import { prepareBlankLineRuns } from "./blank-lines";
import type { BlankLineRun } from "./blank-lines";
import { AnchorTracker } from "./anchors";
import { mirrorCodeMetrics, mirrorDocumentMetrics } from "./document-metrics";
import { findInlineTitle, renderFrontmatter } from "./frontmatter";
import { MinimapPointer } from "./pointer";
import type { PointerHost } from "./pointer";
import {
    applySourceLineHeights,
    buildSourceLineDom,
} from "./source-view";
import {
    computeScrollMetrics,
    resolveDocumentHeights,
} from "./scroll-model";
import type { ScrollMetrics } from "./scroll-model";
import type { MarkdownMinimapSettings } from "./settings";
import type NoteMinimap from "./main";
import { clamp, computedStyle, pixels, sleep, toRGBAAlpha } from "./utils";

export class Minimap implements PointerHost {
    plugin: NoteMinimap;
    view: MarkdownView;
    element: HTMLElement;
    sourceView: HTMLElement;
    scroller: HTMLElement | null = null;
    container: HTMLDivElement | null = null;
    content: HTMLDivElement | null = null;
    slider: HTMLDivElement | null = null;
    hitbox: HTMLDivElement | null = null;
    renderComponent: Component | null = null;
    scale = 0.1;
    minimapOpacity = 0.3;
    sliderOpacity = 0.3;
    topOffset = 0;
    bottomOffset = 0;
    scrollbarGutter = 14;
    minViewportHeight = 24;
    reserveSpace = false;
    centerOnClick = true;
    backgroundColor = "";
    renderVersion = 0;
    trailingSyncTimer = 0;

    readonly anchors = new AnchorTracker();
    private readonly pointer = new MinimapPointer(this);
    /** Heading source lines from the last render, paired with the anchors. */
    private headingLines: number[] = [];
    /** Whether a real code line has been measured for this view yet. */
    private codeMetricsMirrored = false;
    /** Source-mode line elements, index 0 being source line 1. */
    private sourceLineElements: HTMLElement[] = [];
    /** CodeMirror content height the source line heights were copied from. */
    private appliedContentHeight = -1;

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
        this.updateSettings(settings);
        this.modeChange();

        if (this.hitbox) this.pointer.attach(this.hitbox);
    }

    // --- lifecycle -------------------------------------------------------

    setupElements() {
        this.element
            .querySelectorAll(
                ".minimap-container, .minimap-content, .minimap-slider, .minimap-hitbox"
            )
            .forEach((e) => e.remove());

        const container = activeDocument.createElement("div");
        container.className = "minimap-container";
        this.container = container;
        this.element.prepend(container);

        this.content = activeDocument.createElement("div");
        // "show-properties" is what re-enables Obsidian's own rule for the
        // properties widget; rendered Markdown hides it by default, so without
        // this the cloned properties collapse to zero height and render blank.
        this.content.className =
            "minimap-content markdown-preview-view markdown-rendered show-properties";
        container.appendChild(this.content);

        this.slider = activeDocument.createElement("div");
        this.slider.className = "minimap-slider";
        container.appendChild(this.slider);

        this.hitbox = activeDocument.createElement("div");
        this.hitbox.className = "minimap-hitbox";
        container.appendChild(this.hitbox);
    }

    destroy() {
        this.renderVersion++; // invalidate any in-flight render
        window.clearTimeout(this.trailingSyncTimer);
        this.scroller?.removeEventListener("scroll", this.onScroll);
        this.pointer.detach(this.hitbox);

        this.renderComponent?.unload();
        this.renderComponent = null;
        this.container?.remove();
        this.element.style.removeProperty("--minimap-content-shift");
        this.element.classList.remove("minimap-content-shifted");

        this.container = null;
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
        this.sliderOpacity = settings.sliderOpacity;
        this.topOffset = settings.topOffset;
        this.bottomOffset = settings.bottomOffset;
        this.scrollbarGutter = settings.scrollbarGutter;
        this.minViewportHeight = settings.minViewportHeight;
        this.reserveSpace = settings.reserveSpace;
        this.centerOnClick = settings.centerOnClick;

        this.backgroundColor = toRGBAAlpha(
            this.element.getCssPropertyValue("background-color"),
            this.minimapOpacity
        );

        this.updateSettingsInCSS();
        void this.onResize();
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
            // The thumb has three states, so the setting is published as a
            // variable the stylesheet scales rather than a fixed opacity. An
            // inline opacity here would override every one of them.
            this.container.style.setProperty(
                "--minimap-slider-opacity",
                String(this.sliderOpacity)
            );
        }
        if (this.content)
            this.content.style.backgroundColor = this.backgroundColor;
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

    applyBlankLineHeights(
        rendered: HTMLElement,
        runs: BlankLineRun[],
        editorView: EditorView | null
    ) {
        const editorLine =
            this.sourceView.querySelector<HTMLElement>(".cm-line");
        const fallbackLineHeight = editorLine
            ? Number.parseFloat(computedStyle(editorLine)?.lineHeight ?? "")
            : 24;
        const doc = editorView?.state.doc;

        for (const run of runs) {
            const marker = rendered.querySelector<HTMLElement>(
                `.${run.markerClass}`
            );
            if (!marker) continue;

            let height = 0;
            if (editorView && doc) {
                for (const lineNumber of run.sourceLineNumbers) {
                    if (lineNumber > doc.lines) continue;
                    height += editorView.lineBlockAt(
                        doc.line(lineNumber).from
                    ).height;
                }
            } else {
                height =
                    run.sourceLineNumbers.length *
                    (Number.isFinite(fallbackLineHeight)
                        ? fallbackLineHeight
                        : 24);
            }
            marker.style.height = `${Math.max(0, height)}px`;
        }
    }

    // --- rendering --------------------------------------------------------

    /**
     * Source mode's minimap is the source text, one element per line, sized by
     * the same CSS variables Obsidian's own Source-mode styling resolves. No
     * Markdown renderer is involved, so nothing appears that the note does not
     * show, and blank lines and frontmatter need no special handling.
     */
    renderSourceText() {
        const file = this.view.file;
        if (!file || !this.content) return;

        const dom = buildSourceLineDom(this.view.getViewData());
        this.renderComponent?.unload();
        this.renderComponent = null;

        this.content.empty();
        this.content.classList.add("minimap-content-source");
        this.addInlineTitle(file.basename);
        this.content.appendChild(dom.fragment);

        this.sourceLineElements = dom.elements;
        this.appliedContentHeight = -1;
        this.refreshSourceLineHeights();

        this.headingLines = dom.headingLines;
        this.afterRender();
    }

    private refreshSourceLineHeights() {
        const applied = applySourceLineHeights(
            this.sourceLineElements,
            this.getEditorView(),
            this.appliedContentHeight
        );
        if (applied !== null) this.appliedContentHeight = applied;
    }

    // Render the note's full Markdown source into the scaled minimap panel.
    // Blank-line markers retain the source's vertical spacing without
    // replacing Obsidian's rendered Markdown output.
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

        const data = prepareBlankLineRuns(this.view.getViewData());
        const editorView = this.getEditorView();

        const component = new Component();
        component.load();
        const rendered = activeDocument.createElement("div");
        try {
            await MarkdownRenderer.render(
                this.plugin.app,
                data.markdown,
                rendered,
                file.path,
                component
            );
        } catch {
            component.unload();
            return;
        }

        // A newer render started (or we were destroyed) while awaiting
        if (renderVersion !== this.renderVersion || !this.content) {
            component.unload();
            return;
        }

        this.applyBlankLineHeights(rendered, data.runs, editorView);
        renderFrontmatter({
            rendered,
            element: this.element,
            readMode: this.isReadModeActive(),
            editorView,
            lineCount: data.frontmatterLineCount,
            paneMeasurable: this.isPaneMeasurable(),
            displayMode: this.getPropertiesDisplayMode(),
        });
        this.renderComponent?.unload();
        this.renderComponent = component;

        this.content.empty();
        this.addInlineTitle(file.basename);
        while (rendered.firstChild) {
            this.content.appendChild(rendered.firstChild);
        }

        this.headingLines = data.headingLines;
        this.afterRender();
    }

    private addInlineTitle(basename: string) {
        const inlineTitle = findInlineTitle(
            this.element,
            this.isReadModeActive()
        );
        if (!this.content || !inlineTitle || inlineTitle.offsetHeight <= 0)
            return;
        this.content.createDiv({
            cls: "inline-title minimap-inline-title",
            text: basename,
        });
    }

    private afterRender() {
        this.syncDocumentMetrics();
        this.anchors.capture(this.content, this.headingLines, this.scale);
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
        this.updateSliderScroll();
    };

    async onResize() {
        // Wait for Obsidian's editor layout pass before measuring scroll
        // dimensions; immediate reads can be stale after mode or pane changes.
        await sleep(300);
        this.syncDocumentMetrics();
        // CodeMirror replaces its height estimates with measurements as lines
        // are rendered, so refresh from it before re-anchoring.
        if (this.isRawSourceMode()) this.refreshSourceLineHeights();
        // Layout may have shifted every heading, so re-measure the anchors
        // before they are used to place the slider.
        this.anchors.capture(this.content, this.headingLines, this.scale);
        // Sync now and once more after CodeMirror's height estimate settles.
        this.onScroll();
    }

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
        const usable =
            !this.isReadModeActive() &&
            this.anchors.prepare(
                this.getEditorView(),
                this.getEditorContentOffset(),
                heights.effectiveScrollHeight,
                heights.contentHeight
            );

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
        });
    }

    updateSliderScroll = () => {
        if (!this.container || !this.content || !this.slider || !this.hitbox)
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

        this.content.style.top = `${
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

    mapToEditor(minimapY: number): number | null {
        return this.anchors.active ? this.anchors.toEditor(minimapY) : null;
    }

    onScrolled() {
        this.updateSliderScroll();
    }
}
