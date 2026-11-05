# Themes

A theme colours the open panel: its background, text, menus, accents and the warning and critical colours. Pick one under **Settings › Themes**. The closed notch stays black in every theme, so it still blends into the screen edge; a theme can opt in to colour it too.

Built in: Dark (the default), Light, One Dark Pro, GitHub Dark, GitHub Light, Dracula, Night Owl, Catppuccin Mocha, Catppuccin Latte, Nord, Rosé Pine, Rosé Pine Dawn, Gruvbox Dark, Solarized Light and Everforest. All but the first two use the colours of their original palettes under the MIT License, with the few that missed a contrast minimum moved just far enough to pass; the notices are in [`licenses/theme-palettes-MIT.txt`](../licenses/theme-palettes-MIT.txt).

## Changing colours

**Settings › Themes › Colours › Edit** starts from the current theme. Background, foreground, accent, warning and critical each open a colour picker (a square for saturation and brightness, a hue strip, a hex field, arrow keys work on both). Every change shows at once on the whole panel. A new background or foreground also brings new secondary text, tertiary text and menu colours; a background that turns a dark theme light brings a dark foreground if the old one would not read.

**Undo** steps back (a drag across the square is one step), **Discard** drops every change. **Save as new** keeps the changes as a theme of your own; **Overwrite** writes them into the custom theme you started from. Unsaved changes are kept while NotNotch runs.

## Day and night

**Switch by time of day** picks one theme for the day and one for the night, with the start of each in half hours. A day may run past midnight (20:00 to 08:00). While it is on, choosing a theme card changes the theme of the period you are in.

## Windows high contrast

With a Windows contrast theme on, NotNotch uses the system colours whatever theme is chosen: window text on the window colour, gray text for quiet text, the highlight colour for accents. The theme comes back when contrast is turned off.

## Theme files

A theme is a JSON file. **Export** writes the theme on screen (the unsaved colours too, while editing) to `%APPDATA%\io.github.latiefahmad.notnotch\themes\<id>.json`. **Import** reads every `.json` file in that folder (**Open folder** opens it, at most 100 files are read) and adds the valid ones to your themes. It never replaces a theme: a file equal to one you have is skipped, and a different file with the id of one of yours comes in beside it as `<id>-2`, so an old export cannot undo later edits. An export of a built-in theme is skipped; a file that reuses a built-in id with other colours is refused. Each file that cannot be used is listed with the reason.

```json
{
  "format": 1,
  "id": "midnight-teal",
  "name": "Midnight teal",
  "colors": {
    "background": "#04161a",
    "foreground": "#e6f4f1",
    "accent": "#2dd4bf",
    "warning": "#f5b94a",
    "critical": "#ff6b6b"
  },
  "closedNotch": "black"
}
```

| Key | Use | Minimum contrast |
| --- | --- | --- |
| `background` | The open panel; always drawn opaque | |
| `foreground` | Titles and main text | 7:1 on the background and menus |
| `secondary` | Labels | 4.5:1 |
| `tertiary` | Hints and small notes | 2.8:1 (Dark's own is 2.9:1) |
| `accent` | Focus, and the music colour when nothing plays | 3:1 |
| `link` | Links and badges; follows `accent` when left out | 3:1 |
| `warning` | Warnings, also as text | 4.5:1 |
| `critical` | Errors and critical levels, also as text | 4.5:1 |
| `success` | Switches and checks | 3:1 |
| `elevated` | Menus and pop-ups | |

Every colour is optional; what a file leaves out follows from the background (dark or light) and the foreground. Colours are `#rgb`, `#rrggbb`, `#rrggbbaa` (alpha last, as in CSS) or `rgb(r g b / a)`. `closedNotch` is `"black"` (the default) or `"background"`. `id` (letters, digits, `-`, `_`, `.`) is made from `name` when left out. `description`, `author`, `license` and `homepage` are kept; other fields are ignored. The file is plain JSON (no comments) and at most 64 KB. An unknown colour key, a value that is not a colour, or a newer `format` makes the file unusable.

## Readability

A theme decides how the panel looks, never whether it can be read. Each colour is checked against the backgrounds it is drawn on (the panel, the menus and the button fills). One that misses its minimum is made lighter or darker along its own hue, whichever needs the smaller change, just far enough to pass; a colour that passes is used as written. The editor lists every change it made. The colour taken from the album cover gets the same check against the panel's background, so it stays visible on a light theme. Every built-in theme passes as written.
