# Custom HTML Syntax Highlighter

A WordPress plugin that adds full **CodeMirror syntax highlighting** to the built-in Custom HTML block — using WordPress's own bundled CodeMirror. No CDN, no extra downloads, no external dependencies.

![Comparison of the plain Core Output editor vs the plugin's syntax-highlighted editor with optional dark mode toggle](assets/screenshot.png)

---

## Features

- **Syntax highlighting** for HTML, CSS, and JavaScript inside every Custom HTML block
- **Line numbers** and a **fold gutter** for collapsing tags, braces, and comment blocks
- **Dark mode toggle** in the block toolbar — preference is saved to `localStorage` and synced across open tabs
- **Pop-out / expand mode** — promotes the editor into a full canvas overlay so long documents are easy to read and edit; press **Esc** or click the close button to collapse
- **Auto-closing brackets** and smart Tab / Shift-Tab indentation
- Block title displayed in the pop-out header (updates live when you rename the block via the inspector)
- Zero external dependencies — uses the `wp-codemirror` bundle already shipped with WordPress

---

## Requirements

| Requirement | Minimum |
|---|---|
| WordPress | 6.0 |
| PHP | 7.4 |

---

## Installation

1. Upload the `wp-custom-html-syntax` folder to `wp-content/plugins/`.
2. Activate **Custom HTML Syntax Highlighter** from the *Plugins* screen.
3. Open any post or page in the block editor, add or select a **Custom HTML** block, and the syntax-highlighted editor appears automatically.

No configuration is required.

---

## Usage

### Toolbar buttons

Two buttons are added to the Custom HTML block toolbar:

| Button | Action |
|---|---|
| Expand icon | Expand the editor into a full-canvas overlay |
| Moon icon | Toggle dark mode on/off |

Both states persist independently — dark mode across all Custom HTML blocks in the browser, and expand per-block.

### Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Tab` | Indent (or indent selection) |
| `Shift + Tab` | De-indent selection |
| `Ctrl + Q` / `Cmd + Q` | Fold / unfold code at cursor |
| `Esc` | Collapse the pop-out editor |

---

## How it works

The plugin hooks into `enqueue_block_editor_assets` to load a small JS + CSS bundle alongside WordPress's existing `code-editor` package (which already includes `wp-codemirror`). A `MutationObserver` watches for Custom HTML block textareas — both the current inline-textarea layout and the forward-compatible modal layout — and calls `wp.codeEditor.initialize()` on each one. A higher-order component registered via the `editor.BlockEdit` filter injects the dark mode and expand toolbar buttons.

Because everything is sourced from WordPress core's own asset bundle, the plugin adds less than **10 KB** of its own JavaScript and CSS.

---

## Files

```
custom-html-syntax.php   — Plugin bootstrap; enqueues assets and localises settings
editor.js                — CodeMirror initialisation, dark mode, pop-out logic, toolbar HOC
editor.css               — CodeMirror sizing, fold gutter styles, dark theme, pop-out overlay
```

---

## License

License to Kill
