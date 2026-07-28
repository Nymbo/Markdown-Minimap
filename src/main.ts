import {
    Component,
    Plugin,
    MarkdownView,
    TFile,
    debounce,
    Setting,
    PluginSettingTab,
    MarkdownRenderer,
} from "obsidian";
import { EditorView } from "@codemirror/view";
import { prepareBlankLineRuns } from "./blank-lines";
import type { BlankLineRun } from "./blank-lines";

class MinimapSettingTab extends PluginSettingTab {
    plugin: NoteMinimap;

    constructor(plugin: NoteMinimap) {
        super(plugin.app, plugin);
        this.plugin = plugin;
    }
    display() {
        const { containerEl } = this;
        containerEl.empty();

        new Setting(containerEl)
            .setName("Enable by default")
            .setDesc(
                "Already opened notes will not be affected by changing this"
            )
            .addToggle((toggle) => {
                toggle
                    .setValue(this.plugin.settings.enabledByDefault)
                    .onChange((value) => {
                        this.plugin.settings.enabledByDefault = value;
                        void this.plugin.saveSettings();
                    });
            });

        new Setting(containerEl)
            .setName("Scale")
            .setDesc("Change the minimap scale (0.05 - 0.3)")
            .addSlider((slider) => {
                slider
                    .setLimits(0.05, 0.3, 0.01)
                    .setValue(this.plugin.settings.scale)
                    .setDynamicTooltip()
                    .onChange((value) => {
                        this.plugin.settings.scale = value;
                        void this.plugin.saveSettings();
                    });
            });

        new Setting(containerEl)
            .setName("Opacity")
            .setDesc("Change the minimap's background opacity (0.05 - 1)")
            .addSlider((slider) => {
                slider
                    .setLimits(0.05, 1, 0.01)
                    .setValue(this.plugin.settings.minimapOpacity)
                    .setDynamicTooltip()
                    .onChange((value) => {
                        this.plugin.settings.minimapOpacity = value;
                        void this.plugin.saveSettings();
                    });
            });

        new Setting(containerEl)
            .setName("Slider opacity")
            .setDesc("Change the slider opacity (0.05 - 1)")
            .addSlider((slider) => {
                slider
                    .setLimits(0.05, 1, 0.01)
                    .setValue(this.plugin.settings.sliderOpacity)
                    .setDynamicTooltip()
                    .onChange((value) => {
                        this.plugin.settings.sliderOpacity = value;
                        void this.plugin.saveSettings();
                    });
            });

        new Setting(containerEl)
            .setName("Top offset")
            .setDesc(
                "Offset the minimap from the top (pixels) - for special plugin toolbars"
            )
            .addSlider((slider) => {
                slider
                    .setLimits(0, 100, 1)
                    .setValue(this.plugin.settings.topOffset)
                    .setDynamicTooltip()
                    .onChange((value) => {
                        this.plugin.settings.topOffset = value;
                        void this.plugin.saveSettings();
                    });
            });

        new Setting(containerEl)
            .setName("Bottom offset")
            .setDesc(
                "Offset the minimap from the bottom (pixels) - for status bars or bottom chrome"
            )
            .addSlider((slider) => {
                slider
                    .setLimits(0, 100, 1)
                    .setValue(this.plugin.settings.bottomOffset)
                    .setDynamicTooltip()
                    .onChange((value) => {
                        this.plugin.settings.bottomOffset = value;
                        void this.plugin.saveSettings();
                    });
            });

        new Setting(containerEl)
            .setName("Scrollbar gap")
            .setDesc(
                "Distance between the minimap and the regular editor scrollbar (pixels)"
            )
            .addSlider((slider) => {
                slider
                    .setLimits(0, 32, 1)
                    .setValue(this.plugin.settings.scrollbarGutter)
                    .setDynamicTooltip()
                    .onChange((value) => {
                        this.plugin.settings.scrollbarGutter = value;
                        void this.plugin.saveSettings();
                    });
            });

        new Setting(containerEl)
            .setName("Minimum viewport height")
            .setDesc(
                "Minimum height for the visible viewport highlight (pixels)"
            )
            .addSlider((slider) => {
                slider
                    .setLimits(8, 80, 1)
                    .setValue(this.plugin.settings.minViewportHeight)
                    .setDynamicTooltip()
                    .onChange((value) => {
                        this.plugin.settings.minViewportHeight = value;
                        void this.plugin.saveSettings();
                    });
            });

        new Setting(containerEl)
            .setName("Center on click")
            .setDesc("Center the editor viewport around the clicked minimap position")
            .addToggle((toggle) => {
                toggle
                    .setValue(this.plugin.settings.centerOnClick)
                    .onChange((value) => {
                        this.plugin.settings.centerOnClick = value;
                        void this.plugin.saveSettings();
                    });
            });

        new Setting(containerEl)
            .setName("Reset to defaults")
            .setDesc("Restore Markdown Minimap's default settings.")
            .addButton((button) => {
                button
                    .setButtonText("Reset")
                    .setWarning()
                    .onClick(async () => {
                        await this.plugin.resetSettings();
                        this.display();
                    });
            });
    }
}

