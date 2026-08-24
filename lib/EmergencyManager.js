'use strict';

/**
 * EmergencyManager Module
 * 
 * Handles emergency detection and recovery modes:
 * - Emergency charging (critical conditions)
 * - Emergency recovery (discharge blocking after emergency)
 * - Voltage recovery (low voltage protection with hysteresis)
 */
class EmergencyManager {
    /**
     * @param {object} adapter - ioBroker adapter instance
     * @param {string} deviceBasePath - Base path to Zendure device states
     * @param {string} [statePrefix='status.'] - Prefix for this instance's own persisted
     *   recovery states. Single-device mode uses the default (e.g. 'status.emergencyRecoveryActive').
     *   Multi-device mode scopes each device's flags under its own branch, e.g.
     *   'status.devices.device1.', so devices no longer share one global recovery state.
     */
    constructor(adapter, deviceBasePath, statePrefix = 'status.') {
        this.adapter = adapter;
        this.deviceBasePath = deviceBasePath;
        this.statePrefix = statePrefix;
        
        // State flags
        this.inEmergencyRecovery = false;
        this.inVoltageRecovery = false;
        this.inSocRecovery = false;
        this.inMinSocRecovery = false;  // Zendure hardware minSoc protection
        this.inMaxSocRecovery = false;  // full-battery charge hysteresis (issue: device hard-rejects charge right after SOC dips off 100%)
    }

    /**
     * Build this instance's own (device-scoped) state ID
     */
    _stateId(suffix) {
        return `${this.statePrefix}${suffix}`;
    }

    /**
     * Restore persistent recovery states from ioBroker
     * Called on adapter start
     */
    async restoreRecoveryStates() {
        // Restore emergency recovery state
        const emergencyState = await this.adapter.getStateAsync(this._stateId('emergencyRecoveryActive'));
        if (emergencyState && emergencyState.val === true) {
            this.inEmergencyRecovery = true;
            this.adapter.log.warn(`🔒 [${this.deviceBasePath}] Restored emergency recovery state - discharge blocked`);
        }

        // Restore voltage recovery state
        const voltageState = await this.adapter.getStateAsync(this._stateId('voltageRecoveryActive'));
        if (voltageState && voltageState.val === true) {
            this.inVoltageRecovery = true;
            this.adapter.log.info(`Restored voltage recovery state from previous session [${this.deviceBasePath}]`);
        }

        // Restore SOC recovery state
        const socState = await this.adapter.getStateAsync(this._stateId('socRecoveryActive'));
        if (socState && socState.val === true) {
            this.inSocRecovery = true;
            this.adapter.log.info(`Restored SOC recovery state from previous session [${this.deviceBasePath}]`);
        }

        // Restore minSoc recovery state
        const minSocState = await this.adapter.getStateAsync(this._stateId('minSocRecoveryActive'));
        if (minSocState && minSocState.val === true) {
            this.inMinSocRecovery = true;
            this.adapter.log.info(`Restored minSoc recovery state from previous session [${this.deviceBasePath}]`);
        }

        // Restore maxSoc recovery state
        const maxSocState = await this.adapter.getStateAsync(this._stateId('maxSocRecoveryActive'));
        if (maxSocState && maxSocState.val === true) {
            this.inMaxSocRecovery = true;
            this.adapter.log.info(`Restored maxSoc recovery state from previous session [${this.deviceBasePath}]`);
        }
    }

    /**
     * Check for emergency conditions requiring immediate charging
     * @param {object} config - Adapter configuration
     * @param {number} batterySoc - Current battery SOC percentage
     * @param {number|null} minPackVoltageV - Minimum pack voltage
     * @returns {Promise<{isEmergency: boolean, reason: string}>}
     */
    async checkEmergencyConditions(config, batterySoc, minPackVoltageV) {
        const result = { isEmergency: false, reason: '' };

        try {
            // Emergency charging is intentionally voltage-only. Device flags
            // remain available to SafetyLimiter for discharge blocking.
            if (minPackVoltageV !== null) {
                const emergencyVoltageLimit = config.emergencyChargeVoltageV || 2.8;
                if (minPackVoltageV <= emergencyVoltageLimit) {
                    result.isEmergency = true;
                    result.reason = `Critical pack voltage: ${minPackVoltageV.toFixed(2)}V <= ${emergencyVoltageLimit}V`;
                    return result;
                }
            }
        } catch (err) {
            this.adapter.log.warn(`Error checking emergency conditions: ${err.message}`);
        }

        return result;
    }

