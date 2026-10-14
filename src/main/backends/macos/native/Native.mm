//////////////////////////////////////////////////////////////////////////////////////////
//   _  _ ____ _  _ ___  ____                                                           //
//   |_/  |__| |\ | |  \ |  |    This file belongs to Kando, the cross-platform         //
//   | \_ |  | | \| |__/ |__|    pie menu. Read more on github.com/kando-menu/kando     //
//                                                                                      //
//////////////////////////////////////////////////////////////////////////////////////////

// SPDX-FileCopyrightText: Simon Schneegans <code@simonschneegans.de>
// SPDX-License-Identifier: MIT

#include "Native.hpp"

#include <AppKit/AppKit.h>
#include <ApplicationServices/ApplicationServices.h>
#include <Carbon/Carbon.h>

#include <iostream>
#include <sys/mman.h>
#include <unistd.h>
#include <dlfcn.h>
#include <algorithm>
#include <chrono>
#include <cstdlib>
#include <unordered_map>
#include <vector>
#include <string>

//////////////////////////////////////////////////////////////////////////////////////////

namespace {

// Every AX call in this file runs against ONE absolute wall-clock deadline: the caller
// computes it once and passes it down. Reads arm their element through armElement() just
// before the message, actions and attribute writes go through performArmAction() and
// setArmAttribute(), which also check AX return codes and log failures.

// Time left until `deadline`, in milliseconds. Zero or less means the budget is spent and
// the caller must not send another AX message.
long remainingMs(std::chrono::steady_clock::time_point deadline) {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
             deadline - std::chrono::steady_clock::now())
      .count();
}

// Arms `elem` for its next AX message: it caps that element's messaging timeout at the
// remaining budget, and at 100 ms. Returns false when the budget is already spent or
// setting the timeout failed, in which case the caller must abort without messaging the element.
bool armElement(AXUIElementRef elem, std::chrono::steady_clock::time_point deadline) {
  if (!elem) {
    return false;
  }
  long remaining = remainingMs(deadline);
  if (remaining <= 0) {
    return false;
  }
  AXError err = AXUIElementSetMessagingTimeout(
      elem, std::min(static_cast<float>(remaining) / 1000.0f, 0.100f));
  if (err != kAXErrorSuccess) {
    return false;
  }
  return true;
}

// Arms `elem`, then performs one AX action on it. Logs and returns false when the budget
// is spent or the action failed.
bool performArmAction(AXUIElementRef elem, CFStringRef action,
    std::chrono::steady_clock::time_point deadline, const char* what) {
  if (!armElement(elem, deadline)) {
    std::cerr << what << ": budget exhausted; AX action not sent" << std::endl;
    return false;
  }
  AXError err = AXUIElementPerformAction(elem, action);
  if (err != kAXErrorSuccess) {
    std::cerr << what << ": AX action failed (" << err << ")" << std::endl;
    return false;
  }
  return true;
}

// Arms `elem`, then writes one AX attribute on it. Logs and returns false when the budget
// is spent or the write failed.
bool setArmAttribute(AXUIElementRef elem, CFStringRef attribute, CFTypeRef value,
    std::chrono::steady_clock::time_point deadline, const char* what) {
  if (!armElement(elem, deadline)) {
    std::cerr << what << ": budget exhausted; AX attribute not written" << std::endl;
    return false;
  }
  AXError err = AXUIElementSetAttributeValue(elem, attribute, value);
  if (err != kAXErrorSuccess) {
    std::cerr << what << ": AX attribute write failed (" << err << ")" << std::endl;
    return false;
  }
  return true;
}

Napi::Object processAppAtPath(const Napi::Env& env, NSString* appPath) {

  NSBundle* bundle = [NSBundle bundleWithPath:appPath];
  if (!bundle) {
    return Napi::Object();
  }

  // Filter out bundles that are pure background processes with no UI at all. Note that
  // we deliberately do *not* filter out LSUIElement apps: that flag only means "no Dock
  // icon", not "not user-launchable" — lots of everyday menu-bar-only apps (and Kando
  // itself) set it, so excluding them hid apps that were actually installed.
  NSDictionary* infoDict = [bundle infoDictionary];
  if (infoDict) {
    NSNumber* lsbg = infoDict[@"LSBackgroundOnly"];
    if (lsbg && [lsbg boolValue]) {
      return Napi::Object();
    }
  }

  // If there is no executable, this is likely not a user-visible app.
  NSString* execName = [bundle objectForInfoDictionaryKey:@"CFBundleExecutable"];
  if (!execName || [execName length] == 0) {
    return Napi::Object();
  }

  // If there is no icon at all, skip — many helpers/agents don't expose a proper icon.
  NSImage* icon = [[NSWorkspace sharedWorkspace] iconForFile:appPath];
  if (!icon || [icon size].width == 0) {
    return Napi::Object();
  }

  NSString* name = [[bundle objectForInfoDictionaryKey:@"CFBundleName"] description];

  // The bundle's file name (e.g. "Safari" for "Safari.app") is what "open -a" expects
  // and what a file dropped from the Finder is named, so we use it as our id below.
  NSString* bundleFileName = [[appPath lastPathComponent] stringByDeletingPathExtension];

  if (!name) {
    name = bundleFileName;
  }

  // Create a 64x64 bitmap and draw the icon into it
  NSImage* resizedIcon = [[NSImage alloc] initWithSize:NSMakeSize(64, 64)];
  if (icon) {
    [resizedIcon lockFocus];
    [icon drawInRect:NSMakeRect(0, 0, 64, 64)
              fromRect:NSZeroRect
             operation:NSCompositingOperationSourceOver
              fraction:1.0
        respectFlipped:YES
                 hints:@{
                   NSImageHintInterpolation: @(NSImageInterpolationHigh)
                 }];
    [resizedIcon unlockFocus];
  }

  NSData* tiffData = [resizedIcon TIFFRepresentation];
  if (tiffData) {
    NSBitmapImageRep* rep        = [NSBitmapImageRep imageRepWithData:tiffData];
    NSData*           pngData    = [rep representationUsingType:NSBitmapImageFileTypePNG
                                        properties:@{}];
    NSString*         base64Icon = [pngData base64EncodedStringWithOptions:0];

    if (base64Icon) {
      // Add data: prefix to the base64 string.
      base64Icon = [NSString stringWithFormat:@"data:image/png;base64,%@", base64Icon];

      Napi::Object appInfo = Napi::Object::New(env);
      appInfo.Set("name", Napi::String::New(env, name.UTF8String));
      appInfo.Set("id", Napi::String::New(env, bundleFileName.UTF8String));
      appInfo.Set("base64Icon", Napi::String::New(env, base64Icon.UTF8String));
      return appInfo;
    }
  }

  return Napi::Object();
}

std::string getAppNameFromPID(pid_t pid) {
  NSRunningApplication* app =
      [NSRunningApplication runningApplicationWithProcessIdentifier:pid];

  if (app.bundleIdentifier) {
    return app.bundleIdentifier.UTF8String;
  }

  if (app.localizedName) {
    return app.localizedName.UTF8String;
  }

  return "";
}

bool appMatches(NSRunningApplication* app, const std::string& targetAppName) {
  if (!app) {
    return false;
  }

  if (app.bundleIdentifier) {
    if (targetAppName == app.bundleIdentifier.UTF8String) {
      return true;
    }
  }

  if (app.localizedName) {
    if (targetAppName == app.localizedName.UTF8String) {
      return true;
    }
  }

  return false;
}

