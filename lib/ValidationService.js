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
 */
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
                previousPowerW: null
            });
        }
        return this.deviceStates.get(deviceId);
    }

    /**
     * Validate previous cycle's setpoint (non-blocking)
     * @param {string} deviceId - Unique device identifier
     * @param {object} config - Adapter configuration
     * @param {number|null} actualPowerW - Actual battery power measured
     * @returns {Promise<boolean>} True if validation is pending (needs resend)
     */
    async validateSetpoint(deviceId, config, actualPowerW) {
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
     * Write power setpoint to device
     * @param {string} deviceId - Unique device identifier
     * @param {string} deviceBasePath - Base path to device
     * @param {number} powerW - Power to write (negative=charge, positive=discharge)
     * @returns {Promise<void>}
     */
    async writePowerSetpoint(deviceId, deviceBasePath, powerW) {
        const state = this.getDeviceState(deviceId);
        const limitPath = `${deviceBasePath}.control.setDeviceAutomationInOutLimit`;
        const needsResend = state.pendingValidation && state.validationRetryCount > 0;

        // Avoid unnecessary writes
        if (!needsResend && state.lastWrittenLimit === powerW) {
            this.adapter.log.debug(`[${deviceId}] Power unchanged, skipping write`);
            return;
        }

        // Write the value (non-blocking)
        await this.adapter.setForeignStateAsync(limitPath, powerW, false);
        state.lastWrittenLimit = powerW;

        if (needsResend) {
            this.adapter.log.debug(
                `📤 [${deviceId}] Resent battery limit: ${powerW}W (validation retry ${state.validationRetryCount})`
            );
        } else {
            this.adapter.log.debug(`📤 [${deviceId}] Wrote battery limit: ${powerW}W`);
            state.previousPowerW = null; // Reset ramping detection on new command
        }

        // Enable validation for charging setpoints only
        if (powerW < -50) {
            state.pendingValidation = true;
            if (!needsResend) {
                state.validationRetryCount = 0;
            }
            this.adapter.log.debug(`⏳ [${deviceId}] Charge setpoint ${powerW}W will be validated in next cycle`);
        } else {
            state.pendingValidation = false;
            state.validationRetryCount = 0;
            state.previousPowerW = null;
        }
    }
}

module.exports = ValidationService;