    /**
     * Activate emergency recovery mode
     */
    async activateEmergencyRecovery() {
        this.inEmergencyRecovery = true;
        await this.adapter.setStateAsync(this._stateId('emergencyRecoveryActive'), true, true);
    }

    /**
     * Update emergency recovery state (check if recovery is complete)
     * @param {object} config - Adapter configuration
     * @param {number} batterySoc - Current battery SOC
     * @returns {boolean} True if still in recovery
     */
    async updateEmergencyRecovery(config, batterySoc) {
        if (!this.inEmergencyRecovery) return false;

        const recoverySoc = config.emergencyRecoverySoc || 30;
        if (batterySoc >= recoverySoc) {
            this.adapter.log.info(
                `✓ Emergency recovery complete (${batterySoc}% >= ${recoverySoc}%), resuming normal operation`
            );
            this.inEmergencyRecovery = false;
            await this.adapter.setStateAsync(this._stateId('emergencyRecoveryActive'), false, true);
            return false;
        }
        // Still in recovery (no spam logging)
        return true;
    }

    /**
     * Update voltage recovery state
     * @param {object} config - Adapter configuration
     * @param {number|null} minPackVoltageV - Current minimum pack voltage
     * @returns {Promise<boolean>} True if still in voltage recovery
     */
    async updateVoltageRecovery(config, minPackVoltageV) {
        const protectionMode = config.dischargeProtectionMode || 'soc';

        // Only active in voltage protection mode
        if (protectionMode !== 'voltage') {
            if (this.inVoltageRecovery) {
                this.inVoltageRecovery = false;
                await this.adapter.setStateAsync(this._stateId('voltageRecoveryActive'), false, true);
            }
            return false;
        }

        if (!this.inVoltageRecovery || minPackVoltageV === null) {
            return this.inVoltageRecovery;
        }

        const minVoltageLimit = config.minBatteryVoltageV || 3.0;
        const hysteresis = config.voltageRecoveryHysteresisV || 0.1;
        const recoveryVoltage = minVoltageLimit + hysteresis;

        if (minPackVoltageV >= recoveryVoltage) {
            this.adapter.log.info(
                `✓ Voltage recovery complete (${minPackVoltageV.toFixed(2)}V >= ${recoveryVoltage.toFixed(2)}V), resuming discharge`
            );
            this.inVoltageRecovery = false;
            await this.adapter.setStateAsync(this._stateId('voltageRecoveryActive'), false, true);
            return false;
        }
        // Still in recovery (no spam logging)
        return true;
    }

    /**
     * Activate voltage recovery mode
     * @param {number} minPackVoltageV - Voltage that triggered recovery
     * @param {number} minVoltageLimit - Configured minimum voltage limit
     */
    async activateVoltageRecovery(minPackVoltageV, minVoltageLimit) {
        this.adapter.log.warn(
            `⚠️ Pack voltage critically low (${minPackVoltageV.toFixed(2)}V <= ${minVoltageLimit}V), entering voltage recovery mode`
        );
        this.inVoltageRecovery = true;
        await this.adapter.setStateAsync(this._stateId('voltageRecoveryActive'), true, true);
    }

    /**
     * Update SOC recovery state (check if recovery is complete)
     * @param {object} config - Adapter configuration
     * @param {number} batterySoc - Current battery SOC
     * @returns {Promise<boolean>} True if still in SOC recovery
     */
    async updateSocRecovery(config, batterySoc) {
        const protectionMode = config.dischargeProtectionMode || 'soc';

        // Only active in SOC protection mode
        if (protectionMode !== 'soc') {
            if (this.inSocRecovery) {
                this.inSocRecovery = false;
                await this.adapter.setStateAsync(this._stateId('socRecoveryActive'), false, true);
            }
            return false;
        }

        if (!this.inSocRecovery) {
            return false;
        }

        const minSoc = config.minBatterySoc || 20;
        const hysteresis = config.socRecoveryHysteresis || 5;
        const recoverySoc = minSoc + hysteresis;

        if (batterySoc >= recoverySoc) {
            this.adapter.log.info(
                `✓ SOC recovery complete (${batterySoc}% >= ${recoverySoc}%), resuming discharge`
            );
            this.inSocRecovery = false;
            await this.adapter.setStateAsync(this._stateId('socRecoveryActive'), false, true);
            return false;
        }
        // Still in recovery (no spam logging)
        return true;
    }

    /**
     * Activate SOC recovery mode
     * @param {number} batterySoc - SOC that triggered recovery
     * @param {number} minSoc - Configured minimum SOC limit
     */
    async activateSocRecovery(batterySoc, minSoc) {
        this.adapter.log.warn(
            `⚠️ Battery SOC critically low (${batterySoc}% <= ${minSoc}%), entering SOC recovery mode`
        );
        this.inSocRecovery = true;
        await this.adapter.setStateAsync(this._stateId('socRecoveryActive'), true, true);
    }

