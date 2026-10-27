import { PluginSettingTab, Setting } from "obsidian";
import type NoteMinimap from "./main";

export interface MarkdownMinimapSettings {
    enabledByDefault: boolean;
    scale: number;
    minimapOpacity: number;
    sliderOpacity: number;
    sliderIdleOpacity: number;
    topOffset: number;
    bottomOffset: number;
    scrollbarGutter: number;
    minViewportHeight: number;
    reserveSpace: boolean;
    centerOnClick: boolean;
    /** Which of the migrations below the saved settings have been through. */
    settingsVersion: number;
}

/**
 * Bumped whenever a saved setting changes meaning. Settings saved before the
 * field existed read as version 0.
 */
const SETTINGS_VERSION = 1;

export function getDefaultSettings(this: void): MarkdownMinimapSettings {
    return {
        enabledByDefault: true,
        scale: 0.1,
        // The panel fades as a whole, so this is how solid it looks rather than
        // how much of the note shows through its background. Three tenths was
        // chosen when only the background faded and the map stayed solid; at
        // three tenths of the whole panel the minimap is nearly a ghost.
        minimapOpacity: 0.7,
        sliderOpacity: 0.3,
        // The idle state used to be derived as three tenths of the hover one;
        // this is that same value, so the default look is unchanged.
        sliderIdleOpacity: 0.09,
        topOffset: 0,
        bottomOffset: 0,
        scrollbarGutter: 14,
        minViewportHeight: 24,
        // On by default: the minimap draws over the note, so letting the text
        // run underneath it is the wrong thing to do unasked.
        reserveSpace: true,
        centerOnClick: true,
        settingsVersion: SETTINGS_VERSION,
    };
}

/**
 * Brings settings saved by an older version up to date, or returns null when
 * there is nothing to change.
 *
 * Saving writes every setting, not just the ones changed, so a new default
 * never reaches anyone who has saved once: it has to be carried over here.
 */
export function migrateSettings(
    this: void,
    saved: Partial<MarkdownMinimapSettings>
): Partial<MarkdownMinimapSettings> | null {
    if ((saved.settingsVersion ?? 0) >= SETTINGS_VERSION) return null;
    const migrated = { ...saved, settingsVersion: SETTINGS_VERSION };
    // Version 1: Opacity fades the whole panel rather than only its
    // background. The old value faded a background drawn over its own colour,
    // so it changed nothing on screen; read as the new opacity, the old default
    // of 0.3 is close to invisible. Raised to the new default, which is meant
    // to look like the old one did.
    if (
        typeof saved.minimapOpacity === "number" &&
        saved.minimapOpacity < 0.7
    )
        migrated.minimapOpacity = 0.7;
    return migrated;
}

export function isSettingsObject(
    this: void,
    value: unknown
): Partial<MarkdownMinimapSettings> {
    return value && typeof value === "object" ? value : {};
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

        // Kept out of the settings object on purpose: that file syncs with the
        // vault, and this answer is meant to differ from one device to the next.
        new Setting(containerEl)
            .setName("Disable on this device")
            .setDesc(
                "Hide the minimap on this device only. Stored locally, so it does not sync to your other devices"
            )
            .addToggle((toggle) => {
                toggle
                    .setValue(this.plugin.deviceDisabled)
                    .onChange((value) => {
                        this.plugin.setDeviceDisabled(value);
                    });
            });

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
            "Change the minimap's opacity (0.05 - 1) - 0.05 leaves a barely visible ghost, 1 is solid",
            "minimapOpacity",
            [0.05, 1, 0.01]
        );
        this.addSlider(
            "Slider opacity",
            "Slider opacity while hovering the minimap (0.05 - 1) - it strengthens further while dragging",
            "sliderOpacity",
            [0.05, 1, 0.01]
        );
        this.addSlider(
            "Idle slider opacity",
            "Slider opacity while the pointer is elsewhere (0 - 1) - set it to 0 to hide the slider until you hover",
            "sliderIdleOpacity",
            [0, 1, 0.01]
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
