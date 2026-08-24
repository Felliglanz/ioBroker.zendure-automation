'use strict';

/**
 * ValidationService Module
 *
 * Handles non-blocking power setpoint validation:
 * - Validates charging setpoints (discharge changes too frequently)
 * - Retry logic for failed setpoints
 * - Detects communication issues
 * - Per-device state tracking for multi-device support
 * - Configurable validation source (packPower vs gridInputPower)
 *
 * All writes go through control.setDeviceAutomationInOutLimit on the
 * underlying Solarflow integration (control.setOutputLimit/setInputLimit are
 * gated on a live `autoModel` telemetry state that zenSDK devices, e.g.
 * Solarflow 1600AC+/2400AC+, never actually report as 0 - confirmed against
 * a real device, see git history - so those DPs are unusable for this
 * device class).
 *
 * Setting setDeviceAutomationInOutLimit to exactly 0 triggers a delayed
 * internal sequence (acMode=0 at t+2s, smartMode=0 at t+4s) that isn't
 * cancellable - if a setpoint is written shortly after, this can duplicate
 * flash writes or race with the new value (forum.iobroker.net/post/1352076).
 * Every other value (any non-zero limit) takes a single, immediate property
 * write with no delayed sequence at all - so config.avoidZeroSetpoint
 * sidesteps the whole hazard by simply never sending a literal 0 for
 * routine/transient standby: it holds at a small non-zero setpoint
 * (config.standbyKeepAliveW) in the last active direction instead, and only
 * commits to a real 0 (deliberately, to let the inverter actually decouple
 * and save standby power) after config.smartModeIdleTimeoutSec of sustained
 * standby. A post-zero grace window (config.zeroHoldOffSec, floor 6s to
 * safely clear the ~4s delayed sequence) then blocks any further write so
 * that sequence is guaranteed to run to completion without interference.
 */
// Below this margin under maxBatterySoc, the Zendure BMS itself tapers the actual
// charge current down on its own (CV-style charge curve) regardless of the requested
// setpoint - not a communication failure, just the battery finishing up. Hardcoded
// (not configurable): it only suspends setpoint *validation*, never the setpoint writes
// themselves, so there's no meaningful tradeoff to expose in the UI.
const NEAR_FULL_SOC_MARGIN_PERCENT = 5;

class ValidationService {
    constructor(adapter) {
        this.adapter = adapter;

        // Per-device validation state (Map: deviceId -> state object)
        // Required for multi-device mode where each device has independent validation
        this.deviceStates = new Map();
    }

    /**
     * Get or create validation state for a device
     * @param {string} deviceId - Unique device identifier
     * @returns {object} Device validation state
     */
    getDeviceState(deviceId) {
        if (!this.deviceStates.has(deviceId)) {
            this.deviceStates.set(deviceId, {
                pendingValidation: false,
                validationRetryCount: 0,
                lastWrittenLimit: null,
                previousPowerW: null,
                // Zero-avoidance state (unused unless config.avoidZeroSetpoint)
                standbySince: null,   // timestamp: when the regulator first wanted true 0W
                holdOffUntil: 0,      // timestamp: no writes at all until this passes
                lastDirection: 0,     // -1 (charge) / +1 (discharge), for the keep-alive sign
                committedZero: false, // true once the real 0W has been sent for this standby
                                      // spell - stops the keep-alive/real-0 dance from
                                      // repeating every idleTimeoutSec while nothing changes
                nearFullSuspendLogged: false // edge-triggered: log entering near-full suspension once, not every cycle
            });
        }
        return this.deviceStates.get(deviceId);
    }