    /**
     * Update minSoc recovery state (Zendure hardware protection)
     * @param {object} config - Adapter configuration
     * @param {number} batterySoc - Current battery SOC
     * @param {number} zendureMinSoc - Zendure device minSoc setting
     * @returns {Promise<boolean>} True if still in minSoc recovery
     */
    async updateMinSocRecovery(config, batterySoc, zendureMinSoc) {
        const protectionMode = config.dischargeProtectionMode || 'soc';

        // Only active in voltage protection mode
        if (protectionMode !== 'voltage' || config.useZendureMinSoc === false) {
            if (this.inMinSocRecovery) {
                this.inMinSocRecovery = false;
                await this.adapter.setStateAsync(this._stateId('minSocRecoveryActive'), false, true);
            }
            return false;
        }

        if (!this.inMinSocRecovery) {
            return false;
        }

        const margin = config.zendureMinSocMargin || 1;
        const hysteresis = config.zendureMinSocRecoveryHysteresis || 2;
        const effectiveLimit = zendureMinSoc + margin;
        const recoveryLimit = effectiveLimit + hysteresis;

        if (batterySoc >= recoveryLimit) {
            this.adapter.log.info(
                `✓ MinSoc recovery complete (${batterySoc}% >= ${recoveryLimit}%), resuming discharge`
            );
            this.inMinSocRecovery = false;
            await this.adapter.setStateAsync(this._stateId('minSocRecoveryActive'), false, true);
            return false;
        }
        // Still in recovery (no spam logging)
        return true;
    }

    /**
     * Activate minSoc recovery mode
     * @param {number} batterySoc - SOC that triggered recovery
     * @param {number} effectiveLimit - Effective limit (minSoc + margin)
     */
    async activateMinSocRecovery(batterySoc, effectiveLimit) {
        this.adapter.log.warn(
            `⚠️ Zendure minSoc limit reached (${batterySoc}% <= ${effectiveLimit}%), entering minSoc recovery mode`
        );
        this.inMinSocRecovery = true;
        await this.adapter.setStateAsync(this._stateId('minSocRecoveryActive'), true, true);
    }

    /**
     * Update maxSoc recovery state (check if recovery is complete)
     *
     * Mirrors updateSocRecovery/_applySocProtection on the discharge side, but for
     * a full battery: once the device has been at/above maxBatterySoc, the Zendure
     * hardware keeps hard-rejecting a new charge setpoint for a while even after SOC
     * ticks back down by 1% (e.g. rounding/reporting jitter at 100%->99%). Without
     * this hysteresis, SafetyLimiter/WaterfillDistributor immediately allow charging
     * again on that single-percent dip, the device rejects it, and ValidationService
     * retries every cycle until it gives up - a permanent failed-validation loop with
     * needless writes for as long as SOC hovers at the ceiling.
     * @param {object} config - Adapter configuration
     * @param {number} batterySoc - Current battery SOC
     * @returns {Promise<boolean>} True if still in maxSoc recovery
     */
    async updateMaxSocRecovery(config, batterySoc) {
        if (!this.inMaxSocRecovery) {
            return false;
        }

        const maxSoc = config.maxBatterySoc ?? 100;
        const hysteresis = config.maxSocRecoveryHysteresis ?? 4;
        const recoverySoc = maxSoc - hysteresis;

        if (batterySoc <= recoverySoc) {
            this.adapter.log.info(
                `✓ MaxSoc recovery complete (${batterySoc}% <= ${recoverySoc}%), resuming charge`
            );
            this.inMaxSocRecovery = false;
            await this.adapter.setStateAsync(this._stateId('maxSocRecoveryActive'), false, true);
            return false;
        }
        // Still in recovery (no spam logging)
        return true;
    }

    /**
     * Activate maxSoc recovery mode
     * @param {number} batterySoc - SOC that triggered recovery
     * @param {number} maxSoc - Configured maximum SOC limit
     */
    async activateMaxSocRecovery(batterySoc, maxSoc) {
        this.adapter.log.warn(
            `⚠️ Battery SOC at/above max (${batterySoc}% >= ${maxSoc}%), entering maxSoc recovery mode`
        );
        this.inMaxSocRecovery = true;
        await this.adapter.setStateAsync(this._stateId('maxSocRecoveryActive'), true, true);
    }
}

module.exports = EmergencyManager;
