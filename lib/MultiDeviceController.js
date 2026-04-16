'use strict';

/**
 * Multi-Device Automation Controller
 * 
 * Handles the complete automation cycle for multiple battery devices.
 * Implements the I-Regulator algorithm with:
 * - Grid power reading and EMA filtering
 * - Device state aggregation
 * - Per-device emergency management
 * - Anti-windup protection (scaled for total capacity)
 * - Global relay protection
 * - Power regulation with scaled limits
 * - Equal-split power distribution
 * - Status updates
 */

class MultiDeviceController {
    /**
     * @param {object} adapter - ioBroker adapter instance
     * @param {object} components - All required modular components
     */
    constructor(adapter, components) {
        this.adapter = adapter;
        
        // Modular components
        this.multiDeviceMgr = components.multiDeviceMgr;
        this.emergencyManagers = components.emergencyManagers;  // Map<deviceId, EmergencyManager>
        this.safetyLimiters = components.safetyLimiters;  // Map<deviceId, SafetyLimiter>
        this.relayProtection = components.relayProtection;
        this.powerRegulator = components.powerRegulator;
        this.validationService = components.validationService;
        
        // Runtime state
        this.filteredGridPower = null;
    }

    /**
     * Run multi-device automation cycle
     * @param {object} config - Adapter configuration
     */
    async runCycle(config) {
        // ========== READ GRID POWER ==========
        const gridPowerW = await this.getGridPower(config.powerMeterDp);
        const targetGridPowerW = await this.getTargetGridPower(config.targetGridPowerW);

        if (gridPowerW === null) {
            this.adapter.log.warn('Could not read grid power, skipping cycle');
            await this.adapter.setStateAsync('status.mode', 'error', true);
            return;
        }

        // ========== EMA FILTER FOR GRID POWER ==========
        const filteredGridPowerW = this.applyEmaFilter(gridPowerW, config.emaFilterAlpha || 0.5);
        this.adapter.log.debug(`Grid power: raw=${gridPowerW}W, filtered=${filteredGridPowerW}W`);

        // ========== AGGREGATE DEVICE STATES ==========
        const aggregatedState = await this.multiDeviceMgr.aggregateDeviceStates();

        if (aggregatedState.availableDevicesCount === 0) {
            this.adapter.log.warn('No available devices, skipping cycle');
            await this.adapter.setStateAsync('status.mode', 'error', true);
            return;
        }

        // ========== UPDATE GLOBAL STATUS STATES ==========
        await this.updateGlobalStates(gridPowerW, aggregatedState);

        // ========== UPDATE PER-DEVICE STATUS STATES ==========
        await this.updateDeviceStates(aggregatedState.devices);

        // ========== CHECK EMERGENCY FOR EACH DEVICE ==========
        const { emergencyDevices, normalDevices } = await this.checkEmergencies(config, aggregatedState.devices);

        // ========== HANDLE EMERGENCY DEVICES ==========
        if (emergencyDevices.length > 0) {
            await this.handleEmergencyDevices(config, emergencyDevices);
        } else {
            await this.adapter.setStateAsync('status.emergencyReason', '', true);
        }

        // ========== HANDLE NORMAL DEVICES WITH I-REGULATOR ==========
        if (normalDevices.length === 0) {
            // All devices in emergency - set mode and return
            if (emergencyDevices.length > 0) {
                await this.adapter.setStateAsync('status.mode', 'emergency-charging', true);
            }
            return;
        }

        // ========== I-REGULATOR FOR NORMAL DEVICES ==========
        const totalBatteryPowerW = await this.calculateTargetPower(
            config,
            filteredGridPowerW,
            targetGridPowerW,
            normalDevices,
            aggregatedState
        );

        // ========== DISTRIBUTE POWER TO NORMAL DEVICES ==========
        const distribution = await this.distributePowerToNormalDevices(
            config,
            totalBatteryPowerW,
            normalDevices,
            aggregatedState
        );

        // ========== WRITE TO NORMAL DEVICES ==========
        await this.multiDeviceMgr.writePowerSetpoints(distribution, this.validationService);

        // ========== UPDATE DEVICE STATES WITH DISTRIBUTION ==========
        const fullDistribution = this.createFullDistribution(config, emergencyDevices, distribution);
        await this.updateDeviceStates(aggregatedState.devices, fullDistribution);

        // ========== STORE TOTAL FOR NEXT CYCLE ==========
        const actualTotal = this.calculateActualTotal(config, emergencyDevices, distribution);
        this.validationService.lastWrittenLimit = actualTotal;

        // ========== UPDATE MODE STATUS ==========
        await this.updateModeStatus(emergencyDevices, totalBatteryPowerW);
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
     * Get grid power from meter
     */
    async getGridPower(powerMeterDp) {
        try {
            const state = await this.adapter.getForeignStateAsync(powerMeterDp);
            return state?.val ?? null;
        } catch (err) {
            this.adapter.log.error(`Failed to read grid power: ${err.message}`);
            return null;
        }
    }

    /**
     * Get target grid power
     */
    async getTargetGridPower(configValue) {
        try {
            const state = await this.adapter.getStateAsync('control.targetGridPowerW');
            return state?.val ?? configValue ?? 0;
        } catch (err) {
            return configValue ?? 0;
        }
    }

    /**
     * Update global status states
     */
    async updateGlobalStates(gridPowerW, aggregatedState) {
        await this.adapter.setStateAsync('status.gridPowerW', gridPowerW, true);
        await this.adapter.setStateAsync('status.totalPowerW', aggregatedState.totalPowerW, true);
        await this.adapter.setStateAsync('status.avgSoc', aggregatedState.avgSoc, true);
        await this.adapter.setStateAsync('status.lastUpdate', Date.now(), true);
        if (aggregatedState.minPackVoltageV !== null) {
            await this.adapter.setStateAsync('status.minPackVoltageV', aggregatedState.minPackVoltageV, true);
        }
    }

    /**
     * Update per-device status states
     */
    async updateDeviceStates(devices, distribution = null) {
        for (const device of devices) {
            try {
                await this.adapter.setStateAsync(`status.devices.${device.id}.name`, device.name, true);
                await this.adapter.setStateAsync(`status.devices.${device.id}.available`, device.available, true);
                await this.adapter.setStateAsync(`status.devices.${device.id}.soc`, device.soc ?? 0, true);
                await this.adapter.setStateAsync(`status.devices.${device.id}.powerW`, device.powerW ?? 0, true);
                await this.adapter.setStateAsync(`status.devices.${device.id}.minPackVoltageV`, device.minPackVoltageV ?? 0, true);

                // Update emergency/recovery flags
                const emergencyMgr = this.emergencyManagers.get(device.id);
                if (emergencyMgr) {
                    await this.adapter.setStateAsync(`status.devices.${device.id}.emergency`, emergencyMgr.inEmergencyRecovery, true);
                    await this.adapter.setStateAsync(`status.devices.${device.id}.voltageRecovery`, emergencyMgr.inVoltageRecovery, true);
                }

                // Update excluded flag from distribution
                if (distribution) {
                    const distItem = distribution.find(d => d.deviceId === device.id);
                    if (distItem) {
                        await this.adapter.setStateAsync(`status.devices.${device.id}.excluded`, distItem.excluded, true);
                    }
                }
            } catch (err) {
                this.adapter.log.warn(`Failed to update states for ${device.id}: ${err.message}`);
            }
        }
    }

    /**
     * Check emergency conditions for all devices
     * @returns {object} { emergencyDevices: [], normalDevices: [] }
     */
    async checkEmergencies(config, devices) {
        const emergencyDevices = [];
        const normalDevices = [];

        for (const device of devices) {
            if (!device.available) continue;

            const emergencyMgr = this.emergencyManagers.get(device.id);
            if (!emergencyMgr) continue;

            // Update recovery states first
            await emergencyMgr.updateEmergencyRecovery(config, device.soc);
            await emergencyMgr.updateVoltageRecovery(config, device.minPackVoltageV);

            // Check if in recovery after update
            if (emergencyMgr.inEmergencyRecovery) {
                emergencyDevices.push(device);
                const emergencyExitSoc = config.emergencyExitSoc || 20;
                this.adapter.log.warn(`⚡ ${device.name} emergency charging: ${device.soc}% → ${emergencyExitSoc}%`);
            } else if (emergencyMgr.inVoltageRecovery) {
                emergencyDevices.push(device);
                const emergencyExitVoltage = config.emergencyExitVoltage || 3.1;
                this.adapter.log.warn(`⚡ ${device.name} voltage recovery: ${device.minPackVoltageV?.toFixed(2) || 'N/A'}V → ${emergencyExitVoltage}V`);
            } else {
                // Check for new emergency
                const emergencyState = await emergencyMgr.checkEmergencyConditions(
                    config,
                    device.soc,
                    device.minPackVoltageV
                );

                if (emergencyState.isEmergency) {
                    this.adapter.log.warn(`🚨 ${device.name} EMERGENCY: ${emergencyState.reason}`);
                    await emergencyMgr.activateEmergencyRecovery();
                    emergencyDevices.push(device);
                } else {
                    normalDevices.push(device);
                }
            }
        }

        return { emergencyDevices, normalDevices };
    }

    /**
     * Handle emergency devices - write emergency charge power
     */
    async handleEmergencyDevices(config, emergencyDevices) {
        const emergencyChargePower = -(config.emergencyChargePowerW || 800);
        const emergencyDeviceNames = emergencyDevices.map(d => d.name).join(', ');
        
        this.adapter.log.warn(`🚨 Emergency Charging: ${emergencyDeviceNames} at ${Math.abs(emergencyChargePower)}W each`);
        await this.adapter.setStateAsync('status.emergencyReason', `Devices: ${emergencyDeviceNames}`, true);

        // Write emergency charge power to each emergency device
        for (const device of emergencyDevices) {
            const deviceConfig = this.multiDeviceMgr.devices.find(d => d.id === device.id);
            if (deviceConfig) {
                await this.validationService.writePowerSetpoint(deviceConfig.basePath, emergencyChargePower);
            }
        }
    }

    /**
     * Calculate target power using I-Regulator with anti-windup
     */
    async calculateTargetPower(config, filteredGridPowerW, targetGridPowerW, normalDevices, aggregatedState) {
        // ========== I-REGULATOR: CALCULATE TARGET POWER FOR NORMAL DEVICES ==========
        let lastSetPowerW = this.validationService.lastWrittenLimit !== null 
            ? this.validationService.lastWrittenLimit 
            : 0;

        // ========== ANTI-WINDUP: Limit based on ALL configured devices ==========
        const totalDevicesCount = this.multiDeviceMgr.devices.length;
        const maxChargePowerW = -(config.maxChargePowerW || 1200) * totalDevicesCount;
        const maxDischargePowerW = (config.maxDischargePowerW || 1200) * totalDevicesCount;

        if (lastSetPowerW < maxChargePowerW) {
            this.adapter.log.debug(`Anti-windup: Limiting lastSetPowerW from ${lastSetPowerW}W to ${maxChargePowerW}W`);
            lastSetPowerW = maxChargePowerW;
        } else if (lastSetPowerW > maxDischargePowerW) {
            this.adapter.log.debug(`Anti-windup: Limiting lastSetPowerW from ${lastSetPowerW}W to ${maxDischargePowerW}W`);
            lastSetPowerW = maxDischargePowerW;
        }

        this.adapter.log.debug(
            `Cycle: Grid_raw=${filteredGridPowerW}W, Grid_filtered=${filteredGridPowerW}W, ` +
            `Total_measured=${aggregatedState.totalPowerW}W, Total_set=${lastSetPowerW}W, ` +
            `Avg_SOC=${aggregatedState.avgSoc.toFixed(1)}%, Target=${targetGridPowerW}W, Devices=${aggregatedState.availableDevicesCount}`
        );

        // I-Regulator formula (using filtered grid power)
        let newTotalBatteryPowerW = lastSetPowerW + (filteredGridPowerW - targetGridPowerW);

        // ========== ANTI-WINDUP: Limit newTotalBatteryPowerW ==========
        if (newTotalBatteryPowerW < maxChargePowerW) {
            this.adapter.log.debug(`Anti-windup: Limiting newTotalBatteryPowerW from ${newTotalBatteryPowerW}W to ${maxChargePowerW}W`);
            newTotalBatteryPowerW = maxChargePowerW;
        } else if (newTotalBatteryPowerW > maxDischargePowerW) {
            this.adapter.log.debug(`Anti-windup: Limiting newTotalBatteryPowerW from ${newTotalBatteryPowerW}W to ${maxDischargePowerW}W`);
            newTotalBatteryPowerW = maxDischargePowerW;
        }

        this.adapter.log.debug(`Calculated total battery power: ${newTotalBatteryPowerW}W (after anti-windup, before relay protection)`);

        // ========== GLOBAL RELAY PROTECTION (only for normal devices) ==========
        const normalDevicesCurrentPowerW = normalDevices.reduce((sum, d) => sum + (d.powerW || 0), 0);
        
        const relayResult = this.relayProtection.applyProtection({
            config: config,
            gridPowerW: filteredGridPowerW,
            currentBatteryPowerW: normalDevicesCurrentPowerW,
            lastSetPowerW,
            newBatteryPowerW: newTotalBatteryPowerW
        });
        newTotalBatteryPowerW = relayResult.powerW;

        // Update counter states
        await this.adapter.setStateAsync('status.feedInCounter', relayResult.feedInCounter, true);
        await this.adapter.setStateAsync('status.dischargeCounter', relayResult.dischargeCounter, true);
        await this.adapter.setStateAsync('status.deadbandCounter', relayResult.deadbandCounter, true);

        // ========== POWER REGULATION (Hysteresis, Ramping, Limits) ==========
        // Scale power limits by total device count to allow full system capacity
        const multiDeviceConfig = {
            ...config,
            maxChargePowerW: config.maxChargePowerW * totalDevicesCount,
            maxDischargePowerW: config.maxDischargePowerW * totalDevicesCount
        };

        const regResult = this.powerRegulator.applyRegulation({
            config: multiDeviceConfig,
            powerW: newTotalBatteryPowerW,
            lastSetPowerW,
            safetyActive: false  // Safety handled per-device in distribution
        });
        newTotalBatteryPowerW = regResult.powerW;

        this.adapter.log.debug(
            `Setting total battery power: ${newTotalBatteryPowerW}W (Grid: ${filteredGridPowerW}W → ${targetGridPowerW}W)`
        );

        return newTotalBatteryPowerW;
    }

    /**
     * Distribute power to normal devices only
     */
    async distributePowerToNormalDevices(config, totalPowerW, normalDevices, aggregatedState) {
        // Emergency devices already handled - distribute only to normal devices
        const normalDeviceIds = normalDevices.map(d => d.id);
        const normalDevicesAggregatedState = {
            devices: aggregatedState.devices.filter(d => normalDeviceIds.includes(d.id)),
            totalPowerW: normalDevices.reduce((sum, d) => sum + (d.powerW || 0), 0),
            avgSoc: normalDevices.reduce((sum, d) => sum + (d.soc || 0), 0) / normalDevices.length,
            minPackVoltageV: Math.min(...normalDevices.map(d => d.minPackVoltageV).filter(v => v !== null)),
            availableDevicesCount: normalDevices.length
        };

        return await this.multiDeviceMgr.distributePower(
            totalPowerW,
            normalDevicesAggregatedState,
            config,
            this.emergencyManagers,
            this.safetyLimiters
        );
    }

    /**
     * Create combined distribution (emergency + normal devices)
     */
    createFullDistribution(config, emergencyDevices, normalDistribution) {
        const emergencyDistribution = emergencyDevices.map(d => ({
            deviceId: d.id,
            deviceName: d.name,
            powerW: -(config.emergencyChargePowerW || 800),
            excluded: false,
            reason: 'emergency'
        }));
        
        return [...emergencyDistribution, ...normalDistribution];
    }

    /**
     * Calculate actual total power (emergency + normal)
     */
    calculateActualTotal(config, emergencyDevices, normalDistribution) {
        const emergencyTotalW = emergencyDevices.length * (-(config.emergencyChargePowerW || 800));
        const normalTotalW = normalDistribution.reduce((sum, d) => sum + d.powerW, 0);
        return emergencyTotalW + normalTotalW;
    }

    /**
     * Update adapter mode status
     */
    async updateModeStatus(emergencyDevices, totalBatteryPowerW) {
        let mode = 'standby';
        
        // Emergency mode has highest priority
        if (emergencyDevices.length > 0) {
            mode = 'emergency-charging';
        } else if (totalBatteryPowerW < -10) {
            mode = 'charging';
        } else if (totalBatteryPowerW > 10) {
            mode = 'discharging';
        }

        // Override if any device in recovery (but not in emergency)
        if (emergencyDevices.length === 0) {
            const anyInRecovery = Array.from(this.emergencyManagers.values()).some(m => m.inEmergencyRecovery || m.inVoltageRecovery);
            if (anyInRecovery && mode === 'standby') {
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

module.exports = MultiDeviceController;
