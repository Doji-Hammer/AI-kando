//////////////////////////////////////////////////////////////////////////////////////////
//   _  _ ____ _  _ ___  ____                                                           //
//   |_/  |__| |\ | |  \ |  |    This file belongs to Kando, the cross-platform         //
//   | \_ |  | | \| |__/ |__|    pie menu. Read more on github.com/kando-menu/kando     //
//                                                                                      //
//////////////////////////////////////////////////////////////////////////////////////////

// SPDX-FileCopyrightText: Simon Schneegans <code@simonschneegans.de>
// SPDX-License-Identifier: MIT

import React from 'react';
import i18next from 'i18next';
import classNames from 'classnames/bind';

import {
  Modifiers,
  QuickCloseAction,
  QuickCloseBindings,
} from '../../../common/app-switcher';
import { validateQuickCloseBinding } from '../../../common/quick-close-validation';
import Button from './Button';

import * as classes from './ModifierRecorder.module.scss';
const cx = classNames.bind(classes);

/** Resolves an event's key or code to a Modifiers property name, if it is a modifier. */
export function getModifierFromEvent(key: string, code?: string): keyof Modifiers | null {
  if (key === 'Control' || code?.startsWith('Control')) {
    return 'ctrl';
  }
  if (key === 'Meta' || code?.startsWith('Meta')) {
    return 'meta';
  }
  if (key === 'Alt' || code?.startsWith('Alt')) {
    return 'alt';
  }
  if (key === 'Shift' || code?.startsWith('Shift')) {
    return 'shift';
  }
  return null;
}

/** Formats a modifier combination into an array of chip labels. */
export function formatModifierChips(
  combo: Modifiers,
  isMac: boolean = typeof cIsMac !== 'undefined' ? cIsMac : true
): string[] {
  const chips: string[] = [];
  if (combo.ctrl) {
    chips.push('Ctrl');
  }
  if (combo.meta) {
    chips.push(isMac ? 'Cmd' : 'Super');
  }
  if (combo.alt) {
    chips.push(isMac ? 'Option' : 'Alt');
  }
  if (combo.shift) {
    chips.push('Shift');
  }
  return chips;
}

export type SessionEventResult =
  | { type: 'continue'; active: Modifiers; largest: Modifiers }
  | { type: 'commit'; combo: Modifiers }
  | { type: 'cancel' }
  | { type: 'ignore' };

/**
 * Pure state machine tracking modifier keys held during a recording session.
 *
 * Rules:
 *
 * - Commits the largest held modifier set when all modifiers are released.
 * - Commits immediately when a non-modifier key is pressed together with held modifiers.
 * - Escape cancels recording.
 * - Plain keys without modifiers are ignored.
 * - Enter and Space before any modifier was seen are ignored (covers the key that activated
 *   Change).
 */
export class ModifierRecorderSession {
  private active: Modifiers = { ctrl: false, meta: false, alt: false, shift: false };
  private largest: Modifiers = { ctrl: false, meta: false, alt: false, shift: false };
  private hasSeenModifier = false;

  public getActive(): Modifiers {
    return { ...this.active };
  }

  public getLargest(): Modifiers {
    return { ...this.largest };
  }

  public handleKeyDown(event: {
    key: string;
    code?: string;
    ctrlKey?: boolean;
    metaKey?: boolean;
    altKey?: boolean;
    shiftKey?: boolean;
  }): SessionEventResult {
    if (event.key === 'Escape') {
      return { type: 'cancel' };
    }

    const mod = getModifierFromEvent(event.key, event.code);

    if (mod) {
      this.hasSeenModifier = true;
      this.active[mod] = true;

      if (event.ctrlKey) {
        this.active.ctrl = true;
      }
      if (event.metaKey) {
        this.active.meta = true;
      }
      if (event.altKey) {
        this.active.alt = true;
      }
      if (event.shiftKey) {
        this.active.shift = true;
      }

      const activeCount =
        (this.active.ctrl ? 1 : 0) +
        (this.active.meta ? 1 : 0) +
        (this.active.alt ? 1 : 0) +
        (this.active.shift ? 1 : 0);
      const largestCount =
        (this.largest.ctrl ? 1 : 0) +
        (this.largest.meta ? 1 : 0) +
        (this.largest.alt ? 1 : 0) +
        (this.largest.shift ? 1 : 0);

      if (activeCount > largestCount) {
        this.largest = { ...this.active };
      }

      return {
        type: 'continue',
        active: { ...this.active },
        largest: { ...this.largest },
      };
    }

    // Blanket rule: ignore Enter/Space before any modifier was seen (covers the key that activated Change).
    if (!this.hasSeenModifier && (event.key === 'Enter' || event.key === ' ')) {
      return { type: 'ignore' };
    }
    const currentHeld: Modifiers = {
      ctrl: this.active.ctrl || Boolean(event.ctrlKey),
      meta: this.active.meta || Boolean(event.metaKey),
      alt: this.active.alt || Boolean(event.altKey),
      shift: this.active.shift || Boolean(event.shiftKey),
    };

    const anyHeld =
      currentHeld.ctrl || currentHeld.meta || currentHeld.alt || currentHeld.shift;

    if (anyHeld) {
      return { type: 'commit', combo: currentHeld };
    }
    return { type: 'ignore' };
  }

