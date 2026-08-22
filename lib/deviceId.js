'use strict';

/**
 * Stable per-device id for the state tree, derived from the device's own deviceKey (unique per
 * physical unit, assigned by Zendure) rather than its position in the admin devices table.
 * productKey is only the device *class* (e.g. the model) and can repeat across multiple
 * configured devices, so it must never be used as an identity key.
 *
 * Using a stable id means status.devices.<id>.* and control.devices.<id>.* survive reordering or
 * removing rows in the admin table - a positional id like "device1"/"device2" would otherwise
 * silently relabel a different physical device and inherit its persisted state/overrides.
 * @param {string} deviceKey
 * @returns {string}
 */
function deviceStateId(deviceKey) {
    return String(deviceKey).replace(/[.\s]+/g, '_');
}

module.exports = { deviceStateId };
