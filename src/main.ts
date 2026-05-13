import {
    Plugin,
    MarkdownView,
    setIcon,
    debounce,
    Setting,
    PluginSettingTab,
    MarkdownRenderer,
} from "obsidian";

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
                        this.plugin.saveSettings();
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
                        this.plugin.saveSettings();
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
                        this.plugin.saveSettings();
                    });
            });

        new Setting(containerEl)
            .setName("Slider Opacity")
            .setDesc("Change the slider opacity (0.05 - 1)")
            .addSlider((slider) => {
                slider
                    .setLimits(0.05, 1, 0.01)
                    .setValue(this.plugin.settings.sliderOpacity)
                    .setDynamicTooltip()
                    .onChange((value) => {
                        this.plugin.settings.sliderOpacity = value;
                        this.plugin.saveSettings();
                    });
            });

        new Setting(containerEl)
            .setName("Top Offset")
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
                        this.plugin.saveSettings();
                    });
            });

        new Setting(containerEl)
            .setName("Bottom Offset")
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
                        this.plugin.saveSettings();
                    });
            });

        new Setting(containerEl)
            .setName("Scrollbar Gap")
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
                        this.plugin.saveSettings();
                    });
            });

        new Setting(containerEl)
            .setName("Minimum Viewport Height")
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
                        this.plugin.saveSettings();
                    });
            });

        new Setting(containerEl)
            .setName("Center on Click")
            .setDesc("Center the editor viewport around the clicked minimap position")
            .addToggle((toggle) => {
                toggle
                    .setValue(this.plugin.settings.centerOnClick)
                    .onChange((value) => {
                        this.plugin.settings.centerOnClick = value;
                        this.plugin.saveSettings();
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

class NoteMinimap extends Plugin {
    activeNoteView: MarkdownView | null = null;
    updateNeeded = false;
    minimapInstances = new Map<HTMLElement, Minimap>(); // element: noteInstance
    resizeObserver!: ResizeObserver;
    modeObserver!: MutationObserver;
    debouncedUpdateMinimap: ReturnType<typeof debounce>;
    settings!: MarkdownMinimapSettings;
    helperLeafIds = new Map<string, string>();

    async onload() {
        // Handle resize
        const resized = new Set(); // entry.target = element
        const resize = throttle(() => {
            for (const el of resized) {
                for (const [element, note] of this.minimapInstances.entries()) {
                    if (element === el) {
                        note.onResize();
                        break; // Exit inner loop once a match is found
                    }
                }
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
            const noteInstance = this.minimapInstances.get(
                entry.target.parentElement as HTMLElement
            );
            if (entry.attributeName === "style") noteInstance?.modeChange();
            this.updateElementMinimap();
        });

        // Manage active leaf
        this.registerEvent(
            this.app.workspace.on("active-leaf-change", (newActiveLeaf) => {
                if (this.isHelperLeaf(newActiveLeaf)) {
                    newActiveLeaf.detach();
                    return;
                }

                this.updateElementMinimap(); // old leaf
                this.activeNoteView =
                    newActiveLeaf?.view instanceof MarkdownView
                        ? newActiveLeaf.view
                        : null;
                this.updateElementMinimap(); // new leaf

                // Toggle button
                if (newActiveLeaf?.view?.getViewType() === "markdown") {
                    this.openHelperForLeaf(newActiveLeaf);
                    this.addToggleButtonToLeaf(newActiveLeaf);
                }
            })
        );

        // Update previews as needed
        this.debouncedUpdateMinimap = debounce(
            () => {
                this.updateElementMinimap();
            },
            700,
            true
        );
        this.registerEvent(
            this.app.workspace.on("editor-change", this.debouncedUpdateMinimap)
        );

        // This event does not provide arguments
        this.registerEvent(
            this.app.workspace.on("layout-change", () => {
                this.detachRedundantHelperLeavesAndRestoreMissing();
                this.updateHelpers();

                // mode changes cause resizing since the height of the note contents changes
                this.minimapInstances
                    .get(this.activeNoteView?.contentEl)
                    ?.onResize();

                // closed notes
                const openEls = new Set<HTMLElement>(
                    this.app.workspace
                        .getLeavesOfType("markdown")
                        .filter((leaf) => !this.isHelperLeaf(leaf))
                        .map((l: any) => l.view.contentEl)
                );
                for (const [el, note] of this.minimapInstances.entries()) {
                    if (!openEls.has(el)) {
                        note.destroy();
                        this.minimapInstances.delete(el);
                        this.resizeObserver.unobserve(el);
                    }
                }
            })
        );

        await this.loadSettings();
        this.addSettingTab(new MinimapSettingTab(this));
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

        // Destroy all Note instances and disconnect Observers
        this.minimapInstances.forEach((noteInstance) => noteInstance.destroy());
        this.resizeObserver.disconnect();
        this.modeObserver.disconnect();

        document
            .querySelectorAll(".minimap-toggle-button")
            .forEach((button) => button.remove());
        this.detachAllHelperLeaves();

    }

    async loadSettings() {
        this.settings = Object.assign(this.getDefaultSettings(), await this.loadData());
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
        const leaves = this.app.workspace.getLeavesOfType("markdown");
        for (const leaf of leaves) {
            if (this.isHelperLeaf(leaf)) continue;
            this.openHelperForLeaf(leaf);
            this.addToggleButtonToLeaf(leaf);
            this.updateElementMinimap(
                (leaf as any).view.contentEl,
                this.helperLeafIds.get((leaf as any).id)
            );
        }
    }

    async updateElementMinimap(element?: HTMLElement, helperLeafId?: string) {
        // Wait for Obsidian to finish applying leaf/view changes before
        // reading editor DOM state. No equivalent settled event exists.
        await sleep(100);
        const activeLeaf: any = this.app.workspace.activeLeaf;
        if (activeLeaf && !this.isHelperLeaf(activeLeaf))
            helperLeafId = this.helperLeafIds.get(activeLeaf.id);

        // If no element is provided, use the active leaf
        if (!element) {
            if (!this.activeNoteView) return;
            element = this.activeNoteView.contentEl;
        }

        // Assert it's a markdown note by checking for the two needed children
        if (
            !element.querySelector(".markdown-source-view") ||
            !element.querySelector(".markdown-preview-view")
        )
            return;

        // If disabled, remove the minimap if it exists
        if (element.classList.contains("minimap-disabled")) {
            const existing = this.minimapInstances.get(element);
            if (existing) {
                existing.destroy();
                this.minimapInstances.delete(element);
                this.resizeObserver.unobserve(element);
                // MutationObserver.unobserve() does not exist...
            }
            return;
        }

        // Update or create the Note instance for this element
        if (this.minimapInstances.has(element)) {
            const noteInstance = this.minimapInstances.get(element);
            noteInstance?.setHelperLeafId(helperLeafId);
            noteInstance?.updateIframe();
        } else {
            const minimapInstance = new Minimap(
                this,
                element,
                this.settings,
                helperLeafId
            );
            this.minimapInstances.set(element, minimapInstance);
            this.resizeObserver.observe(element);
            this.modeObserver.observe(minimapInstance.sourceView, {
                attributes: true,
            });
        }
    }

    addToggleButtonToLeaf(leaf: any) {
        const viewActions =
            leaf.view.containerEl.querySelector(".view-actions");

        if (!viewActions) return;

        // Avoid adding twice
        if (viewActions.querySelector(".minimap-toggle-button")) return;

        const button = document.createElement("button");
        button.className = "clickable-icon view-actions minimap-toggle-button";
        button.setAttribute("aria-label", "Toggle Minimap");

        // Use Obsidian's built-in icon
        setIcon(button, "star-list");

        const contentEl = leaf.view.contentEl;
        button.onclick = () => {
            contentEl.classList.toggle("minimap-disabled");
            this.updateElementMinimap(contentEl);
        };

        // Handle disable-by-default
        if (!this.settings.enabledByDefault)
            contentEl.classList.add("minimap-disabled");

        viewActions.prepend(button);
    }

    isHelperLeaf(leaf: any): boolean {
        return !!leaf && [...this.helperLeafIds.values()].includes(leaf.id);
    }

    async openHelperForLeaf(leaf: any) {
        if (!leaf || this.helperLeafIds.has(leaf.id) || this.isHelperLeaf(leaf))
            return;
        if (leaf.view?.getViewType() !== "markdown" || !leaf.view.file) return;

        const rightLeaf = this.app.workspace.getRightLeaf(false);
        this.helperLeafIds.set(leaf.id, (rightLeaf as any).id);
        await this.updateHelperForLeaf(leaf);
        this.hideHelperLeaf(rightLeaf);
    }

    hideHelperLeaf(helperLeaf: any) {
        const viewEl = helperLeaf?.view?.containerEl;
        viewEl?.classList.add("markdown-minimap-helper-view");

        const leafEl = viewEl?.closest(".workspace-leaf");
        leafEl?.classList.add("markdown-minimap-helper-leaf");

        const tabHeaderEl = helperLeaf?.tabHeaderEl;
        tabHeaderEl?.classList?.add("markdown-minimap-helper-tab");
    }

    detachRedundantHelperLeavesAndRestoreMissing() {
        this.helperLeafIds.forEach((helperLeafId, originalLeafId) => {
            const originalLeaf = this.app.workspace.getLeafById(originalLeafId);
            const helperLeaf = this.app.workspace.getLeafById(helperLeafId);

            if (originalLeaf) {
                if (helperLeaf) {
                    this.hideHelperLeaf(helperLeaf);
                } else {
                    this.helperLeafIds.delete(originalLeafId);
                    this.openHelperForLeaf(originalLeaf);
                }
            } else {
                helperLeaf?.detach();
                this.helperLeafIds.delete(originalLeafId);
            }
        });
    }

    detachAllHelperLeaves() {
        this.helperLeafIds.forEach((helperLeafId) => {
            this.app.workspace.getLeafById(helperLeafId)?.detach();
        });
        this.helperLeafIds.clear();
    }

    updateHelpers = throttle(() => {
        this.app.workspace
            .getLeavesOfType("markdown")
            .filter((leaf) => !this.isHelperLeaf(leaf))
            .forEach((leaf) => {
                this.updateHelperForLeaf(leaf);
            });
        this.updateElementMinimap();
    }, 500);

    async updateHelperForLeaf(leaf: any) {
        const helperLeaf = this.app.workspace.getLeafById(
            this.helperLeafIds.get(leaf?.id)
        );
        if (!helperLeaf) return;

        const oldState = helperLeaf.view.getState();
        const newState = leaf.view.getState();
        await helperLeaf.setViewState({
            type: "markdown",
            state: newState,
        });
        this.hideHelperLeaf(helperLeaf);
        if (oldState.file !== newState.file)
            await this.initialForceloadContentInMarkdownView(helperLeaf.view);
    }

    async initialForceloadContentInMarkdownView(view: any) {
        if (view?.getViewType() !== "markdown") return;
        view.contentEl
            .querySelectorAll(".markdown-preview-sizer, .cm-sizer")
            .forEach((el) => {
                el.style.cssText = "transform-origin: top right; scale: .1;";
            });
        const data = await view.getViewData();
        await view.clear();
        // Give Obsidian a frame to clear and remount the helper view before
        // writing the content back, which forces a full long-note render.
        await sleep(100);
        await view.setViewData(data);
    }
}

class Minimap {
    plugin: NoteMinimap;
    element: HTMLElement;
    helperLeafId: string | undefined;
    helperElement: HTMLElement | undefined;
    sourceView: HTMLElement;
    scroller: HTMLElement;
    container: HTMLDivElement;
    iframe: HTMLIFrameElement;
    slider: HTMLDivElement;
    hitbox: HTMLDivElement;
    viewContent: HTMLElement | undefined;
    scale = 0.1;
    minimapOpacity = 0.3;
    sliderOpacity = 0.3;
    topOffset = 0;
    bottomOffset = 0;
    scrollbarGutter = 14;
    minViewportHeight = 24;
    centerOnClick = true;
    backgroundColor = "";
    fullHeight = 0;
    visibleHeight = 0;
    minimapHeight = 0;
    renderVersion = 0;
    isDragging = false;

    constructor(
        plugin: NoteMinimap,
        element: HTMLElement,
        settings: MarkdownMinimapSettings,
        helperLeafId?: string
    ) {
        this.plugin = plugin;
        this.element = element;
        this.setHelperLeafId(helperLeafId);
        this.sourceView = element.querySelector(".markdown-source-view") as HTMLElement;
        this.modeChange();
        this.updateSliderScroll = this.updateSliderScroll.bind(this);
        this.onMinimapMouseDown = this.onMinimapMouseDown.bind(this);

        this.setupElements();
        this.updateSettings(settings);

        // Register events - need to remove on destroy!
        this.scroller.addEventListener("scroll", this.updateSliderScroll);
        this.hitbox.addEventListener("mousedown", this.onMinimapMouseDown);
    }
    setHelperLeafId(helperLeafId?: string) {
        this.helperLeafId = helperLeafId;
        this.helperElement =
            (helperLeafId
                ? (this.plugin.app.workspace.getLeafById(helperLeafId)?.view as any)
                      ?.contentEl
                : undefined);
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

        const viewContent = document.querySelector(".view-content");
        this.backgroundColor = viewContent
            ? toRGBAAlpha(
                  (viewContent as any).getCssPropertyValue("background-color"),
                  this.minimapOpacity
              )
            : "transparent";

        if (this.iframe && this.slider) {
            this.updateSettingsInCSS();
            this.onResize();
            this.updateIframe();
            this.updateSliderScroll();
        }
    }

    updateSettingsInCSS() {
        if (this.container)
            this.container.style.setProperty("--scale", String(this.scale));
        if (this.container) {
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
        if (this.iframe) this.iframe.style.setProperty("--scale", String(this.scale));
        if (this.slider) this.slider.style.setProperty("--scale", String(this.scale));
        if (this.hitbox) this.hitbox.style.setProperty("--scale", String(this.scale));
        if (this.slider) this.slider.style.opacity = String(this.sliderOpacity);
    }

    destroy() {
        this.scroller.removeEventListener("scroll", this.updateSliderScroll);
        this.hitbox.removeEventListener("mousedown", this.onMinimapMouseDown);
        document.removeEventListener("mousemove", this.onSliderMouseMove);
        document.removeEventListener("mouseup", this.onSliderMouseUp);

        if (this.iframe) {
            this.iframe.onload = null;
        }
        this.container.remove();

        this.container = null;
        this.iframe = null;
        this.slider = null;
        this.hitbox = null;
    }

    isReadModeActive() {
        return this.sourceView.clientHeight === 0;
    }

    modeChange() {
        this.changeScroller(
            this.element.querySelector(
                this.isReadModeActive()
                    ? ".markdown-preview-view"
                    : ".cm-scroller"
            )
        );
    }
    changeScroller(newScroller) {
        if (this.scroller) {
            this.scroller.removeEventListener(
                "scroll",
                this.updateSliderScroll
            );
        }
        this.scroller = newScroller;
        if (this.scroller) {
            this.scroller.addEventListener("scroll", this.updateSliderScroll);
            this.onResize();
        }
    }

    async onResize() {
        // Wait for Obsidian's editor layout pass before measuring scroll
        // dimensions; immediate reads can be stale after mode or pane changes.
        await sleep(300);

        this.resize(this.scroller.scrollHeight, this.scroller.clientHeight);
    }
    resize(fullHeight, visibleHeight) {
        this.fullHeight = Math.max(fullHeight || 0, visibleHeight || 0);
        this.visibleHeight = visibleHeight || 0;
        this.minimapHeight = this.container?.clientHeight || visibleHeight || 0;
        this.iframe.style.height = `${fullHeight}px`;
        this.updateSliderScroll();
    }

    setupElements() {
        this.element
            .querySelectorAll(
                ".minimap-container, .minimap-frame, .minimap-slider, .minimap-hitbox"
            )
            .forEach((e) => e.remove());

        const container = document.createElement("div");
        container.className = "minimap-container";
        this.container = container;
        this.element.prepend(container);

        this.iframe = document.createElement("iframe");
        this.iframe.className = "minimap-frame";
        container.appendChild(this.iframe);

        this.slider = document.createElement("div");
        this.slider.className = "minimap-slider";
        container.appendChild(this.slider);

        this.hitbox = document.createElement("div");
        this.hitbox.className = "minimap-hitbox";
        container.appendChild(this.hitbox);
    }

    async updateIframe(noteContent?: HTMLElement) {
        const renderVersion = (this.renderVersion || 0) + 1;
        this.renderVersion = renderVersion;

        if (!noteContent) noteContent = await this.getFullHTML();
        if (renderVersion !== this.renderVersion) return;

        noteContent
            .querySelectorAll(".minimap-frame, .minimap-slider")
            .forEach((el) => el.remove());

        // Clone styles
        const styleElements = Array.from(
            document.head.querySelectorAll('style, link[rel="stylesheet"]')
        );
        const stylesHTML = styleElements.map((el) => el.outerHTML).join("\n");

        const themeClass = document.body.classList.contains("theme-dark")
            ? "theme-dark"
            : "theme-light";

        const rootStyles = getComputedStyle(document.body);
        let cssVars = ":root {\n";
        for (let i = 0; i < rootStyles.length; i++) {
            const prop = rootStyles[i];
            if (prop.startsWith("--")) {
                const value = rootStyles.getPropertyValue(prop);
                cssVars += `  ${prop}: ${value};\n`;
            }
        }
        cssVars += "}";
        // Remove scrollbar inside minimap
        cssVars += "::-webkit-scrollbar {display: none;}";

        const html = `
		<!DOCTYPE html>
		<html>
		<head>${stylesHTML}<style>${cssVars}</style></head>
		<body style="background-color:${this.backgroundColor}" class="${themeClass} ${
            this.isReadModeActive() ? "" : "markdown-preview-view"
        } show-inline-title">${noteContent.innerHTML}</body>
		</html>
	`;

        if (this.iframe) {
            this.iframe.onload = () => {
                if (renderVersion !== this.renderVersion) return;
                if (!this.container) return;
                this.onResize();
            };
            this.iframe.srcdoc = html;
        }
        this.onResize();
    }

    updateSliderScroll() {
        if (!this.scroller) return;
        const metrics = this.getScrollMetrics();
        const minimapViewportTop =
            metrics.scrollTop * this.scale - metrics.minimapScrollOffset;
        const sliderTop =
            (this.topOffset || 0) +
            Math.max(
                0,
                Math.min(
                    minimapViewportTop,
                    Math.max(0, metrics.activeHeight - metrics.sliderHeight)
                )
            );

        this.iframe.style.top = `${
            (this.topOffset || 0) - metrics.minimapScrollOffset
        }px`;
        this.slider.style.top = `${sliderTop}px`;
        this.slider.style.height = `${metrics.sliderHeight}px`;
        this.hitbox.style.height = `${metrics.activeHeight}px`;
    }

    getScrollMetrics() {
        const scrollHeight = Math.max(
            this.scroller.scrollHeight,
            this.fullHeight || 0,
            this.scroller.clientHeight
        );
        const clientHeight = Math.max(this.scroller.clientHeight, 1);
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
        const scaledDocumentHeight = Math.max(1, scrollHeight * this.scale);
        const rawActiveHeight = Math.min(availableHeight, scaledDocumentHeight);
        const sliderHeight = Math.max(
            this.minViewportHeight || 24,
            Math.min(rawActiveHeight, clientHeight * this.scale)
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
            maxMinimapScroll,
            scrollRatio,
            minimapScrollOffset,
            sliderHeight,
        };
    }

    async getFullHTML() {
        if (this.isReadModeActive()) {
            return await renderReadMode(this.plugin, this.element);
        }
        return await renderEditMode(this.helperElement, this.scroller);
    }

    onMinimapMouseDown(e) {
        e.preventDefault();
        this.isDragging = true;
        this.slider.classList.add("dragging");

        this.scrollToMinimapClientY(e.clientY, this.centerOnClick);

        document.addEventListener("mousemove", this.onSliderMouseMove);
        document.addEventListener("mouseup", this.onSliderMouseUp);
    }

    onSliderMouseMove = (e) => {
        if (!this.isDragging) return;
        this.scrollToMinimapClientY(e.clientY, this.centerOnClick);
    };

    scrollToMinimapClientY(clientY, centerViewport = false) {
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
        const targetY = centerViewport
            ? localY - metrics.sliderHeight / 2
            : localY;
        const scrollRatio = Math.max(
            0,
            Math.min(
                targetY / Math.max(1, metrics.activeHeight - metrics.sliderHeight),
                1
            )
        );
        const scrollTop = Math.max(
            0,
            Math.min(scrollRatio * metrics.maxScroll, metrics.maxScroll)
        );

        this.scroller.scrollTop = scrollTop;
        this.updateSliderScroll();
    }

    onSliderMouseUp = () => {
        this.isDragging = false;
        this.slider.classList.remove("dragging");
        document.removeEventListener("mousemove", this.onSliderMouseMove);
        document.removeEventListener("mouseup", this.onSliderMouseUp);
    };
}

export default NoteMinimap;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type ThrottleOptions = {
    leading?: boolean;
    trailing?: boolean;
};

function throttle<TArgs extends unknown[], TThis>(
    fn: (this: TThis, ...args: TArgs) => void,
    limit: number,
    options: ThrottleOptions = { leading: false, trailing: true }
) {
    let inThrottle = false;
    let lastArgs: TArgs | null = null;
    let lastThis: TThis | null = null;

    const invoke = () => {
        if (lastArgs) {
            const args = lastArgs;
            const context = lastThis as TThis;
            lastArgs = null;
            lastThis = null;
            fn.apply(context, args);
            setTimeout(invoke, limit);
        } else {
            inThrottle = false;
        }
    };

    return function (this: TThis, ...args: TArgs) {
        if (!inThrottle) {
            if (options.leading) {
                fn.apply(this, args);
            } else {
                lastArgs = args;
                lastThis = this;
            }
            inThrottle = true;
            setTimeout(invoke, limit);
        } else if (options.trailing) {
            lastArgs = args;
            lastThis = this;
        }
    };
}

function toRGBAAlpha(color: string, alpha: number): string {
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
        if (nums.length >= 3) {
            return `rgba(${nums[0]},${nums[1]},${nums[2]},${alpha})`;
        }
    }
    // fallback
    return color;
}

async function renderReadMode(
    plugin: NoteMinimap,
    structureNode: HTMLElement
): Promise<HTMLElement> {
    const structure = structureNode.cloneNode(true) as HTMLElement;
    structure
        .querySelectorAll(".view-content > :not(.markdown-reading-view)")
        .forEach((e) => e.remove());
    const destination = structure.querySelector(
        ".markdown-preview-sizer"
    ) as HTMLElement;
    const titleElement = destination
        .querySelector(".mod-header")
        ?.cloneNode(true);
    destination.innerHTML = "";
    await MarkdownRenderer.render(
        plugin.app,
        await plugin.app.workspace
            .getActiveFile()
            .vault.read(plugin.app.workspace.getActiveFile()),
        destination,
        plugin.app.workspace.getActiveFile().path,
        plugin
    );
    if (titleElement)
        destination.insertBefore(titleElement, destination.firstChild);
    return structure;
}

async function renderEditMode(
    helperElement: HTMLElement | undefined,
    scroller: HTMLElement
): Promise<HTMLElement> {
    let noteContent: HTMLElement;
    if (helperElement) {
        noteContent = helperElement.cloneNode(true) as HTMLElement;
    } else {
        const sizer = scroller.firstElementChild as HTMLElement;
        const element = scroller.parentElement.parentElement.parentElement;

        sizer.style.cssText = "transform-origin: top right; scale: .1;";
        element.offsetWidth;
        // Let the browser apply the temporary scale before cloning the
        // CodeMirror DOM; this helps materialize virtualized long content.
        await sleep(10);

        noteContent = element.cloneNode(true) as HTMLElement;
        sizer.style.cssText = "";
    }

    noteContent
        .querySelectorAll<HTMLElement>(".cm-sizer")
        .forEach((e) => (e.style.cssText = ""));

    // Remove other content (fix for trouble with Editing Toolbar Plugin)
    noteContent
        .querySelectorAll(".markdown-source-view > :not(.cm-editor)")
        .forEach((e) => e.remove());

    return noteContent;
}
