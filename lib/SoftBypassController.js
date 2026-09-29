'use strict';

/**
 * SoftBypassController Module (EXPERIMENTAL)
 *
 * Software replacement for the device's own hardware bypass on PV-equipped devices
 * (issue #43). Once such a device is full, the regulator can no longer put its PV
 * anywhere (charge is blocked at maxBatterySoc) and would write 0W - which on a
 * DC-coupled PV device means "curtail all PV". With soft bypass enabled, the device
 * instead gets a discharge-direction floor that tracks its available PV, so the PV
 * keeps flowing to the house (and, beyond house load, into the grid / other batteries).
 *
 * The floor is only ever a lower bound: callers write max(regulatorDemand, floorW).
 * If the house needs more than the PV provides (large consumer, evening), the normal
 * regulator demand wins immediately and the battery discharges as usual - the soft
 * bypass can never block discharge, only add to it.
 *
 * Tracking the available PV (perturb & observe, like an MPPT):
 * - At a full battery, a curtailed device reads solarInputPower == its own output, so
 *   solarInputPower alone can't tell how much more PV would be available.
 * - Measured battery power can, though: if floor > available PV, the battery covers the
 *   difference (discharges) - that exact amount is how far we're above the PV. If the
 *   battery is ~0 we may be curtailing, so we carefully step the floor up.
 * - Slow up (step, doubling while PV keeps following), fast down (straight back to the
 *   PV-covered share on the first sign of discharge, then hold a while before probing).
 * - Evaluated against what was actually written (floor or higher regulator demand -
 *   the battery reading says how much of it the PV covered either way), only after the
 *   device had time to settle since the last written change.
 *
 * Device with its own hardware bypass (e.g. 2400 Pro, `pass` state): once that engages it
 * passes the full PV through regardless of the setpoint, so tracking pauses and the floor
 * just holds the small entry nudge - probing above the PV would only knock it out of bypass.
 *
 * Exit: device PV below the configured threshold for EXIT_DEBOUNCE_MS, SOC dropping out
 * of the maxSoc hysteresis band, discharge blocked for safety, or feature disabled.
 */

const SETTLE_MS = 15000;          // device ramp + MPPT shift + telemetry lag after a written change
const PROBE_HOLD_MS = 60000;      // pause probing after hitting the PV ceiling
const EXIT_DEBOUNCE_MS = 180000;  // PV must stay below threshold this long before exiting
const ENTRY_HYSTERESIS_W = 50;    // entry needs threshold + this, avoids enter/exit flapping
const DISCHARGE_TOLERANCE_W = 30; // battery discharge above this = floor is above available PV
const CHARGE_TOLERANCE_W = 30;    // battery charge above this = PV exceeds floor
const BACKOFF_MARGIN_W = 10;      // extra step below the PV-covered share on back-off
const MIN_STEP_W = 25;
const MAX_STEP_W = 200;
const MIN_FLOOR_W = 30;           // keeps the device out of standby while active
const NUDGE_START_W = 50;         // entry value when the device's PV reading is already throttled
const PV_TO_AC_ESTIMATE = 0.9;    // conservative DC→AC efficiency for the back-off lower bound
const DEFAULT_MIN_SOLAR_W = 200;

/**
 * Normalize a device's `pass` state (boolean, 0/1 or 'on'/'off' depending on source/firmware).
 * @param {*} value - Raw state value
 * @returns {boolean|null} null when missing/unknown
 */
function parseBypassState(value) {
    if (value === true || value === 1) return true;
    if (value === false || value === 0) return false;
    if (typeof value === 'string') {
        const v = value.trim().toLowerCase();
        if (['on', 'true', '1'].includes(v)) return true;
        if (['off', 'false', '0'].includes(v)) return false;
    }
    return null;
}

/**
 * Admin number fields can come back empty ('' / undefined) - fall back to the default then.
 * @param {*} value - Raw config value
 * @returns {number}
 */
function parseMinSolarW(value) {
    const num = Number(value);
    return value === undefined || value === null || value === '' || !Number.isFinite(num) || num < 0
        ? DEFAULT_MIN_SOLAR_W
        : num;
}

