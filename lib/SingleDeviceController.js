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
    }

    /**
     * Run single-device automation cycle
     * @param {object} config - Adapter configuration
     */
    async runCycle(config) {
        // ========== POWER SETPOINT VALIDATION (NON-BLOCKING) ==========
        const currentBatteryPowerW = await this.dataReader.getCurrentBatteryPowerW();
        await this.validationService.validateSetpoint(config, currentBatteryPowerW);
        // ================================================================

        // ========== READ CURRENT VALUES ==========
        const gridPowerW = await this.dataReader.getGridPowerW(config.powerMeterDp);
        const batterySoc = await this.dataReader.getBatterySoc();
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
        let lastSetPowerW = this.validationService.lastWrittenLimit !== null 
            ? this.validationService.lastWrittenLimit 
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
            safetyActive
        });
        newBatteryPowerW = regResult.powerW;

        this.adapter.log.debug(
            `Setting battery power: ${newBatteryPowerW}W (Grid: ${gridPowerW}W → ${targetGridPowerW}W)`
        );

        // ========== WRITE TO DEVICE ==========
        await this.validationService.writePowerSetpoint(this.deviceBasePath, newBatteryPowerW);

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
        // Check if already in emergency recovery (persistent state)
        if (this.emergencyMgr.inEmergencyRecovery) {
            // ALREADY IN EMERGENCY RECOVERY
            await this.adapter.setStateAsync('status.mode', 'emergency-charging', true);
            
            const emergencyExitSoc = config.emergencyExitSoc || 20;
            if (batterySoc >= emergencyExitSoc) {
                this.adapter.log.info(`✓ Emergency exit SOC reached (${batterySoc}% >= ${emergencyExitSoc}%)`);
                await this.adapter.setStateAsync('status.mode', 'recovery', true);
                await this.adapter.setStateAsync('status.emergencyReason', '', true);
                this.emergencyChargingLogged = false;
                return { handled: false }; // Exit emergency, continue normal cycle
            } else {
                // Continue emergency charging
                const emergencyChargePower = -(config.emergencyChargePowerW || 800);
                if (!this.emergencyChargingLogged) {
                    this.adapter.log.warn(`⚡ Emergency charging at ${Math.abs(emergencyChargePower)}W (${batterySoc}% → ${emergencyExitSoc}%)`);
                    this.emergencyChargingLogged = true;
                }
                await this.validationService.writePowerSetpoint(this.deviceBasePath, emergencyChargePower);
                return { handled: true };
            }
        } else {
            // NOT IN RECOVERY - Check for new emergency conditions
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
                await this.validationService.writePowerSetpoint(this.deviceBasePath, emergencyChargePower);
                return { handled: true };
            } else {
                await this.adapter.setStateAsync('status.emergencyReason', '', true);
            }
        }

        // Update recovery modes
        await this.emergencyMgr.updateEmergencyRecovery(config, batterySoc);
        await this.emergencyMgr.updateVoltageRecovery(config, minPackVoltageV);
        await this.emergencyMgr.updateSocRecovery(config, batterySoc);
        
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
        if (this.emergencyMgr.inEmergencyRecovery || this.emergencyMgr.inVoltageRecovery || this.emergencyMgr.inSocRecovery) {
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
