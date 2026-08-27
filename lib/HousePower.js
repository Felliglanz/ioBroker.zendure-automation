'use strict';

/**
 * Shared house-power computation, used by both DashboardServer (live status API) and
 * Telemetry (history sampling) so the two never disagree about what "house consumption"
 * means for the same instant - a single AC-charge-subtraction implementation instead of
 * two that could quietly drift apart.
 */

/**
 * All configured device base paths (one in single-device mode), for readings that need to
 * be summed across every physical Zendure unit.
 */
function allDeviceBasePaths(cfg) {
    const instance = cfg.zendureSolarflowInstance || 'zendure-solarflow.0';

    if (cfg.multiDeviceEnabled === true) {
        return (cfg.devices || [])
            .filter(d => d.enabled && d.productKey && d.deviceKey)
            .map(d => `${instance}.${d.productKey}.${d.deviceKey}`);
    }

    if (!cfg.deviceProductKey || !cfg.deviceKey) return [];
    return [`${instance}.${cfg.deviceProductKey}.${cfg.deviceKey}`];
}

/**
 * Sum of AC-sourced charge power across all devices right now, in Watts (always >= 0).
 * Uses gridInputPower specifically (AC charging only) rather than packPower, so PV-direct
 * charging - which never touches the house's own electricity meter - is not subtracted.
 * Mirrors the sign handling in DataReader.getGridInputPowerW(): Zendure reports
 * negative=charge inverted to our positive=discharge/negative=charge convention.
 */
async function totalBatteryAcChargeW(adapter, basePaths) {
    let total = 0;
    for (const basePath of basePaths) {
        const state = await adapter.getForeignStateAsync(`${basePath}.gridInputPower`);
        if (!state || state.val === null || state.val === undefined) continue;
        const gridInputW = -Number(state.val);
        if (Number.isFinite(gridInputW) && gridInputW < 0) total += -gridInputW;
    }
    return total;
}

/**
 * House consumption in Watts, or null if no house datapoint is configured/available.
 * Optionally corrected for the batteries' own AC charge draw so a whole-house meter (which
 * sees that draw too) doesn't inflate the "real" consumption figure.
 */
async function readHousePowerW(adapter) {
    const cfg = adapter.config;
    if (!cfg.enableHousePower || !cfg.housePowerDp) return null;

    const state = await adapter.getForeignStateAsync(cfg.housePowerDp);
    if (!state || state.val === null || state.val === undefined) return null;

    const rawW = Number(state.val);
    if (!Number.isFinite(rawW)) return null;
    if (!cfg.subtractBatteryChargeFromHouse) return rawW;

    const acChargeW = await totalBatteryAcChargeW(adapter, allDeviceBasePaths(cfg));
    return rawW - acChargeW;
}

module.exports = { allDeviceBasePaths, totalBatteryAcChargeW, readHousePowerW };
