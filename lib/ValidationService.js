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
        this.previousPowerW = null; // Track power for ramping detection
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
            this.previousPowerW = null;
            return false;
        }

        const deviation = Math.abs(actualPowerW - expectedPowerW);
        const toleranceW = config.setPowerValidationToleranceW || 100; // Increased from 50W
        const withinTolerance = deviation <= toleranceW;

        // Ramping Detection: Check if power is moving towards target
        let isRamping = false;
        if (this.previousPowerW !== null) {
            const previousDeviation = Math.abs(this.previousPowerW - expectedPowerW);
            const currentDeviation = Math.abs(actualPowerW - expectedPowerW);
            isRamping = currentDeviation < previousDeviation;
        }

        if (withinTolerance) {
            // Setpoint accepted
            this.pendingValidation = false;
            this.validationRetryCount = 0;
            this.previousPowerW = null;
            this.adapter.log.debug(
                `✓ Charge setpoint validated: ${expectedPowerW}W (actual: ${actualPowerW}W, matched)`
            );
            return false;
        } else if (isRamping) {
            // Device is ramping towards target - keep monitoring
            this.previousPowerW = actualPowerW;
            this.adapter.log.debug(
                `⏳ Charge setpoint ramping: ${expectedPowerW}W (actual: ${actualPowerW}W, getting closer)`
            );
            return false; // No resend needed, device is working
        } else {
            // Device not responding or not improving
            const maxRetries = config.setPowerMaxRetries || 12; // Increased from 5
            this.validationRetryCount++;
            this.previousPowerW = actualPowerW;

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
                this.previousPowerW = null;
                this.lastWrittenLimit = null; // Reset to allow fresh retry in next cycle
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
            this.previousPowerW = null; // Reset ramping detection on new command
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
            this.previousPowerW = null;
        }
    }
}

module.exports = ValidationService;