    /**
     * Validate previous cycle's setpoint (non-blocking)
     * @param {string} deviceId - Unique device identifier
     * @param {object} config - Adapter configuration
     * @param {number|null} actualPowerW - Actual battery power measured
     * @param {number|null} [batterySoc] - Current battery SOC, to suspend validation near max SOC
     * @returns {Promise<boolean>} True if validation is pending (needs resend)
     */
    async validateSetpoint(deviceId, config, actualPowerW, batterySoc) {
        const state = this.getDeviceState(deviceId);

        if (!state.pendingValidation || state.lastWrittenLimit === null) {
            return false;
        }

        const expectedPowerW = state.lastWrittenLimit;

        // Only validate charging setpoints (negative values)
        if (expectedPowerW >= -50 || actualPowerW === null) {
            state.pendingValidation = false;
            state.validationRetryCount = 0;
            state.previousPowerW = null;
            return false;
        }

        // Near max SOC, the BMS tapers actual charge current down on its own regardless
        // of the requested setpoint, so actual legitimately drifts further from an
        // aggressive target the closer SOC gets to full - the ramping check below can't
        // tell that apart from a real communication failure (deviation grows either way).
        // Without this, that taper alone triggers a false "setpoint failed" every ~60s for
        // the entire final stretch to full - hours of it on a sunny day, pinning charge
        // power well below maxChargePowerW rather than just tapering the last few percent.
        // The setpoint write itself is untouched (still resent every cycle as normal);
        // only the failure/retry bookkeeping is suspended. Deliberately leaves
        // pendingValidation/validationRetryCount/previousPowerW untouched (frozen, not
        // reset) - if we cleared pendingValidation here, a target that stays unchanged
        // once SOC drops back below the margin would never re-arm it (writePowerSetpoint
        // only resends on a changed value or an already-pending retry), silently
        // disabling validation forever instead of just for the top-of-charge band. Once
        // genuinely at/above maxBatterySoc, SafetyLimiter's maxSoc recovery hysteresis
        // takes over and zeroes the request out entirely.
        if (this._isNearFullSoc(config, batterySoc)) {
            if (!state.nearFullSuspendLogged) {
                this.adapter.log.info(`[${deviceId}] Near max SOC - charge setpoint validation suspended`);
                state.nearFullSuspendLogged = true;
            }
            return false;
        }
        state.nearFullSuspendLogged = false;

        const deviation = Math.abs(actualPowerW - expectedPowerW);
        const toleranceW = config.setPowerValidationToleranceW || 100; // Increased from 50W
        const withinTolerance = deviation <= toleranceW;

        // Ramping Detection: Check if power is moving towards target
        let isRamping = false;
        if (state.previousPowerW !== null) {
            const previousDeviation = Math.abs(state.previousPowerW - expectedPowerW);
            const currentDeviation = Math.abs(actualPowerW - expectedPowerW);
            isRamping = currentDeviation < previousDeviation;
        }

        if (withinTolerance) {
            // Setpoint accepted
            state.pendingValidation = false;
            state.validationRetryCount = 0;
            state.previousPowerW = null;
            this.adapter.log.debug(
                `✓ [${deviceId}] Charge setpoint validated: ${expectedPowerW}W (actual: ${actualPowerW}W, matched)`
            );
            return false;
        } else if (isRamping) {
            // Device is ramping towards target - keep monitoring
            const maxRetries = config.setPowerMaxRetries || 12;
            state.validationRetryCount++;
            state.previousPowerW = actualPowerW;

            if (state.validationRetryCount < maxRetries) {
                this.adapter.log.debug(
                    `⏳ [${deviceId}] Charge setpoint ramping (${state.validationRetryCount}/${maxRetries}): ${expectedPowerW}W (actual: ${actualPowerW}W, getting closer)`
                );
                return false; // No resend needed, device is working
            } else {
                // Ramping too slow, timeout reached
                this.adapter.log.warn(
                    `⚠️ [${deviceId}] Ramping timeout after ${maxRetries} cycles (${maxRetries * 5}s): target=${expectedPowerW}W, actual=${actualPowerW}W - device ramping too slowly, will retry`
                );
                state.pendingValidation = false;
                state.validationRetryCount = 0;
                state.previousPowerW = null;
                state.lastWrittenLimit = null; // Reset to allow fresh retry in next cycle
                return false;
            }
        } else {
            // Device not responding or not improving
            const maxRetries = config.setPowerMaxRetries || 12; // Increased from 5
            state.validationRetryCount++;
            state.previousPowerW = actualPowerW;

            if (state.validationRetryCount < maxRetries) {
                this.adapter.log.debug(
                    `[${deviceId}] Charge setpoint retry ${state.validationRetryCount}/${maxRetries}: target=${expectedPowerW}W, actual=${actualPowerW}W`
                );
                return true; // Needs resend
            } else {
                this.adapter.log.error(
                    `❌ [${deviceId}] Charge setpoint failed after ${maxRetries} attempts (${maxRetries * 5}s): target=${expectedPowerW}W, actual=${actualPowerW}W - possible API communication issue`
                );
                state.pendingValidation = false;
                state.validationRetryCount = 0;
                state.previousPowerW = null;
                state.lastWrittenLimit = null; // Reset to allow fresh retry in next cycle
                return false;
            }
        }
    }

    /**
     * True once battery SOC is within NEAR_FULL_SOC_MARGIN_PERCENT of maxBatterySoc
     * @private
     */
    _isNearFullSoc(config, batterySoc) {
        if (!Number.isFinite(batterySoc)) {
            return false;
        }
        const maxSoc = config.maxBatterySoc ?? 100;
        return batterySoc >= maxSoc - NEAR_FULL_SOC_MARGIN_PERCENT;
    }

