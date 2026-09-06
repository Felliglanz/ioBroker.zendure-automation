'use strict';

/**
 * Effective AC-side charge ceiling for a device this cycle. Non-PV devices are
 * unaffected (maxChargePowerW is already AC-only for them). PV-equipped devices
 * (hasPv) reinterpret maxChargePowerW as the combined PV+AC ceiling and subtract
 * live solar production, independently capped by maxAcChargePowerW in case the
 * AC circuit itself has a separate hardware limit.
 * @param {object} device - Device with maxChargePowerW, hasPv, maxAcChargePowerW, solarInputPowerW
 * @returns {number} Effective AC charge limit in Watts, always >= 0
 */
function computeEffectiveChargeLimitW(device) {
    const maxChargePowerW = Math.max(0, Number(device.maxChargePowerW) || 0);
    if (!device.hasPv) {
        return maxChargePowerW;
    }

    const rawAc = device.maxAcChargePowerW;
    const parsedAc = Number(rawAc);
    const maxAcChargePowerW = rawAc !== null && rawAc !== undefined && rawAc !== '' && Number.isFinite(parsedAc)
        ? Math.max(0, parsedAc)
        : maxChargePowerW; // not configured - degrade to combined-only formula

    const solarInputPowerW = Math.max(0, Number(device.solarInputPowerW) || 0);
    return Math.max(0, Math.min(maxAcChargePowerW, maxChargePowerW - solarInputPowerW));
}

module.exports = { computeEffectiveChargeLimitW };