interface MarkdownMinimapSettings {
    enabledByDefault: boolean;
    scale: number;
    minimapOpacity: number;
    sliderOpacity: number;
    topOffset: number;
    bottomOffset: number;
    scrollbarGutter: number;
    minViewportHeight: number;
    centerOnClick: boolean;
}

function isSettingsObject(
    this: void,
    value: unknown
): Partial<MarkdownMinimapSettings> {
    return value && typeof value === "object"
        ? (value as Partial<MarkdownMinimapSettings>)
        : {};
}

class NoteMinimap extends Plugin {
    activeNoteView: MarkdownView | null = null;
    minimapInstances = new Map<HTMLElement, Minimap>(); // contentEl: minimap
    resizeObserver!: ResizeObserver;
    modeObserver!: MutationObserver;
    debouncedUpdateMinimap: ReturnType<typeof debounce> | undefined;
    settings!: MarkdownMinimapSettings;

    async onload() {
        // Handle resize
        const resized = new Set<Element>();
        const resize = throttle(() => {
            for (const el of resized) {
                const note = this.minimapInstances.get(el as HTMLElement);
                if (note) void note.onResize();
            }
            resized.clear();
        }, 1000);
        this.resizeObserver = new ResizeObserver((entries) => {
            for (const entry of entries) {
                resized.add(entry.target);
            }
            resize();
        });

        // Handle mode change, notice that there is no way to unobserve only one element
        this.modeObserver = new MutationObserver((entries) => {
            const entry = entries[0]; // all entries will be about the same topic anyways
            const contentEl = entry.target.parentElement;
            if (!contentEl) return;
            const noteInstance = this.minimapInstances.get(contentEl);
            if (!noteInstance) return;
            if (entry.attributeName === "style") noteInstance.modeChange();
            void this.updateViewMinimap(noteInstance.view);
        });

        // Manage active leaf
        this.registerEvent(
            this.app.workspace.on("active-leaf-change", (newActiveLeaf) => {
                // Capture the outgoing view before reassigning; the update
                // helper reads state asynchronously.
                const previousView = this.activeNoteView;
                this.activeNoteView =
                    newActiveLeaf?.view instanceof MarkdownView
                        ? newActiveLeaf.view
                        : null;

                if (previousView && previousView !== this.activeNoteView)
                    void this.updateViewMinimap(previousView);
                if (this.activeNoteView) {
                    this.addActionButtonsToView(this.activeNoteView);
                    void this.updateViewMinimap(this.activeNoteView);
                }
            })
        );

        // Update previews as needed
        this.debouncedUpdateMinimap = debounce(
            () => {
                if (this.activeNoteView)
                    void this.updateViewMinimap(this.activeNoteView);
            },
            700,
            true
        );
        this.registerEvent(
            this.app.workspace.on("editor-change", this.debouncedUpdateMinimap)
        );

        // Keep background panes showing the same file in sync (external edits,
        // sync, or edits made in another pane).
        this.registerEvent(
            this.app.vault.on("modify", (file) => {
                if (!(file instanceof TFile)) return;
                for (const leaf of this.app.workspace.getLeavesOfType(
                    "markdown"
                )) {
                    const view = leaf.view;
                    if (
                        view instanceof MarkdownView &&
                        view !== this.activeNoteView &&
                        view.file?.path === file.path
                    ) {
                        void this.updateViewMinimap(view);
                    }
                }
            })
        );

        // Theme or snippet changes only affect colors; the rendered content
        // restyles itself since it lives in the app document.
        this.registerEvent(
            this.app.workspace.on("css-change", () => {
                for (const note of this.minimapInstances.values()) {
                    note.updateSettings(this.settings);
                }
            })
        );

        // This event does not provide arguments
        this.registerEvent(
            this.app.workspace.on("layout-change", () => {
                // mode changes cause resizing since the height of the note contents changes
                const activeEl = this.activeNoteView?.contentEl;
                if (activeEl)
                    this.minimapInstances
                        .get(activeEl)
                        ?.onResize()
                        .catch(() => undefined);

                // closed notes
                const openEls = new Set<HTMLElement>(
                    this.app.workspace
                        .getLeavesOfType("markdown")
                        .filter((leaf) => leaf.view instanceof MarkdownView)
                        .map((leaf) => (leaf.view as MarkdownView).contentEl)
                );
                for (const [el, note] of this.minimapInstances.entries()) {
                    if (!openEls.has(el)) this.destroyMinimapForElement(el);
                }
            })
        );

        await this.loadSettings();
        this.addSettingTab(new MinimapSettingTab(this));

        this.addCommand({
            id: "toggle-minimap",
            name: "Toggle minimap for current note",
            checkCallback: (checking) => {
                const view =
                    this.app.workspace.getActiveViewOfType(MarkdownView);
                if (!view) return false;
                if (!checking) this.toggleMinimapForView(view);
                return true;
            },
        });
        this.addCommand({
            id: "refresh-minimap",
            name: "Refresh minimap for current note",
            checkCallback: (checking) => {
                const view =
                    this.app.workspace.getActiveViewOfType(MarkdownView);
                if (!view) return false;
                if (!checking) void this.refreshMinimapForView(view);
                return true;
            },
        });

        this.app.workspace.onLayoutReady(() => {
            this.activeNoteView =
                this.app.workspace.getActiveViewOfType(MarkdownView);
            this.injectMinimapIntoAllNotes();
        });
    }

