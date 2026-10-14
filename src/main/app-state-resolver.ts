//////////////////////////////////////////////////////////////////////////////////////////
//   _  _ ____ _  _ ___  ____                                                           //
//   |_/  |__| |\ | |  \ |  |    This file belongs to Kando, the cross-platform         //
//   | \_ |  | | \| |__/ |__|    pie menu. Read more on github.com/kando-menu/kando     //
//                                                                                      //
//////////////////////////////////////////////////////////////////////////////////////////

// SPDX-FileCopyrightText: Simon Schneegans <code@simonschneegans.de>
// SPDX-License-Identifier: MIT

import {
  AppState,
  DisplayedButtonMenuItem,
  DisplayedChildMenuItem,
  DisplayedRootMenuItem,
  DisplayedSubmenuMenuItem,
} from '../common/app-switcher';
import { getAppLaunchTarget, DisplayedPathInfo } from '../common/app-switcher-logic';
import { ChildMenuItem, RootMenuItem, Workflow } from '../common/settings-schemata';
import { DeepReadonly } from './settings';

/** Minimal backend interface required for app state resolution. */
export type AppControlBackend = {
  getBackendInfo(): { supportsAppControl?: boolean; [key: string]: unknown };
  getAppStates(targets: string[]): AppState[];
};

/** Result of resolving the displayed menu tree against running applications. */
export type ResolvedMenuTree = {
  displayedRoot: DisplayedRootMenuItem;
  pathMap: Map<string, DisplayedPathInfo>;
  generation: number;
};

/** Builds an identity path map for all items in a menu tree. */
function buildIdentityPathMap(
  root: DeepReadonly<RootMenuItem> | RootMenuItem,
  pathMap: Map<string, DisplayedPathInfo>
): void {
  pathMap.set('', { sourcePath: [] });

  function walk(
    children: readonly DeepReadonly<ChildMenuItem>[] | ChildMenuItem[],
    currentPath: number[]
  ): void {
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      const childPath = [...currentPath, i];
      pathMap.set(childPath.join(','), { sourcePath: childPath });

      if (child.type === 'submenu') {
        walk(child.children, childPath);
      }
    }
  }

  walk(root.children, []);
}

/**
 * Resolves the displayed menu tree from the stored menu root and the backend's current
 * application states.
 *
 * - Non-macOS / backends without supportsAppControl: returns stored tree with identity map.
 * - Deep-copies all nodes so the stored menu is never mutated.
 * - Queries backend.getAppStates once for all deduplicated targets.
 * - Converts running apps with >= 2 known windows into submenus of windows.
 * - Single-window apps stay buttons with windowId attached to the binding.
 * - Non-running apps or apps with unknown/0 windows stay buttons with appropriate bindings.
 */
