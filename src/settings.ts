import { PluginSettingTab, Setting } from "obsidian";
import type NoteMinimap from "./main";

export interface MarkdownMinimapSettings {
    enabledByDefault: boolean;
    scale: number;
    minimapOpacity: number;
    panelTint: boolean;
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
const SETTINGS_VERSION = 2;

export function getDefaultSettings(this: void): MarkdownMinimapSettings {
    return {
        enabledByDefault: true,
        scale: 0.1,
        // The panel fades as a whole, so anything below 1 washes out the map's
        // own text too. Solid by default, which is how it looked before the
        // setting faded the whole panel; the fade is there for those who want it.
        minimapOpacity: 1,
        // Off by default for the same reason: the grey wash fogs the map over.
        panelTint: false,
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
    const version = saved.settingsVersion ?? 0;
    // Version 1: Opacity fades the whole panel rather than only its
    // background. The old value faded a background drawn over its own colour,
    // so it changed nothing on screen: what those users saw was a solid panel.
    if (version < 1) migrated.minimapOpacity = 1;
    // Version 2: solid became the default again. Version 1 raised everyone to
    // 0.7, the default then, so 0.7 is almost always that rather than a choice.
    else if (version < 2 && saved.minimapOpacity === 0.7)
        migrated.minimapOpacity = 1;
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
            "Change the minimap's opacity (0.05 - 1) - 1 is solid, lower values fade the whole minimap so the note shows through",
            "minimapOpacity",
            [0.05, 1, 0.01]
        );
        this.addToggle(
            "Tint the minimap",
            "Give the minimap a light wash of the theme's text colour, so it stands apart from the note. Off, it takes the note's own background",
            "panelTint"
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
