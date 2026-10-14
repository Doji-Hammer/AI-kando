//////////////////////////////////////////////////////////////////////////////////////////
//   _  _ ____ _  _ ___  ____                                                           //
//   |_/  |__| |\ | |  \ |  |    This file belongs to Kando, the cross-platform         //
//   | \_ |  | | \| |__/ |__|    pie menu. Read more on github.com/kando-menu/kando     //
//                                                                                      //
//////////////////////////////////////////////////////////////////////////////////////////

// SPDX-FileCopyrightText: Simon Schneegans <code@simonschneegans.de>
// SPDX-License-Identifier: MIT

import { expect } from 'chai';

import { SelectionSource, Vec2 } from '../src/common';
import { Modifiers } from '../src/common/app-switcher';
import {
  ButtonState,
  InputState,
  SelectionType,
} from '../src/menu-renderer/input-methods/input-method';
import { PointerInput } from '../src/menu-renderer/input-methods/pointer-input';

const CENTER: Vec2 = { x: 500, y: 400 };
const DRAG_THRESHOLD = 15;
const EXCURSION = DRAG_THRESHOLD + 85;

const NO_LIVE_MODIFIERS: Modifiers = {
  ctrl: false,
  meta: false,
  alt: false,
  shift: false,
};
const CTRL_ONLY: Modifiers = { ctrl: true, meta: false, alt: false, shift: false };

type FakeEventInit = {
  button?: number;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  pointerType?: string;
  coalescedEvents?: FakePointerEvent[];
};

/**
 * Stands in for the DOM MouseEvent. PointerInput branches on `instanceof MouseEvent`, so
 * the global constructor has to exist in Node and match the events the tests dispatch.
 */
class FakeMouseEvent {
  public readonly clientX: number;
  public readonly clientY: number;
  public readonly button: number;
  public readonly ctrlKey: boolean;
  public readonly metaKey: boolean;
  public readonly altKey: boolean;
  public readonly shiftKey: boolean;
  public preventedDefault = false;
  public stoppedPropagation = false;

  constructor(clientX = 0, clientY = 0, init: FakeEventInit = {}) {
    this.clientX = clientX;
    this.clientY = clientY;
    this.button = init.button ?? 0;
    this.ctrlKey = init.ctrlKey ?? false;
    this.metaKey = init.metaKey ?? false;
    this.altKey = init.altKey ?? false;
    this.shiftKey = init.shiftKey ?? false;
  }

  public preventDefault(): void {
    this.preventedDefault = true;
  }

  public stopPropagation(): void {
    this.stoppedPropagation = true;
  }
}

/** Stands in for the DOM PointerEvent, including its coalesced motion samples. */
class FakePointerEvent extends FakeMouseEvent {
  public readonly pointerType: string;
  private readonly coalescedEvents: FakePointerEvent[];

  constructor(clientX = 0, clientY = 0, init: FakeEventInit = {}) {
    super(clientX, clientY, init);
    this.pointerType = init.pointerType ?? 'mouse';
    this.coalescedEvents = init.coalescedEvents ?? [];
  }

  public getCoalescedEvents(): FakePointerEvent[] {
    return this.coalescedEvents;
  }
}

/** Stands in for the DOM TouchEvent. `update()` probes its candidates with it. */
class FakeTouchEvent {
  public readonly touches: Array<{ clientX: number; clientY: number }> = [];

  public preventDefault(): void {}

  public stopPropagation(): void {}
}

const animationFrameCallbacks: Array<() => void> = [];

/** Runs the queued requestAnimationFrame callbacks, releasing the motion throttle. */
function flushAnimationFrames(): void {
  while (animationFrameCallbacks.length > 0) {
    const callback = animationFrameCallbacks.shift();
    if (callback) {
      callback();
    }
  }
}

/** Routes a synthetic event to the matching PointerInput entry point. */
function fire(kind: 'down' | 'up' | 'motion', event: FakeMouseEvent): void {
  const domEvent = event as unknown as MouseEvent;
  if (kind === 'down') {
    input.onPointerDownEvent(domEvent);
  } else if (kind === 'up') {
    input.onPointerUpEvent(domEvent);
  } else {
    input.onMotionEvent(domEvent);
  }
}

/**
 * Drains the two motion events which onShowMenu asks PointerInput to ignore, so that the
 * next motion event reaches the throttle and the state machine.
 */
