'use strict';

/**
 * Lowest automation tick allowed, regardless of what's stored in config - a fast meter
 * must never hammer the battery's relay (see #42). Older installs may still carry a
 * stored 1-2s value from before the admin field's minimum was raised.
 */
const MIN_UPDATE_INTERVAL_SEC = 3;
const DEFAULT_UPDATE_INTERVAL_SEC = 5;

/**
 * The interval the automation cycle actually runs at. Every consumer that converts
 * time into cycle counts (e.g. Waterfill's hold time) must use this, not the raw
 * config value, or its timing drifts from the real tick.
 * @param {object} config - Adapter configuration
 * @returns {number} Seconds
 */
function effectiveUpdateIntervalSec(config) {
    const configured = Number(config && config.updateIntervalSec);
    return Math.max(
        MIN_UPDATE_INTERVAL_SEC,
        Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_UPDATE_INTERVAL_SEC
    );
}

module.exports = { effectiveUpdateIntervalSec, MIN_UPDATE_INTERVAL_SEC };