    /**
     * Write power setpoint to device
     * @param {string} deviceId - Unique device identifier
     * @param {string} deviceBasePath - Base path to device
     * @param {number} powerW - Power to write (negative=charge, positive=discharge)
     * @param {object} [config] - Adapter configuration (required for zero-avoidance)
     * @param {object} [options] - { bypassHoldOff: true } to skip zero-avoidance gating,
     *   e.g. for emergency charging, where responsiveness outranks flash-write avoidance
     * @returns {Promise<void>}
     */
    async writePowerSetpoint(deviceId, deviceBasePath, powerW, config, options) {
        const state = this.getDeviceState(deviceId);
        const bypassHoldOff = Boolean(options && options.bypassHoldOff);

        let effectivePowerW = powerW;
        if (config && config.avoidZeroSetpoint) {
            effectivePowerW = this._resolveZeroAvoidance(deviceId, state, powerW, config, bypassHoldOff);
            if (effectivePowerW === null) {
                return; // held during the post-zero grace window, nothing to write this cycle
            }
        }

        // Check if power value changed (new setpoint vs resend)
        const powerChanged = state.lastWrittenLimit !== effectivePowerW;
        const needsResend = state.pendingValidation && state.validationRetryCount > 0 && !powerChanged;

        // Avoid unnecessary writes
        if (!needsResend && !powerChanged) {
            this.adapter.log.debug(`[${deviceId}] Power unchanged, skipping write`);
            return;
        }

        await this.adapter.setForeignStateAsync(
            `${deviceBasePath}.control.setDeviceAutomationInOutLimit`,
            effectivePowerW,
            false
        );
        state.lastWrittenLimit = effectivePowerW;

        if (needsResend) {
            this.adapter.log.debug(
                `📤 [${deviceId}] Resent battery limit: ${effectivePowerW}W (validation retry ${state.validationRetryCount})`
            );
        } else {
            this.adapter.log.debug(
                `📤 [${deviceId}] Wrote battery limit: ${effectivePowerW}W${effectivePowerW !== powerW ? ` (requested ${powerW}W)` : ''}`
            );
            state.previousPowerW = null; // Reset ramping detection on new command
        }

        // Enable validation for charging setpoints only
        if (effectivePowerW < -50) {
            state.pendingValidation = true;
            // CRITICAL: Always reset counter on new power value, even if validation was running
            if (powerChanged) {
                state.validationRetryCount = 0;
                state.previousPowerW = null;
            }
            this.adapter.log.debug(`⏳ [${deviceId}] Charge setpoint ${effectivePowerW}W will be validated in next cycle`);
        } else {
            state.pendingValidation = false;
            state.validationRetryCount = 0;
            state.previousPowerW = null;
        }
    }

    /**
     * Decide what to actually send instead of the raw regulator output, so we
     * (almost) never write a literal 0:
     * - Any non-zero request goes through unchanged (that path has no delayed sequence).
     * - A request for 0 is held at a small non-zero keep-alive (same direction
     *   as last time) until it has been wanted for smartModeIdleTimeoutSec.
     * - Only then do we send a real 0, and open a grace window afterwards
     *   during which nothing else is sent, so the resulting acMode/smartMode-off
     *   sequence is guaranteed to finish undisturbed.
     * - Once that real 0 has landed, we stay silent (no more writes at all) for as
     *   long as standby continues - we do NOT re-run the keep-alive-then-real-0
     *   dance every idleTimeoutSec. Without this, a sustained standby would send a
     *   fresh real 0 (full acMode/smartMode-off flash sequence) every single
     *   idleTimeoutSec indefinitely, defeating the point of avoiding zero writes.
     * @private
     * @returns {number|null} value to send, or null to send nothing this cycle
     */
    _resolveZeroAvoidance(deviceId, state, powerW, config, bypassHoldOff) {
        const now = Date.now();

        if (!bypassHoldOff && now < state.holdOffUntil) {
            this.adapter.log.debug(
                `[${deviceId}] Post-zero grace window active (${Math.ceil((state.holdOffUntil - now) / 1000)}s left), holding`
            );
            return null;
        }

        if (powerW !== 0) {
            state.standbySince = null;
            state.committedZero = false;
            state.lastDirection = powerW < 0 ? -1 : 1;
            return powerW;
        }

        // Regulator still wants standby (0W). If we already committed the real 0 for
        // this spell, there's nothing left to do - stay put, don't re-arm.
        if (state.committedZero) {
            return 0;
        }

        if (state.standbySince === null) {
            state.standbySince = now;
        }

        const idleTimeoutMs = Math.max(30, config.smartModeIdleTimeoutSec || 300) * 1000;
        const idleElapsedMs = now - state.standbySince;

        if (idleElapsedMs < idleTimeoutMs) {
            const floorW = Math.max(1, config.standbyKeepAliveW || 10);
            const direction = state.lastDirection || 1; // never been active yet: default to discharge
            return floorW * direction;
        }

        // Genuinely idle long enough - commit to a real 0 and open the grace window
        const holdOffMs = Math.max(6, config.zeroHoldOffSec || 8) * 1000;
        state.holdOffUntil = now + holdOffMs;
        state.standbySince = null;
        state.committedZero = true;
        this.adapter.log.info(
            `[${deviceId}] Standby held for ${Math.round(idleElapsedMs / 1000)}s, sending real 0W (device will disarm itself)`
        );
        return 0;
    }
}

module.exports = ValidationService;