function consumeIgnoredMotionEvents(): void {
  fire('motion', new FakePointerEvent(CENTER.x, CENTER.y));
  fire('motion', new FakePointerEvent(CENTER.x, CENTER.y));
}

/** Every recorded selection must be free of live modifiers. */
function expectNoLiveModifiers(): void {
  for (const selection of selections) {
    expect(
      selection.modifiers,
      'a selection must not carry live modifiers'
    ).to.deep.equal(NO_LIVE_MODIFIERS);
  }
}

type RecordedSelection = {
  position: Vec2;
  type: SelectionType;
  source: SelectionSource;
  modifiers: Modifiers;
};

let input: PointerInput;
let selections: RecordedSelection[];
let closeCalls: number;
let states: InputState[];

describe('PointerInput', () => {
  const globalScope = globalThis as unknown as Record<string, unknown>;
  const globalKeys = [
    'MouseEvent',
    'PointerEvent',
    'TouchEvent',
    'requestAnimationFrame',
  ];
  const savedGlobals = new Map<string, unknown>();

  before(() => {
    for (const key of globalKeys) {
      savedGlobals.set(key, globalScope[key]);
    }

    globalScope.MouseEvent = FakeMouseEvent;
    globalScope.PointerEvent = FakePointerEvent;
    globalScope.TouchEvent = FakeTouchEvent;
    globalScope.requestAnimationFrame = (callback: () => void): number => {
      animationFrameCallbacks.push(callback);
      return animationFrameCallbacks.length;
    };
  });

  after(() => {
    for (const [key, value] of savedGlobals) {
      if (value === undefined) {
        delete globalScope[key];
      } else {
        globalScope[key] = value;
      }
    }
  });

  beforeEach(() => {
    animationFrameCallbacks.length = 0;
    selections = [];
    closeCalls = 0;
    states = [];

    input = new PointerInput();
    input.dragThreshold = DRAG_THRESHOLD;
    input.onSelection((position, type, source, modifiers) => {
      selections.push({ position, type, source, modifiers });
    });
    input.onUpdateState((state) => states.push(state));
    input.onCloseMenu(() => {
      closeCalls += 1;
    });

    input.setCurrentCenter(CENTER, 40);
    input.onShowMenu(false);
  });

  describe('click modifier eligibility', () => {
    it('carries held modifiers for a plain primary click', () => {
      fire('down', new FakePointerEvent(CENTER.x, CENTER.y, { ctrlKey: true }));
      fire('up', new FakePointerEvent(CENTER.x, CENTER.y, { ctrlKey: true }));

      expect(selections).to.have.length(1);
      expect(selections[0].modifiers).to.deep.equal(CTRL_ONLY);
      expect(selections[0].type).to.equal(SelectionType.eActiveItem);
      expect(selections[0].source).to.equal(SelectionSource.eClick);
    });

    it('carries no modifiers when the click was made with no modifier held', () => {
      fire('down', new FakePointerEvent(CENTER.x, CENTER.y));
      fire('up', new FakePointerEvent(CENTER.x, CENTER.y));

      expect(selections).to.have.length(1);
      expect(selections[0].modifiers).to.deep.equal(NO_LIVE_MODIFIERS);
    });

    it('treats a release just inside the drag threshold as a click', () => {
      fire('down', new FakePointerEvent(CENTER.x, CENTER.y));
      fire(
        'up',
        new FakePointerEvent(CENTER.x + DRAG_THRESHOLD - 1, CENTER.y, {
          ctrlKey: true,
        })
      );

      expect(selections).to.have.length(1);
      expect(selections[0].modifiers).to.deep.equal(CTRL_ONLY);
    });

    it('treats a release exactly at the drag threshold as neutral', () => {
      fire('down', new FakePointerEvent(CENTER.x, CENTER.y));
      fire(
        'up',
        new FakePointerEvent(CENTER.x + DRAG_THRESHOLD, CENTER.y, {
          ctrlKey: true,
        })
      );

      expect(selections).to.have.length(1);
      expect(selections[0].modifiers).to.deep.equal(NO_LIVE_MODIFIERS);
    });

    it('stays neutral when only the release is displaced', () => {
      fire('down', new FakePointerEvent(CENTER.x, CENTER.y));
      fire('up', new FakePointerEvent(CENTER.x + EXCURSION, CENTER.y, { ctrlKey: true }));

      expect(selections).to.have.length(1);
      expectNoLiveModifiers();
    });
  });

  describe('motion excursions', () => {
    it('stays neutral after a processed move left the click zone and returned', () => {
      fire('down', new FakePointerEvent(CENTER.x, CENTER.y));
      consumeIgnoredMotionEvents();
      fire('motion', new FakePointerEvent(CENTER.x + EXCURSION, CENTER.y));
      fire('up', new FakePointerEvent(CENTER.x, CENTER.y, { ctrlKey: true }));

      expect(selections).to.have.length(1);
      expectNoLiveModifiers();
    });

    it('stays neutral when the excursion arrives while motion throttling is active', () => {
      fire('down', new FakePointerEvent(CENTER.x, CENTER.y));
      consumeIgnoredMotionEvents();
      fire('motion', new FakePointerEvent(CENTER.x, CENTER.y));
      expect(
        animationFrameCallbacks,
        'the processed move must arm the throttle'
      ).to.have.length(1);

      fire('motion', new FakePointerEvent(CENTER.x + EXCURSION, CENTER.y));
      fire('up', new FakePointerEvent(CENTER.x, CENTER.y, { ctrlKey: true }));

      expect(selections).to.have.length(1);
      expectNoLiveModifiers();
    });

    it('releases the throttle once the animation frame runs', () => {
      fire('down', new FakePointerEvent(CENTER.x, CENTER.y));
      consumeIgnoredMotionEvents();
      fire('motion', new FakePointerEvent(CENTER.x, CENTER.y));
      flushAnimationFrames();

      fire('motion', new FakePointerEvent(CENTER.x + EXCURSION, CENTER.y));
      fire('up', new FakePointerEvent(CENTER.x, CENTER.y, { ctrlKey: true }));

      expect(selections).to.have.length(1);
      expectNoLiveModifiers();
    });

    it('stays neutral when the excursion arrives while motion events are ignored', () => {
      fire('down', new FakePointerEvent(CENTER.x, CENTER.y));
      fire('motion', new FakePointerEvent(CENTER.x + EXCURSION, CENTER.y));
      expect(
        animationFrameCallbacks,
        'an ignored motion event must not arm the throttle'
      ).to.have.length(0);

      fire('up', new FakePointerEvent(CENTER.x, CENTER.y, { ctrlKey: true }));

      expect(selections).to.have.length(1);
      expectNoLiveModifiers();
    });

    it('stays neutral when a coalesced sample left the click zone', () => {
      fire('down', new FakePointerEvent(CENTER.x, CENTER.y));
      consumeIgnoredMotionEvents();
      fire(
        'motion',
        new FakePointerEvent(CENTER.x, CENTER.y, {
          coalescedEvents: [new FakePointerEvent(CENTER.x + EXCURSION, CENTER.y)],
        })
      );
      fire('up', new FakePointerEvent(CENTER.x, CENTER.y, { ctrlKey: true }));

      expect(selections).to.have.length(1);
      expectNoLiveModifiers();
    });
  });

  describe('gesture cancellation and menu lifetime', () => {
    it('stays neutral when the press was cancelled before the release', () => {
      fire('down', new FakePointerEvent(CENTER.x, CENTER.y, { ctrlKey: true }));
      input.cancelGesture();
      fire('up', new FakePointerEvent(CENTER.x, CENTER.y, { ctrlKey: true }));

      expect(selections).to.have.length(1);
      expectNoLiveModifiers();
    });

    it('ignores a release without a preceding press', () => {
      fire('up', new FakePointerEvent(CENTER.x, CENTER.y, { ctrlKey: true }));

      expect(selections, 'a release without a press must not select').to.have.length(0);
      expectNoLiveModifiers();
    });

    it('stays neutral for a press held across a menu change', () => {
      fire('down', new FakePointerEvent(CENTER.x, CENTER.y, { ctrlKey: true }));
      input.onShowMenu(false);
      fire('up', new FakePointerEvent(CENTER.x, CENTER.y, { ctrlKey: true }));

      expect(selections).to.have.length(0);
      expectNoLiveModifiers();
    });
  });

  describe('secondary buttons', () => {
    it('closes the menu on a right-button press', () => {
      fire(
        'down',
        new FakePointerEvent(CENTER.x, CENTER.y, { button: 2, ctrlKey: true })
      );

      expect(closeCalls).to.equal(1);
      expect(selections).to.have.length(0);
      expectNoLiveModifiers();
    });

    it('stays neutral on a right-button release', () => {
      fire('down', new FakePointerEvent(CENTER.x, CENTER.y, { button: 2 }));
      fire('up', new FakePointerEvent(CENTER.x, CENTER.y, { button: 2, ctrlKey: true }));

      expect(selections).to.have.length(0);
      expectNoLiveModifiers();
    });

    it('stays neutral when a primary press ends on a right-button release', () => {
      fire('down', new FakePointerEvent(CENTER.x, CENTER.y));
      fire('up', new FakePointerEvent(CENTER.x, CENTER.y, { button: 2, ctrlKey: true }));

      expect(selections).to.have.length(1);
      expectNoLiveModifiers();
    });

    it('selects the parent with neutral modifiers on a mouse-back press', () => {
      fire(
        'down',
        new FakePointerEvent(CENTER.x, CENTER.y, { button: 3, ctrlKey: true })
      );

      expect(selections).to.have.length(1);
      expect(selections[0].type).to.equal(SelectionType.eParent);
      expect(selections[0].source).to.equal(SelectionSource.eClick);
      expect(selections[0].modifiers).to.deep.equal(NO_LIVE_MODIFIERS);
    });
  });

  describe('touch and pen input', () => {
    it('stays neutral for touch input', () => {
      fire(
        'down',
        new FakePointerEvent(CENTER.x, CENTER.y, {
          ctrlKey: true,
          pointerType: 'touch',
        })
      );
      fire(
        'up',
        new FakePointerEvent(CENTER.x, CENTER.y, {
          ctrlKey: true,
          pointerType: 'touch',
        })
      );

      expect(selections).to.have.length(1);
      expectNoLiveModifiers();
    });

    it('stays neutral for pen input', () => {
      fire(
        'down',
        new FakePointerEvent(CENTER.x, CENTER.y, {
          ctrlKey: true,
          pointerType: 'pen',
        })
      );
      fire(
        'up',
        new FakePointerEvent(CENTER.x, CENTER.y, {
          ctrlKey: true,
          pointerType: 'pen',
        })
      );

      expect(selections).to.have.length(1);
      expectNoLiveModifiers();
    });

    it('stays neutral when a pen release ends a mouse press', () => {
      fire('down', new FakePointerEvent(CENTER.x, CENTER.y));
      fire(
        'up',
        new FakePointerEvent(CENTER.x, CENTER.y, {
          ctrlKey: true,
          pointerType: 'pen',
        })
      );

      expect(selections).to.have.length(1);
      expectNoLiveModifiers();
    });

    it('stays neutral when a touch release ends a mouse press', () => {
      fire('down', new FakePointerEvent(CENTER.x, CENTER.y));
      fire(
        'up',
        new FakePointerEvent(CENTER.x, CENTER.y, {
          ctrlKey: true,
          pointerType: 'touch',
        })
      );

      expect(selections).to.have.length(1);
      expectNoLiveModifiers();
    });
  });

  describe('preserved click behaviour', () => {
    it('still selects on an unmodified click', () => {
      const downEvent = new FakePointerEvent(CENTER.x, CENTER.y);
      fire('down', downEvent);
      fire('up', new FakePointerEvent(CENTER.x, CENTER.y));

      expect(selections).to.have.length(1);
      expect(selections[0].type).to.equal(SelectionType.eActiveItem);
      expect(selections[0].source).to.equal(SelectionSource.eClick);
      expect(selections[0].position).to.deep.equal(CENTER);
      expect(selections[0].modifiers).to.deep.equal(NO_LIVE_MODIFIERS);
      expect(downEvent.preventedDefault).to.equal(true);
      expect(downEvent.stoppedPropagation).to.equal(true);
      expect(states.some((state) => state.button === ButtonState.eClicked)).to.equal(
        true
      );
    });

    it('treats a plain MouseEvent without pointerType as a mouse click', () => {
      fire('down', new FakeMouseEvent(CENTER.x, CENTER.y, { ctrlKey: true }));
      fire('up', new FakeMouseEvent(CENTER.x, CENTER.y, { ctrlKey: true }));

      expect(selections).to.have.length(1);
      expect(selections[0].modifiers).to.deep.equal(CTRL_ONLY);
    });
  });
});
