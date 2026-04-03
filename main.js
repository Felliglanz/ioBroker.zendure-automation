'use strict';

const utils = require('@iobroker/adapter-core');

// Import modular components
const DataReader = require('./lib/DataReader');
const EmergencyManager = require('./lib/EmergencyManager');
const RelayProtection = require('./lib/RelayProtection');
const SafetyLimiter = require('./lib/SafetyLimiter');
const PowerRegulator = require('./lib/PowerRegulator');
const ValidationService = require('./lib/ValidationService');

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
 * 
 * Modular Architecture:
 * - DataReader: Sensor data access layer
 * - EmergencyManager: Emergency detection & recovery
 * - RelayProtection: Mode switching protection
 * - SafetyLimiter: SOC/Voltage safety checks
 * - PowerRegulator: Hysteresis, ramping, limits
 * - ValidationService: Setpoint validation
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
        this._isRunning = false;
        this._deviceBasePath = null;
        
        // Modular components (initialized in onReady)
        this.dataReader = null;
        this.emergencyMgr = null;
        this.relayProtection = null;
        this.safetyLimiter = null;
        this.powerRegulator = null;
        this.validationService = null;
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

        // Initialize modular components
        this.dataReader = new DataReader(this, this._deviceBasePath);
        this.emergencyMgr = new EmergencyManager(this, this._deviceBasePath);
        this.relayProtection = new RelayProtection(this);
        this.safetyLimiter = new SafetyLimiter(this, this._deviceBasePath);
        this.powerRegulator = new PowerRegulator(this);
        this.validationService = new ValidationService(this);
        
        this.log.info('✓ Modular components initialized');

        // Initialize control states
        await this.setStateAsync('control.enabled', true, true);
        await this.setStateAsync('control.targetGridPowerW', this.config.targetGridPowerW || 0, true);
        await this.setStateAsync('status.mode', 'idle', true);
        await this.setStateAsync('info.connection', true, true);

        // Restore emergency recovery states from persistent storage
        await this.emergencyMgr.restoreRecoveryStates();

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
            const currentBatteryPowerW = await this.dataReader.getCurrentBatteryPowerW();
            const needsResend = await this.validationService.validateSetpoint(this.config, currentBatteryPowerW);
            // ================================================================

            // ========== READ CURRENT VALUES ==========
            const gridPowerW = await this.dataReader.getGridPowerW(this.config.powerMeterDp);
            const batterySoc = await this.dataReader.getBatterySoc();
            const targetGridPowerW = await this.dataReader.getTargetGridPowerW(this.config.targetGridPowerW);
            const minPackVoltageV = await this.dataReader.getMinimumPackVoltageV();

            if (gridPowerW === null || batterySoc === null || currentBatteryPowerW === null) {
                this.log.warn('Could not read all required values, skipping cycle');
                await this.setStateAsync('status.mode', 'error', true);
                return;
            }

            // Update status states
            await this.setStateAsync('status.gridPowerW', gridPowerW, true);
            await this.setStateAsync('status.batterySoc', batterySoc, true);
            await this.setStateAsync('status.currentPowerW', currentBatteryPowerW, true);
            if (minPackVoltageV !== null) {
                await this.setStateAsync('status.minPackVoltageV', minPackVoltageV, true);
            }
            await this.setStateAsync('status.lastUpdate', Date.now(), true);

            // ========== EMERGENCY & RECOVERY CHECK (HIGHEST PRIORITY) ==========
            const emergencyState = await this.emergencyMgr.checkEmergencyConditions(
                this.config,
                batterySoc,
                minPackVoltageV
            );
            
            if (emergencyState.isEmergency) {
                // EMERGENCY DETECTED
                if (!this.emergencyMgr.inEmergencyRecovery) {
                    this.log.warn(`🚨 EMERGENCY TRIGGERED: ${emergencyState.reason}`);
                    this.log.warn(`🔒 Activating persistent emergency recovery mode`);
                    await this.emergencyMgr.activateEmergencyRecovery();
                }
                
                await this.setStateAsync('status.mode', 'emergency-charging', true);
                await this.setStateAsync('status.emergencyReason', emergencyState.reason, true);
                
                const emergencyExitSoc = this.config.emergencyExitSoc || 20;
                if (batterySoc >= emergencyExitSoc) {
                    this.log.info(`✓ Emergency exit SOC reached (${batterySoc}% >= ${emergencyExitSoc}%)`);
                    await this.setStateAsync('status.mode', 'recovery', true);
                    await this.setStateAsync('status.emergencyReason', '', true);
                } else {
                    // Continue emergency charging
                    const emergencyChargePower = -(this.config.emergencyChargePowerW || 800);
                    this.log.warn(`⚡ Emergency charging at ${Math.abs(emergencyChargePower)}W (${batterySoc}% → ${emergencyExitSoc}%)`);
                    await this.validationService.writePowerSetpoint(this._deviceBasePath, emergencyChargePower);
                    return;
                }
            } else {
                await this.setStateAsync('status.emergencyReason', '', true);
            }

            // Update recovery modes
            await this.emergencyMgr.updateEmergencyRecovery(this.config, batterySoc);
            await this.emergencyMgr.updateVoltageRecovery(this.config, minPackVoltageV);
            // ================================================================

            // ========== I-REGULATOR: CALCULATE TARGET POWER ==========
            const lastSetPowerW = this.validationService.lastWrittenLimit !== null 
                ? this.validationService.lastWrittenLimit 
                : 0;

            this.log.debug(
                `Cycle: Grid=${gridPowerW}W, Battery_measured=${currentBatteryPowerW}W, ` +
                `Battery_set=${lastSetPowerW}W, SOC=${batterySoc}%, Target=${targetGridPowerW}W`
            );

            // I-Regulator formula
            let newBatteryPowerW = lastSetPowerW + (gridPowerW - targetGridPowerW);
            this.log.debug(`Calculated new battery power: ${newBatteryPowerW}W (before limits)`);

            // ========== MODE SWITCHING PROTECTION (RELAY PROTECTION) ==========
            const relayResult = this.relayProtection.applyProtection({
                config: this.config,
                gridPowerW,
                currentBatteryPowerW,
                lastSetPowerW,
                newBatteryPowerW
            });
            newBatteryPowerW = relayResult.powerW;
            
            // Update counter states for visibility
            await this.setStateAsync('status.feedInCounter', relayResult.feedInCounter, true);
            await this.setStateAsync('status.dischargeCounter', relayResult.dischargeCounter, true);

            // ========== SAFETY CHECKS (HIGHEST PRIORITY) ==========
            const safetyResult = await this.safetyLimiter.applySafetyLimits({
                config: this.config,
                emergencyManager: this.emergencyMgr,
                batterySoc,
                minPackVoltageV,
                powerW: newBatteryPowerW
            });
            newBatteryPowerW = safetyResult.powerW;
            const safetyActive = safetyResult.safetyActive;

            if (safetyActive) {
                this.log.debug('Safety limit active, regulation bypassed');
            }

            // ========== POWER REGULATION (Hysteresis, Ramping, Limits) ==========
            const regResult = this.powerRegulator.applyRegulation({
                config: this.config,
                powerW: newBatteryPowerW,
                lastSetPowerW,
                safetyActive
            });
            newBatteryPowerW = regResult.powerW;

            this.log.debug(
                `Setting battery power: ${newBatteryPowerW}W (Grid: ${gridPowerW}W → ${targetGridPowerW}W)`
            );

            // ========== WRITE TO DEVICE ==========
            await this.validationService.writePowerSetpoint(this._deviceBasePath, newBatteryPowerW);

            // ========== UPDATE MODE STATUS ==========
            let mode = 'standby';
            if (newBatteryPowerW < -10) {
                mode = 'charging';
            } else if (newBatteryPowerW > 10) {
                mode = 'discharging';
            }
            
            // Override mode display if in recovery
            if (this.emergencyMgr.inEmergencyRecovery || this.emergencyMgr.inVoltageRecovery) {
                if (mode === 'standby') {
                    mode = 'recovery';
                }
            }
            
            await this.setStateAsync('status.mode', mode, true);

        } catch (err) {
            this.log.error(`Automation cycle error: ${err.message}`);
            await this.setStateAsync('status.mode', 'error', true);
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
                await this.validationService.writePowerSetpoint(this._deviceBasePath, 0);
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
            await this.validationService.writePowerSetpoint(this._deviceBasePath, 0);
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
