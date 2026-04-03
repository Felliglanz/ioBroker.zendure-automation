'use strict';

/**
 * ValidationService Module
 * 
 * Handles non-blocking power setpoint validation:
 * - Validates charging setpoints (discharge changes too frequently)
 * - Retry logic for failed setpoints
 * - Detects communication issues
 */
class ValidationService {
    constructor(adapter) {
        this.adapter = adapter;
        
        // Validation state
        this.pendingValidation = false;
        this.validationRetryCount = 0;
        this.lastWrittenLimit = null;
    }

    /**
     * Validate previous cycle's setpoint (non-blocking)
     * @param {object} config - Adapter configuration
     * @param {number|null} actualPowerW - Actual battery power measured
     * @returns {Promise<boolean>} True if validation is pending (needs resend)
     */
    async validateSetpoint(config, actualPowerW) {
        if (!this.pendingValidation || this.lastWrittenLimit === null) {
            return false;
        }

        const expectedPowerW = this.lastWrittenLimit;

        // Only validate charging setpoints (negative values)
        if (expectedPowerW >= -50 || actualPowerW === null) {
            this.pendingValidation = false;
            this.validationRetryCount = 0;
            return false;
        }

        const deviation = Math.abs(actualPowerW - expectedPowerW);
        const toleranceW = config.setPowerValidationToleranceW || 50;
        const isCharging = actualPowerW < -50;
        const withinTolerance = deviation <= toleranceW;

        if (withinTolerance || isCharging) {
            // Setpoint accepted
            this.pendingValidation = false;
            this.validationRetryCount = 0;
            this.adapter.log.debug(
                `✓ Charge setpoint validated: ${expectedPowerW}W (actual: ${actualPowerW}W, ${withinTolerance ? 'matched' : 'ramping'})`
            );
            return false;
        } else {
            // Device not responding
            const maxRetries = config.setPowerMaxRetries || 5;
            this.validationRetryCount++;

            if (this.validationRetryCount < maxRetries) {
                this.adapter.log.debug(
                    `Charge setpoint retry ${this.validationRetryCount}/${maxRetries}: target=${expectedPowerW}W, actual=${actualPowerW}W`
                );
                return true; // Needs resend
            } else {
                this.adapter.log.error(
                    `❌ Charge setpoint failed after ${maxRetries} attempts (${maxRetries * 5}s): target=${expectedPowerW}W, actual=${actualPowerW}W - possible API communication issue`
                );
                this.pendingValidation = false;
                this.validationRetryCount = 0;
                return false;
            }
        }
    }

    /**
     * Write power setpoint to device
     * @param {string} deviceBasePath - Base path to device
     * @param {number} powerW - Power to write (negative=charge, positive=discharge)
     * @returns {Promise<void>}
     */
    async writePowerSetpoint(deviceBasePath, powerW) {
        const limitPath = `${deviceBasePath}.control.setDeviceAutomationInOutLimit`;
        const needsResend = this.pendingValidation && this.validationRetryCount > 0;

        // Avoid unnecessary writes
        if (!needsResend && this.lastWrittenLimit === powerW) {
            this.adapter.log.debug('Power unchanged, skipping write');
            return;
        }

        // Write the value (non-blocking)
        await this.adapter.setForeignStateAsync(limitPath, powerW, false);
        this.lastWrittenLimit = powerW;

        if (needsResend) {
            this.adapter.log.debug(
                `📤 Resent battery limit: ${powerW}W (validation retry ${this.validationRetryCount})`
            );
        } else {
            this.adapter.log.debug(`📤 Wrote battery limit: ${powerW}W`);
        }

        // Enable validation for charging setpoints only
        if (powerW < -50) {
            this.pendingValidation = true;
            if (!needsResend) {
                this.validationRetryCount = 0;
            }
            this.adapter.log.debug(`⏳ Charge setpoint ${powerW}W will be validated in next cycle`);
        } else {
            this.pendingValidation = false;
            this.validationRetryCount = 0;
        }
    }
}

module.exports = ValidationService;