bool raiseWindow(NSRunningApplication* app, NSString* targetWindowName,
    std::chrono::steady_clock::time_point deadline) {
  if (!app) {
    return false;
  }

  AXUIElementRef appElement = AXUIElementCreateApplication(app.processIdentifier);
  if (!appElement) {
    return false;
  }

  if (!armElement(appElement, deadline)) {
    std::cerr << "focusWindow: budget exhausted; window list not requested" << std::endl;
    CFRelease(appElement);
    return false;
  }

  CFTypeRef windowsValue = nullptr;
  AXError   windowsError = AXUIElementCopyAttributeValue(
      appElement, kAXWindowsAttribute, &windowsValue);

  if (windowsError != kAXErrorSuccess || !windowsValue ||
      CFGetTypeID(windowsValue) != CFArrayGetTypeID()) {
    if (windowsValue) {
      CFRelease(windowsValue);
    }
    CFRelease(appElement);
    return false;
  }

  CFArrayRef windows = static_cast<CFArrayRef>(windowsValue);
  bool       focused = false;

  for (CFIndex i = 0; i < CFArrayGetCount(windows); ++i) {
    AXUIElementRef window =
        static_cast<AXUIElementRef>(const_cast<void*>(CFArrayGetValueAtIndex(windows, i)));

    if (!window) {
      continue;
    }

    if (!armElement(window, deadline)) {
      std::cerr << "focusWindow: budget exhausted; remaining windows not inspected"
                << std::endl;
      break;
    }

    CFTypeRef titleValue = nullptr;
    AXError   titleError =
        AXUIElementCopyAttributeValue(window, kAXTitleAttribute, &titleValue);

    if (titleError != kAXErrorSuccess || !titleValue ||
        CFGetTypeID(titleValue) != CFStringGetTypeID()) {
      if (titleValue) {
        CFRelease(titleValue);
      }
      continue;
    }

    NSString* title = (__bridge NSString*)titleValue;
    bool      isMatch = title && [title isEqualToString:targetWindowName];
    CFRelease(titleValue);

    if (!isMatch) {
      continue;
    }

    if (!armElement(appElement, deadline)) {
      break;
    }
    [app activateWithOptions:NSApplicationActivateIgnoringOtherApps];
    performArmAction(window, kAXRaiseAction, deadline, "focusWindow");
    setArmAttribute(window, kAXMainAttribute, kCFBooleanTrue, deadline, "focusWindow");
    setArmAttribute(window, kAXFocusedAttribute, kCFBooleanTrue, deadline, "focusWindow");
    focused = true;
    break;
  }

  CFRelease(windowsValue);
  CFRelease(appElement);
  return focused;
}

  extern "C" {
  typedef AXError (*AXUIElementGetWindowFunc)(AXUIElementRef, CGWindowID*);
  }

  AXUIElementGetWindowFunc getAXUIElementGetWindow() {
    static AXUIElementGetWindowFunc sFunc = nullptr;
    static bool sInitialized = false;
    if (!sInitialized) {
      sFunc = reinterpret_cast<AXUIElementGetWindowFunc>(
          dlsym(RTLD_DEFAULT, "_AXUIElementGetWindow"));
      sInitialized = true;
    }
    return sFunc;
  }

  // The three lookup tiers of V3.1, in priority order.
  enum class AppMatchTier { BundleFileName, LocalizedName, BundleIdentifier };

  bool appMatchesTier(
      NSRunningApplication* app, NSString* target, AppMatchTier tier) {
    switch (tier) {
      case AppMatchTier::BundleFileName: {
        if (!app.bundleURL) {
          return false;
        }
        NSString* bundleFileName =
            [[app.bundleURL lastPathComponent] stringByDeletingPathExtension];
        return bundleFileName &&
               [bundleFileName caseInsensitiveCompare:target] == NSOrderedSame;
      }
      case AppMatchTier::LocalizedName:
        return app.localizedName &&
               [app.localizedName caseInsensitiveCompare:target] == NSOrderedSame;
      case AppMatchTier::BundleIdentifier:
        return app.bundleIdentifier &&
               [app.bundleIdentifier caseInsensitiveCompare:target] == NSOrderedSame;
    }
    return false;
  }

  // Implements the V3.1 tiered lookup: first match on the bundle name (bundleURL's last
  // path component minus its single ".app" extension), only if none on localizedName,
  // only if none on bundleIdentifier. Each tier is case-insensitive; within a tier the
  // lowest pid wins. The target is used exactly as recognition (src/common/
  // app-switcher-logic.ts) normalised it: one trailing ".app" was already stripped there,
  // so native must not strip a second one.
  NSRunningApplication* findMatchingApp(
      NSString* target, NSArray<NSRunningApplication*>* runningApps) {
    const AppMatchTier tiers[] = {
        AppMatchTier::BundleFileName,
        AppMatchTier::LocalizedName,
        AppMatchTier::BundleIdentifier,
    };

    for (AppMatchTier tier : tiers) {
      NSRunningApplication* bestApp   = nil;
      pid_t                 lowestPid = -1;

      for (NSRunningApplication* app in runningApps) {
        if (!appMatchesTier(app, target, tier)) {
          continue;
        }
        pid_t pid = app.processIdentifier;
        if (bestApp == nil || pid < lowestPid) {
          bestApp   = app;
          lowestPid = pid;
        }
      }

      if (bestApp) {
        return bestApp;
      }
    }

    return nil;
  }

  // Per-bundle tab-strip rules for close-tab. Every entry is `verified: false`, because
  // the STRUCTURAL rules in inspectTabGroup() below were written without ever capturing a
  // real AX tree from these browsers (no Accessibility permission was available and
  // driving the apps is forbidden). Until an entry is verified against a captured tree,
  // close-tab refuses to post anything unless KANDO_UNVERIFIED_TAB_CLOSE=1 was set at
  // process start, which exists only so the rules can be validated interactively.
  struct TabStripRule {
    const char* bundleId;
    // Whether the rule for this bundle has been checked against a real AX tree.
    bool verified;
    // Chromium-family browsers only expose their AX tree once AXManualAccessibility is
    // set on the application element.
    bool needsManualAccessibility;
  };

  const TabStripRule kTabStripRules[] = {
      {"com.vivaldi.Vivaldi", false, true},
      {"com.google.Chrome", false, true},
      {"com.brave.Browser", false, true},
      {"com.apple.Safari", false, false},
      {"org.mozilla.firefox", false, false},
  };

  const TabStripRule* findTabStripRule(NSString* bundleId) {
    for (const TabStripRule& rule : kTabStripRules) {
      if ([bundleId isEqualToString:[NSString stringWithUTF8String:rule.bundleId]]) {
        return &rule;
      }
    }
    return nullptr;
  }

  // Whether unverified tab-strip rules may be used. Read once when the addon is loaded,
  // so a later change to the environment cannot turn tab closing back on mid-run.
  const bool kUnverifiedTabCloseAllowed = []() {
    const char* value = std::getenv("KANDO_UNVERIFIED_TAB_CLOSE");
    return value != nullptr && std::string(value) == "1";
  }();

  struct AppWindowResult {
    CGWindowID windowId;
    std::string title;
  };

  struct AppStateResult {
    bool running = false;
    pid_t pid = 0;
    bool windowsKnown = false;
    std::vector<AppWindowResult> windows;
  };

  // The result of inspecting a candidate AXTabGroup. "valid" is only true when the group
  // was positively identified as a window-level tab strip with >= 2 tabs.
  struct TabGroupInspection {
    bool valid = false;
  };

  // The frame of an accessibility element in screen coordinates. Only the fields we need
  // to qualify a tab group are kept; "known" is false if either AXPosition or AXSize
  // could not be read.
  struct ElementFrame {
    bool known = false;
    CGFloat y = 0;
    CGFloat width = 0;
  };

  struct TabSearchContext {
    int nodesVisited = 0;
    int maxNodes = 400;
    int maxDepth = 6;
    // The web content check searches a little deeper than the tab strip search.
    int maxWebAreaDepth = 8;
    std::chrono::steady_clock::time_point deadline;
    // The frame of the window being inspected. Used to qualify a candidate tab group.
    ElementFrame windowFrame;
    // Diagnostic: the largest tab count seen on any AXTabGroup candidate, even rejected
    // ones. Only used for the fail-closed log line.
    int maxCandidateTabs = 0;
  };

  // Reads the screen frame of an accessibility element. The result is only "known" if
  // both AXPosition and AXSize could be read as their expected AXValue types.
  ElementFrame getElementFrame(
      AXUIElementRef elem, std::chrono::steady_clock::time_point deadline) {
    ElementFrame frame;

    if (!armElement(elem, deadline)) {
      return frame;
    }
    CFTypeRef posVal   = nullptr;
    CGPoint   pos      = CGPointZero;
    bool      havePos  = false;
    if (AXUIElementCopyAttributeValue(elem, kAXPositionAttribute, &posVal) ==
            kAXErrorSuccess &&
        posVal && CFGetTypeID(posVal) == AXValueGetTypeID()) {
      havePos = AXValueGetValue(static_cast<AXValueRef>(posVal),
          static_cast<AXValueType>(kAXValueCGPointType), &pos);
    }
    if (posVal) CFRelease(posVal);

    if (!armElement(elem, deadline)) {
      return frame;
    }
    CFTypeRef sizeVal  = nullptr;
    CGSize    size     = CGSizeZero;
    bool      haveSize = false;
    if (AXUIElementCopyAttributeValue(elem, kAXSizeAttribute, &sizeVal) ==
            kAXErrorSuccess &&
        sizeVal && CFGetTypeID(sizeVal) == AXValueGetTypeID()) {
      haveSize = AXValueGetValue(static_cast<AXValueRef>(sizeVal),
          static_cast<AXValueType>(kAXValueCGSizeType), &size);
    }
    if (sizeVal) CFRelease(sizeVal);

    if (havePos && haveSize) {
      frame.known = true;
      frame.y     = pos.y;
      frame.width = size.width;
    }
    return frame;
  }

  // Returns 1 if the tab element is selected, 0 if it is readable but not selected and -1
  // if neither AXValue (== 1) nor AXSelected (== true) could be read.
  int readTabSelected(
      AXUIElementRef tabElem, std::chrono::steady_clock::time_point deadline) {
    if (!armElement(tabElem, deadline)) {
      return -1;
    }

    bool readable = false;
    bool selected = false;

    CFTypeRef val = nullptr;
    if (AXUIElementCopyAttributeValue(tabElem, kAXValueAttribute, &val) ==
            kAXErrorSuccess &&
        val) {
      if (CFGetTypeID(val) == CFNumberGetTypeID()) {
        int32_t number = 0;
        if (CFNumberGetValue(
                static_cast<CFNumberRef>(val), kCFNumberSInt32Type, &number)) {
          readable = true;
          if (number == 1) {
            selected = true;
          }
        }
      }
      CFRelease(val);
    }

    val = nullptr;
    if (armElement(tabElem, deadline)) {
      if (AXUIElementCopyAttributeValue(tabElem, CFSTR("AXSelected"), &val) ==
              kAXErrorSuccess &&
          val) {
        if (CFGetTypeID(val) == CFBooleanGetTypeID()) {
          readable = true;
          if (CFBooleanGetValue(static_cast<CFBooleanRef>(val))) {
            selected = true;
          }
        }
        CFRelease(val);
      }
    }

    if (!readable) {
      return -1;
    }
    return selected ? 1 : 0;
  }

  // Determines whether a candidate AXTabGroup is really a window-level browser tab strip
  // with >= 2 tabs. All rules below are STRUCTURAL (frame position/size, horizontal child
  // layout, exactly one selected tab); they are NOT derived from captured AX trees, since
  // the agent had no Accessibility permission and Tom forbids driving his apps. They must
  // be re-validated live, per app, before trusting a tab close.
  TabGroupInspection inspectTabGroup(
      AXUIElementRef tabGroupElem, TabSearchContext& ctx) {
    TabGroupInspection result;

    if (!ctx.windowFrame.known) {
      std::cerr << "close-tab: window frame unreadable; fail closed" << std::endl;
      return result;
    }

    ElementFrame groupFrame = getElementFrame(tabGroupElem, ctx.deadline);
    if (!groupFrame.known) {
      std::cerr << "close-tab: tab group frame unreadable; fail closed" << std::endl;
      return result;
    }

    // A window-level tab strip sits at the very top of the window and spans most of its
    // width. A preferences/content-pane AXTabGroup sits lower down or is much narrower.
    CGFloat topOffset = groupFrame.y - ctx.windowFrame.y;
    if (topOffset < -2 || topOffset > 160) {
      std::cerr << "close-tab: tab group not within the top 160pt of the window (offset "
                << topOffset << "pt); fail closed" << std::endl;
      return result;
    }
    if (groupFrame.width < 0.5 * ctx.windowFrame.width) {
      std::cerr << "close-tab: tab group spans " << groupFrame.width
                << "pt, less than 50% of the window width " << ctx.windowFrame.width
                << "pt; fail closed" << std::endl;
      return result;
    }

    if (!armElement(tabGroupElem, ctx.deadline)) {
      std::cerr << "close-tab: budget exhausted; tab group children not read" << std::endl;
      return result;
    }
    CFTypeRef childrenVal = nullptr;
    AXError   err =
        AXUIElementCopyAttributeValue(tabGroupElem, kAXChildrenAttribute, &childrenVal);
    if (err != kAXErrorSuccess || !childrenVal ||
        CFGetTypeID(childrenVal) != CFArrayGetTypeID()) {
      if (childrenVal) CFRelease(childrenVal);
      std::cerr << "close-tab: tab group children unreadable; fail closed" << std::endl;
      return result;
    }

    CFArrayRef children = static_cast<CFArrayRef>(childrenVal);
    CFIndex    count    = CFArrayGetCount(children);

    int     tabCount            = 0;
    int     selectedCount       = 0;
    bool    selectionUnreadable = false;
    bool    horizontal          = true;
    bool    haveFirstY          = false;
    CGFloat firstTabY           = 0;
    // Set when a child could not be inspected at all. The remaining tabs are unknown, so
    // the group must not be trusted even if the tabs read so far looked right.
    bool    aborted             = false;

    for (CFIndex i = 0; i < count; ++i) {
      // Every child inspected counts against the shared node budget, whether or not it
      // turns out to be a tab; exceeding it aborts the whole walk.
      if (ctx.nodesVisited >= ctx.maxNodes) {
        std::cerr << "close-tab: node budget exhausted in tab group; fail closed"
                  << std::endl;
        CFRelease(childrenVal);
        return result;
      }
      if (remainingMs(ctx.deadline) <= 0) {
        std::cerr << "close-tab: budget exhausted in tab group; fail closed"
                  << std::endl;
        CFRelease(childrenVal);
        return result;
      }
      ctx.nodesVisited++;

      AXUIElementRef child = static_cast<AXUIElementRef>(
          const_cast<void*>(CFArrayGetValueAtIndex(children, i)));
      if (!child) continue;

      if (!armElement(child, ctx.deadline)) {
        aborted = true;
        break;
      }
      CFTypeRef roleVal = nullptr;
      if (AXUIElementCopyAttributeValue(child, kAXRoleAttribute, &roleVal) !=
              kAXErrorSuccess ||
          !roleVal) {
        if (roleVal) CFRelease(roleVal);
        continue;
      }

      bool isTab = false;
      if (CFGetTypeID(roleVal) == CFStringGetTypeID()) {
        CFStringRef roleStr = static_cast<CFStringRef>(roleVal);
        isTab =
            CFStringCompare(roleStr, CFSTR("AXRadioButton"), 0) == kCFCompareEqualTo ||
            CFStringCompare(roleStr, CFSTR("AXTab"), 0) == kCFCompareEqualTo;
      }
      CFRelease(roleVal);

      if (!isTab) continue;

      tabCount++;

      ElementFrame tabFrame = getElementFrame(child, ctx.deadline);
      if (!tabFrame.known) {
        horizontal = false;
      } else if (!haveFirstY) {
        firstTabY  = tabFrame.y;
        haveFirstY = true;
      } else {
        CGFloat dy = tabFrame.y - firstTabY;
        if (dy > 4 || dy < -4) {
          horizontal = false;
        }
      }

      int selected = readTabSelected(child, ctx.deadline);
      if (selected < 0) {
        selectionUnreadable = true;
      } else if (selected == 1) {
        selectedCount++;
      }
    }

    CFRelease(childrenVal);

    if (tabCount > ctx.maxCandidateTabs) {
      ctx.maxCandidateTabs = tabCount;
    }

    if (tabCount < 2) {
      return result;
    }
    if (aborted) {
      std::cerr << "close-tab: tab group children could not all be inspected; fail closed"
                << std::endl;
      return result;
    }
    if (!haveFirstY || !horizontal) {
      std::cerr << "close-tab: tab children are not laid out horizontally; fail closed"
                << std::endl;
      return result;
    }
    if (selectionUnreadable) {
      std::cerr << "close-tab: tab selection state unreadable; fail closed" << std::endl;
      return result;
    }
    if (selectedCount != 1) {
      std::cerr << "close-tab: expected exactly one selected tab, found "
                << selectedCount << "; fail closed" << std::endl;
      return result;
    }

    result.valid = true;
    return result;
  }

  // Searches the window subtree (bounded by ctx) for an AXWebArea. Real browser windows
  // contain a web area for their page content; a native tabbed settings window does not.
  bool containsWebArea(AXUIElementRef elem, int currentDepth, TabSearchContext& ctx) {
    if (currentDepth > ctx.maxWebAreaDepth || ctx.nodesVisited >= ctx.maxNodes) {
      return false;
    }
    if (remainingMs(ctx.deadline) <= 0) {
      return false;
    }

    ctx.nodesVisited++;

    if (!armElement(elem, ctx.deadline)) {
      return false;
    }
    CFTypeRef roleVal = nullptr;
    AXError   err     = AXUIElementCopyAttributeValue(elem, kAXRoleAttribute, &roleVal);
    if (err != kAXErrorSuccess || !roleVal) {
      return false;
    }

    bool isWebArea = false;
    if (CFGetTypeID(roleVal) == CFStringGetTypeID()) {
      isWebArea =
          CFStringCompare(static_cast<CFStringRef>(roleVal), CFSTR("AXWebArea"), 0) ==
          kCFCompareEqualTo;
    }
    CFRelease(roleVal);

    if (isWebArea) {
      return true;
    }

    if (!armElement(elem, ctx.deadline)) {
      return false;
    }
    CFTypeRef childrenVal = nullptr;
    err = AXUIElementCopyAttributeValue(elem, kAXChildrenAttribute, &childrenVal);
    if (err != kAXErrorSuccess || !childrenVal ||
        CFGetTypeID(childrenVal) != CFArrayGetTypeID()) {
      if (childrenVal) CFRelease(childrenVal);
      return false;
    }

    CFArrayRef children = static_cast<CFArrayRef>(childrenVal);
    CFIndex    count    = CFArrayGetCount(children);
    bool       found    = false;

    for (CFIndex i = 0; i < count; ++i) {
      if (remainingMs(ctx.deadline) <= 0 || ctx.nodesVisited >= ctx.maxNodes) {
        break;
      }
      AXUIElementRef child = static_cast<AXUIElementRef>(
          const_cast<void*>(CFArrayGetValueAtIndex(children, i)));
      if (!child) continue;

      if (containsWebArea(child, currentDepth + 1, ctx)) {
        found = true;
        break;
      }
      if (remainingMs(ctx.deadline) <= 0 || ctx.nodesVisited >= ctx.maxNodes) {
        break;
      }
    }

    CFRelease(childrenVal);
    return found;
  }

  // Searches the window subtree (bounded by ctx) for a positively identified window-level
  // tab strip. The search only considers candidates outside AXWebArea so that content
  // panes and web content cannot qualify.
  TabGroupInspection searchForTabStrip(
      AXUIElementRef elem, int currentDepth, TabSearchContext& ctx) {
    if (currentDepth > ctx.maxDepth || ctx.nodesVisited >= ctx.maxNodes) {
      return TabGroupInspection{};
    }
    if (remainingMs(ctx.deadline) <= 0) {
      return TabGroupInspection{};
    }

    ctx.nodesVisited++;

    if (!armElement(elem, ctx.deadline)) {
      return TabGroupInspection{};
    }
    CFTypeRef roleVal = nullptr;
    AXError   err = AXUIElementCopyAttributeValue(elem, kAXRoleAttribute, &roleVal);
    if (err != kAXErrorSuccess || !roleVal) {
      return TabGroupInspection{};
    }

    bool isTabGroup = false;
    bool isWebArea  = false;
    if (CFGetTypeID(roleVal) == CFStringGetTypeID()) {
      CFStringRef roleStr = static_cast<CFStringRef>(roleVal);
      if (CFStringCompare(roleStr, CFSTR("AXTabGroup"), 0) == kCFCompareEqualTo) {
        isTabGroup = true;
      } else if (CFStringCompare(roleStr, CFSTR("AXWebArea"), 0) == kCFCompareEqualTo) {
        isWebArea = true;
      }
    }
    CFRelease(roleVal);

    if (isWebArea) {
      return TabGroupInspection{};
    }

    if (isTabGroup) {
      TabGroupInspection inspection = inspectTabGroup(elem, ctx);
      if (inspection.valid) {
        return inspection;
      }
    }

    if (!armElement(elem, ctx.deadline)) {
      return TabGroupInspection{};
    }
    CFTypeRef childrenVal = nullptr;
    err = AXUIElementCopyAttributeValue(elem, kAXChildrenAttribute, &childrenVal);
    if (err != kAXErrorSuccess || !childrenVal ||
        CFGetTypeID(childrenVal) != CFArrayGetTypeID()) {
      if (childrenVal) CFRelease(childrenVal);
      return TabGroupInspection{};
    }

    CFArrayRef children = static_cast<CFArrayRef>(childrenVal);
    CFIndex    count    = CFArrayGetCount(children);
    TabGroupInspection found;

    for (CFIndex i = 0; i < count; ++i) {
      if (remainingMs(ctx.deadline) <= 0 || ctx.nodesVisited >= ctx.maxNodes) {
        break;
      }
      AXUIElementRef child = static_cast<AXUIElementRef>(
          const_cast<void*>(CFArrayGetValueAtIndex(children, i)));
      if (!child) continue;

      found = searchForTabStrip(child, currentDepth + 1, ctx);
      if (found.valid) {
        break;
      }
      if (remainingMs(ctx.deadline) <= 0 || ctx.nodesVisited >= ctx.maxNodes) {
        break;
      }
    }

    CFRelease(childrenVal);
    return found;
  }

  AXUIElementRef findWindowByWindowId(AXUIElementRef appElem, CGWindowID targetWindowId,
      std::chrono::steady_clock::time_point deadline) {
    if (!armElement(appElem, deadline)) {
      std::cerr << "controlApp: budget exhausted; window list not requested" << std::endl;
      return nullptr;
    }
    CFTypeRef windowsVal = nullptr;
    AXError err =
        AXUIElementCopyAttributeValue(appElem, kAXWindowsAttribute, &windowsVal);
    if (err != kAXErrorSuccess || !windowsVal ||
        CFGetTypeID(windowsVal) != CFArrayGetTypeID()) {
      if (windowsVal) CFRelease(windowsVal);
      return nullptr;
    }

    auto getWinIdFunc = getAXUIElementGetWindow();
    if (!getWinIdFunc) {
      CFRelease(windowsVal);
      return nullptr;
    }

    CFArrayRef windows = static_cast<CFArrayRef>(windowsVal);
    CFIndex count = CFArrayGetCount(windows);
    AXUIElementRef matchedWindow = nullptr;

    for (CFIndex i = 0; i < count; ++i) {
      AXUIElementRef win = static_cast<AXUIElementRef>(
          const_cast<void*>(CFArrayGetValueAtIndex(windows, i)));
      if (!win) continue;

      if (!armElement(win, deadline)) {
        std::cerr << "controlApp: budget exhausted; remaining windows not queried"
                  << std::endl;
        break;
      }

      CGWindowID wid = 0;
      if (getWinIdFunc(win, &wid) == kAXErrorSuccess && wid == targetWindowId) {
        CFRetain(win);
        matchedWindow = win;
        break;
      }
    }

    CFRelease(windowsVal);
    return matchedWindow;
  }

  std::unordered_map<std::string, AppStateResult> resolveAppStatesInternal(
      const std::vector<std::string>& targets,
      std::chrono::steady_clock::time_point deadline) {
    std::unordered_map<std::string, AppStateResult> cache;

    @autoreleasepool {
      NSArray<NSRunningApplication*>* runningApps =
          [[NSWorkspace sharedWorkspace] runningApplications];
      auto getWinIdFunc = getAXUIElementGetWindow();

      for (const auto& targetStr : targets) {
        if (targetStr.empty()) {
          AppStateResult emptyRes;
          emptyRes.running = false;
          emptyRes.windowsKnown = true;
          cache[targetStr] = emptyRes;
          continue;
        }

        if (cache.find(targetStr) != cache.end()) {
          continue;
        }

        NSString* nsTarget = [NSString stringWithUTF8String:targetStr.c_str()];
        NSRunningApplication* app = findMatchingApp(nsTarget, runningApps);

        AppStateResult res;
        if (!app) {
          res.running = false;
          res.windowsKnown = true;
          cache[targetStr] = res;
          continue;
        }

        res.running = true;
        res.pid = app.processIdentifier;

        if (remainingMs(deadline) <= 0 || !getWinIdFunc) {
          res.windowsKnown = false;
          cache[targetStr] = res;
          continue;
        }

        AXUIElementRef appElem = AXUIElementCreateApplication(res.pid);
        if (!appElem) {
          res.windowsKnown = false;
          cache[targetStr] = res;
          continue;
        }

        if (!armElement(appElem, deadline)) {
          CFRelease(appElem);
          res.windowsKnown = false;
          cache[targetStr] = res;
          continue;
        }

        CFTypeRef windowsVal = nullptr;
        AXError axErr =
            AXUIElementCopyAttributeValue(appElem, kAXWindowsAttribute, &windowsVal);

        if (axErr != kAXErrorSuccess || !windowsVal ||
            CFGetTypeID(windowsVal) != CFArrayGetTypeID()) {
          if (windowsVal) {
            CFRelease(windowsVal);
          }
          CFRelease(appElem);
          res.windowsKnown = false;
          cache[targetStr] = res;
          continue;
        }

        CFArrayRef windowsArray = static_cast<CFArrayRef>(windowsVal);
        CFIndex count = CFArrayGetCount(windowsArray);

        // Enumeration is complete only if every returned window answered its role,
        // subrole and window-id query. A window that fails any of those makes the whole
        // list untrustworthy (the missing entry could be the very window the caller
        // wanted), so the run reports windowsKnown:false with no windows. A window whose
        // query succeeded but which is not a standard window is merely excluded.
        bool complete = true;

        for (CFIndex i = 0; i < count; ++i) {
          if (remainingMs(deadline) <= 0) {
            complete = false;
            break;
          }

          AXUIElementRef winElem = static_cast<AXUIElementRef>(
              const_cast<void*>(CFArrayGetValueAtIndex(windowsArray, i)));
          if (!winElem) {
            complete = false;
            break;
          }

          if (!armElement(winElem, deadline)) {
            complete = false;
            break;
          }

          CFTypeRef roleVal = nullptr;
          AXError rErr =
              AXUIElementCopyAttributeValue(winElem, kAXRoleAttribute, &roleVal);
          if (rErr != kAXErrorSuccess || !roleVal) {
            if (roleVal) CFRelease(roleVal);
            complete = false;
            break;
          }
          bool isWindowRole = false;
          if (CFGetTypeID(roleVal) == CFStringGetTypeID()) {
            isWindowRole =
                CFStringCompare(static_cast<CFStringRef>(roleVal), kAXWindowRole, 0) ==
                kCFCompareEqualTo;
          }
          CFRelease(roleVal);
          if (!isWindowRole) {
            continue;
          }

          if (!armElement(winElem, deadline)) {
            complete = false;
            break;
          }
          CFTypeRef subroleVal = nullptr;
          AXError sErr =
              AXUIElementCopyAttributeValue(winElem, kAXSubroleAttribute, &subroleVal);
          if (sErr != kAXErrorSuccess || !subroleVal) {
            if (subroleVal) CFRelease(subroleVal);
            complete = false;
            break;
          }
          bool isStandardWindow = false;
          if (CFGetTypeID(subroleVal) == CFStringGetTypeID()) {
            isStandardWindow = CFStringCompare(static_cast<CFStringRef>(subroleVal),
                                   kAXStandardWindowSubrole, 0) == kCFCompareEqualTo;
          }
          CFRelease(subroleVal);
          if (!isStandardWindow) {
            continue;
          }

          if (!armElement(winElem, deadline)) {
            complete = false;
            break;
          }
          CGWindowID winId = 0;
          AXError wErr = getWinIdFunc(winElem, &winId);
          if (wErr != kAXErrorSuccess || winId == 0) {
            complete = false;
            break;
          }

          // An unreadable title is tolerated: it degrades to an empty title, which the
          // caller renders as "<App> (window N)". Running out of budget on it is not
          // tolerated, since that means more queries were still pending.
          if (!armElement(winElem, deadline)) {
            complete = false;
            break;
          }
          std::string titleStr = "";
          CFTypeRef   titleVal = nullptr;
          if (AXUIElementCopyAttributeValue(winElem, kAXTitleAttribute, &titleVal) ==
                  kAXErrorSuccess &&
              titleVal) {
            if (CFGetTypeID(titleVal) == CFStringGetTypeID()) {
              NSString* nsTitle = (__bridge NSString*)titleVal;
              titleStr = nsTitle.UTF8String ?: "";
            }
            CFRelease(titleVal);
          }

          res.windows.push_back({winId, titleStr});
        }

        CFRelease(windowsVal);
        CFRelease(appElem);

        if (!complete) {
          res.windows.clear();
          res.windowsKnown = false;
        } else {
          res.windowsKnown = true;
        }
        cache[targetStr] = res;
      }
    }

    return cache;
  }

  Napi::Object formatAppState(Napi::Env env, const AppStateResult& res) {
    Napi::Object obj = Napi::Object::New(env);
    obj.Set("running", Napi::Boolean::New(env, res.running));
    if (res.running) {
      obj.Set("pid", Napi::Number::New(env, res.pid));
    }
    obj.Set("windowsKnown", Napi::Boolean::New(env, res.windowsKnown));

    Napi::Array winArray = Napi::Array::New(env, res.windows.size());
    for (size_t w = 0; w < res.windows.size(); ++w) {
      Napi::Object wObj = Napi::Object::New(env);
      wObj.Set("windowId", Napi::Number::New(env, res.windows[w].windowId));
      wObj.Set("title", Napi::String::New(env, res.windows[w].title));
      winArray.Set(static_cast<uint32_t>(w), wObj);
    }
    obj.Set("windows", winArray);
    return obj;
  }
} // namespace