    onunload() {
        // IMPORTANT: Obsidian automatically unregisters hooks made only by using this.registerEvent or this.registerDomEvent.

        // Free timeout
        if (this.debouncedUpdateMinimap?.cancel) {
            this.debouncedUpdateMinimap.cancel();
        }

        // Destroy all minimap instances and disconnect observers
        this.minimapInstances.forEach((noteInstance) => noteInstance.destroy());
        this.minimapInstances.clear();
        this.resizeObserver.disconnect();
        this.modeObserver.disconnect();

        // Remove action buttons from every markdown view, including popout windows
        for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
            leaf.view.containerEl
                .querySelectorAll(
                    ".minimap-toggle-button, .minimap-refresh-button"
                )
                .forEach((button) => button.remove());
        }
    }

    async loadSettings() {
        const savedSettings: unknown = await this.loadData();
        this.settings = Object.assign(
            this.getDefaultSettings(),
            isSettingsObject(savedSettings)
        );
    }

    getDefaultSettings() {
        return {
            enabledByDefault: true,
            scale: 0.1,
            minimapOpacity: 0.3,
            sliderOpacity: 0.3,
            topOffset: 0,
            bottomOffset: 0,
            scrollbarGutter: 14,
            minViewportHeight: 24,
            centerOnClick: true,
        };
    }

    async resetSettings() {
        this.settings = this.getDefaultSettings();
        await this.saveSettings();
    }

    async saveSettings() {
        await this.saveData(this.settings);

        // Update all existing notes
        for (const note of this.minimapInstances.values()) {
            note.updateSettings(this.settings);
        }
    }

    injectMinimapIntoAllNotes() {
        for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
            if (!(leaf.view instanceof MarkdownView)) continue;
            this.addActionButtonsToView(leaf.view);
            void this.updateViewMinimap(leaf.view);
        }
    }

    async updateViewMinimap(view: MarkdownView) {
        // Wait for Obsidian to finish applying leaf/view changes before
        // reading editor DOM state. No equivalent settled event exists.
        await sleep(100);
        const element = view.contentEl;
        if (!element.isConnected) return;

        // Assert it's a markdown note by checking for the two needed children.
        // The reading-view scope avoids matching the minimap's own content div.
        if (
            !element.querySelector(".markdown-source-view") ||
            !element.querySelector(".markdown-reading-view .markdown-preview-view")
        )
            return;

        // If disabled, remove the minimap if it exists
        if (element.classList.contains("minimap-disabled")) {
            this.destroyMinimapForElement(element);
            return;
        }

        // Update or create the minimap instance for this view
        let noteInstance = this.minimapInstances.get(element);
        if (!noteInstance) {
            noteInstance = new Minimap(this, view, this.settings);
            this.minimapInstances.set(element, noteInstance);
            this.resizeObserver.observe(element);
            this.modeObserver.observe(noteInstance.sourceView, {
                attributes: true,
            });
        }
        void noteInstance.render();
    }

    destroyMinimapForElement(element: HTMLElement) {
        const existing = this.minimapInstances.get(element);
        if (!existing) return;
        existing.destroy();
        this.minimapInstances.delete(element);
        this.resizeObserver.unobserve(element);
        // MutationObserver.unobserve() does not exist...
    }

    addActionButtonsToView(view: MarkdownView) {
        // Avoid adding twice
        if (view.containerEl.querySelector(".minimap-toggle-button")) return;

        const toggleButton = view.addAction("star-list", "Toggle minimap", () =>
            this.toggleMinimapForView(view)
        );
        toggleButton.addClass("minimap-toggle-button");

        const refreshButton = view.addAction(
            "refresh-cw",
            "Refresh minimap",
            () => void this.refreshMinimapForView(view)
        );
        refreshButton.addClass("minimap-refresh-button");

        // Handle disable-by-default
        if (!this.settings.enabledByDefault)
            view.contentEl.classList.add("minimap-disabled");
    }

    toggleMinimapForView(view: MarkdownView) {
        view.contentEl.classList.toggle("minimap-disabled");
        void this.updateViewMinimap(view);
    }

    async refreshMinimapForView(view: MarkdownView) {
        this.destroyMinimapForElement(view.contentEl);
        await this.updateViewMinimap(view);
    }
}

