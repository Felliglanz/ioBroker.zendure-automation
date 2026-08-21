'use strict';

/**
 * Single Device Automation Controller
 * 
 * Handles the complete automation cycle for a single battery device.
 * Implements the I-Regulator algorithm with:
 * - Power setpoint validation
 * - Grid power reading and EMA filtering
 * - Emergency and recovery management
 * - Anti-windup protection
 * - Relay protection (mode switching)
 * - Safety limits (SOC/Voltage)
 * - Power regulation (hysteresis, ramping, limits)
 * - Status updates
 */

class SingleDeviceController {
    /**
     * @param {object} adapter - ioBroker adapter instance
     * @param {object} components - All required modular components
     * @param {string} deviceBasePath - Device base path in object tree
     */
    constructor(adapter, components, deviceBasePath) {
        this.adapter = adapter;
        this.deviceBasePath = deviceBasePath;
        this.deviceId = deviceBasePath; // Use basePath as unique device ID in single-device mode
        
        // Modular components
        this.dataReader = components.dataReader;
        this.emergencyMgr = components.emergencyMgr;
        this.relayProtection = components.relayProtection;
        this.safetyLimiter = components.safetyLimiter;
        this.powerRegulator = components.powerRegulator;
        this.validationService = components.validationService;
        
        // Runtime state
        this.filteredGridPower = null;
        this.emergencyChargingLogged = false;
        this.exitSocReachedLogged = false;
    }

    /**
     * Run single-device automation cycle
     * @param {object} config - Adapter configuration
     */
    async runCycle(config) {
        // ========== POWER SETPOINT VALIDATION (NON-BLOCKING) ==========
        // Determine validation source from config (packPower, gridInputPower, or none)
        const validationSource = config.validationSource || 'packPower';
        
        let validationPowerW = null;
        if (validationSource === 'packPower') {
            validationPowerW = await this.dataReader.getCurrentBatteryPowerW();
        } else if (validationSource === 'gridInputPower') {
            validationPowerW = await this.dataReader.getGridInputPowerW();
        }
        // If validationSource is 'none' or invalid, validationPowerW stays null (no validation)
        
        if (validationPowerW !== null) {
            await this.validationService.validateSetpoint(this.deviceId, config, validationPowerW);
        }
        // ================================================================

        // ========== READ CURRENT VALUES ==========
        const gridPowerW = await this.dataReader.getGridPowerW(config.powerMeterDp);
        const batterySoc = await this.dataReader.getBatterySoc();
        const currentBatteryPowerW = await this.dataReader.getCurrentBatteryPowerW();
        const targetGridPowerW = await this.dataReader.getTargetGridPowerW(config.targetGridPowerW);
        const minPackVoltageV = await this.dataReader.getMinimumPackVoltageV();

        if (gridPowerW === null || batterySoc === null || currentBatteryPowerW === null) {
            this.adapter.log.warn('Could not read all required values, skipping cycle');
            await this.adapter.setStateAsync('status.mode', 'error', true);
            return;
        }

        // ========== EMA FILTER FOR GRID POWER ==========
        const filteredGridPowerW = this.applyEmaFilter(gridPowerW, config.emaFilterAlpha || 0.5);
        this.adapter.log.debug(`Grid power: raw=${gridPowerW}W, filtered=${filteredGridPowerW}W`);

        // ========== UPDATE STATUS STATES ==========
        await this.updateStatusStates(gridPowerW, batterySoc, currentBatteryPowerW, minPackVoltageV);

        // ========== EMERGENCY & RECOVERY CHECK (HIGHEST PRIORITY) ==========
        const emergencyResult = await this.handleEmergency(config, batterySoc, minPackVoltageV);
        if (emergencyResult.handled) {
            return; // Emergency charging active, skip normal cycle
        }

        // ========== I-REGULATOR: CALCULATE TARGET POWER ==========
        // Get last written power from per-device validation state
        const validationState = this.validationService.getDeviceState(this.deviceId);
        let lastSetPowerW = validationState.lastWrittenLimit !== null 
            ? validationState.lastWrittenLimit 
            : 0;

        // ========== ANTI-WINDUP: Limit lastSetPowerW to prevent integrator windup ==========
        const maxChargePowerW = -(config.maxChargePowerW || 1200);
        const maxDischargePowerW = config.maxDischargePowerW || 1200;
        
        lastSetPowerW = this.applyAntiWindup(lastSetPowerW, maxChargePowerW, maxDischargePowerW);

        this.adapter.log.debug(
            `Cycle: Grid_raw=${gridPowerW}W, Grid_filtered=${filteredGridPowerW}W, ` +
            `Battery_measured=${currentBatteryPowerW}W, Battery_set=${lastSetPowerW}W, ` +
            `SOC=${batterySoc}%, Target=${targetGridPowerW}W`
        );

        // I-Regulator formula (using filtered grid power)
        let newBatteryPowerW = lastSetPowerW + (filteredGridPowerW - targetGridPowerW);
        
        // ========== ANTI-WINDUP: Limit newBatteryPowerW immediately ==========
        newBatteryPowerW = this.applyAntiWindup(newBatteryPowerW, maxChargePowerW, maxDischargePowerW);
        
        this.adapter.log.debug(`Calculated new battery power: ${newBatteryPowerW}W (after anti-windup, before relay protection)`);

        // ========== MODE SWITCHING PROTECTION (RELAY PROTECTION) ==========
        const relayResult = this.relayProtection.applyProtection({
            config: config,
            gridPowerW: filteredGridPowerW,
            currentBatteryPowerW,
            lastSetPowerW,
            newBatteryPowerW
        });
        newBatteryPowerW = relayResult.powerW;
        
        // Update counter states for visibility
        await this.adapter.setStateAsync('status.feedInCounter', relayResult.feedInCounter, true);
        await this.adapter.setStateAsync('status.dischargeCounter', relayResult.dischargeCounter, true);
        await this.adapter.setStateAsync('status.deadbandCounter', relayResult.deadbandCounter, true);

        // ========== SAFETY CHECKS (HIGHEST PRIORITY) ==========
        const safetyResult = await this.safetyLimiter.applySafetyLimits({
            config: config,
            emergencyManager: this.emergencyMgr,
            batterySoc,
            minPackVoltageV,
            powerW: newBatteryPowerW
        });
        newBatteryPowerW = safetyResult.powerW;
        const safetyActive = safetyResult.safetyActive;

        if (safetyActive) {
            this.adapter.log.debug('Safety limit active, regulation bypassed');
        }

        // ========== POWER REGULATION (Hysteresis, Ramping, Limits) ==========
        const regResult = this.powerRegulator.applyRegulation({
            config: config,
            powerW: newBatteryPowerW,
            lastSetPowerW,
            safetyActive,
            bypassHysteresis: relayResult.relayModified
        });
        newBatteryPowerW = regResult.powerW;

        this.adapter.log.debug(
            `Setting battery power: ${newBatteryPowerW}W (Grid: ${gridPowerW}W → ${targetGridPowerW}W)`
        );

        // ========== WRITE TO DEVICE ==========
        await this.validationService.writePowerSetpoint(this.deviceId, this.deviceBasePath, newBatteryPowerW, config);

        // ========== UPDATE MODE STATUS ==========
        await this.updateModeStatus(newBatteryPowerW);
    }

