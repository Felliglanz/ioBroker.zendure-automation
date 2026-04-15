'use strict';

const utils = require('@iobroker/adapter-core');

// Import modular components
const DataReader = require('./lib/DataReader');
const EmergencyManager = require('./lib/EmergencyManager');
const RelayProtection = require('./lib/RelayProtection');
const SafetyLimiter = require('./lib/SafetyLimiter');
const PowerRegulator = require('./lib/PowerRegulator');
const ValidationService = require('./lib/ValidationService');
const MultiDeviceManager = require('./lib/MultiDeviceManager');
const SingleDeviceController = require('./lib/SingleDeviceController');

/**
 * Battery Automation Engine
 * 
 * This module handles the automatic battery charge/discharge control
 * to achieve zero grid feed-in/draw.
 * 
 * Algorithm: I-Regulator (Integrator)
 * - Reads current grid power
 * - Uses last setpoint as base (not measured power for stability)
 * - Calculates new battery power to achieve target grid power
 * - Formula: newBatteryPower = lastSetPower + (gridPower - targetGridPower)
 * - Applies relay protection, safety limits, regulation (hysteresis, ramping, limits)
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
        this._isMultiDevice = false;
        
        // I-Regulator state
        this._filteredGridPower = null;  // EMA-filtered grid power for multi-device
        
        // Modular components (initialized in onReady)
        this.dataReader = null;
        this.emergencyMgr = null;  // Single device mode
        this.emergencyManagers = null;  // Multi-device mode: Map<deviceId, EmergencyManager>
        this.relayProtection = null;
        this.safetyLimiter = null;  // Single device mode
        this.safetyLimiters = null;  // Multi-device mode: Map<deviceId, SafetyLimiter>
        this.powerRegulator = null;
        this.validationService = null;
        this.multiDeviceMgr = null;  // Multi-device manager
        this.singleDeviceController = null;  // Single-device automation controller
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

        const instance = this.config.zendureSolarflowInstance || 'zendure-solarflow.0';
        this._isMultiDevice = this.config.multiDeviceEnabled === true;

        // ========== MULTI-DEVICE MODE ==========
        if (this._isMultiDevice) {
            this.log.info('🔄 Multi-Device Mode enabled');
            
            try {
                // Initialize Multi-Device Manager
                this.multiDeviceMgr = new MultiDeviceManager(
                    this,
                    instance,
                    this.config.devices || []
                );

                // Initialize per-device Emergency Managers
                this.emergencyManagers = new Map();
                for (const device of this.multiDeviceMgr.devices) {
                    const emergencyMgr = new EmergencyManager(this, device.basePath);
                    this.emergencyManagers.set(device.id, emergencyMgr);
                }

                // Initialize per-device Safety Limiters
                this.safetyLimiters = new Map();
                for (const device of this.multiDeviceMgr.devices) {
                    const safetyLimiter = new SafetyLimiter(this, device.basePath);
                    this.safetyLimiters.set(device.id, safetyLimiter);
                }

                // Initialize shared components
                this.relayProtection = new RelayProtection(this);
                this.powerRegulator = new PowerRegulator(this);
                this.validationService = new ValidationService(this);
                
                this.log.info('✓ Multi-Device components initialized');

                // Initialize control states
                await this.setStateAsync('control.enabled', true, true);
                await this.setStateAsync('control.targetGridPowerW', this.config.targetGridPowerW || 0, true);
                await this.setStateAsync('status.mode', 'idle', true);
                await this.setStateAsync('info.connection', true, true);

                // Create device channels and states
                await this.createDeviceStates();

                // Restore emergency recovery states for all devices
                for (const [deviceId, emergencyMgr] of this.emergencyManagers) {
                    await emergencyMgr.restoreRecoveryStates();
                }

                // Subscribe to control states
                this.subscribeStates('control.*');

                // Subscribe to grid power meter
                if (this.config.powerMeterDp) {
                    await this.subscribeForeignStatesAsync(this.config.powerMeterDp);
                }

                // Subscribe to all device states
                await this.multiDeviceMgr.subscribeToDevices();

            } catch (err) {
                this.log.error(`Multi-Device initialization failed: ${err.message}`);
                return;
            }

        // ========== SINGLE-DEVICE MODE ==========
        } else {
            this.log.info('📱 Single-Device Mode');
            
            // Build device base path
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
            
            // Initialize single-device controller
            this.singleDeviceController = new SingleDeviceController(
                this,
                {
                    dataReader: this.dataReader,
                    emergencyMgr: this.emergencyMgr,
                    relayProtection: this.relayProtection,
                    safetyLimiter: this.safetyLimiter,
                    powerRegulator: this.powerRegulator,
                    validationService: this.validationService
                },
                this._deviceBasePath
            );
            
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
        }

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

        if (this.config.multiDeviceEnabled) {
            // Multi-device validation
            if (!this.config.devices || this.config.devices.length === 0) {
                this.log.error('Multi-Device enabled but no devices configured!');
                return false;
            }

            const enabledDevices = this.config.devices.filter(d => d.enabled && d.productKey && d.deviceKey);
            if (enabledDevices.length === 0) {
                this.log.error('No valid devices configured (need ProductKey and DeviceKey)!');
                return false;
            }

            this.log.info(`Multi-Device: ${enabledDevices.length} device(s) configured`);
        } else {
            // Single-device validation
            if (!this.config.deviceProductKey || !this.config.deviceKey) {
                this.log.error('Device ProductKey and DeviceKey must be configured!');
                return false;
            }
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

            // Route to appropriate cycle based on mode
            if (this._isMultiDevice) {
                await this.runMultiDeviceAutomationCycle();
            } else {
                await this.singleDeviceController.runCycle(this.config);
            }

        } catch (err) {
            this.log.error(`Automation cycle error: ${err.message}`);
            await this.setStateAsync('status.mode', 'error', true);
        }
    }



    /**
     * Multi-device automation cycle
     */
    async runMultiDeviceAutomationCycle() {
        // ========== READ GRID POWER ==========
        const gridPowerW = await this.getGridPowerForMultiDevice(this.config.powerMeterDp);
        const targetGridPowerW = await this.getTargetGridPowerForMultiDevice(this.config.targetGridPowerW);

        if (gridPowerW === null) {
            this.log.warn('Could not read grid power, skipping cycle');
            await this.setStateAsync('status.mode', 'error', true);
            return;
        }

        // ========== EMA FILTER FOR GRID POWER ==========
        const emaAlpha = this.config.emaFilterAlpha || 0.5;
        if (this._filteredGridPower === null) {
            this._filteredGridPower = gridPowerW;
        } else {
            this._filteredGridPower = emaAlpha * gridPowerW + (1 - emaAlpha) * this._filteredGridPower;
        }
        const filteredGridPowerW = Math.round(this._filteredGridPower);
        this.log.debug(`Grid power: raw=${gridPowerW}W, filtered=${filteredGridPowerW}W`);

        // ========== AGGREGATE DEVICE STATES ==========
        const aggregatedState = await this.multiDeviceMgr.aggregateDeviceStates();

        if (aggregatedState.availableDevicesCount === 0) {
            this.log.warn('No available devices, skipping cycle');
            await this.setStateAsync('status.mode', 'error', true);
            return;
        }

        // Update global status states
        await this.setStateAsync('status.gridPowerW', gridPowerW, true);
        await this.setStateAsync('status.totalPowerW', aggregatedState.totalPowerW, true);
        await this.setStateAsync('status.avgSoc', aggregatedState.avgSoc, true);
        await this.setStateAsync('status.lastUpdate', Date.now(), true);
        if (aggregatedState.minPackVoltageV !== null) {
            await this.setStateAsync('status.minPackVoltageV', aggregatedState.minPackVoltageV, true);
        }

        // Update per-device status states
        await this.updateDeviceStates(aggregatedState.devices);

        // ========== CHECK EMERGENCY FOR EACH DEVICE ==========
        const emergencyDevices = [];
        const normalDevices = [];

        for (const device of aggregatedState.devices) {
            if (!device.available) continue;

            const emergencyMgr = this.emergencyManagers.get(device.id);
            if (!emergencyMgr) continue;

            // Update recovery states first
            await emergencyMgr.updateEmergencyRecovery(this.config, device.soc);
            await emergencyMgr.updateVoltageRecovery(this.config, device.minPackVoltageV);

            // Check if in recovery after update
            if (emergencyMgr.inEmergencyRecovery) {
                emergencyDevices.push(device);
                const emergencyExitSoc = this.config.emergencyExitSoc || 20;
                this.log.warn(`⚡ ${device.name} emergency charging: ${device.soc}% → ${emergencyExitSoc}%`);
            } else if (emergencyMgr.inVoltageRecovery) {
                emergencyDevices.push(device);
                const emergencyExitVoltage = this.config.emergencyExitVoltage || 3.1;
                this.log.warn(`⚡ ${device.name} voltage recovery: ${device.minPackVoltageV?.toFixed(2) || 'N/A'}V → ${emergencyExitVoltage}V`);
            } else {
                // Check for new emergency
                const emergencyState = await emergencyMgr.checkEmergencyConditions(
                    this.config,
                    device.soc,
                    device.minPackVoltageV
                );

                if (emergencyState.isEmergency) {
                    this.log.warn(`🚨 ${device.name} EMERGENCY: ${emergencyState.reason}`);
                    await emergencyMgr.activateEmergencyRecovery();
                    emergencyDevices.push(device);
                } else {
                    normalDevices.push(device);
                }
            }
        }

        // ========== HANDLE EMERGENCY DEVICES ==========
        if (emergencyDevices.length > 0) {
            const emergencyChargePower = -(this.config.emergencyChargePowerW || 800);
            const emergencyDeviceNames = emergencyDevices.map(d => d.name).join(', ');
            
            this.log.warn(`🚨 Emergency Charging: ${emergencyDeviceNames} at ${Math.abs(emergencyChargePower)}W each`);
            await this.setStateAsync('status.emergencyReason', `Devices: ${emergencyDeviceNames}`, true);

            // Write emergency charge power to each emergency device
            for (const device of emergencyDevices) {
                const deviceConfig = this.multiDeviceMgr.devices.find(d => d.id === device.id);
                if (deviceConfig) {
                    await this.validationService.writePowerSetpoint(deviceConfig.basePath, emergencyChargePower);
                }
            }
        } else {
            await this.setStateAsync('status.emergencyReason', '', true);
        }

        // ========== HANDLE NORMAL DEVICES WITH I-REGULATOR ==========
        if (normalDevices.length === 0) {
            // All devices in emergency - set mode and return
            if (emergencyDevices.length > 0) {
                await this.setStateAsync('status.mode', 'emergency-charging', true);
            }
            return;
        }

        // Continue with I-Regulator for normal devices only

        // Continue with I-Regulator for normal devices only

        // ========== I-REGULATOR: CALCULATE TARGET POWER FOR NORMAL DEVICES ==========
        // Use sum of last written limits as base
        let lastSetPowerW = this.validationService.lastWrittenLimit !== null 
            ? this.validationService.lastWrittenLimit 
            : 0;

        // ========== ANTI-WINDUP: Limit based on ALL configured devices ==========
        // Use total device count, not active count, so limits stay constant
        const totalDevicesCount = this.multiDeviceMgr.devices.length;
        const maxChargePowerW = -(this.config.maxChargePowerW || 1200) * totalDevicesCount;
        const maxDischargePowerW = (this.config.maxDischargePowerW || 1200) * totalDevicesCount;

        if (lastSetPowerW < maxChargePowerW) {
            this.log.debug(`Anti-windup: Limiting lastSetPowerW from ${lastSetPowerW}W to ${maxChargePowerW}W`);
            lastSetPowerW = maxChargePowerW;
        } else if (lastSetPowerW > maxDischargePowerW) {
            this.log.debug(`Anti-windup: Limiting lastSetPowerW from ${lastSetPowerW}W to ${maxDischargePowerW}W`);
            lastSetPowerW = maxDischargePowerW;
        }

        this.log.debug(
            `Cycle: Grid_raw=${gridPowerW}W, Grid_filtered=${filteredGridPowerW}W, ` +
            `Total_measured=${aggregatedState.totalPowerW}W, Total_set=${lastSetPowerW}W, ` +
            `Avg_SOC=${aggregatedState.avgSoc.toFixed(1)}%, Target=${targetGridPowerW}W, Devices=${aggregatedState.availableDevicesCount}`
        );

        // I-Regulator formula (using filtered grid power)
        let newTotalBatteryPowerW = lastSetPowerW + (filteredGridPowerW - targetGridPowerW);

        // ========== ANTI-WINDUP: Limit newTotalBatteryPowerW ==========
        if (newTotalBatteryPowerW < maxChargePowerW) {
            this.log.debug(`Anti-windup: Limiting newTotalBatteryPowerW from ${newTotalBatteryPowerW}W to ${maxChargePowerW}W`);
            newTotalBatteryPowerW = maxChargePowerW;
        } else if (newTotalBatteryPowerW > maxDischargePowerW) {
            this.log.debug(`Anti-windup: Limiting newTotalBatteryPowerW from ${newTotalBatteryPowerW}W to ${maxDischargePowerW}W`);
            newTotalBatteryPowerW = maxDischargePowerW;
        }

        this.log.debug(`Calculated total battery power: ${newTotalBatteryPowerW}W (after anti-windup, before relay protection)`);

        // ========== GLOBAL RELAY PROTECTION (only for normal devices) ==========
        // Calculate current power only from normal devices
        const normalDevicesCurrentPowerW = normalDevices.reduce((sum, d) => sum + (d.powerW || 0), 0);
        
        const relayResult = this.relayProtection.applyProtection({
            config: this.config,
            gridPowerW: filteredGridPowerW,
            currentBatteryPowerW: normalDevicesCurrentPowerW,
            lastSetPowerW,
            newBatteryPowerW: newTotalBatteryPowerW
        });
        newTotalBatteryPowerW = relayResult.powerW;

        // Update counter states
        await this.setStateAsync('status.feedInCounter', relayResult.feedInCounter, true);
        await this.setStateAsync('status.dischargeCounter', relayResult.dischargeCounter, true);
        await this.setStateAsync('status.deadbandCounter', relayResult.deadbandCounter, true);

        // ========== POWER REGULATION (Hysteresis, Ramping, Limits) ==========
        // For multi-device: scale power limits by total device count to allow full system capacity
        // This ensures PowerRegulator doesn't limit to single-device values
        const multiDeviceConfig = {
            ...this.config,
            maxChargePowerW: this.config.maxChargePowerW * totalDevicesCount,
            maxDischargePowerW: this.config.maxDischargePowerW * totalDevicesCount
        };

        const regResult = this.powerRegulator.applyRegulation({
            config: multiDeviceConfig,
            powerW: newTotalBatteryPowerW,
            lastSetPowerW,
            safetyActive: false  // Safety handled per-device in distribution
        });
        newTotalBatteryPowerW = regResult.powerW;

        this.log.debug(
            `Setting total battery power: ${newTotalBatteryPowerW}W (Grid: ${gridPowerW}W → ${targetGridPowerW}W)`
        );

        // ========== DISTRIBUTE POWER TO NORMAL DEVICES ONLY ==========
        // Emergency devices already handled above - distribute only to normal devices
        const normalDeviceIds = normalDevices.map(d => d.id);
        const normalDevicesAggregatedState = {
            devices: aggregatedState.devices.filter(d => normalDeviceIds.includes(d.id)),
            totalPowerW: normalDevicesCurrentPowerW,
            avgSoc: normalDevices.reduce((sum, d) => sum + (d.soc || 0), 0) / normalDevices.length,
            minPackVoltageV: Math.min(...normalDevices.map(d => d.minPackVoltageV).filter(v => v !== null)),
            availableDevicesCount: normalDevices.length
        };

        const distribution = await this.multiDeviceMgr.distributePower(
            newTotalBatteryPowerW,
            normalDevicesAggregatedState,
            this.config,
            this.emergencyManagers,
            this.safetyLimiters
        );

        // ========== WRITE TO NORMAL DEVICES ==========
        await this.multiDeviceMgr.writePowerSetpoints(distribution, this.validationService);

        // ========== UPDATE DEVICE STATES ==========
        // Create combined distribution for state updates (emergency + normal)
        const emergencyDistribution = emergencyDevices.map(d => ({
            deviceId: d.id,
            deviceName: d.name,
            powerW: -this.config.emergencyChargePowerW,
            excluded: false,
            reason: 'emergency'
        }));
        const fullDistribution = [...emergencyDistribution, ...distribution];
        
        await this.updateDeviceStates(aggregatedState.devices, fullDistribution);

        // Store total for next cycle (emergency + normal power)
        const emergencyTotalW = emergencyDevices.length * (-this.config.emergencyChargePowerW);
        const normalTotalW = distribution.reduce((sum, d) => sum + d.powerW, 0);
        const actualTotal = emergencyTotalW + normalTotalW;
        this.validationService.lastWrittenLimit = actualTotal;

        // ========== UPDATE MODE STATUS ==========
        let mode = 'standby';
        
        // Emergency mode has highest priority
        if (emergencyDevices.length > 0) {
            mode = 'emergency-charging';
        } else if (newTotalBatteryPowerW < -10) {
            mode = 'charging';
        } else if (newTotalBatteryPowerW > 10) {
            mode = 'discharging';
        }

        // Override if any device in recovery (but not in emergency)
        if (emergencyDevices.length === 0) {
            const anyInRecovery = Array.from(this.emergencyManagers.values()).some(m => m.inEmergencyRecovery || m.inVoltageRecovery);
            if (anyInRecovery && mode === 'standby') {
                mode = 'recovery';
            }
        }

        await this.setStateAsync('status.mode', mode, true);
    }

    /**
     * Helper: Get grid power for multi-device (same as single device)
     */
    async getGridPowerForMultiDevice(powerMeterDp) {
        try {
            const state = await this.getForeignStateAsync(powerMeterDp);
            return state?.val ?? null;
        } catch (err) {
            this.log.error(`Failed to read grid power: ${err.message}`);
            return null;
        }
    }

    /**
     * Helper: Get target grid power for multi-device
     */
    async getTargetGridPowerForMultiDevice(configValue) {
        try {
            const state = await this.getStateAsync('control.targetGridPowerW');
            return state?.val ?? configValue ?? 0;
        } catch (err) {
            return configValue ?? 0;
        }
    }

    /**
     * Helper: Update per-device status states in object tree
     */
    async updateDeviceStates(devices, distribution = null) {
        for (const device of devices) {
            try {
                await this.setStateAsync(`status.devices.${device.id}.name`, device.name, true);
                await this.setStateAsync(`status.devices.${device.id}.available`, device.available, true);
                await this.setStateAsync(`status.devices.${device.id}.soc`, device.soc ?? 0, true);
                await this.setStateAsync(`status.devices.${device.id}.powerW`, device.powerW ?? 0, true);
                await this.setStateAsync(`status.devices.${device.id}.minPackVoltageV`, device.minPackVoltageV ?? 0, true);

                // Update emergency/recovery flags
                const emergencyMgr = this.emergencyManagers.get(device.id);
                if (emergencyMgr) {
                    await this.setStateAsync(`status.devices.${device.id}.emergency`, emergencyMgr.inEmergencyRecovery, true);
                    await this.setStateAsync(`status.devices.${device.id}.voltageRecovery`, emergencyMgr.inVoltageRecovery, true);
                }

                // Update excluded flag from distribution
                if (distribution) {
                    const distItem = distribution.find(d => d.deviceId === device.id);
                    if (distItem) {
                        await this.setStateAsync(`status.devices.${device.id}.excluded`, distItem.excluded, true);
                    }
                }
            } catch (err) {
                this.log.warn(`Failed to update states for ${device.id}: ${err.message}`);
            }
        }
    }

    /**
     * Create device channels and states for multi-device mode
     */
    async createDeviceStates() {
        if (!this._isMultiDevice || !this.multiDeviceMgr) return;

        // Create devices channel
        await this.setObjectNotExistsAsync('status.devices', {
            type: 'channel',
            common: {
                name: 'Multi-Device States'
            },
            native: {}
        });

        // Create per-device channels and states
        for (const device of this.multiDeviceMgr.devices) {
            // Device channel
            await this.setObjectNotExistsAsync(`status.devices.${device.id}`, {
                type: 'channel',
                common: {
                    name: device.name
                },
                native: {}
            });

            // Device states
            await this.setObjectNotExistsAsync(`status.devices.${device.id}.name`, {
                type: 'state',
                common: {
                    name: 'Device Name',
                    type: 'string',
                    role: 'text',
                    read: true,
                    write: false
                },
                native: {}
            });

            await this.setObjectNotExistsAsync(`status.devices.${device.id}.available`, {
                type: 'state',
                common: {
                    name: 'Device Available',
                    type: 'boolean',
                    role: 'indicator.reachable',
                    read: true,
                    write: false
                },
                native: {}
            });

            await this.setObjectNotExistsAsync(`status.devices.${device.id}.soc`, {
                type: 'state',
                common: {
                    name: 'Battery SOC',
                    type: 'number',
                    role: 'value.battery',
                    unit: '%',
                    read: true,
                    write: false
                },
                native: {}
            });

            await this.setObjectNotExistsAsync(`status.devices.${device.id}.powerW`, {
                type: 'state',
                common: {
                    name: 'Battery Power',
                    type: 'number',
                    role: 'value.power',
                    unit: 'W',
                    read: true,
                    write: false
                },
                native: {}
            });

            await this.setObjectNotExistsAsync(`status.devices.${device.id}.minPackVoltageV`, {
                type: 'state',
                common: {
                    name: 'Minimum Pack Voltage',
                    type: 'number',
                    role: 'value.voltage',
                    unit: 'V',
                    read: true,
                    write: false
                },
                native: {}
            });

            await this.setObjectNotExistsAsync(`status.devices.${device.id}.emergency`, {
                type: 'state',
                common: {
                    name: 'Emergency Recovery Active',
                    type: 'boolean',
                    role: 'indicator.alarm',
                    read: true,
                    write: false
                },
                native: {}
            });

            await this.setObjectNotExistsAsync(`status.devices.${device.id}.voltageRecovery`, {
                type: 'state',
                common: {
                    name: 'Voltage Recovery Active',
                    type: 'boolean',
                    role: 'indicator',
                    read: true,
                    write: false
                },
                native: {}
            });

            await this.setObjectNotExistsAsync(`status.devices.${device.id}.excluded`, {
                type: 'state',
                common: {
                    name: 'Excluded from Distribution',
                    type: 'boolean',
                    role: 'indicator',
                    read: true,
                    write: false,
                    def: false
                },
                native: {}
            });
        }

        // Create additional multi-device global states
        await this.setObjectNotExistsAsync('status.totalPowerW', {
            type: 'state',
            common: {
                name: 'Total Battery Power (all devices)',
                type: 'number',
                role: 'value.power',
                unit: 'W',
                read: true,
                write: false
            },
            native: {}
        });

        await this.setObjectNotExistsAsync('status.avgSoc', {
            type: 'state',
            common: {
                name: 'Average Battery SOC',
                type: 'number',
                role: 'value.battery',
                unit: '%',
                read: true,
                write: false
            },
            native: {}
        });

        this.log.info(`✓ Created states for ${this.multiDeviceMgr.devices.length} device(s)`);
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
                if (this._isMultiDevice) {
                    // Stop all devices
                    for (const device of this.multiDeviceMgr.devices) {
                        await this.validationService.writePowerSetpoint(device.basePath, 0);
                    }
                } else {
                    await this.validationService.writePowerSetpoint(this._deviceBasePath, 0);
                }
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
            if (this._isMultiDevice) {
                // Stop all devices
                for (const device of this.multiDeviceMgr.devices) {
                    await this.validationService.writePowerSetpoint(device.basePath, 0);
                }
            } else {
                await this.validationService.writePowerSetpoint(this._deviceBasePath, 0);
            }
            
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