Native::Native(Napi::Env env, Napi::Object exports) {
  DefineAddon(exports,
      {
          InstanceMethod("movePointer", &Native::movePointer),
          InstanceMethod("simulateKey", &Native::simulateKey),
          InstanceMethod("getActiveWindow", &Native::getActiveWindow),
          InstanceMethod("getOpenWindows", &Native::getOpenWindows),
          InstanceMethod("focusWindow", &Native::focusWindow),
          InstanceMethod("listInstalledApplications", &Native::listInstalledApplications),
          InstanceMethod("getAppStates", &Native::getAppStates),
          InstanceMethod("controlApp", &Native::controlApp),
      });
}

//////////////////////////////////////////////////////////////////////////////////////////

Native::~Native() {
}

//////////////////////////////////////////////////////////////////////////////////////////

void Native::movePointer(const Napi::CallbackInfo& info) {

  // We need to check the number of arguments and their types. If something is wrong, we
  // throw a JavaScript exception.
  Napi::Env env = info.Env();

  if (info.Length() != 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
    Napi::Error::New(env, "Two Numbers expected!").ThrowAsJavaScriptException();
    return;
  }

  int32_t dx = info[0].As<Napi::Number>().Int32Value();
  int32_t dy = info[1].As<Napi::Number>().Int32Value();

  // Get the current mouse position.
  CGEventRef event = CGEventCreate(NULL);
  CGPoint    pos   = CGEventGetLocation(event);
  CFRelease(event);

  // Move the pointer.
  CGWarpMouseCursorPosition(CGPointMake(dx + pos.x, dy + pos.y));
}

