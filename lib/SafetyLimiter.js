'use strict';

/**
 * SafetyLimiter Module
 * 
 * Implements all safety checks that cannot be overridden:
 * - SOC-based discharge protection
 * - Voltage-based discharge protection with hysteresis
 * - Emergency recovery blocking
 * - Charge/discharge enable flags
 */
class SafetyLimiter {
    constructor(adapter, deviceBasePath) {
        this.adapter = adapter;
        this.deviceBasePath = deviceBasePath;
    }

    /**
     * Apply all safety limits to power value
     * @param {object} params - Parameters object
     * @param {object} params.config - Adapter configuration
     * @param {object} params.emergencyManager - EmergencyManager instance
     * @param {number} params.batterySoc - Current battery SOC
     * @param {number|null} params.minPackVoltageV - Minimum pack voltage
     * @param {number} params.powerW - Power value to check (negative=charge, positive=discharge)
     * @returns {Promise<{powerW: number, safetyActive: boolean}>} Limited power and safety flag
     */
    async applySafetyLimits(params) {
        const {
            config,
            emergencyManager,
            batterySoc,
            minPackVoltageV,
            powerW
        } = params;

        let limitedPowerW = powerW;
        let safetyActive = false;

        // ========== DISCHARGE PROTECTION ==========
        if (limitedPowerW > 0) {
            // Emergency recovery mode
            if (emergencyManager.inEmergencyRecovery) {
                this.adapter.log.debug(
                    `Emergency recovery active, preventing discharge until ${config.emergencyRecoverySoc || 30}% SOC`
                );
                limitedPowerW = 0;
                safetyActive = true;
            }

            // Device lowVoltageBlock flag
            if (!safetyActive && config.useLowVoltageBlock) {
                const lowVoltageState = await this.adapter.getForeignStateAsync(
                    `${this.deviceBasePath}.control.lowVoltageBlock`
                );
                if (lowVoltageState && lowVoltageState.val === true) {
                    this.adapter.log.debug('Device lowVoltageBlock active, preventing discharge');
                    limitedPowerW = 0;
                    safetyActive = true;
                }
            }

            // SOC or Voltage protection
            if (!safetyActive) {
                const protectionMode = config.dischargeProtectionMode || 'soc';

                if (protectionMode === 'soc') {
                    // SOC-based protection
                    if (batterySoc <= config.minBatterySoc) {
                        this.adapter.log.debug(`Battery SOC low (${batterySoc}%), preventing discharge`);
                        limitedPowerW = 0;
                        safetyActive = true;
                    }
                } else if (protectionMode === 'voltage') {
                    // Voltage-based protection
                    const result = await this._applyVoltageProtection(
                        config,
                        emergencyManager,
                        minPackVoltageV
                    );
                    if (result.blocked) {
                        limitedPowerW = 0;
                        safetyActive = true;
                    }
                }
            }
        }

        // ========== CHARGE PROTECTION ==========
        if (limitedPowerW < 0) {
            if (batterySoc >= config.maxBatterySoc) {
                this.adapter.log.debug(`Battery SOC high (${batterySoc}%), preventing charge`);
                limitedPowerW = 0;
                safetyActive = true;
            }
        }

        // ========== ENABLE FLAGS ==========
        if (limitedPowerW < 0 && !config.enableCharge) {
            this.adapter.log.debug('Charging disabled by configuration');
            limitedPowerW = 0;
            safetyActive = true;
        }

        if (limitedPowerW > 0 && !config.enableDischarge) {
            this.adapter.log.debug('Discharging disabled by configuration');
            limitedPowerW = 0;
            safetyActive = true;
        }

        return { powerW: limitedPowerW, safetyActive };
    }

    /**
     * Apply voltage-based protection with hysteresis
     * @private
     */
    async _applyVoltageProtection(config, emergencyManager, minPackVoltageV) {
        if (minPackVoltageV === null) {
            return { blocked: false };
        }

        const minVoltageLimit = config.minBatteryVoltageV || 3.0;

        // Check if voltage recovery should be activated
        if (minPackVoltageV <= minVoltageLimit) {
            if (!emergencyManager.inVoltageRecovery) {
                await emergencyManager.activateVoltageRecovery(minPackVoltageV, minVoltageLimit);
            }
            this.adapter.log.debug(
                `Pack voltage low (${minPackVoltageV.toFixed(2)}V <= ${minVoltageLimit}V), preventing discharge`
            );
            return { blocked: true };
        }

        // Check if in voltage recovery mode
        if (emergencyManager.inVoltageRecovery) {
            this.adapter.log.debug('Voltage recovery mode active, preventing discharge');
            return { blocked: true };
        }

        return { blocked: false };
    }
}

module.exports = SafetyLimiter;
