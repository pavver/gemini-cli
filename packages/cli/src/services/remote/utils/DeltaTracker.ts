/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * DeltaTracker provides a generic mechanism to track state changes
 * and generate incremental updates (deltas) for objects with IDs.
 */
export class DeltaTracker<T extends { id: string }> {
  private cache = new Map<string, T>();

  /**
   * Compares the current object with the cached state.
   * Returns:
   * - The full object if it's new.
   * - A partial object with only changed fields (plus ID) if it has changed.
   * - null if nothing has changed.
   */
  getDelta(current: T): Partial<T> | null {
    const last = this.cache.get(current.id);
    if (!last) {
      this.cache.set(current.id, { ...current });
      return current;
    }

    const delta: Record<string, unknown> = { id: current.id };
    let hasChanges = false;

    // We use a shallow keys comparison with JSON stringification for values
    // to detect changes in objects/arrays without deep recursion issues.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const keys = Object.keys(current) as Array<keyof T>;
    for (const key of keys) {
      if (key === 'id') continue;

      const currentVal = current[key];
      const lastVal = last[key];

      if (JSON.stringify(currentVal) !== JSON.stringify(lastVal)) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        delta[key as string] = currentVal;
        hasChanges = true;
      }
    }

    if (hasChanges) {
      this.cache.set(current.id, { ...current });
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      return delta as Partial<T>;
    }

    return null;
  }

  /**
   * Clears the cache for a specific ID or all objects.
   */
  clear(id?: string): void {
    if (id) {
      this.cache.delete(id);
    } else {
      this.cache.clear();
    }
  }
}