//////////////////////////////////////////////////////////////////////////////////////////

void Native::simulateKey(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  // Make sure we have access to the event tap.
  if (!CGRequestPostEventAccess()) {
    Napi::Error::New(env, "Please give accessibility permissions to Kando!")
        .ThrowAsJavaScriptException();
    return;
  }

  // We need to check the number of arguments and their types. If something is wrong, we
  // throw a JavaScript exception.
  if (info.Length() != 2 || !info[0].IsNumber() || !info[1].IsBoolean()) {
    Napi::TypeError::New(env, "Number and Boolean expected").ThrowAsJavaScriptException();
  }

  int32_t keycode = info[0].As<Napi::Number>().Int32Value();
  bool    press   = info[1].As<Napi::Boolean>().Value();

  auto setOrReleaseBit = [](uint32_t& mask, uint32_t bit, bool set) {
    if (set) {
      mask |= bit;
    } else {
      mask &= ~bit;
    }
  };

  // If this is a modifier key, we need to update our internal modifier mask.
  if (keycode == kVK_Command) {
    setOrReleaseBit(mLeftModifierMask, kCGEventFlagMaskCommand, press);
  } else if (keycode == kVK_RightCommand) {
    setOrReleaseBit(mRightModifierMask, kCGEventFlagMaskCommand, press);
  } else if (keycode == kVK_Shift) {
    setOrReleaseBit(mLeftModifierMask, kCGEventFlagMaskShift, press);
  } else if (keycode == kVK_RightShift) {
    setOrReleaseBit(mRightModifierMask, kCGEventFlagMaskShift, press);
  } else if (keycode == kVK_Control) {
    setOrReleaseBit(mLeftModifierMask, kCGEventFlagMaskControl, press);
  } else if (keycode == kVK_RightControl) {
    setOrReleaseBit(mRightModifierMask, kCGEventFlagMaskControl, press);
  } else if (keycode == kVK_Option) {
    setOrReleaseBit(mLeftModifierMask, kCGEventFlagMaskAlternate, press);
  } else if (keycode == kVK_RightOption) {
    setOrReleaseBit(mRightModifierMask, kCGEventFlagMaskAlternate, press);
  }

  // Create a key event.
  CGEventSourceRef src = CGEventSourceCreate(kCGEventSourceStateHIDSystemState);
  if (!src) {
    Napi::Error::New(env, "CGEventSourceCreate failed").ThrowAsJavaScriptException();
    return;
  }
  CGEventRef event = CGEventCreateKeyboardEvent(src, keycode, press);
  CFRelease(src);
  if (!event) {
    Napi::Error::New(env, "CGEventCreateKeyboardEvent failed")
        .ThrowAsJavaScriptException();
    return;
  }

  // Add modifier flags without removing system flags.
  CGEventFlags flags = CGEventGetFlags(event);
  flags |= (mLeftModifierMask | mRightModifierMask);
  CGEventSetFlags(event, flags);

  // Post at session level for reliability.
  CGEventPost(kCGSessionEventTap, event);

  CFRelease(event);
}

