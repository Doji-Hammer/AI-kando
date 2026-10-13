<!--
SPDX-FileCopyrightText: Simon Schneegans <code@simonschneegans.de>
SPDX-License-Identifier: CC-BY-4.0
-->

# Product

## Register

product

## Users

Power users on macOS who build and tune their own pie menus: launchers, hotkey macros, per-app menus, multi-step workflows. They open the settings window to change something specific, then leave. They know pie menus; they don't want hand-holding.

## Product Purpose

The Kando settings window is where menus are built, edited and configured. The pie menu itself is drawn by menu themes and is out of scope.

Direction: a built-in AI assistant becomes a first-class part of the window. It knows the current configuration, can build menus, items and workflows on request, and explains what is and isn't possible. In the composer, the user pulls in references with a trigger character instead of typing them out: menus, items, settings, action types (Execute Command, Simulate Hotkey, Open URI…) and selection methods (Select workflow vs. hover workflow). Because the assistant does the heavy building, the window needs less hand-built visual configuration and can give that space to the assistant.

Success: a power user can describe a change in one sentence, see exactly what the assistant will change, and accept it, without hunting through panels.

## Brand Personality

Calm, soft, precise. Quiet and confident, like Things 3 or iA Writer. The Organic design system (Warm Editorial made softer: warm paper, clay and sage, rounder shapes, soft shadows) does the talking; the interface stays out of the way.

## Anti-references

- Generic AI chat bolted onto the side (purple gradients, sparkle icons everywhere, chat bubbles that can't act).
- Developer-tool density for its own sake.
- Playful decoration competing with the work (swirls, blossoms and badges as the main voice).
- Cross-platform compromise UI: this is macOS only now.

## Design Principles

1. Ask, then see: the assistant proposes, the editor shows the exact change, the user accepts.
2. Reference, don't retype: anything nameable (menu, item, action, setting) can be pulled into a prompt by a trigger character.
3. Show the menu, hide the plumbing: keep the preview and properties that matter; move rare settings behind the assistant or disclosure.
4. Mac first: native conventions (Cmd shortcuts, standard window chrome, solid cream window, no see-through).
5. Fewer, quieter surfaces: one primary action per view.

## Accessibility & Inclusion

WCAG 2.2 AA: 4.5:1 text contrast, full keyboard use, visible focus, reduced-motion support. The Organic palette meets these: ink on the clay button is 5.03:1, clay links are 5.84:1 on canvas.