  public handleKeyUp(event: {
    key: string;
    code?: string;
    ctrlKey?: boolean;
    metaKey?: boolean;
    altKey?: boolean;
    shiftKey?: boolean;
  }): SessionEventResult {
    const mod = getModifierFromEvent(event.key, event.code);

    if (mod || this.hasSeenModifier) {
      if (mod) {
        this.active[mod] = false;
      }
      if (event.ctrlKey === false && mod !== 'ctrl') {
        this.active.ctrl = false;
      }
      if (event.metaKey === false && mod !== 'meta') {
        this.active.meta = false;
      }
      if (event.altKey === false && mod !== 'alt') {
        this.active.alt = false;
      }
      if (event.shiftKey === false && mod !== 'shift') {
        this.active.shift = false;
      }

      const anyActive =
        this.active.ctrl || this.active.meta || this.active.alt || this.active.shift;

      if (!anyActive && this.hasSeenModifier) {
        return {
          type: 'commit',
          combo: { ...this.largest },
        };
      }

      return {
        type: 'continue',
        active: { ...this.active },
        largest: { ...this.largest },
      };
    }

    return { type: 'ignore' };
  }
}

/** Localized action name for validation messages. */
export function getActionLocalizedName(action: QuickCloseAction): string {
  switch (action) {
    case 'quit':
      return i18next.t('settings.quick-close-action-quit');
    case 'closeWindow':
      return i18next.t('settings.quick-close-action-close-window');
    case 'closeTab':
      return i18next.t('settings.quick-close-action-close-tab');
    case 'hide':
      return i18next.t('settings.quick-close-action-hide');
  }
}

export type ModifierRecorderProps = {
  /** The action this recorder is configuring. */
  readonly action: QuickCloseAction;

  /** Label text for the row (e.g. 'Quit app'). */
  readonly label: string;

  /** Currently configured modifier combination. */
  readonly value: Modifiers;

  /** All bindings in the menu's Quick close config, used for duplicate validation. */
  readonly allBindings: QuickCloseBindings;

  /** Callback when a new valid modifier combination is committed. */
  readonly onChange: (newCombo: Modifiers) => void;

  /** Whether the row is read-only (no Change button). */
  readonly isReadOnly?: boolean;

  /** Whether the row is dimmed (e.g. opacity 0.55). */
  readonly isDimmed?: boolean;

  /** Whether to show the 'Experimental' pill next to the label. */
  readonly isExperimental?: boolean;

  /** Optional hint text displayed below the label. */
  readonly hint?: string;

  /** Currently selected menu index. When this changes, recording cancels. */
  readonly selectedMenu?: number;
};

/**
 * Component configuring modifier bindings for one Quick close action.
 *
 * It renders the row label, chips representing the configured combination, and a Change
 * button. Clicking Change transitions the row into recording mode ("Press keys…"), where
 * the user holds their desired modifier combination.
 */