//////////////////////////////////////////////////////////////////////////////////////////

Napi::Value Native::getActiveWindow(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  // Set default values.
  Napi::Object result = Napi::Object::New(env);
  result.Set("name", Napi::String::New(env, ""));
  result.Set("app", Napi::String::New(env, ""));

  // We get the PID of the frontmost application and then iterate over all windows to
  // find the first one with the same PID.
  auto app = NSWorkspace.sharedWorkspace.frontmostApplication;

  if (app) {

    std::string appName;

    // We prefer the bundle identifier, but if it is not available we use the
    // localizedName. The former is more portable and more specific.
    if (app.bundleIdentifier) {
      appName = app.bundleIdentifier.UTF8String;
    }

    if (appName.empty() && app.localizedName) {
      appName = app.localizedName.UTF8String;
    }

    result.Set("app", Napi::String::New(env, appName));

    // Now we iterate over all windows and find the first one with the same PID.
    CFArrayRef windows =
        CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly, kCGNullWindowID);

    for (NSMutableDictionary* entry in (NSArray*)windows) {
      NSInteger pid = [[entry objectForKey:(id)kCGWindowOwnerPID] integerValue];

      if (pid == app.processIdentifier) {
        NSString* name = [entry objectForKey:(id)kCGWindowName];

        if (name) {
          result.Set("name", Napi::String::New(env, name.UTF8String));
        } else {
          result.Set(
              "name", Napi::String::New(env, "Missing Screen Recording Permissions"));
          std::cout
              << "Failed to get window name for app " << appName
              << ". Maybe you need to enable screen recording permissions for Kando?"
              << std::endl;
        }

        break;
      }
    }

    CFRelease(windows);
  }

  return result;
}