    /**
     * Apply Exponential Moving Average filter to grid power
     */
    applyEmaFilter(rawGridPower, alpha) {
        if (this.filteredGridPower === null) {
            this.filteredGridPower = rawGridPower;
        } else {
            this.filteredGridPower = alpha * rawGridPower + (1 - alpha) * this.filteredGridPower;
        }
        return Math.round(this.filteredGridPower);
    }

    /**
     * Apply anti-windup limiting to power value
     */
    applyAntiWindup(powerW, minPowerW, maxPowerW) {
        if (powerW < minPowerW) {
            this.adapter.log.debug(`Anti-windup: Limiting power from ${powerW}W to ${minPowerW}W`);
            return minPowerW;
        } else if (powerW > maxPowerW) {
            this.adapter.log.debug(`Anti-windup: Limiting power from ${powerW}W to ${maxPowerW}W`);
            return maxPowerW;
        }
        return powerW;
    }

    /**
     * Update status states
     */
    async updateStatusStates(gridPowerW, batterySoc, currentBatteryPowerW, minPackVoltageV) {
        await this.adapter.setStateAsync('status.gridPowerW', gridPowerW, true);
        await this.adapter.setStateAsync('status.batterySoc', batterySoc, true);
        await this.adapter.setStateAsync('status.currentPowerW', currentBatteryPowerW, true);
        if (minPackVoltageV !== null) {
            await this.adapter.setStateAsync('status.minPackVoltageV', minPackVoltageV, true);
        }
        await this.adapter.setStateAsync('status.lastUpdate', Date.now(), true);
    }

