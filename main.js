'use strict';

const utils = require('@iobroker/adapter-core');

/**
 * Battery Automation Engine
 * 
 * This module handles the automatic battery charge/discharge control
 * to achieve zero grid feed-in/draw.
 * 
 * Algorithm inspired by OpenDTU-OnBattery Dynamic Power Limiter:
 * - Reads current grid power
 * - Reads current battery power (charge/discharge)
 * - Calculates new battery power to achieve target grid power
 * - Formula: newBatteryPower = currentBatteryPower + (targetGridPower - actualGridPower)
 * - Applies limits, hysteresis, and ramp rates
 */

class ZendureAutomation extends utils.Adapter {
    constructor(options = {}) {
        super({
            ...options,
            name: 'zendure-automation'
        });

        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));

        // Runtime state
        this._updateTimer = null;
        this._lastBatteryPowerW = 0; // negative = charging, positive = discharging
        this._lastWrittenLimit = null;
        this._isRunning = false;
        this._deviceBasePath = null;
        this._inRecoveryMode = false; // Recovery mode after emergency charging
        this._feedInCounter = 0; // Counter for sustained feed-in detection
    }

    /**
     * Called when adapter is initialized
     */
    async onReady() {
        this.log.info('Zendure Automation Adapter starting...');

        // Validate configuration
        if (!this.validateConfig()) {
            this.log.error('Configuration invalid, adapter will not start');
            return;
        }

        // Build device base path
        const instance = this.config.zendureSolarflowInstance || 'zendure-solarflow.0';
        const productKey = this.config.deviceProductKey || '';
        const deviceKey = this.config.deviceKey || '';

        if (!productKey || !deviceKey) {
            this.log.error('Device ProductKey and DeviceKey must be configured!');
            return;
        }

        this._deviceBasePath = `${instance}.${productKey}.${deviceKey}`;
        this.log.info(`Using device path: ${this._deviceBasePath}`);

        // Initialize control states
        await this.setStateAsync('control.enabled', true, true);
        await this.setStateAsync('control.targetGridPowerW', this.config.targetGridPowerW || 0, true);
        await this.setStateAsync('status.mode', 'idle', true);
        await this.setStateAsync('info.connection', true, true);

        // Subscribe to control states
        this.subscribeStates('control.*');

        // Subscribe to foreign states (grid power and battery power)
        if (this.config.powerMeterDp) {
            await this.subscribeForeignStatesAsync(this.config.powerMeterDp);
        }

        // Subscribe to device states to track current power
        await this.subscribeForeignStatesAsync(`${this._deviceBasePath}.outputPower`);
        await this.subscribeForeignStatesAsync(`${this._deviceBasePath}.inputPower`);
        await this.subscribeForeignStatesAsync(`${this._deviceBasePath}.electricLevel`);

        // Subscribe to pack voltage states (for all packs)
        await this.subscribeForeignStatesAsync(`${this._deviceBasePath}.packData.*.minVol`);

        // Subscribe to device protection flags
        await this.subscribeForeignStatesAsync(`${this._deviceBasePath}.control.lowVoltageBlock`);
        await this.subscribeForeignStatesAsync(`${this._deviceBasePath}.control.fullChargeNeeded`);

        // Start automation loop
        this.startAutomation();
    }

    /**
     * Validate adapter configuration
     */
    validateConfig() {
        if (!this.config.powerMeterDp) {
            this.log.error('Power meter datapoint must be configured!');
            return false;
        }

        if (!this.config.deviceProductKey || !this.config.deviceKey) {
            this.log.error('Device ProductKey and DeviceKey must be configured!');
            return false;
        }

        return true;
    }

    /**
     * Start the automation control loop
     */
    startAutomation() {
        this.log.info(`Starting automation with ${this.config.updateIntervalSec}s interval`);
        this._isRunning = true;

        // Run first cycle immediately
        this.runAutomationCycle().catch(err => {
            this.log.error(`Automation cycle failed: ${err.message}`);
        });

        // Schedule periodic updates
        const intervalMs = (this.config.updateIntervalSec || 5) * 1000;
        this._updateTimer = this.setInterval(() => {
            this.runAutomationCycle().catch(err => {
                this.log.error(`Automation cycle failed: ${err.message}`);
            });
        }, intervalMs);
    }

    /**
     * Main automation cycle - runs periodically
     */
    async runAutomationCycle() {
        try {
            // Check if automation is enabled
            const enabledState = await this.getStateAsync('control.enabled');
            if (!enabledState || !enabledState.val) {
                await this.setStateAsync('status.mode', 'idle', true);
                return;
            }

            // Read current values
            const gridPowerW = await this.getGridPowerW();
            const batterySoc = await this.getBatterySoc();
            const currentBatteryPowerW = await this.getCurrentBatteryPowerW();
            const targetGridPowerW = await this.getTargetGridPowerW();

            if (gridPowerW === null || batterySoc === null || currentBatteryPowerW === null) {
                this.log.warn('Could not read all required values, skipping cycle');
                await this.setStateAsync('status.mode', 'error', true);
                return;
            }

            // Determine protection mode once
            const protectionMode = this.config.dischargeProtectionMode || 'soc';

            // Update status states
            await this.setStateAsync('status.gridPowerW', gridPowerW, true);
            await this.setStateAsync('status.batterySoc', batterySoc, true);
            await this.setStateAsync('status.currentPowerW', currentBatteryPowerW, true);
            
            // Read and update pack voltage if in voltage mode
            if (protectionMode === 'voltage') {
                const minPackVoltageV = await this.getMinimumPackVoltageV();
                if (minPackVoltageV !== null) {
                    await this.setStateAsync('status.minPackVoltageV', minPackVoltageV, true);
                }
            }
            
            await this.setStateAsync('status.lastUpdate', Date.now(), true);

            // ========== EMERGENCY & RECOVERY CHECK (HIGHEST PRIORITY) ==========
            // Check device protection flags and critical voltage BEFORE normal automation
            const emergencyState = await this.checkEmergencyConditions(batterySoc);
            
            if (emergencyState.isEmergency) {
                this.log.warn(`🚨 EMERGENCY MODE ACTIVE: ${emergencyState.reason}`);
                await this.setStateAsync('status.mode', 'emergency-charging', true);
                await this.setStateAsync('status.emergencyReason', emergencyState.reason, true);
                
                // Check if we should exit emergency and enter recovery
                const emergencyExitSoc = this.config.emergencyExitSoc || 20;
                if (batterySoc >= emergencyExitSoc) {
                    this.log.info(`✓ Emergency exit SOC reached (${batterySoc}% >= ${emergencyExitSoc}%), entering recovery mode`);
                    this._inRecoveryMode = true;
                    await this.setStateAsync('status.mode', 'recovery', true);
                    await this.setStateAsync('status.emergencyReason', '', true);
                    // Continue to normal automation (but discharge will be blocked)
                } else {
                    // Continue emergency charging
                    const emergencyChargePower = -(this.config.emergencyChargePowerW || 800);
                    this.log.warn(`⚡ Forcing emergency charge at ${Math.abs(emergencyChargePower)}W (SOC: ${batterySoc}%)`);
                    await this.setBatteryPower(emergencyChargePower);
                    return; // Skip normal automation cycle
                }
            } else {
                // Clear emergency reason when not in emergency
                await this.setStateAsync('status.emergencyReason', '', true);
            }

            // Check recovery mode status
            if (this._inRecoveryMode) {
                const recoverySoc = this.config.emergencyRecoverySoc || 30;
                if (batterySoc >= recoverySoc) {
                    this.log.info(`✓ Recovery complete (${batterySoc}% >= ${recoverySoc}%), resuming normal operation`);
                    this._inRecoveryMode = false;
                    await this.setStateAsync('status.mode', 'standby', true);
                } else {
                    this.log.debug(`Recovery mode active (${batterySoc}% < ${recoverySoc}%), discharge blocked`);
                    await this.setStateAsync('status.mode', 'recovery', true);
                }
            }
            // ================================================================

            // Use last written limit as base for calculation (more stable than measured power)
            // If no limit was written yet, use 0 as starting point
            const lastSetPowerW = this._lastWrittenLimit !== null ? this._lastWrittenLimit : 0;

            this.log.debug(
                `Cycle: Grid=${gridPowerW}W, Battery_measured=${currentBatteryPowerW}W, Battery_set=${lastSetPowerW}W, SOC=${batterySoc}%, Target=${targetGridPowerW}W`
            );

            // Calculate new battery power target
            // Formula: newPower = lastSetPower + (actualGrid - targetGrid)
            // Convention: positive = discharge, negative = charge
            // Use last SET power instead of measured power for stable control loop
            // Example: Grid=+300W (drawing), Target=0W, LastSet=0W
            //   => newPower = 0 + (300 - 0) = +300W (discharge 300W to compensate grid draw)
            // Example: Grid=-200W (feeding), Target=0W, LastSet=0W  
            //   => newPower = 0 + (-200 - 0) = -200W (charge 200W to use excess power)
            
            let newBatteryPowerW = lastSetPowerW + (gridPowerW - targetGridPowerW);

            this.log.debug(`Calculated new battery power: ${newBatteryPowerW}W (before limits)`);

            // ========== FEED-IN SWITCHING PROTECTION ==========
            // Prevents frequent charge/discharge switching by requiring sustained feed-in
            // before switching to charging mode. Protects hardware relays from excessive wear.
            const feedInThresholdW = this.config.feedInThresholdW || -150;
            const feedInDelayTicks = this.config.feedInDelayTicks || 5;
            
            if (newBatteryPowerW < 0) {
                // Would charge - check if feed-in is sufficient and sustained
                if (gridPowerW < feedInThresholdW) {
                    // Sufficient feed-in detected
                    this._feedInCounter++;
                    this.log.debug(`Feed-in detected (${gridPowerW}W < ${feedInThresholdW}W), counter: ${this._feedInCounter}/${feedInDelayTicks}`);
                    
                    if (this._feedInCounter < feedInDelayTicks) {
                        // Not yet sustained enough - stay in discharge/standby mode
                        this.log.info(
                            `Feed-in not yet sustained (${this._feedInCounter}/${feedInDelayTicks} ticks), ` +
                            `staying in discharge mode (Hardware protection)`
                        );
                        newBatteryPowerW = Math.max(0, lastSetPowerW); // Keep discharging or go to standby
                    } else {
                        // Sustained feed-in confirmed - allow charging
                        this.log.info(
                            `✓ Feed-in sustained for ${feedInDelayTicks} ticks (${gridPowerW}W), ` +
                            `allowing charge: ${newBatteryPowerW}W`
                        );
                    }
                } else {
                    // Feed-in below threshold - reset counter and prevent charging
                    if (this._feedInCounter > 0) {
                        this.log.debug(`Feed-in below threshold, resetting counter (was ${this._feedInCounter})`);
                    }
                    this._feedInCounter = 0;
                    newBatteryPowerW = Math.max(0, lastSetPowerW); // Stay in discharge/standby mode
                }
            } else {
                // Not charging (discharging or standby) - reset counter
                if (this._feedInCounter > 0) {
                    this.log.debug(`Switched to discharge/standby, resetting feed-in counter (was ${this._feedInCounter})`);
                }
                this._feedInCounter = 0;
            }
            
            // Update feed-in counter state for visibility
            await this.setStateAsync('status.feedInCounter', this._feedInCounter, true);
            // ==================================================

            // Apply discharge protection based on selected mode
            if (newBatteryPowerW > 0) { // Only when discharging
                // RECOVERY MODE: Block all discharging
                if (this._inRecoveryMode) {
                    this.log.info(`Recovery mode active, preventing discharge until ${this.config.emergencyRecoverySoc || 30}% SOC`);
                    newBatteryPowerW = 0;
                }
                
                // Check device lowVoltageBlock flag (even if not critical enough for emergency)
                if (this.config.useLowVoltageBlock) {
                    const lowVoltageState = await this.getForeignStateAsync(
                        `${this._deviceBasePath}.control.lowVoltageBlock`
                    );
                    if (lowVoltageState && lowVoltageState.val === true) {
                        this.log.info('Device lowVoltageBlock active, preventing discharge');
                        newBatteryPowerW = 0;
                    }
                }
                
                if (protectionMode === 'soc') {
                    // SOC-based protection
                    if (batterySoc <= this.config.minBatterySoc) {
                        this.log.info(`Battery SOC low (${batterySoc}%), preventing discharge`);
                        newBatteryPowerW = 0;
                    }
                } else if (protectionMode === 'voltage') {
                    // Voltage-based protection
                    const minPackVoltageV = await this.getMinimumPackVoltageV();
                    if (minPackVoltageV !== null) {
                        const minVoltageLimit = this.config.minBatteryVoltageV || 3.0;
                        if (minPackVoltageV <= minVoltageLimit) {
                            this.log.info(`Pack voltage low (${minPackVoltageV.toFixed(2)}V <= ${minVoltageLimit}V), preventing discharge`);
                            newBatteryPowerW = 0;
                        }
                    }
                }
            }

            if (batterySoc >= this.config.maxBatterySoc && newBatteryPowerW < 0) {
                this.log.info(`Battery SOC high (${batterySoc}%), preventing charge`);
                newBatteryPowerW = 0;
            }

            // Check charge/discharge enable flags
            if (newBatteryPowerW < 0 && !this.config.enableCharge) {
                this.log.debug('Charging disabled by configuration');
                newBatteryPowerW = 0;
            }

            if (newBatteryPowerW > 0 && !this.config.enableDischarge) {
                this.log.debug('Discharging disabled by configuration');
                newBatteryPowerW = 0;
            }

            // Apply hysteresis (avoid frequent small changes)
            const powerDelta = Math.abs(newBatteryPowerW - lastSetPowerW);
            if (powerDelta < (this.config.hysteresisW || 50)) {
                this.log.debug(`Power delta ${powerDelta}W below hysteresis, keeping current power`);
                newBatteryPowerW = lastSetPowerW;
            }

            // Apply ramp rate limits
            const rampUpLimit = this.config.rampUpWPerCycle || 200;
            const rampDownLimit = this.config.rampDownWPerCycle || 100;

            if (newBatteryPowerW > lastSetPowerW) {
                // Increasing power (slower discharge or faster charge)
                const maxChange = Math.abs(lastSetPowerW) > 0 ? rampUpLimit : 9999;
                if ((newBatteryPowerW - lastSetPowerW) > maxChange) {
                    newBatteryPowerW = lastSetPowerW + maxChange;
                    this.log.debug(`Ramp-up limited to ${maxChange}W/cycle`);
                }
            } else if (newBatteryPowerW < lastSetPowerW) {
                // Decreasing power (slower charge or faster discharge)
                const maxChange = Math.abs(lastSetPowerW) > 0 ? rampDownLimit : 9999;
                if ((lastSetPowerW - newBatteryPowerW) > maxChange) {
                    newBatteryPowerW = lastSetPowerW - maxChange;
                    this.log.debug(`Ramp-down limited to ${maxChange}W/cycle`);
                }
            }

            // Apply absolute power limits
            const maxCharge = -(this.config.maxChargePowerW || 1600);
            const maxDischarge = this.config.maxDischargePowerW || 1600;

            if (newBatteryPowerW < maxCharge) {
                this.log.debug(`Limiting charge to ${maxCharge}W`);
                newBatteryPowerW = maxCharge;
            }

            if (newBatteryPowerW > maxDischarge) {
                this.log.debug(`Limiting discharge to ${maxDischarge}W`);
                newBatteryPowerW = maxDischarge;
            }

            // Round to nearest 10W
            newBatteryPowerW = Math.round(newBatteryPowerW / 10) * 10;

            this.log.info(
                `Setting battery power: ${newBatteryPowerW}W (Grid: ${gridPowerW}W → ${targetGridPowerW}W)`
            );

            // Write to device (only if changed)
            await this.setBatteryPower(newBatteryPowerW);

            // Update mode status
            let mode = 'standby';
            if (newBatteryPowerW < -10) {
                mode = 'charging';
            } else if (newBatteryPowerW > 10) {
                mode = 'discharging';
            }
            await this.setStateAsync('status.mode', mode, true);

        } catch (err) {
            this.log.error(`Automation cycle error: ${err.message}`);
            await this.setStateAsync('status.mode', 'error', true);
        }
    }

    /**
     * Read grid power from configured datapoint
     */
    async getGridPowerW() {
        try {
            const state = await this.getForeignStateAsync(this.config.powerMeterDp);
            if (state && state.val !== null && state.val !== undefined) {
                return Number(state.val);
            }
        } catch (err) {
            this.log.warn(`Could not read grid power: ${err.message}`);
        }
        return null;
    }

    /**
     * Read battery SOC from Zendure device
     */
    async getBatterySoc() {
        try {
            const state = await this.getForeignStateAsync(`${this._deviceBasePath}.electricLevel`);
            if (state && state.val !== null && state.val !== undefined) {
                return Number(state.val);
            }
        } catch (err) {
            this.log.warn(`Could not read battery SOC: ${err.message}`);
        }
        return null;
    }

    /**
     * Get minimum cell voltage across all battery packs
     * Reads all packData.{sn}.minVol states and returns the lowest value
     * @returns {number|null} Minimum voltage in Volts, or null if no packs found
     */
    async getMinimumPackVoltageV() {
        try {
            // Find all pack minVol states
            const packDataPattern = `${this._deviceBasePath}.packData.`;
            const allStates = await this.getForeignObjectsAsync(packDataPattern + '*', 'state');
            
            let minVoltage = null;
            let packCount = 0;

            for (const [id, obj] of Object.entries(allStates)) {
                if (id.endsWith('.minVol')) {
                    const state = await this.getForeignStateAsync(id);
                    if (state && state.val !== null && state.val !== undefined) {
                        const voltage = Number(state.val);
                        packCount++;
                        
                        if (minVoltage === null || voltage < minVoltage) {
                            minVoltage = voltage;
                        }
                        
                        this.log.debug(`Pack ${id.split('.')[4]}: minVol = ${voltage.toFixed(2)}V`);
                    }
                }
            }

            if (packCount > 0) {
                this.log.debug(`Found ${packCount} pack(s), minimum voltage: ${minVoltage?.toFixed(2)}V`);
                return minVoltage;
            } else {
                this.log.warn('No battery packs found for voltage monitoring');
                return null;
            }
        } catch (err) {
            this.log.warn(`Could not read pack voltages: ${err.message}`);
            return null;
        }
    }

    /**
     * Check for emergency conditions that require immediate charging
     * Returns object with isEmergency flag and reason
     * @param {number} batterySoc - Current battery SOC percentage
     * @returns {Promise<{isEmergency: boolean, reason: string}>}
     */
    async checkEmergencyConditions(batterySoc) {
        const result = { isEmergency: false, reason: '' };

        try {
            // 1. Check device lowVoltageBlock flag
            if (this.config.useLowVoltageBlock) {
                const lowVoltageState = await this.getForeignStateAsync(
                    `${this._deviceBasePath}.control.lowVoltageBlock`
                );
                if (lowVoltageState && lowVoltageState.val === true) {
                    result.isEmergency = true;
                    result.reason = 'Device lowVoltageBlock flag active';
                    return result;
                }
            }

            // 2. Check device fullChargeNeeded flag
            if (this.config.useFullChargeNeeded) {
                const fullChargeState = await this.getForeignStateAsync(
                    `${this._deviceBasePath}.control.fullChargeNeeded`
                );
                if (fullChargeState && fullChargeState.val === true) {
                    result.isEmergency = true;
                    result.reason = 'Device requests full charge (calibration needed)';
                    return result;
                }
            }

            // 3. Check critical pack voltage
            const minPackVoltageV = await this.getMinimumPackVoltageV();
            if (minPackVoltageV !== null) {
                const emergencyVoltageLimit = this.config.emergencyChargeVoltageV || 2.8;
                if (minPackVoltageV <= emergencyVoltageLimit) {
                    result.isEmergency = true;
                    result.reason = `Critical pack voltage: ${minPackVoltageV.toFixed(2)}V <= ${emergencyVoltageLimit}V`;
                    return result;
                }
            }

        } catch (err) {
            this.log.warn(`Error checking emergency conditions: ${err.message}`);
        }

        return result;
    }

    /**
     * Read current battery power from Zendure device
     * Returns: negative = charging, positive = discharging
     */
    async getCurrentBatteryPowerW() {
        try {
            // Read both input and output power
            const outputState = await this.getForeignStateAsync(`${this._deviceBasePath}.outputPower`);
            const inputState = await this.getForeignStateAsync(`${this._deviceBasePath}.inputPower`);

            let outputPower = 0;
            let inputPower = 0;

            if (outputState && outputState.val !== null) {
                outputPower = Number(outputState.val);
            }

            if (inputState && inputState.val !== null) {
                inputPower = Number(inputState.val);
            }

            // Net power: positive = discharging, negative = charging
            const netPower = outputPower - inputPower;
            
            this._lastBatteryPowerW = netPower;
            return netPower;

        } catch (err) {
            this.log.warn(`Could not read battery power: ${err.message}`);
        }
        return this._lastBatteryPowerW; // Return last known value
    }

    /**
     * Get target grid power from control state
     */
    async getTargetGridPowerW() {
        try {
            const state = await this.getStateAsync('control.targetGridPowerW');
            if (state && state.val !== null && state.val !== undefined) {
                return Number(state.val);
            }
        } catch (err) {
            this.log.warn(`Could not read target grid power: ${err.message}`);
        }
        return this.config.targetGridPowerW || 0;
    }

    /**
     * Set battery power by writing to setDeviceAutomationInOutLimit
     * @param {number} powerW - Target power (negative=charge, positive=discharge)
     */
    async setBatteryPower(powerW) {
        try {
            // Avoid unnecessary writes
            if (this._lastWrittenLimit === powerW) {
                this.log.debug('Power unchanged, skipping write');
                return;
            }

            // The setDeviceAutomationInOutLimit uses:
            // - negative values for charging
            // - positive values for discharging
            // Which matches our convention
            
            const limitPath = `${this._deviceBasePath}.control.setDeviceAutomationInOutLimit`;
            
            await this.setForeignStateAsync(limitPath, powerW, false);
            
            this._lastWrittenLimit = powerW;
            this.log.info(`✓ Wrote battery limit: ${powerW}W to ${limitPath}`);

        } catch (err) {
            this.log.error(`Failed to set battery power: ${err.message}`);
        }
    }

    /**
     * Handle state changes
     */
    async onStateChange(id, state) {
        if (!state || state.ack) return;

        // Handle control state changes
        if (id.endsWith('.control.enabled')) {
            this.log.info(`Automation ${state.val ? 'enabled' : 'disabled'}`);
            if (!state.val) {
                // Stop battery when disabled
                await this.setBatteryPower(0);
                await this.setStateAsync('status.mode', 'idle', true);
            }
        }

        if (id.endsWith('.control.targetGridPowerW')) {
            this.log.info(`Target grid power changed to ${state.val}W`);
            // Trigger immediate cycle
            this.runAutomationCycle().catch(err => {
                this.log.error(`Automation cycle failed: ${err.message}`);
            });
        }

        // React to grid power changes (faster response)
        if (id === this.config.powerMeterDp) {
            this.log.debug(`Grid power changed to ${state.val}W, triggering cycle`);
            this.runAutomationCycle().catch(err => {
                this.log.error(`Automation cycle failed: ${err.message}`);
            });
        }
    }

    /**
     * Called when adapter is stopped
     */
    async onUnload(callback) {
        try {
            this.log.info('Stopping Zendure Automation...');
            this._isRunning = false;

            if (this._updateTimer) {
                this.clearInterval(this._updateTimer);
                this._updateTimer = null;
            }

            // Set battery to standby
            await this.setBatteryPower(0);
            await this.setStateAsync('status.mode', 'idle', true);
            await this.setStateAsync('info.connection', false, true);

            callback();
        } catch (e) {
            callback();
        }
    }
}

if (require.main !== module) {
    // Export for testing
    module.exports = (options) => new ZendureAutomation(options);
} else {
    // Start adapter instance
    new ZendureAutomation();
}