//////////////////////////////////////////////////////////////////////////////////////////

Napi::Value Native::listInstalledApplications(const Napi::CallbackInfo& info) {
  Napi::Env   env    = info.Env();
  Napi::Array result = Napi::Array::New(env);

  @autoreleasepool {
    // Note: "/System/Library/CoreServices/Applications" is deliberately not listed
    // separately here — it is a subdirectory of "/System/Library/CoreServices" below,
    // so the recursive enumerator already visits it. Listing both produced a duplicate
    // entry (same id, same name) for every app in that folder.
    NSArray<NSString*>* appDirs = @[
      @"/Applications", @"/System/Applications", @"/System/Library/CoreServices",
      [NSHomeDirectory() stringByAppendingPathComponent:@"Applications"],
      [NSHomeDirectory() stringByAppendingPathComponent:@"Library/Applications"]
    ];

    // Guards against the same app bundle being added twice, in case any of the
    // directories above end up overlapping (e.g. one being a subdirectory of another).
    NSMutableSet<NSString*>* seenPaths = [NSMutableSet set];

    NSFileManager* fm = [NSFileManager defaultManager];
    for (NSString* dir in appDirs) {
      NSDirectoryEnumerator* enumerator = [fm enumeratorAtPath:dir];
      NSString*              file;
      while ((file = [enumerator nextObject])) {
        if ([[file pathExtension] isEqualToString:@"app"]) {
          NSString* fullPath = [dir stringByAppendingPathComponent:file];
          if (![seenPaths containsObject:fullPath]) {
            [seenPaths addObject:fullPath];
            Napi::Object appInfo = processAppAtPath(env, fullPath);
            if (!appInfo.IsEmpty()) {
              result.Set(result.Length(), appInfo);
            }
          }
          [enumerator skipDescendants];
        }
      }
    }
  }

  return result;
}

//////////////////////////////////////////////////////////////////////////////////////////

Napi::Value Native::getOpenWindows(const Napi::CallbackInfo& info) {
  Napi::Env   env    = info.Env();
  Napi::Array result = Napi::Array::New(env);

  // Include off-screen/minimized windows as well and avoid desktop-only elements.
  CGWindowListOption listOptions = static_cast<CGWindowListOption>(
      kCGWindowListOptionAll | kCGWindowListExcludeDesktopElements);

  CFArrayRef windows =
      CGWindowListCopyWindowInfo(listOptions, kCGNullWindowID);

  if (!windows) {
    return result;
  }

  uint32_t index = 0;
  for (NSDictionary* entry in (NSArray*)windows) {
    NSString* windowName = [entry objectForKey:(id)kCGWindowName];

    NSInteger pid = [[entry objectForKey:(id)kCGWindowOwnerPID] integerValue];
    if (pid <= 0) {
      continue;
    }

    std::string appName = getAppNameFromPID(static_cast<pid_t>(pid));
    if (appName.empty()) {
      NSString* ownerName = [entry objectForKey:(id)kCGWindowOwnerName];
      if (!ownerName || [ownerName length] == 0) {
        continue;
      }
      appName = ownerName.UTF8String;
    }

    NSString* resolvedWindowName = windowName;
    if (!resolvedWindowName || [resolvedWindowName length] == 0) {
      NSString* ownerName = [entry objectForKey:(id)kCGWindowOwnerName];
      if (ownerName && [ownerName length] > 0) {
        resolvedWindowName = ownerName;
      } else {
        resolvedWindowName = @"Untitled Window";
      }
    }

    Napi::Object obj = Napi::Object::New(env);
    obj.Set("app", Napi::String::New(env, appName));
    obj.Set("window", Napi::String::New(env, resolvedWindowName.UTF8String));
    result.Set(index++, obj);
  }

  CFRelease(windows);
  return result;
}

//////////////////////////////////////////////////////////////////////////////////////////

void Native::focusWindow(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() != 2 || !info[0].IsString() || !info[1].IsString()) {
    Napi::TypeError::New(env, "Two strings expected").ThrowAsJavaScriptException();
    return;
  }

  std::string targetWindowName = info[0].As<Napi::String>().Utf8Value();
  std::string targetAppName    = info[1].As<Napi::String>().Utf8Value();

  if (targetWindowName.empty() || targetAppName.empty()) {
    return;
  }

  NSString* targetWindowNameNs =
      [NSString stringWithUTF8String:targetWindowName.c_str()];

  NSArray<NSRunningApplication*>* runningApps =
      [[NSWorkspace sharedWorkspace] runningApplications];

  // Focusing a window is a control operation, so it gets the same 500 ms budget as the
  // controlApp ops.
  auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(500);

  for (NSRunningApplication* app in runningApps) {
    if (!appMatches(app, targetAppName)) {
      continue;
    }

    if (raiseWindow(app, targetWindowNameNs, deadline)) {
      return;
    }

    // Fallback: At least activate the app if focusing a specific window failed.
    [app activateWithOptions:NSApplicationActivateIgnoringOtherApps];
    return;
  }
}
//////////////////////////////////////////////////////////////////////////////////////////

Napi::Value Native::getAppStates(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsArray()) {
    Napi::TypeError::New(env, "Array of strings expected").ThrowAsJavaScriptException();
    return env.Null();
  }

  Napi::Array targetsArray = info[0].As<Napi::Array>();
  uint32_t len = targetsArray.Length();

  std::vector<std::string> targets;
  targets.reserve(len);
  for (uint32_t i = 0; i < len; ++i) {
    Napi::Value item = targetsArray.Get(i);
    if (item.IsString()) {
      targets.push_back(item.As<Napi::String>().Utf8Value());
    } else {
      targets.push_back("");
    }
  }

  // One shared 150 ms budget for the whole pass: the deadline is captured once and every
  // AX call below arms its element against it.
  auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(150);
  auto cache    = resolveAppStatesInternal(targets, deadline);

  Napi::Array outArray = Napi::Array::New(env, len);
  for (uint32_t i = 0; i < len; ++i) {
    outArray.Set(i, formatAppState(env, cache[targets[i]]));
  }

  return outArray;
}

//////////////////////////////////////////////////////////////////////////////////////////

