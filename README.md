# 🗺️ Markdown Minimap — A Minimap View for Markdown Notes

Markdown Minimap adds a minimap panel inside your Obsidian editor pane, giving you a scaled-down visual overview of the entire note. Inspired by modern code editors, this plugin helps you **navigate long Markdown files faster** and with more spatial awareness.

## ✨ Features

- 🔎 **Live minimap view** of the current note - supports all view modes
- 🖱️ **Draggable viewport slider** to scroll instantly
- 🌓 Supports all themes
- 💠 Automatically updates on scroll and content change
- 🔁 Per-note toggle button in the note header
- 📏 Resizes automatically with the pane

## 📸 Screenshot

![Screenshot of Obsidian with active minimaps.](/screenshot.png)

## 🚀 Getting Started

### 📦 Installation

You can install Markdown Minimap in **three** ways:
#### 1. From the Community Plugins Browser (Recommended!)

- Open Obsidian
- Go to `Settings` → `Community Plugins`
- Disable Restricted Mode
- Click `Browse` and search for `Markdown Minimap`
- Click `Install` and then `Enable`
#### 2. Manual Installation

- Download the latest release from [GitHub Releases](https://github.com/Nymbo/Markdown-Minimap/releases)
- Extract into your Obsidian `.obsidian/plugins/markdown-minimap` folder
- Make sure the folder includes:
  - `main.js`
  - `manifest.json`
  - `styles.css` (optional)
#### 3. Clone Directly (For Developers)

```bash

git clone https://github.com/Nymbo/Markdown-Minimap .obsidian/plugins/markdown-minimap

```

## 🧪 Usage

1. Install & enable the plugin.
2. Open any markdown note.
3. A minimap will appear on the right edge of the editor.
4. Scroll & write in the editor — the minimap updates live.
5. Drag the slider in the minimap to jump to different parts of the note.
6. Click the `Toggle Minimap` button in the upper-right corner of the pane to choose whether to show minimap.

## ⚙️ Settings 

- Adjustable minimap scale
- Enable minimap by default
- Opacity (separate for minimap and slider)
- Top and bottom offsets (for custom toolbars, status bars, or bottom chrome)
- Scrollbar gap
- Minimum viewport highlight height
- Center-on-click behavior

## 📌 Limitations

- Uses workaround to render long notes because of Obsidian's lazy loading  

## Development

Markdown Minimap is built from TypeScript source in `src/main.ts`.

```bash
npm install
npm run build
```

Use `npm run dev` to watch and rebuild `main.js` during local development.

## 💡 Ideas and Contributions

Contributions, bug reports, and feature requests are welcome!  
Feel free to open an [issue](https://github.com/Nymbo/Markdown-Minimap/issues) or submit a pull request.

## Credits

Markdown Minimap is initially based on [YairSegel/ObsidianMinimap](https://github.com/YairSegel/ObsidianMinimap), distributed under the MIT License.
