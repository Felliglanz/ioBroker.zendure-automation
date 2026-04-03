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
     */
    constructor(adapter, deviceBasePath) {
        this.adapter = adapter;
        this.deviceBasePath = deviceBasePath;
        
        // State flags
        this.inEmergencyRecovery = false;
        this.inVoltageRecovery = false;
    }

    /**
     * Restore persistent recovery states from ioBroker
     * Called on adapter start
     */
    async restoreRecoveryStates() {
        // Restore emergency recovery state
        const emergencyState = await this.adapter.getStateAsync('status.emergencyRecoveryActive');
        if (emergencyState && emergencyState.val === true) {
            this.inEmergencyRecovery = true;
            this.adapter.log.warn('🔒 Restored emergency recovery state - discharge blocked');
        }

        // Restore voltage recovery state
        const voltageState = await this.adapter.getStateAsync('status.voltageRecoveryActive');
        if (voltageState && voltageState.val === true) {
            this.inVoltageRecovery = true;
            this.adapter.log.info('Restored voltage recovery state from previous session');
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
            // 1. Check device lowVoltageBlock flag
            if (config.useLowVoltageBlock) {
                const lowVoltageState = await this.adapter.getForeignStateAsync(
                    `${this.deviceBasePath}.control.lowVoltageBlock`
                );
                if (lowVoltageState && lowVoltageState.val === true) {
                    result.isEmergency = true;
                    result.reason = 'Device lowVoltageBlock flag active';
                    return result;
                }
            }

            // 2. Check device fullChargeNeeded flag
            if (config.useFullChargeNeeded) {
                const fullChargeState = await this.adapter.getForeignStateAsync(
                    `${this.deviceBasePath}.control.fullChargeNeeded`
                );
                if (fullChargeState && fullChargeState.val === true) {
                    result.isEmergency = true;
                    result.reason = 'Device requests full charge (calibration needed)';
                    return result;
                }
            }

            // 3. Check critical pack voltage
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
        await this.adapter.setStateAsync('status.emergencyRecoveryActive', true, true);
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
            await this.adapter.setStateAsync('status.emergencyRecoveryActive', false, true);
            return false;
        } else {
            this.adapter.log.debug(
                `Emergency recovery active (${batterySoc}% < ${recoverySoc}%), discharge blocked`
            );
            return true;
        }
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
                await this.adapter.setStateAsync('status.voltageRecoveryActive', false, true);
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
            await this.adapter.setStateAsync('status.voltageRecoveryActive', false, true);
            return false;
        } else {
            this.adapter.log.debug(
                `Voltage recovery active (${minPackVoltageV.toFixed(2)}V < ${recoveryVoltage.toFixed(2)}V), discharge blocked`
            );
            return true;
        }
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
        await this.adapter.setStateAsync('status.voltageRecoveryActive', true, true);
    }
}

module.exports = EmergencyManager;
