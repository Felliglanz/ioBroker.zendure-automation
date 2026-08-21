'use strict';

/**
 * How long a foreign state's value may go unrefreshed before it's treated as stale.
 * Generous on purpose: the source adapter (e.g. zendure-solarflow) may not rewrite a
 * value every poll if it's unchanged, so this only needs to catch a source that has
 * genuinely stopped updating (device offline, cloud connection lost, etc.), not normal
 * idle periods.
 */
const DEFAULT_MAX_DATA_AGE_MS = 3 * 60 * 1000;

/**
 * Whether an ioBroker state exists but hasn't been (re)written by its source adapter
 * recently - i.e. it may be a frozen last-known value rather than a live reading.
 * @param {object|null|undefined} state - ioBroker state object (as returned by getForeignStateAsync)
 * @param {number} [maxAgeMs] - Maximum allowed age since the state's last write (`ts`)
 * @returns {boolean}
 */
function isStale(state, maxAgeMs = DEFAULT_MAX_DATA_AGE_MS) {
    return Boolean(state) && typeof state.ts === 'number' && (Date.now() - state.ts) > maxAgeMs;
}

module.exports = { isStale, DEFAULT_MAX_DATA_AGE_MS };