class SoftBypassController {
    /**
     * @param {object} adapter - ioBroker adapter instance
     */
    constructor(adapter) {
        this.adapter = adapter;
        this.states = new Map(); // Map<deviceId, state>
    }

    /**
     * @private
     */
    _getState(deviceId) {
        if (!this.states.has(deviceId)) {
            this.states.set(deviceId, {
                active: false,
                floorW: 0,
                stepW: MIN_STEP_W,
                nextProbeAt: 0,
                belowThresholdSince: null,
                lastWrittenW: null,
                lastWrittenChangeAt: 0,
                // One PV-independent entry per charge-up (see update()); re-armed only once
                // SOC has genuinely left the top band, so a battery sitting at 100% (e.g.
                // overnight) can't re-nudge every EXIT_DEBOUNCE_MS.
                nudgeArmed: true,
                hardwareBypassHold: false
            });
        }
        return this.states.get(deviceId);
    }

    /**
     * Current floor for a device without advancing the state machine
     * @param {string} deviceId - Device identifier
     * @returns {number} Floor in W (0 when inactive)
     */
    getFloorW(deviceId) {
        const state = this.states.get(deviceId);
        return state && state.active ? state.floorW : 0;
    }

    /**
     * Advance the state machine for one cycle and return the floor to apply.
     * @param {string} deviceId - Device identifier
     * @param {object} params - Inputs
     * @param {boolean} params.enabled - Soft bypass configured for this device
     * @param {boolean} params.blocked - Discharge currently blocked (recovery, emergency, disabled, ...)
     * @param {number|null} params.soc - Battery SOC (%)
     * @param {number} params.maxSoc - Configured maxBatterySoc
     * @param {number} params.maxSocHysteresis - Configured maxSocRecoveryHysteresis
     * @param {number|null} params.solarInputW - Device PV input (W)
     * @param {number|null} params.batteryPowerW - Measured battery power (positive = discharge)
     * @param {number} params.maxDischargePowerW - Device discharge limit (W)
     * @param {number} params.minSolarW - Exit threshold for PV input (W)
     * @param {boolean|null} [params.hardwareBypassActive] - Device's own bypass state (`pass`),
     *   null when the device doesn't expose one
     * @param {number} [params.now] - Timestamp (ms), injectable for tests
     * @returns {{active: boolean, floorW: number}}
     */
    update(deviceId, params) {
        const now = params.now ?? Date.now();
        const state = this._getState(deviceId);
        const soc = Number(params.soc);
        const solarW = Math.max(0, Number(params.solarInputW) || 0);
        const minSolarW = Math.max(0, Number(params.minSolarW) || 0);
        const maxSoc = params.maxSoc ?? 100;
        const hysteresis = params.maxSocHysteresis ?? 4;
        const maxDischargeW = Math.max(0, Number(params.maxDischargePowerW) || 0);

        if (Number.isFinite(soc) && soc <= maxSoc - hysteresis) {
            state.nudgeArmed = true;
        }

        if (!params.enabled || params.blocked || !Number.isFinite(soc) || maxDischargeW <= 0) {
            if (state.active) {
                const reason = !params.enabled ? 'disabled' : params.blocked ? 'discharge blocked' : 'no valid SOC/limit';
                this._deactivate(deviceId, state, reason);
            }
            return { active: false, floorW: 0 };
        }

        if (!state.active) {
            // Entry on reaching maxSoc must not depend on the PV reading: a PV device near
            // full already throttles its MPPT (BMS taper), and once 0W puts it into standby
            // solarInputPower reads ~0 for good - observed on a 2400 Pro (issue #43, log
            // 2026-09-29: never entered until the user nudged it with 50W manually). So the
            // first time it gets full it enters regardless and starts from a small nudge;
            // if no PV follows, the normal PV exit ends it after EXIT_DEBOUNCE_MS.
            const nudge = state.nudgeArmed;
            if (soc >= maxSoc && (nudge || solarW >= minSolarW + ENTRY_HYSTERESIS_W)) {
                state.active = true;
                state.nudgeArmed = false;
                // Uncurtailed PV reading (e.g. right out of charging) is a good first estimate;
                // otherwise start from the nudge and let probing find the PV.
                state.floorW = this._clampFloor(Math.max(NUDGE_START_W, solarW - BACKOFF_MARGIN_W), solarW, maxDischargeW);
                state.stepW = MIN_STEP_W;
                state.nextProbeAt = now + SETTLE_MS;
                state.belowThresholdSince = null;
                this.adapter.log.info(
                    `☀️ [${deviceId}] Soft bypass active (SOC ${soc}%, PV ${solarW}W) - starting at ${state.floorW}W`
                );
            }
            return { active: state.active, floorW: state.active ? state.floorW : 0 };
        }

        // ========== EXIT CONDITIONS ==========
        if (soc <= maxSoc - hysteresis) {
            this._deactivate(deviceId, state, `SOC dropped to ${soc}%`);
            return { active: false, floorW: 0 };
        }

        if (solarW < minSolarW) {
            if (state.belowThresholdSince === null) {
                state.belowThresholdSince = now;
            } else if (now - state.belowThresholdSince >= EXIT_DEBOUNCE_MS) {
                this._deactivate(deviceId, state, `PV ${solarW}W below ${minSolarW}W for ${Math.round(EXIT_DEBOUNCE_MS / 60000)} min`);
                return { active: false, floorW: 0 };
            }
        } else {
            state.belowThresholdSince = null;
        }

        // ========== HARDWARE BYPASS HOLD ==========
        // While the device's own bypass is engaged it passes its full PV through regardless
        // of the setpoint - observed on a 2400 Pro (issue #43, 2026-09-29: 338W set, 550-700W
        // out with pass=true). Probing above the PV only knocks it out of bypass (pass drops,
        // battery covers the step, back-off, pass returns - once a minute). So just hold the
        // small nudge and let the device do the work; regulator demand above it still wins
        // via max(). Probing stays the fallback for devices without (or out of) bypass.
        if (params.hardwareBypassActive === true) {
            if (!state.hardwareBypassHold) {
                state.hardwareBypassHold = true;
                this.adapter.log.info(`☀️ [${deviceId}] Device bypass active - holding ${NUDGE_START_W}W, PV tracking paused`);
            }
            state.floorW = this._clampFloor(NUDGE_START_W, solarW, maxDischargeW);
            state.stepW = MIN_STEP_W;
            // Fresh settle window once the bypass drops, before probing reads the battery
            state.nextProbeAt = now + SETTLE_MS;
            return { active: true, floorW: state.floorW };
        }
        if (state.hardwareBypassHold) {
            state.hardwareBypassHold = false;
            this.adapter.log.info(`☀️ [${deviceId}] Device bypass ended - PV tracking resumed from ${state.floorW}W`);
        }

        // ========== PV TRACKING ==========
        // Evaluated against what was actually written (writtenW = max(regulator, floor)),
        // not just the floor: if the regulator's demand was higher, the battery reading
        // still says exactly how much of writtenW the PV covered. Freezing whenever the
        // floor wasn't binding let a floor that collapsed during a cloud stay stuck below a
        // modest house load for as long as the load lasted, curtailing the PV all along.
        const batteryW = Number(params.batteryPowerW);
        const writtenW = state.lastWrittenW;
        const settled = now - state.lastWrittenChangeAt >= SETTLE_MS;

        if (settled && Number.isFinite(batteryW) && Number.isFinite(writtenW) && writtenW > 0) {
            const previousW = state.floorW;

            if (batteryW > DISCHARGE_TOLERANCE_W) {
                // PV covers writtenW minus the discharge. With slow telemetry the same stale
                // discharge reading can show up for several cycles - while discharging,
                // solarInputPower is uncurtailed though, which bounds the estimate from
                // below so repeated stale readings can't compound into a collapse. A stale
                // reading must never raise a floor that is itself what got written.
                const pvCoveredW = writtenW - batteryW - BACKOFF_MARGIN_W;
                const pvEstimateW = solarW * PV_TO_AC_ESTIMATE - BACKOFF_MARGIN_W;
                let targetW = Math.max(pvCoveredW, pvEstimateW);
                if (writtenW === state.floorW) {
                    targetW = Math.min(state.floorW, targetW);
                }
                state.floorW = this._clampFloor(targetW, solarW, maxDischargeW);
                state.stepW = MIN_STEP_W;
                state.nextProbeAt = now + PROBE_HOLD_MS;
            } else if (batteryW < -CHARGE_TOLERANCE_W) {
                // PV exceeds writtenW and the battery absorbs the rest. Below maxSoc that's
                // wanted (refill first), so only follow it once the battery is full.
                if (soc >= maxSoc) {
                    state.floorW = this._clampFloor(Math.max(state.floorW, writtenW - batteryW), solarW, maxDischargeW);
                }
            } else {
                // Battery ~idle: PV covers at least writtenW (exactly matched or curtailing).
                if (writtenW > state.floorW) {
                    state.floorW = this._clampFloor(writtenW, solarW, maxDischargeW);
                }
                if (soc >= maxSoc && now >= state.nextProbeAt) {
                    const beforeProbeW = state.floorW;
                    state.floorW = this._clampFloor(state.floorW + state.stepW, solarW, maxDischargeW);
                    if (state.floorW > beforeProbeW) {
                        state.stepW = Math.min(state.stepW * 2, MAX_STEP_W);
                    }
                } else if (soc < maxSoc && now >= state.nextProbeAt) {
                    // Below full and not refilling: a floor sitting just above the PV drains
                    // the battery by a few W (below DISCHARGE_TOLERANCE_W) for hours, which
                    // would slowly walk SOC out of the hysteresis band. Step back so the PV
                    // surplus refills it first; probing resumes once it's full again.
                    state.floorW = this._clampFloor(state.floorW - MIN_STEP_W, solarW, maxDischargeW);
                    state.stepW = MIN_STEP_W;
                    state.nextProbeAt = now + SETTLE_MS;
                }
            }

            if (state.floorW !== previousW) {
                this.adapter.log.debug(
                    `[${deviceId}] Soft bypass: written ${writtenW}W, battery ${batteryW}W, PV ${solarW}W → floor ${previousW}W → ${state.floorW}W`
                );
            }
        }

        return { active: true, floorW: state.floorW };
    }