class Minimap {
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
    centerOnClick = true;
    backgroundColor = "";
    renderVersion = 0;
    isDragging = false;
    dragMode: "thumb" | "document" = "document";
    trailingSyncTimer = 0;

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

        // Register events - need to remove on destroy!
        this.hitbox?.addEventListener("mousedown", this.onMinimapMouseDown);
        this.hitbox?.addEventListener("wheel", this.onMinimapWheel, {
            passive: false,
        });
    }

    updateSettings(settings: MarkdownMinimapSettings) {
        this.scale = settings.scale;
        this.minimapOpacity = settings.minimapOpacity;
        this.sliderOpacity = settings.sliderOpacity;
        this.topOffset = settings.topOffset;
        this.bottomOffset = settings.bottomOffset;
        this.scrollbarGutter = settings.scrollbarGutter;
        this.minViewportHeight = settings.minViewportHeight;
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
        }
        if (this.content)
            this.content.style.backgroundColor = this.backgroundColor;
        if (this.slider) this.slider.style.opacity = String(this.sliderOpacity);
    }

    destroy() {
        this.renderVersion++; // invalidate any in-flight render
        window.clearTimeout(this.trailingSyncTimer);
        this.scroller?.removeEventListener("scroll", this.onScroll);
        this.hitbox?.removeEventListener("mousedown", this.onMinimapMouseDown);
        this.hitbox?.removeEventListener("wheel", this.onMinimapWheel);
        activeDocument.removeEventListener("mousemove", this.onSliderMouseMove);
        activeDocument.removeEventListener("mouseup", this.onSliderMouseUp);

        this.renderComponent?.unload();
        this.renderComponent = null;
        this.container?.remove();

        this.container = null;
        this.content = null;
        this.slider = null;
        this.hitbox = null;
        this.scroller = null;
    }

    isReadModeActive() {
        return this.sourceView.clientHeight === 0;
    }

    modeChange() {
        // Scope to the reading view so we never match the minimap's own
        // content div, which also carries .markdown-preview-view.
        this.changeScroller(
            this.element.querySelector(
                this.isReadModeActive()
                    ? ".markdown-reading-view .markdown-preview-view"
                    : ".cm-scroller"
            )
        );
    }
    changeScroller(newScroller: HTMLElement | null) {
        if (this.scroller) {
            this.scroller.removeEventListener("scroll", this.onScroll);
        }
        this.scroller = newScroller;
        if (this.scroller) {
            this.scroller.addEventListener("scroll", this.onScroll);
            void this.onResize();
        }
    }

    // CodeMirror's scrollHeight is an estimate that settles shortly after a
    // jump, so re-sync once more after scrolling stops.
    onScroll = () => {
        this.updateSliderScroll();
        window.clearTimeout(this.trailingSyncTimer);
        this.trailingSyncTimer = window.setTimeout(
            this.updateSliderScroll,
            350
        );
    };

    async onResize() {
        // Wait for Obsidian's editor layout pass before measuring scroll
        // dimensions; immediate reads can be stale after mode or pane changes.
        await sleep(300);
        this.updateSliderScroll();
    }

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
        this.content.className =
            "minimap-content markdown-preview-view markdown-rendered";
        container.appendChild(this.content);

        this.slider = activeDocument.createElement("div");
        this.slider.className = "minimap-slider";
        container.appendChild(this.slider);

        this.hitbox = activeDocument.createElement("div");
        this.hitbox.className = "minimap-hitbox";
        container.appendChild(this.hitbox);
    }

    getEditorView() {
        const editorElement =
            this.sourceView.querySelector<HTMLElement>(".cm-editor");
        return editorElement ? EditorView.findFromDOM(editorElement) : null;
    }

    applyBlankLineHeights(
        rendered: HTMLElement,
        runs: BlankLineRun[],
        editorView: EditorView | null
    ) {
        const editorLine =
            this.sourceView.querySelector<HTMLElement>(".cm-line");
        const fallbackLineHeight = editorLine
            ? Number.parseFloat(
                  editorLine.ownerDocument.defaultView
                      ?.getComputedStyle(editorLine)
                      .lineHeight ?? ""
              )
            : 24;
        const document = editorView?.state.doc;

        for (const run of runs) {
            const marker = rendered.querySelector<HTMLElement>(
                `.${run.markerClass}`
            );
            if (!marker) continue;

            let height = 0;
            if (editorView && document) {
                for (const lineNumber of run.sourceLineNumbers) {
                    if (lineNumber > document.lines) continue;
                    const line = document.line(lineNumber);
                    height += editorView.lineBlockAt(line.from).height;
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

    // Render the note's full Markdown source into the scaled minimap panel.
    // Blank-line markers retain the source's vertical spacing without
    // replacing Obsidian's rendered Markdown output.
    async render() {
        const renderVersion = ++this.renderVersion;
        const file = this.view.file;
        if (!file || !this.content) return;

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
        this.renderComponent?.unload();
        this.renderComponent = component;

        this.content.empty();
        this.content.createDiv({
            cls: "inline-title minimap-inline-title",
            text: file.basename,
        });
        while (rendered.firstChild) {
            this.content.appendChild(rendered.firstChild);
        }

        void this.onResize();
    }

    updateSliderScroll = () => {
        if (
            !this.scroller ||
            !this.container ||
            !this.content ||
            !this.slider ||
            !this.hitbox
        )
            return;
        const metrics = this.getScrollMetrics();
        const minimapViewportTop =
            metrics.scrollTop * metrics.docScale - metrics.minimapScrollOffset;
        const sliderTop =
            (this.topOffset || 0) +
            Math.max(
                0,
                Math.min(
                    minimapViewportTop,
                    Math.max(0, metrics.activeHeight - metrics.sliderHeight)
                )
            );

        this.content.style.top = `${
            (this.topOffset || 0) - metrics.minimapScrollOffset
        }px`;
        this.slider.style.top = `${sliderTop}px`;
        this.slider.style.height = `${metrics.sliderHeight}px`;
        this.hitbox.style.height = `${metrics.activeHeight}px`;
    };

    getScrollMetrics() {
        const clientHeight = Math.max(this.scroller.clientHeight, 1);
        const scrollHeight = Math.max(this.scroller.scrollHeight, clientHeight);
        const maxScroll = Math.max(0, scrollHeight - clientHeight);
        const scrollTop = Math.max(
            0,
            Math.min(this.scroller.scrollTop, maxScroll)
        );
        const availableHeight = Math.max(
            1,
            (this.container?.clientHeight || clientHeight) -
                (this.topOffset || 0) -
                (this.bottomOffset || 0)
        );
        // The rendered minimap's height differs from the editor's scroll
        // height (rendered markdown vs. live preview), so map through the
        // minimap content's own height rather than assuming they match.
        const contentHeight =
            this.content && this.content.scrollHeight > 1
                ? this.content.scrollHeight
                : scrollHeight;
        const scaledDocumentHeight = Math.max(1, contentHeight * this.scale);
        // Effective scale from editor pixels to minimap pixels
        const docScale = scaledDocumentHeight / scrollHeight;
        const rawActiveHeight = Math.min(availableHeight, scaledDocumentHeight);
        const sliderHeight = Math.max(
            this.minViewportHeight || 24,
            Math.min(rawActiveHeight, clientHeight * docScale)
        );
        const activeHeight = Math.max(rawActiveHeight, sliderHeight);
        const maxMinimapScroll = Math.max(
            0,
            scaledDocumentHeight - activeHeight
        );
        const scrollRatio = maxScroll > 0 ? scrollTop / maxScroll : 0;
        const minimapScrollOffset = maxMinimapScroll * scrollRatio;

        return {
            scrollHeight,
            clientHeight,
            maxScroll,
            scrollTop,
            availableHeight,
            activeHeight,
            scaledDocumentHeight,
            docScale,
            maxMinimapScroll,
            scrollRatio,
            minimapScrollOffset,
            sliderHeight,
        };
    }

    onMinimapMouseDown = (e: MouseEvent) => {
        e.preventDefault();
        this.isDragging = true;
        this.dragMode = this.isClientYInsideSlider(e.clientY)
            ? "thumb"
            : "document";
        this.slider?.classList.add("dragging");

        this.scrollToMinimapClientY(
            e.clientY,
            this.centerOnClick,
            this.dragMode
        );

        activeDocument.addEventListener("mousemove", this.onSliderMouseMove);
        activeDocument.addEventListener("mouseup", this.onSliderMouseUp);
    };

    onMinimapWheel = (e: WheelEvent) => {
        if (!this.scroller) return;
        e.preventDefault();
        this.scroller.scrollBy({
            left: e.deltaX,
            top: e.deltaY,
            behavior: "auto",
        });
        this.updateSliderScroll();
    };

    onSliderMouseMove = (e: MouseEvent) => {
        if (!this.isDragging) return;
        this.scrollToMinimapClientY(
            e.clientY,
            this.centerOnClick,
            this.dragMode
        );
    };

    isClientYInsideSlider(clientY: number) {
        if (!this.slider) return false;
        const sliderRect = this.slider.getBoundingClientRect();
        return clientY >= sliderRect.top && clientY <= sliderRect.bottom;
    }

    scrollToMinimapClientY(
        clientY: number,
        centerViewport = false,
        mode: "thumb" | "document" = "document"
    ) {
        if (!this.scroller || !this.container) return;
        const metrics = this.getScrollMetrics();
        if (metrics.maxScroll <= 0) return;

        const rect = this.container.getBoundingClientRect();
        const localY = Math.max(
            0,
            Math.min(
                clientY - rect.top - (this.topOffset || 0),
                metrics.activeHeight
            )
        );
        const scrollRatio =
            mode === "thumb"
                ? this.getThumbScrollRatio(localY, metrics, centerViewport)
                : this.getDocumentScrollRatio(localY, metrics, centerViewport);
        const scrollTop = Math.max(
            0,
            Math.min(scrollRatio * metrics.maxScroll, metrics.maxScroll)
        );

        this.scroller.scrollTop = scrollTop;
        this.updateSliderScroll();
    }

    getThumbScrollRatio(
        localY: number,
        metrics: ReturnType<Minimap["getScrollMetrics"]>,
        centerViewport: boolean
    ) {
        const targetY = centerViewport
            ? localY - metrics.sliderHeight / 2
            : localY;
        return Math.max(
            0,
            Math.min(
                targetY / Math.max(1, metrics.activeHeight - metrics.sliderHeight),
                1
            )
        );
    }

    getDocumentScrollRatio(
        localY: number,
        metrics: ReturnType<Minimap["getScrollMetrics"]>,
        centerViewport: boolean
    ) {
        const documentY =
            (localY + metrics.minimapScrollOffset) /
            Math.max(metrics.docScale, 0.001);
        const targetScrollTop = centerViewport
            ? documentY - metrics.clientHeight / 2
            : documentY;
        return Math.max(
            0,
            Math.min(targetScrollTop / Math.max(1, metrics.maxScroll), 1)
        );
    }

    onSliderMouseUp = () => {
        this.isDragging = false;
        this.slider?.classList.remove("dragging");
        activeDocument.removeEventListener("mousemove", this.onSliderMouseMove);
        activeDocument.removeEventListener("mouseup", this.onSliderMouseUp);
    };
}

export default NoteMinimap;

const sleep = (ms: number) =>
    new Promise<void>((resolve) => window.setTimeout(resolve, ms));

type ThrottleOptions = {
    leading?: boolean;
    trailing?: boolean;
};

function throttle<TArgs extends unknown[]>(
    fn: (...args: TArgs) => void,
    limit: number,
    options: ThrottleOptions = { leading: false, trailing: true }
) {
    let inThrottle = false;
    let lastArgs: TArgs | null = null;

    const invoke = () => {
        if (lastArgs) {
            const args = lastArgs;
            lastArgs = null;
            fn(...args);
            window.setTimeout(invoke, limit);
        } else {
            inThrottle = false;
        }
    };

    return (...args: TArgs) => {
        if (!inThrottle) {
            if (options.leading) {
                fn(...args);
            } else {
                lastArgs = args;
            }
            inThrottle = true;
            window.setTimeout(invoke, limit);
        } else if (options.trailing) {
            lastArgs = args;
        }
    };
}

function toRGBAAlpha(this: void, color: string, alpha: number): string {
    if (color.startsWith("#")) {
        // hex to rgb
        let hex = color.replace("#", "");
        if (hex.length === 3)
            hex = hex
                .split("")
                .map((x) => x + x)
                .join("");
        const num = parseInt(hex, 16);
        const r = (num >> 16) & 255;
        const g = (num >> 8) & 255;
        const b = num & 255;
        return `rgba(${r},${g},${b},${alpha})`;
    } else if (color.startsWith("rgb")) {
        // rgb or rgba
        const nums = color.match(/[\d.]+/g);
        if (nums && nums.length >= 3) {
            return `rgba(${nums[0]},${nums[1]},${nums[2]},${alpha})`;
        }
    }
    // fallback
    return color;
}