export function resolveAppState(
  storedRoot: DeepReadonly<RootMenuItem> | RootMenuItem,
  backend: AppControlBackend,
  generation = 0
): ResolvedMenuTree {
  const pathMap = new Map<string, DisplayedPathInfo>();

  const backendInfo = backend.getBackendInfo();
  if (!backendInfo.supportsAppControl) {
    const copy = structuredClone(storedRoot) as DisplayedRootMenuItem;
    buildIdentityPathMap(storedRoot, pathMap);
    return {
      displayedRoot: copy,
      pathMap,
      generation,
    };
  }

  // 1. Collect all app launch targets
  const collectedTargets: string[] = [];
  function collectTargets(
    children: readonly DeepReadonly<ChildMenuItem>[] | ChildMenuItem[]
  ): void {
    for (const child of children) {
      if (child.type === 'button') {
        const target = getAppLaunchTarget(child);
        if (target) {
          collectedTargets.push(target);
        }
      } else if (child.type === 'submenu') {
        collectTargets(child.children);
      }
    }
  }
  collectTargets(storedRoot.children);

  // 2. Query states for deduplicated targets in one call
  const targetMap = new Map<string, AppState>();
  if (collectedTargets.length > 0) {
    const dedupedTargets: string[] = [];
    const seen = new Set<string>();
    for (const target of collectedTargets) {
      if (!seen.has(target)) {
        seen.add(target);
        dedupedTargets.push(target);
      }
    }

    const states = backend.getAppStates(dedupedTargets);
    for (let i = 0; i < dedupedTargets.length; i++) {
      targetMap.set(dedupedTargets[i], states[i]);
    }
  }

  // 3. Deep-copy and transform tree
  pathMap.set('', { sourcePath: [] });

  function transformChildren(
    children: readonly DeepReadonly<ChildMenuItem>[] | ChildMenuItem[],
    parentSourcePath: number[],
    parentDisplayedPath: number[]
  ): DisplayedChildMenuItem[] {
    const result: DisplayedChildMenuItem[] = [];

    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      const sourcePath = [...parentSourcePath, i];
      const displayedPath = [...parentDisplayedPath, i];
      const displayedKey = displayedPath.join(',');

      // Every displayed item starts as a structured clone of its stored source, so that
      // all schema fields survive even those the resolver does not care about, such as
      // the fixed `angle` of an item.
      if (child.type === 'submenu') {
        pathMap.set(displayedKey, { sourcePath });
        const submenu = structuredClone(child) as unknown as DisplayedSubmenuMenuItem;
        submenu.children = transformChildren(child.children, sourcePath, displayedPath);
        result.push(submenu);
        continue;
      }

      // Button item: check if it is a recognised app launch target
      const target = getAppLaunchTarget(child);
      if (!target) {
        pathMap.set(displayedKey, { sourcePath });
        result.push(structuredClone(child) as unknown as DisplayedButtonMenuItem);
        continue;
      }

      const state: AppState = targetMap.get(target) ?? {
        running: false,
        windows: [],
        windowsKnown: false,
      };
      const originalWorkflow: Workflow = child.selectWorkflow
        ? (structuredClone(child.selectWorkflow) as unknown as Workflow)
        : { actions: [] };

      // Multi-window running app: convert button to submenu
      if (state.running && state.windowsKnown && state.windows.length >= 2) {
        pathMap.set(displayedKey, { sourcePath, isConvertedParent: true });

        const windowChildren: DisplayedChildMenuItem[] = state.windows.map(
          (win, winIdx) => {
            const childDisplayedPath = [...displayedPath, winIdx];
            pathMap.set(childDisplayedPath.join(','), {
              sourcePath,
              isSyntheticChild: true,
            });

            const windowTitle =
              win.title.trim().length > 0
                ? win.title
                : `${child.name} (window ${winIdx + 1})`;

            const windowItem: DisplayedButtonMenuItem = {
              type: 'button',
              name: windowTitle,
              icon: child.icon,
              iconTheme: child.iconTheme,
              selectWorkflow: { actions: [] },
              app: {
                target,
                running: true,
                pid: state.pid,
                windowId: win.windowId,
                windowsKnown: true,
                originalWorkflow,
              },
            };

            return windowItem;
          }
        );

        // The converted submenu keeps every field of the source button, including its
        // fixed angle and its hover-workflow. Only the workflows which drive opening and
        // activating change: the launch workflow moves into the app binding and is never
        // attached to the submenu itself, and a submenu item has no select-workflow.
        const clonedButton = structuredClone(child) as unknown as DisplayedButtonMenuItem;
        const { selectWorkflow: launchWorkflow, ...buttonFields } = clonedButton;

        const convertedSubmenu = {
          ...buttonFields,
          type: 'submenu',
          app: {
            target,
            running: true,
            pid: state.pid,
            windowsKnown: true,
            originalWorkflow,
          },
          openWorkflow: {
            quickSelectKey: launchWorkflow?.quickSelectKey,
            actions: [],
          },
          children: windowChildren,
        } as unknown as DisplayedSubmenuMenuItem;

        result.push(convertedSubmenu);
        continue;
      }

      // Single known window, unknown windows, 0 windows, or not running
      pathMap.set(displayedKey, { sourcePath });

      let windowId: number | undefined;
      if (state.running && state.windowsKnown && state.windows.length === 1) {
        windowId = state.windows[0].windowId;
      }

      const appButton = structuredClone(child) as unknown as DisplayedButtonMenuItem;
      appButton.app = {
        target,
        running: state.running,
        pid: state.pid,
        windowId,
        windowsKnown: state.windowsKnown,
        originalWorkflow,
      };

      result.push(appButton);
    }

    return result;
  }

  const displayedRoot = structuredClone(storedRoot) as unknown as DisplayedRootMenuItem;
  displayedRoot.children = transformChildren(storedRoot.children, [], []);

  return {
    displayedRoot,
    pathMap,
    generation,
  };
}
