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
const MultiDeviceController = require('./lib/MultiDeviceController');

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
        this._cycleRunning = false;
        this._isRunning = false;
        this._deviceBasePath = null;
        this._isMultiDevice = false;
        
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
        this.multiDeviceController = null;  // Multi-device automation controller
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
                // Each device gets its own persisted recovery states under status.devices.<id>.*
                // instead of sharing the single-device global status.* keys (see #restoreRecoveryStates).
                this.emergencyManagers = new Map();
                for (const device of this.multiDeviceMgr.devices) {
                    const emergencyMgr = new EmergencyManager(this, device.basePath, `status.devices.${device.id}.`);
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
                
                // Initialize multi-device controller
                this.multiDeviceController = new MultiDeviceController(
                    this,
                    {
                        multiDeviceMgr: this.multiDeviceMgr,
                        emergencyManagers: this.emergencyManagers,
                        safetyLimiters: this.safetyLimiters,
                        relayProtection: this.relayProtection,
                        powerRegulator: this.powerRegulator,
                        validationService: this.validationService
                    }
                );
                
                this.log.info('✓ Multi-Device components initialized');

                // Initialize control states
                await this.setStateAsync('control.enabled', true, true);
                await this.setStateAsync('control.targetGridPowerW', this.config.targetGridPowerW || 0, true);
                await this.setStateAsync('control.maxBatterySoc', this.config.maxBatterySoc ?? 100, true);
                await this.setStateAsync('control.minBatterySoc', this.config.minBatterySoc ?? 10, true);
                await this.setStateAsync('control.enableCharge', this.config.enableCharge !== false, true);
                await this.setStateAsync('control.enableDischarge', this.config.enableDischarge !== false, true);
                await this.setStateAsync('control.maxChargePowerW', this.config.maxChargePowerW ?? 1600, true);
                await this.setStateAsync('control.maxDischargePowerW', this.config.maxDischargePowerW ?? 1600, true);
                await this.setStateAsync('control.operatingDeadbandW', this.config.operatingDeadbandW ?? 10, true);
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
            await this.setStateAsync('control.maxBatterySoc', this.config.maxBatterySoc ?? 100, true);
            await this.setStateAsync('control.minBatterySoc', this.config.minBatterySoc ?? 10, true);
            await this.setStateAsync('control.enableCharge', this.config.enableCharge !== false, true);
            await this.setStateAsync('control.enableDischarge', this.config.enableDischarge !== false, true);
            await this.setStateAsync('control.maxChargePowerW', this.config.maxChargePowerW ?? 1600, true);
            await this.setStateAsync('control.maxDischargePowerW', this.config.maxDischargePowerW ?? 1600, true);
            await this.setStateAsync('control.operatingDeadbandW', this.config.operatingDeadbandW ?? 10, true);
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

            const distributionStrategy = this.config.multiDeviceDistributionStrategy || 'equalSplit';
            if (!['equalSplit', 'waterfill'].includes(distributionStrategy)) {
                this.log.error(`Unknown multi-device distribution strategy: ${distributionStrategy}`);
                return false;
            }

            if (distributionStrategy === 'waterfill') {
                for (const device of enabledDevices) {
                    const numericValues = [
                        ['maxChargePowerW', device.maxChargePowerW],
                        ['maxDischargePowerW', device.maxDischargePowerW]
                    ];
                    const hasInvalidValue = numericValues.some(([, value]) =>
                        value === null || value === undefined || !Number.isFinite(Number(value))
                    );

                    if (hasInvalidValue || Number(device.maxChargePowerW) <= 0 || Number(device.maxDischargePowerW) <= 0) {
                        this.log.error(
                            `Waterfill requires valid limits for device ${device.name || device.deviceKey}: ` +
                            'positive charge/discharge limits'
                        );
                        return false;
                    }
                }
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
     * Build the effective configuration for this cycle.
     * Starts from the static admin config and overlays runtime overrides
     * from the writable control.* states (Fixes #9 - runtime-changeable limits).
     * Falls back to the static config value if a control state is unset.
     * @returns {Promise<object>} Effective configuration
     */
    async getEffectiveConfig() {
        const effectiveConfig = { ...this.config };

        const overrides = [
            ['control.maxBatterySoc', 'maxBatterySoc'],
            ['control.minBatterySoc', 'minBatterySoc'],
            ['control.enableCharge', 'enableCharge'],
            ['control.enableDischarge', 'enableDischarge'],
            ['control.maxChargePowerW', 'maxChargePowerW'],
            ['control.maxDischargePowerW', 'maxDischargePowerW'],
            ['control.operatingDeadbandW', 'operatingDeadbandW']
        ];

        for (const [stateId, configKey] of overrides) {
            const state = await this.getStateAsync(stateId);
            if (state && state.val !== null && state.val !== undefined) {
                effectiveConfig[configKey] = state.val;
            }
        }

        return effectiveConfig;
    }

    /**
     * Main automation cycle - runs periodically
     */
    async runAutomationCycle() {
        // Prevent overlapping cycles
        if (this._cycleRunning) {
            this.log.debug('Automation cycle already running, skipping this trigger');
            return;
        }
        
        this._cycleRunning = true;
        try {
            // Check if automation is enabled
            const enabledState = await this.getStateAsync('control.enabled');
            if (!enabledState || !enabledState.val) {
                await this.setStateAsync('status.mode', 'idle', true);
                return;
            }

            // Build effective config (static config + runtime control.* overrides)
            const effectiveConfig = await this.getEffectiveConfig();

            // Check for manual override modes (highest priority)
            const maxChargeState = await this.getStateAsync('control.maxCharge');
            const maxDischargeState = await this.getStateAsync('control.maxDischarge');

            if (maxChargeState?.val) {
                await this.handleMaxChargeMode(effectiveConfig);
                return;
            }

            if (maxDischargeState?.val) {
                await this.handleMaxDischargeMode(effectiveConfig);
                return;
            }

            // Route to appropriate cycle based on mode
            if (this._isMultiDevice) {
                await this.multiDeviceController.runCycle(effectiveConfig);
            } else {
                await this.singleDeviceController.runCycle(effectiveConfig);
            }

        } catch (err) {
            this.log.error(`Automation cycle error: ${err.message}`);
            await this.setStateAsync('status.mode', 'error', true);
        } finally {
            this._cycleRunning = false;
        }
    }

    /**
     * Handle Max Charge Override Mode
     * Charges all eligible batteries at maximum configured power.
     * Each device is checked individually (availability, chargeAllowed, own SOC) so that one
     * fully-charged or disabled device never blocks the override for the others.
     */
    async handleMaxChargeMode(config) {
        this.log.debug('Max Charge Override active');
        await this.setStateAsync('status.mode', 'max-charging', true);

        const maxBatterySoc = config.maxBatterySoc ?? 100;
        const globalChargePowerW = Math.abs(config.maxChargePowerW || 1200);

        if (this._isMultiDevice) {
            const waterfillActive = config.multiDeviceDistributionStrategy === 'waterfill';
            const aggregated = await this.multiDeviceMgr.aggregateDeviceStates();

            const setpoints = this.multiDeviceMgr.devices.map(device => {
                const state = aggregated.devices.find(item => item.id === device.id);
                const limitW = waterfillActive ? Number(device.maxChargePowerW) : globalChargePowerW;
                const allowed = device.chargeAllowed !== false && state?.available &&
                    Number.isFinite(limitW) && limitW > 0 &&
                    Number(state?.soc) < maxBatterySoc;
                return { device, powerW: allowed ? -limitW : 0, allowed };
            });

            await Promise.all(setpoints.map(({ device, powerW }) => {
                this.log.debug(`Max Charge: ${device.name} ${powerW}W`);
                return this.validationService.writePowerSetpoint(device.id, device.basePath, powerW);
            }));

            const anyCharging = setpoints.some(({ allowed }) => allowed);
            if (!anyCharging) {
                this.log.info(`Max SOC ${maxBatterySoc}% reached on all devices, disabling Max Charge mode`);
                await this.setStateAsync('control.maxCharge', false, true);
                await this.setStateAsync('status.mode', 'idle', true);
            }
            return;
        }

        // ========== SINGLE-DEVICE ==========
        const batterySoc = await this.dataReader.getBatterySoc();
        if (batterySoc !== null && batterySoc >= maxBatterySoc) {
            this.log.info(`Max SOC ${maxBatterySoc}% reached, disabling Max Charge mode`);
            await this.setStateAsync('control.maxCharge', false, true);
            await this.setStateAsync('status.mode', 'idle', true);
            await this.validationService.writePowerSetpoint(this._deviceBasePath, this._deviceBasePath, 0);
            return;
        }

        this.log.debug(`Max Charge: ${-globalChargePowerW}W`);
        await this.validationService.writePowerSetpoint(this._deviceBasePath, this._deviceBasePath, -globalChargePowerW);
    }

    /**
     * Handle Max Discharge Override Mode
     * Discharges all eligible batteries at maximum configured power.
     * Respects discharge protection mode (SOC/Voltage/Both) and emergency/recovery states
     * per device, so a single recovering device no longer disables the override for all others.
     */
    async handleMaxDischargeMode(config) {
        this.log.debug('Max Discharge Override active');
        await this.setStateAsync('status.mode', 'max-discharging', true);

        const dischargeProtectionMode = config.dischargeProtectionMode || 'soc';
        const minBatterySoc = config.minBatterySoc ?? 10;
        const minBatteryVoltageV = config.minBatteryVoltageV || 3.0;
        const socCheckApplies = dischargeProtectionMode === 'soc' || dischargeProtectionMode === 'both';
        const voltageCheckApplies = dischargeProtectionMode === 'voltage' || dischargeProtectionMode === 'both';
        const globalDischargePowerW = config.maxDischargePowerW || 1200;

        if (this._isMultiDevice) {
            const waterfillActive = config.multiDeviceDistributionStrategy === 'waterfill';
            const aggregated = await this.multiDeviceMgr.aggregateDeviceStates();

            const setpoints = this.multiDeviceMgr.devices.map(device => {
                const state = aggregated.devices.find(item => item.id === device.id);
                const emergencyManager = this.emergencyManagers.get(device.id);
                const inRecovery = Boolean(emergencyManager) && (
                    emergencyManager.inEmergencyRecovery ||
                    emergencyManager.inVoltageRecovery ||
                    emergencyManager.inSocRecovery ||
                    emergencyManager.inMinSocRecovery
                );
                const socOk = !socCheckApplies || (Number.isFinite(Number(state?.soc)) && Number(state.soc) > minBatterySoc);
                const voltageOk = !voltageCheckApplies || state?.minPackVoltageV === null ||
                    state?.minPackVoltageV === undefined || state.minPackVoltageV > minBatteryVoltageV;
                const limitW = waterfillActive ? Number(device.maxDischargePowerW) : globalDischargePowerW;
                const allowed = device.dischargeAllowed !== false && state?.available && !inRecovery &&
                    Number.isFinite(limitW) && limitW > 0 && socOk && voltageOk;
                return { device, powerW: allowed ? limitW : 0, allowed };
            });

            await Promise.all(setpoints.map(({ device, powerW }) => {
                this.log.debug(`Max Discharge: ${device.name} ${powerW}W`);
                return this.validationService.writePowerSetpoint(device.id, device.basePath, powerW);
            }));

            const anyDischarging = setpoints.some(({ allowed }) => allowed);
            if (!anyDischarging) {
                this.log.info('No device eligible for Max Discharge (limits/recovery), disabling Max Discharge mode');
                await this.setStateAsync('control.maxDischarge', false, true);
                await this.setStateAsync('status.mode', 'idle', true);
            }
            return;
        }

        // ========== SINGLE-DEVICE ==========
        if (this.emergencyMgr.inEmergencyRecovery || this.emergencyMgr.inVoltageRecovery ||
            this.emergencyMgr.inSocRecovery || this.emergencyMgr.inMinSocRecovery) {
            this.log.info('Battery in recovery mode, disabling Max Discharge');
            await this.setStateAsync('control.maxDischarge', false, true);
            await this.setStateAsync('status.mode', 'idle', true);
            await this.validationService.writePowerSetpoint(this._deviceBasePath, this._deviceBasePath, 0);
            return;
        }

        const batterySoc = await this.dataReader.getBatterySoc();
        const minPackVoltageV = await this.dataReader.getMinimumPackVoltageV();

        // Check for Zendure minSoc protection
        const minSocState = await this.getForeignStateAsync(`${this._deviceBasePath}.minSoc`);
        const deviceMinSoc = minSocState?.val ?? null;
        const minSocMargin = config.minSocProtectionMargin ?? 1;
        const effectiveMinSoc = (deviceMinSoc !== null && deviceMinSoc > 0)
            ? deviceMinSoc + minSocMargin
            : minBatterySoc;

        if (socCheckApplies && batterySoc !== null && batterySoc <= effectiveMinSoc) {
            this.log.info(`Min SOC ${effectiveMinSoc}% reached, disabling Max Discharge mode`);
            await this.setStateAsync('control.maxDischarge', false, true);
            await this.setStateAsync('status.mode', 'idle', true);
            await this.validationService.writePowerSetpoint(this._deviceBasePath, this._deviceBasePath, 0);
            return;
        }

        if (voltageCheckApplies && minPackVoltageV !== null && minPackVoltageV <= minBatteryVoltageV) {
            this.log.info(`Min voltage ${minBatteryVoltageV}V reached (current: ${minPackVoltageV}V), disabling Max Discharge mode`);
            await this.setStateAsync('control.maxDischarge', false, true);
            await this.setStateAsync('status.mode', 'idle', true);
            await this.validationService.writePowerSetpoint(this._deviceBasePath, this._deviceBasePath, 0);
            return;
        }

        this.log.debug(`Max Discharge: ${globalDischargePowerW}W`);
        await this.validationService.writePowerSetpoint(this._deviceBasePath, this._deviceBasePath, globalDischargePowerW);
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

            await this.setObjectNotExistsAsync(`status.devices.${device.id}.emergencyRecoveryActive`, {
                type: 'state',
                common: {
                    name: 'Emergency Recovery Active',
                    type: 'boolean',
                    role: 'indicator.alarm',
                    read: true,
                    write: false,
                    def: false
                },
                native: {}
            });

            await this.setObjectNotExistsAsync(`status.devices.${device.id}.voltageRecoveryActive`, {
                type: 'state',
                common: {
                    name: 'Voltage Recovery Active',
                    type: 'boolean',
                    role: 'indicator',
                    read: true,
                    write: false,
                    def: false
                },
                native: {}
            });

            await this.setObjectNotExistsAsync(`status.devices.${device.id}.socRecoveryActive`, {
                type: 'state',
                common: {
                    name: 'SOC Recovery Active',
                    type: 'boolean',
                    role: 'indicator',
                    read: true,
                    write: false,
                    def: false
                },
                native: {}
            });

            await this.setObjectNotExistsAsync(`status.devices.${device.id}.minSocRecoveryActive`, {
                type: 'state',
                common: {
                    name: 'MinSoc Recovery Active (Zendure hardware protection)',
                    type: 'boolean',
                    role: 'indicator',
                    read: true,
                    write: false,
                    def: false
                },
                native: {}
            });

            // Clean up the old, pre-1.0.1 state names these replace (renamed to
            // emergencyRecoveryActive/voltageRecoveryActive above) so upgraded
            // installs don't keep dead, frozen-value objects around forever.
            for (const staleId of ['emergency', 'voltageRecovery']) {
                try {
                    await this.delObjectAsync(`status.devices.${device.id}.${staleId}`);
                } catch (err) {
                    // Already gone (fresh install) - nothing to clean up.
                }
            }

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

            await this.setObjectNotExistsAsync(`status.devices.${device.id}.effectiveMinSoc`, {
                type: 'state',
                common: {
                    name: 'Effective minSoc limit (minSoc + margin)',
                    type: 'number',
                    role: 'value.battery',
                    unit: '%',
                    read: true,
                    write: false,
                    def: 0
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
                        await this.validationService.writePowerSetpoint(device.id, device.basePath, 0);
                    }
                } else {
                    await this.validationService.writePowerSetpoint(this._deviceBasePath, this._deviceBasePath, 0);
                }
                await this.setStateAsync('status.mode', 'idle', true);
            }
        }

        if (id.endsWith('.control.maxCharge')) {
            if (state.val) {
                this.log.info('Max Charge Override enabled');
                // Mutual exclusion: Disable maxDischarge
                await this.setStateAsync('control.maxDischarge', false, true);
                // Trigger immediate cycle
                this.runAutomationCycle().catch(err => {
                    this.log.error(`Automation cycle failed: ${err.message}`);
                });
            } else {
                this.log.info('Max Charge Override disabled');
                // Set all devices to 0W
                if (this._isMultiDevice) {
                    for (const device of this.multiDeviceMgr.devices) {
                        await this.validationService.writePowerSetpoint(device.id, device.basePath, 0);
                    }
                } else {
                    await this.validationService.writePowerSetpoint(this._deviceBasePath, this._deviceBasePath, 0);
                }
                await this.setStateAsync('status.mode', 'idle', true);
            }
        }

        if (id.endsWith('.control.maxDischarge')) {
            if (state.val) {
                this.log.info('Max Discharge Override enabled');
                // Mutual exclusion: Disable maxCharge
                await this.setStateAsync('control.maxCharge', false, true);
                // Trigger immediate cycle
                this.runAutomationCycle().catch(err => {
                    this.log.error(`Automation cycle failed: ${err.message}`);
                });
            } else {
                this.log.info('Max Discharge Override disabled');
                // Set all devices to 0W
                if (this._isMultiDevice) {
                    for (const device of this.multiDeviceMgr.devices) {
                        await this.validationService.writePowerSetpoint(device.id, device.basePath, 0);
                    }
                } else {
                    await this.validationService.writePowerSetpoint(this._deviceBasePath, this._deviceBasePath, 0);
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

        // Runtime overrides for battery limits (Fixes #9)
        if (id.endsWith('.control.maxBatterySoc')) {
            this.log.info(`Max battery SOC changed to ${state.val}%`);
            this.runAutomationCycle().catch(err => {
                this.log.error(`Automation cycle failed: ${err.message}`);
            });
        }

        if (id.endsWith('.control.minBatterySoc')) {
            this.log.info(`Min battery SOC changed to ${state.val}%`);
            this.runAutomationCycle().catch(err => {
                this.log.error(`Automation cycle failed: ${err.message}`);
            });
        }

        if (id.endsWith('.control.enableCharge')) {
            this.log.info(`Charging ${state.val ? 'enabled' : 'disabled'} (runtime override)`);
            this.runAutomationCycle().catch(err => {
                this.log.error(`Automation cycle failed: ${err.message}`);
            });
        }

        if (id.endsWith('.control.enableDischarge')) {
            this.log.info(`Discharging ${state.val ? 'enabled' : 'disabled'} (runtime override)`);
            this.runAutomationCycle().catch(err => {
                this.log.error(`Automation cycle failed: ${err.message}`);
            });
        }

        if (id.endsWith('.control.maxChargePowerW')) {
            this.log.info(`Max charge power changed to ${state.val}W`);
            this.runAutomationCycle().catch(err => {
                this.log.error(`Automation cycle failed: ${err.message}`);
            });
        }

        if (id.endsWith('.control.maxDischargePowerW')) {
            this.log.info(`Max discharge power changed to ${state.val}W`);
            this.runAutomationCycle().catch(err => {
                this.log.error(`Automation cycle failed: ${err.message}`);
            });
        }

        if (id.endsWith('.control.operatingDeadbandW')) {
            this.log.info(`Operating deadband changed to ${state.val}W per device`);
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
                    await this.validationService.writePowerSetpoint(device.id, device.basePath, 0);
                }
            } else {
                await this.validationService.writePowerSetpoint(this._deviceBasePath, this._deviceBasePath, 0);
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