void Native::controlApp(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 2 || !info[0].IsString() || !info[1].IsString()) {
    Napi::TypeError::New(env, "Target and operation strings expected")
        .ThrowAsJavaScriptException();
    return;
  }

  std::string target = info[0].As<Napi::String>().Utf8Value();
  std::string op = info[1].As<Napi::String>().Utf8Value();

  uint32_t windowId = 0;
  if (info.Length() > 2 && info[2].IsNumber()) {
    windowId = info[2].As<Napi::Number>().Uint32Value();
  }

  pid_t expectedPid = 0;
  if (info.Length() > 3 && info[3].IsNumber()) {
    expectedPid = info[3].As<Napi::Number>().Int32Value();
  }

  const long kControlBudgetMs = 500;
  auto deadline = std::chrono::steady_clock::now() +
                  std::chrono::milliseconds(kControlBudgetMs);

  @autoreleasepool {
    NSArray<NSRunningApplication*>* runningApps =
        [[NSWorkspace sharedWorkspace] runningApplications];

    NSString* nsTarget = [NSString stringWithUTF8String:target.c_str()];
    NSRunningApplication* app = findMatchingApp(nsTarget, runningApps);

    if (!app) {
      std::cerr << "controlApp: application not running: " << target << std::endl;
      return;
    }

    if (expectedPid > 0 && app.processIdentifier != expectedPid) {
      std::cerr << "controlApp: process ID mismatch for " << target
                << " (expected " << expectedPid << ", got " << app.processIdentifier
                << ")" << std::endl;
      return;
    }

    if (op == "quit") {
      [app terminate];
      return;
    }

    if (op == "hide") {
      [app hide];
      return;
    }

    if (op == "activate") {
      if (windowId == 0) {
        if (remainingMs(deadline) <= 0) {
          std::cerr << "controlApp(activate): budget exhausted; app not activated"
                    << std::endl;
          return;
        }
        [app activateWithOptions:NSApplicationActivateIgnoringOtherApps];
        return;
      }

      auto getWinIdFunc = getAXUIElementGetWindow();
      if (!getWinIdFunc) {
        std::cerr << "controlApp(activate): _AXUIElementGetWindow unavailable; "
                     "activating app instead"
                  << std::endl;
        [app activateWithOptions:NSApplicationActivateIgnoringOtherApps];
        return;
      }

      AXUIElementRef appElem = AXUIElementCreateApplication(app.processIdentifier);
      if (!appElem) {
        [app activateWithOptions:NSApplicationActivateIgnoringOtherApps];
        return;
      }

      AXUIElementRef winElem = findWindowByWindowId(appElem, windowId, deadline);
      if (!winElem) {
        std::cerr << "controlApp(activate): window " << windowId
                  << " not resolved for app " << target
                  << "; activating app instead" << std::endl;
        [app activateWithOptions:NSApplicationActivateIgnoringOtherApps];
        CFRelease(appElem);
        return;
      }

      // Unminimize if minimized
      if (armElement(winElem, deadline)) {
        CFTypeRef minVal = nullptr;
        if (AXUIElementCopyAttributeValue(winElem, kAXMinimizedAttribute, &minVal) ==
                kAXErrorSuccess &&
            minVal) {
          if (CFGetTypeID(minVal) == CFBooleanGetTypeID() &&
              CFBooleanGetValue(static_cast<CFBooleanRef>(minVal))) {
            setArmAttribute(
                winElem, kAXMinimizedAttribute, kCFBooleanFalse, deadline,
                "controlApp(activate)");
          }
          CFRelease(minVal);
        }
      }

      if (remainingMs(deadline) > 0) {
        [app activateWithOptions:NSApplicationActivateIgnoringOtherApps];
      } else {
        std::cerr << "controlApp(activate): budget exhausted before activation"
                  << std::endl;
      }
      performArmAction(winElem, kAXRaiseAction, deadline, "controlApp(activate)");
      setArmAttribute(winElem, kAXMainAttribute, kCFBooleanTrue, deadline,
          "controlApp(activate)");
      setArmAttribute(winElem, kAXFocusedAttribute, kCFBooleanTrue, deadline,
          "controlApp(activate)");

      CFRelease(winElem);
      CFRelease(appElem);
      return;
    }

    if (op == "close-window") {
      if (windowId == 0) {
        std::cerr << "controlApp(close-window): windowId required" << std::endl;
        return;
      }

      auto getWinIdFunc = getAXUIElementGetWindow();
      if (!getWinIdFunc) {
        std::cerr << "controlApp(close-window): _AXUIElementGetWindow unavailable; "
                     "failing safe"
                  << std::endl;
        return;
      }

      AXUIElementRef appElem = AXUIElementCreateApplication(app.processIdentifier);
      if (!appElem) {
        return;
      }

      AXUIElementRef winElem = findWindowByWindowId(appElem, windowId, deadline);
      if (!winElem) {
        std::cerr << "controlApp(close-window): window " << windowId
                  << " not found for app " << target << "; failing safe" << std::endl;
        CFRelease(appElem);
        return;
      }

      if (armElement(winElem, deadline)) {
        CFTypeRef closeButton = nullptr;
        AXError err =
            AXUIElementCopyAttributeValue(winElem, kAXCloseButtonAttribute, &closeButton);
        if (err == kAXErrorSuccess && closeButton) {
          performArmAction(static_cast<AXUIElementRef>(closeButton), kAXPressAction,
              deadline, "controlApp(close-window)");
          CFRelease(closeButton);
        } else {
          std::cerr << "controlApp(close-window): close button not found for window "
                    << windowId << std::endl;
          if (closeButton) CFRelease(closeButton);
        }
      } else {
        std::cerr << "controlApp(close-window): budget exhausted; window not closed"
                  << std::endl;
      }

      CFRelease(winElem);
      CFRelease(appElem);
      return;
    }

    if (op == "close-tab") {
      NSString* bundleId = app.bundleIdentifier;
      if (!bundleId) {
        std::cerr << "controlApp(close-tab): no bundle identifier; fail closed"
                  << std::endl;
        return;
      }

      const TabStripRule* rule = findTabStripRule(bundleId);
      if (!rule) {
        std::cerr << "controlApp(close-tab): app " << bundleId.UTF8String
                  << " not in allowlist; fail closed" << std::endl;
        return;
      }

      // The tab-strip rules were written from reasoning about how browsers lay out their
      // AX trees, never checked against a tree captured from these apps. An unverified
      // rule stays a no-op unless KANDO_UNVERIFIED_TAB_CLOSE=1 was set at process start,
      // which exists purely so the rule can be validated; it is not a supported mode.
      if (!rule->verified && !kUnverifiedTabCloseAllowed) {
        std::cerr << "controlApp(close-tab): the tab-strip rule for "
                  << bundleId.UTF8String
                  << " is unverified (no captured AX tree) and close-tab is disabled. Set"
                     " KANDO_UNVERIFIED_TAB_CLOSE=1 in Kando's environment before "
                     "starting it to validate the rule; do not ship that setting."
                  << std::endl;
        return;
      }

      if (windowId == 0) {
        std::cerr << "controlApp(close-tab): windowId required; fail closed"
                  << std::endl;
        return;
      }

      auto getWinIdFunc = getAXUIElementGetWindow();
      if (!getWinIdFunc) {
        std::cerr << "controlApp(close-tab): _AXUIElementGetWindow unavailable; fail closed"
                  << std::endl;
        return;
      }

      AXUIElementRef appElem = AXUIElementCreateApplication(app.processIdentifier);
      if (!appElem) {
        return;
      }

      // Runs the remaining budget down while waiting for the window server; false
      // means the budget ran out or the settle time is unaffordable, and the caller
      // must fail closed and not post anything.
      auto sleepWithinBudget = [&](useconds_t microseconds) {
        long rem = remainingMs(deadline);
        if (rem <= 0) {
          return false;
        }
        if (static_cast<unsigned long long>(rem) * 1000ULL < microseconds) {
          return false;
        }
        useconds_t sleepDuration =
            std::min(microseconds, static_cast<useconds_t>(rem * 1000L));
        usleep(sleepDuration);
        return remainingMs(deadline) > 0;
      };

      if (rule->needsManualAccessibility) {
        if (!setArmAttribute(appElem, CFSTR("AXManualAccessibility"), kCFBooleanTrue,
                deadline, "controlApp(close-tab)")) {
          std::cerr << "controlApp(close-tab): could not enable AXManualAccessibility; "
                       "fail closed"
                    << std::endl;
          CFRelease(appElem);
          return;
        }
        if (!sleepWithinBudget(50000)) {
          std::cerr << "controlApp(close-tab): budget exhausted while waiting for "
                       "AXManualAccessibility; fail closed"
                    << std::endl;
          CFRelease(appElem);
          return;
        }
      }

      AXUIElementRef winElem = findWindowByWindowId(appElem, windowId, deadline);
      if (!winElem) {
        std::cerr << "controlApp(close-tab): window " << windowId << " not found for app "
                  << target << "; fail closed" << std::endl;
        CFRelease(appElem);
        return;
      }

      // Logs and releases both elements. Every failure path below ends here.
      auto failClosed = [&](const char* reason) {
        std::cerr << "controlApp(close-tab): " << reason << "; fail closed" << std::endl;
        CFRelease(winElem);
        CFRelease(appElem);
      };

      TabSearchContext ctx;
      ctx.nodesVisited    = 0;
      ctx.maxNodes        = 400;
      ctx.maxDepth        = 6;
      ctx.maxWebAreaDepth = 8;
      ctx.deadline        = deadline;
      ctx.windowFrame     = getElementFrame(winElem, deadline);

      // (a) A real browser window contains page content, i.e. an AXWebArea. A native
      // tabbed settings window does not, so we require a web area before trusting any
      // tab strip. This is a structural rule, not derived from captured AX trees; it
      // needs a live validation per app.
      if (!containsWebArea(winElem, 0, ctx)) {
        failClosed("no AXWebArea in the window subtree");
        return;
      }

      // (b)-(d) The candidate must be a window-level tab strip: in the top 160pt of the
      // window, spanning >= 50% of its width, with >= 2 horizontally laid out tabs of
      // which exactly one is selected.
      TabGroupInspection inspection = searchForTabStrip(winElem, 0, ctx);
      if (!inspection.valid) {
        std::cerr << "controlApp(close-tab): no qualified window-level tab strip (largest "
                     "candidate had "
                  << ctx.maxCandidateTabs << " tabs); fail closed" << std::endl;
        CFRelease(winElem);
        CFRelease(appElem);
        return;
      }

      if (armElement(winElem, deadline)) {
        CFTypeRef minVal = nullptr;
        if (AXUIElementCopyAttributeValue(winElem, kAXMinimizedAttribute, &minVal) ==
                kAXErrorSuccess &&
            minVal) {
          if (CFGetTypeID(minVal) == CFBooleanGetTypeID() &&
              CFBooleanGetValue(static_cast<CFBooleanRef>(minVal))) {
            setArmAttribute(winElem, kAXMinimizedAttribute, kCFBooleanFalse, deadline,
                "controlApp(close-tab)");
          }
          CFRelease(minVal);
        }
      }

      if (remainingMs(deadline) <= 0) {
        failClosed("budget exhausted before focusing the window");
        return;
      }
      [app activateWithOptions:NSApplicationActivateIgnoringOtherApps];
      performArmAction(winElem, kAXRaiseAction, deadline, "controlApp(close-tab)");
      setArmAttribute(winElem, kAXMainAttribute, kCFBooleanTrue, deadline,
          "controlApp(close-tab)");
      setArmAttribute(winElem, kAXFocusedAttribute, kCFBooleanTrue, deadline,
          "controlApp(close-tab)");

      if (!sleepWithinBudget(30000)) {
        failClosed("budget exhausted while waiting for the window to focus");
        return;
      }

      auto getActiveWindowId = [&]() -> CGWindowID {
        CFTypeRef focusedWinVal = nullptr;
        if (armElement(appElem, deadline) &&
            AXUIElementCopyAttributeValue(
                appElem, kAXFocusedWindowAttribute, &focusedWinVal) == kAXErrorSuccess &&
            focusedWinVal) {
          CGWindowID wid = 0;
          if (armElement(static_cast<AXUIElementRef>(focusedWinVal), deadline) &&
              getWinIdFunc(static_cast<AXUIElementRef>(focusedWinVal), &wid) ==
                  kAXErrorSuccess) {
            CFRelease(focusedWinVal);
            return wid;
          }
          CFRelease(focusedWinVal);
        }
        if (armElement(appElem, deadline) &&
            AXUIElementCopyAttributeValue(
                appElem, kAXMainWindowAttribute, &focusedWinVal) == kAXErrorSuccess &&
            focusedWinVal) {
          CGWindowID wid = 0;
          if (armElement(static_cast<AXUIElementRef>(focusedWinVal), deadline) &&
              getWinIdFunc(static_cast<AXUIElementRef>(focusedWinVal), &wid) ==
                  kAXErrorSuccess) {
            CFRelease(focusedWinVal);
            return wid;
          }
          CFRelease(focusedWinVal);
        }
        return 0;
      };

      CGWindowID activeWid = getActiveWindowId();
      if (activeWid != static_cast<CGWindowID>(windowId)) {
        if (!sleepWithinBudget(50000)) {
          failClosed("budget exhausted while waiting for the window to activate");
          return;
        }
        activeWid = getActiveWindowId();
        if (activeWid != static_cast<CGWindowID>(windowId)) {
          failClosed("active window mismatch while waiting for the window to activate");
          return;
        }
      }

      if (remainingMs(deadline) <= 0) {
        failClosed("budget exhausted before posting the key event");
        return;
      }

      if (!CGPreflightPostEventAccess()) {
        failClosed("CGPreflightPostEventAccess() returned false");
        return;
      }

      CGEventSourceRef src = CGEventSourceCreate(kCGEventSourceStateHIDSystemState);
      if (!src) {
        failClosed("CGEventSourceCreate failed");
        return;
      }

      CGEventRef keyDown =
          CGEventCreateKeyboardEvent(src, static_cast<CGKeyCode>(kVK_ANSI_W), true);
      CGEventRef keyUp =
          CGEventCreateKeyboardEvent(src, static_cast<CGKeyCode>(kVK_ANSI_W), false);
      if (!keyDown || !keyUp) {
        if (keyDown) CFRelease(keyDown);
        if (keyUp) CFRelease(keyUp);
        CFRelease(src);
        failClosed("CGEventCreateKeyboardEvent failed");
        return;
      }

      CGEventSetFlags(keyDown, kCGEventFlagMaskCommand);
      CGEventSetFlags(keyUp, kCGEventFlagMaskCommand);

      auto failWithEvents = [&](const char* reason) {
        CFRelease(keyDown);
        CFRelease(keyUp);
        CFRelease(src);
        failClosed(reason);
      };

      // The event is posted to the target pid, but the key window belongs to whichever
      // app is frontmost, so the target must own the keyboard focus at this exact moment.
      // Otherwise Command+W would close a tab of whatever is frontmost instead. One
      // retry, then fail closed.
      auto targetIsFrontmost = [&]() {
        NSRunningApplication* frontmost =
            NSWorkspace.sharedWorkspace.frontmostApplication;
        return frontmost != nil &&
               frontmost.processIdentifier == app.processIdentifier;
      };

      if (!targetIsFrontmost()) {
        if (remainingMs(deadline) <= 0) {
          failWithEvents("budget exhausted before re-focusing the app");
          return;
        }
        BOOL activated =
            [app activateWithOptions:NSApplicationActivateIgnoringOtherApps];
        bool raised = performArmAction(
            winElem, kAXRaiseAction, deadline, "controlApp(close-tab)");
        bool setMain = setArmAttribute(
            winElem, kAXMainAttribute, kCFBooleanTrue, deadline, "controlApp(close-tab)");
        bool setFocused = setArmAttribute(winElem, kAXFocusedAttribute,
            kCFBooleanTrue, deadline, "controlApp(close-tab)");
        if (!activated || !raised || !setMain || !setFocused) {
          failWithEvents("refocus operations failed in retry");
          return;
        }
        if (!sleepWithinBudget(50000)) {
          failWithEvents("budget exhausted while waiting for the app to refocus");
          return;
        }
      }

      // Revalidate both the frontmost app PID and the selected window ID immediately
      // before posting Command+W. Any refocus, sleep, or window switch invalidates prior
      // checks.
      if (remainingMs(deadline) <= 0) {
        failWithEvents("budget exhausted before posting the key event");
        return;
      }

      if (!targetIsFrontmost()) {
        failWithEvents("the target application is not frontmost immediately before posting");
        return;
      }

      CGWindowID finalActiveWid = getActiveWindowId();
      if (finalActiveWid != static_cast<CGWindowID>(windowId)) {
        failWithEvents("active window mismatch immediately before posting");
        return;
      }

      if (remainingMs(deadline) <= 0) {
        failWithEvents("budget exhausted after window lookup before posting");
        return;
      }

      if (!targetIsFrontmost()) {
        failWithEvents("the target application is not frontmost immediately before posting");
        return;
      }
      CGEventPostToPid(app.processIdentifier, keyDown);
      CGEventPostToPid(app.processIdentifier, keyUp);
      CFRelease(keyDown);
      CFRelease(keyUp);
      CFRelease(src);

      CFRelease(winElem);
      CFRelease(appElem);
      return;
    }

    std::cerr << "controlApp: unknown operation " << op << std::endl;
  }
}

//////////////////////////////////////////////////////////////////////////////////////////

// This generates the addon and makes it available to JavaScript.
NODE_API_ADDON(Native)

//////////////////////////////////////////////////////////////////////////////////////////