    /**
     * Handle emergency and recovery logic
     * @returns {object} { handled: boolean } - true if emergency charging is active
     */
    async handleEmergency(config, batterySoc, minPackVoltageV) {
        // ========== STEP 1: UPDATE ALL RECOVERY STATES FIRST ==========
        // This ensures recovery states are evaluated BEFORE any early returns
        await this.emergencyMgr.updateEmergencyRecovery(config, batterySoc);
        await this.emergencyMgr.updateVoltageRecovery(config, minPackVoltageV);
        await this.emergencyMgr.updateSocRecovery(config, batterySoc);

        // Update minSoc recovery (Zendure hardware protection)
        if (config.useZendureMinSoc !== false && config.dischargeProtectionMode === 'voltage') {
            try {
                const minSocState = await this.adapter.getForeignStateAsync(
                    `${this.deviceBasePath}.minSoc`
                );
                if (minSocState && minSocState.val !== null && minSocState.val !== undefined) {
                    const zendureMinSoc = Number(minSocState.val);
                    const margin = config.zendureMinSocMargin || 1;
                    const effectiveMinSoc = zendureMinSoc + margin;
                    
                    // Update state for transparency
                    await this.adapter.setStateAsync('status.effectiveMinSoc', effectiveMinSoc, true);
                    
                    await this.emergencyMgr.updateMinSocRecovery(config, batterySoc, zendureMinSoc);
                }
            } catch (err) {
                this.adapter.log.debug(`Could not update minSoc recovery: ${err.message}`);
            }
        } else {
            // Clear state if feature disabled
            await this.adapter.setStateAsync('status.effectiveMinSoc', 0, true);
        }

        // ========== STEP 2: CHECK IF STILL IN EMERGENCY RECOVERY ==========
        if (this.emergencyMgr.inEmergencyRecovery) {
            const emergencyExitSoc = config.emergencyExitSoc || 20;
            
            if (batterySoc < emergencyExitSoc) {
                // Phase 1: Charging to exit SOC
                await this.adapter.setStateAsync('status.mode', 'emergency-charging', true);
                
                const emergencyChargePower = -(config.emergencyChargePowerW || 800);
                if (!this.emergencyChargingLogged) {
                    this.adapter.log.warn(`⚡ Emergency charging at ${Math.abs(emergencyChargePower)}W (${batterySoc}% → ${emergencyExitSoc}%)`);
                    this.emergencyChargingLogged = true;
                }
                await this.validationService.writePowerSetpoint(this.deviceId, this.deviceBasePath, emergencyChargePower, config, { bypassHoldOff: true });
                return { handled: true };
            } else {
                // Phase 2: Exit SOC reached, in recovery phase waiting for recovery SOC
                await this.adapter.setStateAsync('status.mode', 'recovery', true);

                if (!this.exitSocReachedLogged) {
                    const recoverySoc = config.emergencyRecoverySoc || 30;
                    this.adapter.log.info(`⏳ Recovery phase: waiting for ${recoverySoc}% (currently ${batterySoc}%)`);
                    this.exitSocReachedLogged = true;
                }

                // Stop charging, discharge blocked by SafetyLimiter
                await this.validationService.writePowerSetpoint(this.deviceId, this.deviceBasePath, 0, config);
                return { handled: false }; // Continue to normal cycle, SafetyLimiter blocks discharge
            }
        }

        // ========== STEP 3: CHECK FOR NEW EMERGENCY CONDITIONS ==========
        const emergencyState = await this.emergencyMgr.checkEmergencyConditions(
            config,
            batterySoc,
            minPackVoltageV
        );
        
        if (emergencyState.isEmergency) {
            // NEW EMERGENCY DETECTED
            this.adapter.log.warn(`🚨 EMERGENCY TRIGGERED: ${emergencyState.reason}`);
            this.adapter.log.warn(`🔒 Activating persistent emergency recovery mode`);
            await this.emergencyMgr.activateEmergencyRecovery();
            
            await this.adapter.setStateAsync('status.mode', 'emergency-charging', true);
            await this.adapter.setStateAsync('status.emergencyReason', emergencyState.reason, true);
            
            // Start emergency charging immediately
            const emergencyChargePower = -(config.emergencyChargePowerW || 800);
            const emergencyExitSoc = config.emergencyExitSoc || 20;
            this.adapter.log.warn(`⚡ Emergency charging at ${Math.abs(emergencyChargePower)}W (${batterySoc}% → ${emergencyExitSoc}%)`);
            this.emergencyChargingLogged = true;
            this.exitSocReachedLogged = false; // Reset for next recovery
            await this.validationService.writePowerSetpoint(this.deviceId, this.deviceBasePath, emergencyChargePower, config);
            return { handled: true };
        }

        // ========== STEP 4: NO EMERGENCY, NORMAL OPERATION ==========
        await this.adapter.setStateAsync('status.emergencyReason', '', true);
        this.emergencyChargingLogged = false;
        this.exitSocReachedLogged = false;
        return { handled: false };
    }

    /**
     * Update adapter mode status
     */
    async updateModeStatus(newBatteryPowerW) {
        let mode = 'standby';
        if (newBatteryPowerW < -10) {
            mode = 'charging';
        } else if (newBatteryPowerW > 10) {
            mode = 'discharging';
        }
        
        // Override mode display if in recovery
        if (this.emergencyMgr.inEmergencyRecovery || this.emergencyMgr.inVoltageRecovery || this.emergencyMgr.inSocRecovery || this.emergencyMgr.inMinSocRecovery) {
            if (mode === 'standby') {
                mode = 'recovery';
            }
        }
        
        await this.adapter.setStateAsync('status.mode', mode, true);
    }

    /**
     * Reset filtered grid power (e.g., on adapter restart)
     */
    resetFilter() {
        this.filteredGridPower = null;
    }
}

module.exports = SingleDeviceController;
