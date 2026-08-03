import { Plugin, MarkdownView, TFile, debounce } from "obsidian";
import { Minimap } from "./minimap";
import {
    MinimapSettingTab,
    getDefaultSettings,
    isSettingsObject,
} from "./settings";
import type { MarkdownMinimapSettings } from "./settings";
import { sleep, throttle } from "./utils";

export default class NoteMinimap extends Plugin {
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
                for (const el of this.minimapInstances.keys()) {
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
            getDefaultSettings(),
            isSettingsObject(savedSettings)
        );
    }

    async resetSettings() {
        this.settings = getDefaultSettings();
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
            !element.querySelector(
                ".markdown-reading-view .markdown-preview-view"
            )
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
