//////////////////////////////////////////////////////////////////////////////////////////
//   _  _ ____ _  _ ___  ____                                                           //
//   |_/  |__| |\ | |  \ |  |    This file belongs to Kando, the cross-platform         //
//   | \_ |  | | \| |__/ |__|    pie menu. Read more on github.com/kando-menu/kando     //
//                                                                                      //
//////////////////////////////////////////////////////////////////////////////////////////

// SPDX-FileCopyrightText: Simon Schneegans <code@simonschneegans.de>
// SPDX-License-Identifier: MIT

import type { MenuInteractionType } from '../index';

/** Delivered to a single IPC observer. */
type ObserverCallback = (interaction: MenuInteractionType, path: number[]) => void;

/**
 * An interaction callback which also tells the generation of the displayed menu that the
 * interaction belongs to. Menu generations increase with every shown menu.
 */
export type GenerationCallback = (
  interaction: MenuInteractionType,
  path: number[],
  generation: number
) => void;

type Observer = {
  token: number;
  callback: ObserverCallback;
  /** One-time observers belong to the menu shown by their own request. */
  oneTime: boolean;
  /** Identifies the show request a one-time observer was announced by. */
  ticket?: number;
  /** The generation a one-time observer is bound to, once its menu is shown. */
  generation?: number;
};

/**
 * Keeps track of the IPC observers of menu interactions.
 *
 * Persistent observers receive every interaction. A one-time observer (created by a
 * `show-custom-menu` request) only ever receives the interactions of the menu generation
 * which its own request produced: until that menu is shown it receives nothing, and
 * interactions of any other generation (for example the late close event of the menu it
 * replaced) are never delivered to it.
 */
export class IPCObserverRegistry {
  /** The IPC server registers one-time observers under this reserved ID. */
  public static readonly cOneTimeObserverID = 0;

  private observers = new Map<number, Observer>();
  private nextTicket = 1;
  private nextRegistrationToken = 1;
  private announcedTicket: number | null = null;
  /**
   * Announces that the next one-time observer belongs to a show request which is about to
   * be processed. Call it when the request arrives, before the observer is registered.
   *
   * @returns A ticket to pass to {@link bindOneTime} once the request's menu is shown.
   */
  public announceOneTime(): number {
    this.announcedTicket = this.nextTicket++;
    return this.announcedTicket;
  }

  /** Registers an observer and returns a unique registration token. */
  public add(observerID: number, callback: ObserverCallback): number {
    const token = this.nextRegistrationToken++;
    const oneTime = observerID === IPCObserverRegistry.cOneTimeObserverID;
    const observer: Observer = { token, callback, oneTime };

    if (oneTime) {
      observer.ticket = this.announcedTicket ?? undefined;
      this.announcedTicket = null;
    }

    this.observers.set(observerID, observer);
    return token;
  }

  /**
   * Unregisters an observer.
   *
   * If a registration token or callback is provided, the observer is only removed if it
   * matches the current registration. This ensures that an older observer disconnecting
   * does not unregister a newer observer that replaced it under the same ID.
   *
   * @param observerID The ID of the observer to remove.
   * @param identity Optional registration token or callback reference to verify
   *   ownership.
   * @returns True if the observer was removed, false if not found or identity mismatched.
   */
  public remove(observerID: number, identity?: number | ObserverCallback): boolean {
    const existing = this.observers.get(observerID);
    if (!existing) {
      return false;
    }

    if (identity !== undefined) {
      if (typeof identity === 'number') {
        if (existing.token !== identity) {
          return false;
        }
      } else if (existing.callback !== identity) {
        return false;
      }
    }

    this.observers.delete(observerID);
    return true;
  }

  /**
   * Binds the one-time observer announced with the given ticket to the generation of the
   * menu its request showed. Does nothing if that observer was replaced in the meantime.
   */
  public bindOneTime(ticket: number, generation: number) {
    const observer = this.observers.get(IPCObserverRegistry.cOneTimeObserverID);
    if (observer?.oneTime && observer.ticket === ticket && observer.generation == null) {
      observer.generation = generation;
    }
  }

  /** Delivers an interaction of the given menu generation to all matching observers. */
  public dispatch(interaction: MenuInteractionType, path: number[], generation: number) {
    for (const observer of [...this.observers.values()]) {
      if (!observer.oneTime || observer.generation === generation) {
        observer.callback(interaction, path);
      }
    }
  }
}
