import { PluginSettingTab, Setting } from "obsidian";
import type NoteMinimap from "./main";

export interface MarkdownMinimapSettings {
    enabledByDefault: boolean;
    scale: number;
    minimapOpacity: number;
    sliderOpacity: number;
    topOffset: number;
    bottomOffset: number;
    scrollbarGutter: number;
    minViewportHeight: number;
    reserveSpace: boolean;
    centerOnClick: boolean;
}

export function getDefaultSettings(this: void): MarkdownMinimapSettings {
    return {
        enabledByDefault: true,
        scale: 0.1,
        minimapOpacity: 0.3,
        sliderOpacity: 0.3,
        topOffset: 0,
        bottomOffset: 0,
        scrollbarGutter: 14,
        minViewportHeight: 24,
        // On by default: the minimap draws over the note, so letting the text
        // run underneath it is the wrong thing to do unasked.
        reserveSpace: true,
        centerOnClick: true,
    };
}

export function isSettingsObject(
    this: void,
    value: unknown
): Partial<MarkdownMinimapSettings> {
    return value && typeof value === "object"
        ? (value as Partial<MarkdownMinimapSettings>)
        : {};
}

export class MinimapSettingTab extends PluginSettingTab {
    plugin: NoteMinimap;

    constructor(plugin: NoteMinimap) {
        super(plugin.app, plugin);
        this.plugin = plugin;
    }

    private addSlider(
        name: string,
        desc: string,
        key: {
            [K in keyof MarkdownMinimapSettings]: MarkdownMinimapSettings[K] extends number
                ? K
                : never;
        }[keyof MarkdownMinimapSettings],
        limits: [number, number, number]
    ) {
        new Setting(this.containerEl)
            .setName(name)
            .setDesc(desc)
            .addSlider((slider) => {
                slider
                    .setLimits(limits[0], limits[1], limits[2])
                    .setValue(this.plugin.settings[key])
                    .setDynamicTooltip()
                    .onChange((value) => {
                        this.plugin.settings[key] = value;
                        void this.plugin.saveSettings();
                    });
            });
    }

    private addToggle(
        name: string,
        desc: string,
        key: {
            [K in keyof MarkdownMinimapSettings]: MarkdownMinimapSettings[K] extends boolean
                ? K
                : never;
        }[keyof MarkdownMinimapSettings]
    ) {
        new Setting(this.containerEl)
            .setName(name)
            .setDesc(desc)
            .addToggle((toggle) => {
                toggle
                    .setValue(this.plugin.settings[key])
                    .onChange((value) => {
                        this.plugin.settings[key] = value;
                        void this.plugin.saveSettings();
                    });
            });
    }

    display() {
        const { containerEl } = this;
        containerEl.empty();

        this.addToggle(
            "Enable by default",
            "Already opened notes will not be affected by changing this",
            "enabledByDefault"
        );
        this.addSlider(
            "Scale",
            "Change the minimap scale (0.05 - 0.3)",
            "scale",
            [0.05, 0.3, 0.01]
        );
        this.addSlider(
            "Opacity",
            "Change the minimap's background opacity (0.05 - 1)",
            "minimapOpacity",
            [0.05, 1, 0.01]
        );
        this.addSlider(
            "Slider opacity",
            "Slider opacity while hovering the minimap (0.05 - 1) - it fades when idle and strengthens while dragging",
            "sliderOpacity",
            [0.05, 1, 0.01]
        );
        this.addSlider(
            "Top offset",
            "Offset the minimap from the top (pixels) - for special plugin toolbars",
            "topOffset",
            [0, 100, 1]
        );
        this.addSlider(
            "Bottom offset",
            "Offset the minimap from the bottom (pixels) - for status bars or bottom chrome",
            "bottomOffset",
            [0, 100, 1]
        );
        this.addSlider(
            "Scrollbar gap",
            "Distance between the minimap and the regular editor scrollbar (pixels)",
            "scrollbarGutter",
            [0, 32, 1]
        );
        this.addSlider(
            "Minimum viewport height",
            "Minimum height for the visible viewport highlight (pixels)",
            "minViewportHeight",
            [8, 80, 1]
        );
        this.addToggle(
            "Make room for the minimap",
            "Move the note's text so the space either side of it stays even once the minimap has taken its strip. Uses the file margin as well as the readable line length margin, and never moves the text past the pane's left edge",
            "reserveSpace"
        );
        this.addToggle(
            "Center on click",
            "Center the editor viewport on the clicked position. Applies to clicks on the minimap, not to dragging the viewport marker",
            "centerOnClick"
        );

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