export default function ModifierRecorder(props: ModifierRecorderProps) {
  const [isRecording, setIsRecording] = React.useState(false);
  const [error, setError] = React.useState<string | undefined>();
  const [attemptedCombo, setAttemptedCombo] = React.useState<Modifiers | undefined>();
  const sessionRef = React.useRef<ModifierRecorderSession | null>(null);
  const recorderRef = React.useRef<HTMLDivElement>(null);

  // Cancel recording and reset error when the selected menu changes.
  React.useEffect(() => {
    setIsRecording(false);
    setError(undefined);
    setAttemptedCombo(undefined);
    sessionRef.current = null;
  }, [props.selectedMenu]);
  // Reset local state if external value changes.
  React.useEffect(() => {
    setError(undefined);
    setAttemptedCombo(undefined);
  }, [props.value]);

  const handleStartRecording = () => {
    if (props.isReadOnly) {
      return;
    }
    setError(undefined);
    setAttemptedCombo(undefined);
    setIsRecording(true);
    sessionRef.current = new ModifierRecorderSession();
    setTimeout(() => {
      recorderRef.current?.focus();
    }, 0);
  };

  const handleCancel = () => {
    setIsRecording(false);
    setError(undefined);
    setAttemptedCombo(undefined);
    sessionRef.current = null;
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();

    if (!sessionRef.current) {
      return;
    }

    const res = sessionRef.current.handleKeyDown(event.nativeEvent);

    if (res.type === 'cancel') {
      handleCancel();
    } else if (res.type === 'commit') {
      commitCombo(res.combo);
    }
  };

  const handleKeyUp = (event: React.KeyboardEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();

    if (!sessionRef.current) {
      return;
    }

    const res = sessionRef.current.handleKeyUp(event.nativeEvent);

    if (res.type === 'cancel') {
      handleCancel();
    } else if (res.type === 'commit') {
      commitCombo(res.combo);
    }
  };

  const commitCombo = (combo: Modifiers) => {
    setIsRecording(false);
    sessionRef.current = null;

    const validation = validateQuickCloseBinding(props.allBindings, props.action, combo);

    if ('reason' in validation) {
      setAttemptedCombo(combo);
      if (validation.reason === 'duplicate' && validation.conflictsWith) {
        const actionName = getActionLocalizedName(validation.conflictsWith);
        setError(
          i18next.t('settings.quick-close-error-duplicate', { action: actionName })
        );
      } else {
        setError(i18next.t('settings.quick-close-error-empty'));
      }
      return;
    }

    setError(undefined);
    setAttemptedCombo(undefined);
    props.onChange(combo);
  };

  const handleBlur = () => {
    // Blurring the recording element cancels recording.
    if (isRecording) {
      handleCancel();
    }
  };

  const displayedCombo = attemptedCombo ?? props.value;
  const isMac = typeof cIsMac !== 'undefined' ? cIsMac : true;
  const chips = formatModifierChips(displayedCombo, isMac);

  const chipElements = chips.map((chip, index) => (
    <React.Fragment key={`${props.action}-chip-${chip}`}>
      {index > 0 ? <span className={classes.plus}>+</span> : null}
      <span className={classes.chip}>{chip}</span>
    </React.Fragment>
  ));

  return (
    <div
      className={cx({
        row: true,
        errbox: Boolean(error),
        dimmed: props.isDimmed,
      })}>
      <div className={classes.lab}>
        {props.label}
        {props.isExperimental ? (
          <span className={classes.exp}>
            {i18next.t('settings.quick-close-experimental')}
          </span>
        ) : null}
        {props.hint ? <span className={classes.hint}>{props.hint}</span> : null}
        {error ? (
          <span className={classes.err} role="alert">
            {error}
          </span>
        ) : null}
      </div>
      <div className={classes.controls}>
        {isRecording ? (
          <>
            <div
              ref={recorderRef}
              aria-label={i18next.t('settings.quick-close-press-keys')}
              aria-live="polite"
              className={cx(classes.chip, classes.rec)}
              role="status"
              tabIndex={0}
              onBlur={handleBlur}
              onKeyDown={handleKeyDown}
              onKeyUp={handleKeyUp}>
              {i18next.t('settings.quick-close-press-keys')}
            </div>
            <Button
              label={i18next.t('settings.quick-close-cancel')}
              size="small"
              variant="secondary"
              onClick={handleCancel}
            />
          </>
        ) : (
          <>
            {chipElements}
            {!props.isReadOnly ? (
              <Button
                label={i18next.t('settings.quick-close-change')}
                size="small"
                variant="secondary"
                onClick={() => handleStartRecording()}
              />
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