    /**
     * Report what was actually requested for the device this cycle - the next update()
     * evaluates the battery reading against it, once the device had time to settle.
     * Regulator jitter smaller than the minimum probe step doesn't restart the settle
     * time, otherwise a constantly-nudged setpoint would never get evaluated at all.
     * @param {string} deviceId - Device identifier
     * @param {number} writtenW - Final setpoint requested this cycle
     * @param {number} [now] - Timestamp (ms), injectable for tests
     */
    recordWrite(deviceId, writtenW, now = Date.now()) {
        const state = this._getState(deviceId);
        if (state.lastWrittenW === null || Math.abs(writtenW - state.lastWrittenW) >= MIN_STEP_W) {
            state.lastWrittenChangeAt = now;
        }
        state.lastWrittenW = writtenW;
    }

    /**
     * Floor bounds: never below MIN_FLOOR_W (stay out of standby), never more than one
     * max step above measured PV (no runaway if telemetry freezes or the device stops
     * following), never above the device's discharge limit.
     * @private
     */
    _clampFloor(floorW, solarW, maxDischargeW) {
        const upperW = Math.min(maxDischargeW, solarW + MAX_STEP_W);
        return Math.round(Math.max(Math.min(MIN_FLOOR_W, maxDischargeW), Math.min(floorW, upperW)));
    }

    /**
     * @private
     */
    _deactivate(deviceId, state, reason) {
        state.active = false;
        state.floorW = 0;
        state.stepW = MIN_STEP_W;
        state.belowThresholdSince = null;
        state.hardwareBypassHold = false;
        this.adapter.log.info(`☀️ [${deviceId}] Soft bypass ended (${reason}), back to normal regulation`);
    }
}

SoftBypassController.SETTLE_MS = SETTLE_MS;
SoftBypassController.PROBE_HOLD_MS = PROBE_HOLD_MS;
SoftBypassController.EXIT_DEBOUNCE_MS = EXIT_DEBOUNCE_MS;
SoftBypassController.parseMinSolarW = parseMinSolarW;
SoftBypassController.parseBypassState = parseBypassState;

module.exports = SoftBypassController;
