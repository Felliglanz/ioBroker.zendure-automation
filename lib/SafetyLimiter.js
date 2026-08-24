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
            // Emergency recovery mode (silent - logged in EmergencyManager)
            if (emergencyManager.inEmergencyRecovery) {
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
                    // SOC-based protection with hysteresis
                    const result = await this._applySocProtection(
                        config,
                        emergencyManager,
                        batterySoc
                    );
                    if (result.blocked) {
                        limitedPowerW = 0;
                        safetyActive = true;
                    }
                } else if (protectionMode === 'voltage' || protectionMode === 'both') {
                    // Voltage-based protection
                    const result = await this._applyVoltageProtection(
                        config,
                        emergencyManager,
                        batterySoc,
                        minPackVoltageV
                    );
                    if (result.blocked) {
                        limitedPowerW = 0;
                        safetyActive = true;
                    }
                    
                    // For 'both' mode, also check SOC
                    if (protectionMode === 'both' && !safetyActive) {
                        const socResult = await this._applySocProtection(
                            config,
                            emergencyManager,
                            batterySoc
                        );
                        if (socResult.blocked) {
                            limitedPowerW = 0;
                            safetyActive = true;
                        }
                    }
                }
            }
        }

        // ========== CHARGE PROTECTION ==========
        if (limitedPowerW < 0) {
            const result = await this._applyMaxSocProtection(config, emergencyManager, batterySoc);
            if (result.blocked) {
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
     * Apply SOC-based protection with hysteresis
     * @private
     */
    async _applySocProtection(config, emergencyManager, batterySoc) {
        const minSoc = config.minBatterySoc ?? 20;

        // Check if SOC recovery should be activated
        if (batterySoc <= minSoc) {
            if (!emergencyManager.inSocRecovery) {
                await emergencyManager.activateSocRecovery(batterySoc, minSoc);
            }
            return { blocked: true };
        }

        // Check if in SOC recovery mode (silent - logged in EmergencyManager)
        if (emergencyManager.inSocRecovery) {
            return { blocked: true };
        }

        return { blocked: false };
    }

    /**
     * Apply max-SOC (full battery) charge protection with hysteresis
     *
     * The Zendure device hard-rejects a new charge setpoint for a while after
     * hitting maxBatterySoc, even once SOC ticks back down by a single percent
     * (rounding/reporting jitter at the ceiling). Without this hysteresis we'd
     * re-request charge on that dip, the device would reject it, and
     * ValidationService would retry every cycle - a permanent failed-validation
     * loop. Mirrors _applySocProtection on the discharge side.
     * @private
     */
    async _applyMaxSocProtection(config, emergencyManager, batterySoc) {
        const maxSoc = config.maxBatterySoc ?? 100;

        // Check if maxSoc recovery should be activated
        if (batterySoc >= maxSoc) {
            if (!emergencyManager.inMaxSocRecovery) {
                await emergencyManager.activateMaxSocRecovery(batterySoc, maxSoc);
            }
            return { blocked: true };
        }

        // Check if in maxSoc recovery mode (silent - logged in EmergencyManager)
        if (emergencyManager.inMaxSocRecovery) {
            return { blocked: true };
        }

        return { blocked: false };
    }

    /**
     * Apply voltage-based protection with hysteresis
     * @private
     */
    async _applyVoltageProtection(config, emergencyManager, batterySoc, minPackVoltageV) {
        // Check Zendure minSoc limit (prevents hardware block at ~5%)
        if (config.useZendureMinSoc !== false) {
            try {
                const minSocState = await this.adapter.getForeignStateAsync(
                    `${this.deviceBasePath}.minSoc`
                );
                if (minSocState && minSocState.val !== null && minSocState.val !== undefined) {
                    const zendureMinSoc = Number(minSocState.val);
                    const margin = config.zendureMinSocMargin ?? 1;
                    const effectiveLimit = zendureMinSoc + margin;
                    
                    // Check if minSoc recovery should be activated
                    if (batterySoc <= effectiveLimit) {
                        if (!emergencyManager.inMinSocRecovery) {
                            await emergencyManager.activateMinSocRecovery(batterySoc, effectiveLimit);
                        }
                        return { blocked: true };
                    }

                    // Check if in minSoc recovery mode (silent - logged in EmergencyManager)
                    if (emergencyManager.inMinSocRecovery) {
                        return { blocked: true };
                    }
                }
            } catch (err) {
                this.adapter.log.debug(`Could not read minSoc state: ${err.message}`);
            }
        }

        if (minPackVoltageV === null) {
            return { blocked: false };
        }

        const minVoltageLimit = config.minBatteryVoltageV ?? 3.0;

        // Check if voltage recovery should be activated
        if (minPackVoltageV <= minVoltageLimit) {
            if (!emergencyManager.inVoltageRecovery) {
                await emergencyManager.activateVoltageRecovery(minPackVoltageV, minVoltageLimit);
            }
            return { blocked: true };
        }

        // Check if in voltage recovery mode (silent - logged in EmergencyManager)
        if (emergencyManager.inVoltageRecovery) {
            return { blocked: true };
        }

        return { blocked: false };
    }
}

module.exports = SafetyLimiter;
