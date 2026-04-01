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
        this._inEmergencyRecovery = false; // Persistent emergency recovery mode (survives restarts, both SOC and Voltage)
        this._inVoltageRecovery = false; // Voltage recovery mode after low voltage cutoff (voltage mode only)
        this._feedInCounter = 0; // Counter for sustained feed-in detection (Discharge→Charge)
        this._dischargeCounter = 0; // Counter for sustained grid draw detection (Charge→Discharge)
        this._pendingValidation = false; // Flag: power setpoint needs validation in next cycle
        this._validationRetryCount = 0; // Retry counter for failed validations
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

        // Restore emergency recovery state from persistent storage (survives restarts)
        // This flag protects against discharge after emergency conditions in BOTH modes
        const emergencyRecoveryState = await this.getStateAsync('status.emergencyRecoveryActive');
        if (emergencyRecoveryState && emergencyRecoveryState.val === true) {
            this._inEmergencyRecovery = true;
            this.log.warn('🔒 Restored emergency recovery state from previous session - discharge blocked');
        }

        // Restore voltage recovery state from persistent storage (survives restarts)
        const voltageRecoveryState = await this.getStateAsync('status.voltageRecoveryActive');
        if (voltageRecoveryState && voltageRecoveryState.val === true) {
            this._inVoltageRecovery = true;
            this.log.info('Restored voltage recovery state from previous session');
        }

        // Subscribe to control states
        this.subscribeStates('control.*');

        // Subscribe to foreign states (grid power and battery power)
        if (this.config.powerMeterDp) {
            await this.subscribeForeignStatesAsync(this.config.powerMeterDp);
        }

        // Subscribe to device states to track current power
        await this.subscribeForeignStatesAsync(`${this._deviceBasePath}.packPower`);
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

            // ========== POWER SETPOINT VALIDATION (NON-BLOCKING) ==========
            // Validate previous cycle's power setpoint (if pending)
            // Only for charging (negative values), discharge changes too frequently
            if (this._pendingValidation && this._lastWrittenLimit !== null) {
                const actualPowerW = await this.getCurrentBatteryPowerW();
                const expectedPowerW = this._lastWrittenLimit;
                
                // Only validate charging setpoints (negative values)
                if (expectedPowerW < -50 && actualPowerW !== null) {
                    const deviation = Math.abs(actualPowerW - expectedPowerW);
                    const toleranceW = this.config.setPowerValidationToleranceW || 50;
                    
                    // Accept if device is charging (even if still ramping toward target)
                    // This prevents false failures while device ramps up power gradually
                    const isCharging = actualPowerW < -50;
                    const withinTolerance = deviation <= toleranceW;
                    
                    if (withinTolerance || isCharging) {
                        // Setpoint accepted - device is responding (either at target or ramping)
                        this._pendingValidation = false;
                        this._validationRetryCount = 0;
                        this.log.debug(`✓ Charge setpoint validated: ${expectedPowerW}W (actual: ${actualPowerW}W, ${withinTolerance ? 'matched' : 'ramping'})`);
                    } else {
                        // Device not responding (still at 0W or discharging) - communication issue
                        const maxRetries = this.config.setPowerMaxRetries || 5;
                        this._validationRetryCount++;
                        
                        if (this._validationRetryCount < maxRetries) {
                            // Silent retry - normal during mode switches or device ramp-up
                            this.log.debug(`Charge setpoint retry ${this._validationRetryCount}/${maxRetries}: target=${expectedPowerW}W, actual=${actualPowerW}W`);
                            // Keep pendingValidation=true, will be resent below
                        } else {
                            this.log.error(`❌ Charge setpoint failed after ${maxRetries} attempts (${maxRetries * 5}s): target=${expectedPowerW}W, actual=${actualPowerW}W - possible API communication issue`);
                            this._pendingValidation = false;
                            this._validationRetryCount = 0;
                        }
                    }
                } else {
                    // Not charging anymore or no data - clear validation
                    this._pendingValidation = false;
                    this._validationRetryCount = 0;
                }
            }
            // ================================================================

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
            
            // Read and update pack voltage (always for monitoring, used for protection when in voltage mode)
            const minPackVoltageV = await this.getMinimumPackVoltageV();
            if (minPackVoltageV !== null) {
                await this.setStateAsync('status.minPackVoltageV', minPackVoltageV, true);
            }
            
            await this.setStateAsync('status.lastUpdate', Date.now(), true);

            // ========== EMERGENCY & RECOVERY CHECK (HIGHEST PRIORITY) ==========
            // Check device protection flags and critical voltage BEFORE normal automation
            const emergencyState = await this.checkEmergencyConditions(batterySoc);
            
            if (emergencyState.isEmergency) {
                // EMERGENCY DETECTED - activate persistent recovery mode immediately
                if (!this._inEmergencyRecovery) {
                    this.log.warn(`🚨 EMERGENCY TRIGGERED: ${emergencyState.reason}`);
                    this.log.warn(`🔒 Activating persistent emergency recovery mode (survives restarts)`);
                    this._inEmergencyRecovery = true;
                    await this.setStateAsync('status.emergencyRecoveryActive', true, true);
                }
                
                await this.setStateAsync('status.mode', 'emergency-charging', true);
                await this.setStateAsync('status.emergencyReason', emergencyState.reason, true);
                
                // Check if we can exit emergency charging phase
                const emergencyExitSoc = this.config.emergencyExitSoc || 20;
                if (batterySoc >= emergencyExitSoc) {
                    this.log.info(`✓ Emergency exit SOC reached (${batterySoc}% >= ${emergencyExitSoc}%), entering recovery phase`);
                    await this.setStateAsync('status.mode', 'recovery', true);
                    await this.setStateAsync('status.emergencyReason', '', true);
                    // Continue to normal automation (but discharge blocked by emergencyRecoveryActive)
                } else {
                    // Continue emergency charging until exit SOC
                    const emergencyChargePower = -(this.config.emergencyChargePowerW || 800);
                    this.log.warn(`⚡ Emergency charging at ${Math.abs(emergencyChargePower)}W (SOC: ${batterySoc}% → ${emergencyExitSoc}%)`);
                    await this.setBatteryPower(emergencyChargePower);
                    return; // Skip normal automation cycle
                }
            } else {
                // Clear emergency reason when not in active emergency
                await this.setStateAsync('status.emergencyReason', '', true);
            }

            // Check emergency recovery status (persistent, both SOC and Voltage modes)
            // This blocks discharge after ANY emergency condition until full recovery
            // Mode is NOT set here - recovery just blocks discharge, normal charging continues
            if (this._inEmergencyRecovery) {
                const recoverySoc = this.config.emergencyRecoverySoc || 30;
                if (batterySoc >= recoverySoc) {
                    this.log.info(`✓ Emergency recovery complete (${batterySoc}% >= ${recoverySoc}%), resuming normal operation`);
                    this._inEmergencyRecovery = false;
                    await this.setStateAsync('status.emergencyRecoveryActive', false, true);
                } else {
                    this.log.debug(`Emergency recovery active (${batterySoc}% < ${recoverySoc}%), discharge blocked`);
                }
            }

            // Check voltage recovery mode status (Voltage-based)
            // Mode is NOT set here - recovery just blocks discharge, normal charging continues
            if (this._inVoltageRecovery) {
                const protectionMode = this.config.dischargeProtectionMode || 'soc';
                if (protectionMode === 'voltage') {
                    const minPackVoltageV = await this.getMinimumPackVoltageV();
                    if (minPackVoltageV !== null) {
                        const minVoltageLimit = this.config.minBatteryVoltageV || 3.0;
                        const hysteresis = this.config.voltageRecoveryHysteresisV || 0.1;
                        const recoveryVoltage = minVoltageLimit + hysteresis;
                        
                        if (minPackVoltageV >= recoveryVoltage) {
                            this.log.info(`✓ Voltage recovery complete (${minPackVoltageV.toFixed(2)}V >= ${recoveryVoltage.toFixed(2)}V), resuming discharge`);
                            this._inVoltageRecovery = false;
                            await this.setStateAsync('status.voltageRecoveryActive', false, true);
                        } else {
                            this.log.debug(`Voltage recovery active (${minPackVoltageV.toFixed(2)}V < ${recoveryVoltage.toFixed(2)}V), discharge blocked`);
                        }
                    }
                } else {
                    // If mode changed from voltage to SOC, clear the flag
                    this._inVoltageRecovery = false;
                    await this.setStateAsync('status.voltageRecoveryActive', false, true);
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

            // ========== MODE SWITCHING PROTECTION ==========
            // Prevents frequent charge/discharge switching by requiring sustained conditions
            // before allowing mode transitions. Protects hardware relays from excessive wear.
            const feedInThresholdW = this.config.feedInThresholdW || -150;      // Grid feed-in to start charging
            const feedInDelayTicks = this.config.feedInDelayTicks || 5;         // Delay for discharge→charge
            const dischargeThresholdW = this.config.dischargeThresholdW || 200; // Grid draw to stop charging
            const dischargeDelayTicks = this.config.dischargeDelayTicks || 3;   // Delay for charge→discharge
            
            const currentlyCharging = lastSetPowerW < 0;    // Are we already charging?
            const currentlyDischarging = lastSetPowerW > 0; // Are we already discharging?
            const wantsToCharge = newBatteryPowerW < 0;     // Does regulation want to charge?
            const wantsToDischarge = newBatteryPowerW > 0;  // Does regulation want to discharge?
            
            if (!currentlyCharging && wantsToCharge) {
                // ========== TRANSITION: Discharge/Standby → Charge ==========
                // Require sustained feed-in before starting to charge
                if (gridPowerW < feedInThresholdW) {
                    // Sufficient feed-in detected
                    this._feedInCounter++;
                    this.log.debug(`Feed-in detected (${gridPowerW}W < ${feedInThresholdW}W), counter: ${this._feedInCounter}/${feedInDelayTicks}`);
                    
                    if (this._feedInCounter < feedInDelayTicks) {
                        // Not yet sustained - block transition to charging
                        this.log.debug(
                            `Feed-in not sustained (${this._feedInCounter}/${feedInDelayTicks}), blocking charge transition`
                        );
                        newBatteryPowerW = Math.max(0, newBatteryPowerW); // Allow regulation but block charging (negative values)
                    } else {
                        // Sustained feed-in confirmed
                        // Only check battery power tolerance when switching from active discharging
                        // (to protect relay). No check needed from standby.
                        if (currentlyDischarging) {
                            const modeSwitchToleranceW = 10;
                            if (Math.abs(currentBatteryPowerW) > modeSwitchToleranceW) {
                                this.log.debug(
                                    `Waiting for battery power near 0W before relay switch (current: ${currentBatteryPowerW}W)`
                                );
                                newBatteryPowerW = Math.max(0, newBatteryPowerW); // Force toward zero but block charging
                            } else {
                                this.log.debug(
                                    `✓ Feed-in sustained, battery at ${currentBatteryPowerW}W (~0W), relay safe to switch`
                                );
                            }
                        } else {
                            // Starting from standby - no relay switch needed, allow immediate charging
                            this.log.debug(`✓ Feed-in sustained, allowing charge from standby: ${newBatteryPowerW}W`);
                        }
                    }
                } else {
                    // Feed-in below threshold - reset counter and block
                    if (this._feedInCounter > 0) {
                        this.log.debug(`Feed-in below threshold, resetting counter (was ${this._feedInCounter})`);
                    }
                    this._feedInCounter = 0;
                    newBatteryPowerW = Math.max(0, newBatteryPowerW); // Allow regulation but block charging (negative values)
                }
                // Reset discharge counter when attempting to charge
                this._dischargeCounter = 0;
                
            } else if (currentlyCharging && wantsToDischarge) {
                // ========== TRANSITION: Charge → Discharge ==========
                // Require sustained grid draw before stopping charge and starting discharge
                if (gridPowerW > dischargeThresholdW) {
                    // Sufficient grid draw detected
                    this._dischargeCounter++;
                    this.log.debug(`Grid draw detected (${gridPowerW}W > ${dischargeThresholdW}W), counter: ${this._dischargeCounter}/${dischargeDelayTicks}`);
                    
                    if (this._dischargeCounter < dischargeDelayTicks) {
                        // Not yet sustained - stay in charging mode
                        this.log.debug(
                            `Grid draw not sustained (${this._dischargeCounter}/${dischargeDelayTicks}), staying in charge mode`
                        );
                        newBatteryPowerW = Math.min(0, newBatteryPowerW); // Allow regulation but block discharging (positive values)
                    } else {
                        // Sustained grid draw confirmed - always check battery power tolerance
                        // when switching from charge to discharge (relay protection)
                        const modeSwitchToleranceW = 10;
                        if (Math.abs(currentBatteryPowerW) > modeSwitchToleranceW) {
                            this.log.debug(
                                `Waiting for battery power near 0W before relay switch (current: ${currentBatteryPowerW}W)`
                            );
                            newBatteryPowerW = Math.min(0, newBatteryPowerW); // Force toward zero but block discharging
                        } else {
                            this.log.debug(
                                `✓ Grid draw sustained, battery at ${currentBatteryPowerW}W (~0W), relay safe to switch`
                            );
                        }
                    }
                } else {
                    // Grid draw below threshold - reset counter and stay charging
                    if (this._dischargeCounter > 0) {
                        this.log.debug(`Grid draw below threshold, resetting counter (was ${this._dischargeCounter})`);
                    }
                    this._dischargeCounter = 0;
                    newBatteryPowerW = Math.min(0, newBatteryPowerW); // Allow regulation but block discharging (positive values)
                }
                // Reset feed-in counter when attempting to discharge
                this._feedInCounter = 0;
                
            } else if (currentlyCharging && wantsToCharge) {
                // ========== CONTINUE CHARGING ==========
                // Already charging, continue with normal regulation (no counter check)
                this.log.debug(`Continuing charge mode, normal regulation applies`);
                // Keep counters to indicate active charge mode
                if (this._feedInCounter < feedInDelayTicks) {
                    this._feedInCounter = feedInDelayTicks;
                }
                this._dischargeCounter = 0;
                
            } else if (currentlyDischarging && wantsToDischarge) {
                // ========== CONTINUE DISCHARGING ==========
                // Already discharging, continue with normal regulation (no counter check)
                this.log.debug(`Continuing discharge mode, normal regulation applies`);
                this._feedInCounter = 0;
                // Keep discharge counter to indicate active discharge mode
                if (this._dischargeCounter < dischargeDelayTicks) {
                    this._dischargeCounter = dischargeDelayTicks;
                }
                
            } else {
                // ========== OTHER TRANSITIONS (Standby, etc.) ==========
                // Reset counters for standby or other states
                if (this._feedInCounter > 0 || this._dischargeCounter > 0) {
                    this.log.debug(`Mode change to standby, resetting counters`);
                }
                this._feedInCounter = 0;
                this._dischargeCounter = 0;
            }
            
            // Update counter states for visibility
            await this.setStateAsync('status.feedInCounter', this._feedInCounter, true);
            await this.setStateAsync('status.dischargeCounter', this._dischargeCounter, true);
            // ==================================================

            // ========== SAFETY CHECKS (HIGHEST PRIORITY - CANNOT BE OVERRIDDEN) ==========
            let safetyLimitActive = false;
            
            // Apply discharge protection based on selected mode
            if (newBatteryPowerW > 0) { // Only when discharging
                // EMERGENCY RECOVERY MODE: Block all discharging (persistent, both SOC and Voltage modes)
                if (this._inEmergencyRecovery) {
                    this.log.debug(`Emergency recovery active, preventing discharge until ${this.config.emergencyRecoverySoc || 30}% SOC`);
                    newBatteryPowerW = 0;
                    safetyLimitActive = true;
                }
                
                // Check device lowVoltageBlock flag (even if not critical enough for emergency)
                if (this.config.useLowVoltageBlock) {
                    const lowVoltageState = await this.getForeignStateAsync(
                        `${this._deviceBasePath}.control.lowVoltageBlock`
                    );
                    if (lowVoltageState && lowVoltageState.val === true) {
                        this.log.debug('Device lowVoltageBlock active, preventing discharge');
                        newBatteryPowerW = 0;
                        safetyLimitActive = true;
                    }
                }
                
                if (protectionMode === 'soc') {
                    // SOC-based protection
                    if (batterySoc <= this.config.minBatterySoc) {
                        this.log.debug(`Battery SOC low (${batterySoc}%), preventing discharge`);
                        newBatteryPowerW = 0;
                        safetyLimitActive = true;
                    }
                } else if (protectionMode === 'voltage') {
                    // Voltage-based protection with hysteresis recovery
                    const minPackVoltageV = await this.getMinimumPackVoltageV();
                    if (minPackVoltageV !== null) {
                        const minVoltageLimit = this.config.minBatteryVoltageV || 3.0;
                        
                        // Check if voltage recovery mode should be activated
                        if (minPackVoltageV <= minVoltageLimit) {
                            if (!this._inVoltageRecovery) {
                                this.log.warn(`⚠️ Pack voltage critically low (${minPackVoltageV.toFixed(2)}V <= ${minVoltageLimit}V), entering voltage recovery mode`);
                                this._inVoltageRecovery = true;
                                await this.setStateAsync('status.voltageRecoveryActive', true, true);
                            }
                            this.log.debug(`Pack voltage low (${minPackVoltageV.toFixed(2)}V <= ${minVoltageLimit}V), preventing discharge`);
                            newBatteryPowerW = 0;
                            safetyLimitActive = true;
                        }
                        
                        // Block discharge if in voltage recovery (requires voltage + hysteresis to exit)
                        if (this._inVoltageRecovery) {
                            this.log.debug(`Voltage recovery mode active, preventing discharge`);
                            newBatteryPowerW = 0;
                            safetyLimitActive = true;
                        }
                    }
                }
            }

            if (batterySoc >= this.config.maxBatterySoc && newBatteryPowerW < 0) {
                this.log.debug(`Battery SOC high (${batterySoc}%), preventing charge`);
                newBatteryPowerW = 0;
                safetyLimitActive = true;
            }

            // Check charge/discharge enable flags
            if (newBatteryPowerW < 0 && !this.config.enableCharge) {
                this.log.debug('Charging disabled by configuration');
                newBatteryPowerW = 0;
                safetyLimitActive = true;
            }

            if (newBatteryPowerW > 0 && !this.config.enableDischarge) {
                this.log.debug('Discharging disabled by configuration');
                newBatteryPowerW = 0;
                safetyLimitActive = true;
            }
            // ========== END SAFETY CHECKS ==========

            // Apply hysteresis (only if no safety limit is active)
            // Hysteresis prevents small frequent changes during normal operation
            // but NEVER overrides safety limits (SOC/voltage protection)
            if (!safetyLimitActive) {
                const powerDelta = Math.abs(newBatteryPowerW - lastSetPowerW);
                if (powerDelta < (this.config.hysteresisW || 50)) {
                    this.log.debug(`Power delta ${powerDelta}W below hysteresis, keeping current power`);
                    newBatteryPowerW = lastSetPowerW;
                }
            } else {
                this.log.debug('Safety limit active, hysteresis bypassed');
            }

            // Apply ramp rate limits (only if no safety limit is active)
            // Ramp limits prevent sudden power changes during normal operation
            // but NEVER override safety limits
            // 
            // IMPORTANT: Ramp limit is chosen based on CURRENT MODE, not direction of change
            // - If currently discharging (>0): use discharge ramp for all changes (up or down)
            // - If currently charging (<0): use charge ramp for all changes (up or down)
            // This ensures fast response when discharging (600W) and gentle regulation when charging (100W)
            if (!safetyLimitActive) {
                const rampChargeLimit = this.config.rampChargeWPerCycle || 100;
                const rampDischargeLimit = this.config.rampDischargeWPerCycle || 400;

                const powerChange = newBatteryPowerW - lastSetPowerW;
                const isCurrentlyInDischargeMode = lastSetPowerW > 0;
                const isCurrentlyInChargeMode = lastSetPowerW < 0;

                if (isCurrentlyInDischargeMode) {
                    // Currently discharging: use discharge ramp for ALL changes (up or down)
                    if (Math.abs(powerChange) > rampDischargeLimit) {
                        if (powerChange > 0) {
                            // Increasing discharge
                            newBatteryPowerW = lastSetPowerW + rampDischargeLimit;
                        } else {
                            // Decreasing discharge (toward zero)
                            newBatteryPowerW = lastSetPowerW - rampDischargeLimit;
                        }
                        this.log.debug(`Discharge ramp applied: ${rampDischargeLimit}W/cycle (change: ${powerChange.toFixed(0)}W)`);
                    }
                } else if (isCurrentlyInChargeMode) {
                    // Currently charging: use charge ramp for ALL changes (up or down)
                    if (Math.abs(powerChange) > rampChargeLimit) {
                        if (powerChange > 0) {
                            // Decreasing charge (toward zero)
                            newBatteryPowerW = lastSetPowerW + rampChargeLimit;
                        } else {
                            // Increasing charge
                            newBatteryPowerW = lastSetPowerW - rampChargeLimit;
                        }
                        this.log.debug(`Charge ramp applied: ${rampChargeLimit}W/cycle (change: ${powerChange.toFixed(0)}W)`);
                    }
                } else {
                    // Starting from zero/standby: use appropriate ramp based on target direction
                    if (powerChange > 0 && Math.abs(powerChange) > rampDischargeLimit) {
                        // Starting discharge
                        newBatteryPowerW = rampDischargeLimit;
                        this.log.debug(`Starting discharge with ramp: ${rampDischargeLimit}W/cycle`);
                    } else if (powerChange < 0 && Math.abs(powerChange) > rampChargeLimit) {
                        // Starting charge
                        newBatteryPowerW = -rampChargeLimit;
                        this.log.debug(`Starting charge with ramp: ${rampChargeLimit}W/cycle`);
                    }
                }
            } else {
                this.log.debug('Safety limit active, ramp limits bypassed');
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

            this.log.debug(
                `Setting battery power: ${newBatteryPowerW}W (Grid: ${gridPowerW}W → ${targetGridPowerW}W)`
            );

            // Write to device (only if changed)
            await this.setBatteryPower(newBatteryPowerW);

            // Update mode status based on actual power and recovery state
            let mode = 'standby';
            if (newBatteryPowerW < -10) {
                mode = 'charging';
            } else if (newBatteryPowerW > 10) {
                mode = 'discharging';
            }
            
            // Override mode display if in recovery (but still show actual action)
            if (this._inEmergencyRecovery || this._inVoltageRecovery) {
                if (mode === 'standby') {
                    mode = 'recovery'; // Show recovery only when idle
                }
                // If charging, show 'charging' (user sees battery is being charged)
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
            // Read packPower from Zendure device
            // Note: Zendure packPower convention is INVERTED:
            //   Zendure: negative=discharge, positive=charge
            //   Our code: positive=discharge, negative=charge
            // Therefore we invert: -packPower
            const packPowerState = await this.getForeignStateAsync(`${this._deviceBasePath}.packPower`);

            if (packPowerState && packPowerState.val !== null && packPowerState.val !== undefined) {
                // Invert Zendure packPower to match our code convention
                const batteryPower = -Number(packPowerState.val);
                this._lastBatteryPowerW = batteryPower;
                return batteryPower;
            }

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
     * Non-blocking: writes immediately, validation happens in next cycle
     * Only validates charging setpoints (negative values), discharge changes too frequently
     * @param {number} powerW - Target power (negative=charge, positive=discharge)
     */
    async setBatteryPower(powerW) {
        try {
            const limitPath = `${this._deviceBasePath}.control.setDeviceAutomationInOutLimit`;
            
            // Check if we need to resend due to failed validation
            const needsResend = this._pendingValidation && this._validationRetryCount > 0;
            
            // Avoid unnecessary writes (unless retry needed)
            if (!needsResend && this._lastWrittenLimit === powerW) {
                this.log.debug('Power unchanged, skipping write');
                return;
            }

            // The setDeviceAutomationInOutLimit uses:
            // - negative values for charging
            // - positive values for discharging
            // Which matches our convention
            
            // Write the value (non-blocking)
            await this.setForeignStateAsync(limitPath, powerW, false);
            this._lastWrittenLimit = powerW;
            
            if (needsResend) {
                this.log.debug(`📤 Resent battery limit: ${powerW}W (validation retry ${this._validationRetryCount})`);
            } else {
                this.log.debug(`📤 Wrote battery limit: ${powerW}W`);
            }
            
            // Enable validation for charging setpoints only (negative values < -50W)
            // Discharge (positive) changes constantly, validation not useful
            if (powerW < -50) {
                this._pendingValidation = true;
                // Don't reset retry count if this is a resend
                if (!needsResend) {
                    this._validationRetryCount = 0;
                }
                this.log.debug(`⏳ Charge setpoint ${powerW}W will be validated in next cycle`);
            } else {
                // Discharge or standby - no validation needed
                this._pendingValidation = false;
                this._validationRetryCount = 0;
            }

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
