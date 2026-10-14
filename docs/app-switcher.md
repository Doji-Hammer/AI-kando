<!--
SPDX-FileCopyrightText: Simon Schneegans <code@simonschneegans.de>
SPDX-License-Identifier: CC-BY-4.0
-->

# Smart App-Launcher Switcher (macOS)

On macOS, Kando turns menu items that launch applications into smart application switchers. When the pie menu is shown, Kando inspects running applications and adapts app items dynamically without modifying your saved configuration.

## What App Items Do

- **Running Indicators**: Items for running applications display a small running dot on their icon.
- **Single-Window Applications**: Selecting the item brings the application and its open window to the front instead of launching a redundant instance.
- **Multi-Window Applications**: When an application has two or more open windows, the item expands into a submenu displaying each window by title (or `<App> (window N)` if untitled). Selecting a window raises and focuses that specific window.
- **Non-Running Applications**: Unmodified selection launches the application as usual.

## Modifier Key Actions

Holding modifier keys while selecting an application or window performs native control operations:

| Modifier | Running Application | Non-Running Application |
| :--- | :--- | :--- |
| **None** | Focuses and raises application / window | Launches application |
| <kbd>Control</kbd> (⌃) | Quits the application | No-op (never launches) |
| <kbd>Command</kbd> (⌘) | Closes the selected window | No-op (never launches) |
| <kbd>Option</kbd> (⌥) | Closes the active tab in the window (if 2+ tabs; disabled by default) | No-op (never launches) |
| <kbd>Command</kbd> + <kbd>Option</kbd> (⌘⌥) | Hides the application | No-op (never launches) |
| **Any other combination** | No-op | No-op (never launches) |

*Note: Selecting a non-running application while holding any modifier key will never launch the application.*

### Which gestures can carry modifiers

Modifiers only count for two deliberate gestures:

- A **plain primary-button mouse click** made while the menu is shown: the pointer must stay strictly below the drag threshold between press and release (reaching or exceeding it at any point, even if the pointer returns, removes modifier eligibility for that press), and the press must have happened in the current menu. A button that is still held when a menu is replaced, a right-click or back-button gesture, touch and pen input never carry modifiers.
- **Enter** pressed in the current menu (modifiers are taken when the key goes down; key auto-repeat is ignored).

Marking mode, turbo mode, hover selection, gestures, quick-select keys and gamepads always select without modifiers.

Whether a Control-click arrives from macOS as a primary click or as a secondary click in the Electron version Kando uses has not been confirmed yet. Until it is, a Control-click that arrives as a secondary click behaves like a normal right-click (back) and does not quit the application. The pointer event sequences can be recorded by setting `localStorage['kando-debug-pointer']` in the menu window.

## Recognition Rules

An item is recognized as an application launcher if it satisfies strict literal grammar:
- The item type is `button`.
- Its selection workflow contains **exactly one** `execute-command` action.
- The command matches `open -a "<App Name>"` or `open -a <AppName>`.
- Any trailing `.app` extension is stripped case-insensitively.
- The command must not contain path separators (`/`), shell expansions (`$`, backticks), shell operators (`;`, `|`, `&`), placeholders (`{{...}}`), or extra arguments (`-n`, `--args`).
- All other actions in the workflow must be in the allowlist: `close-menu`, `delay`, `inhibit-shortcuts`.

## System Permissions

- **Accessibility**: Required for enumerating application windows and closing windows. If Accessibility permissions are not granted, Kando still detects running status, but window enumeration and window-specific modifiers will be disabled.
- **Event Posting**: Required for closing tabs via simulated key events (`Cmd+W`). Event posting needs the macOS "event posting" access that Kando checks with `CGPreflightPostEventAccess`.

## Ordering and Themes

- **Menu Closes Before the Native Operation**: For app items the menu always closes *before* Kando performs a native operation on the application or window, even if the stored workflow had its `close-menu` action after the launch action. When an app selection is superseded by a newer menu, its remaining workflow actions are skipped and only registered finalizers still run; otherwise remaining actions of the workflow, including a later `close-menu` and `inhibit-shortcuts` finalizers, still run in their configured order.
- **Purity Theme**: The Purity theme intentionally hides the running dot on the *active* (center) item. Its icon layer collapses to 0x0 pixels, so a dot anchored to it would be invisible or misplaced. The dot is still shown for child, parent and grandchild items. The Default theme shows it in every state.

## Limitations

- **macOS Only**: On Windows and Linux, application launch buttons execute their configured workflow without runtime modification.
- **Tab Closing**: Option (close tab) is implemented for Vivaldi, Google Chrome, Brave, Safari and Firefox with STRUCTURAL rules that have not yet been validated against real accessibility trees, therefore it is DISABLED by default and does nothing (a log line is written) unless the environment variable `KANDO_UNVERIFIED_TAB_CLOSE=1` is set when Kando starts (note it is for validation only). Even when enabled, tab closing requires 2 or more open tabs.
- **Quick-Select Keys**: Quick-select keys cannot be combined with modifiers.
- **Spaces**: Window enumeration for windows located on other macOS Spaces may be limited by macOS WindowServer privacy policies.
- **Budgets**: Wall-clock and node traversal limits are best-effort deadlines (not hard guarantees) until measured.
- **One-Time IPC Observers**: A `show-custom-menu` request dropped before a generation is allocated (such as when superseded by another request before showing or when no menu could be shown) leaves its one-time observer silently unbound. It receives no events until replaced by a subsequent request or disconnected; clients must time out and clean up.
