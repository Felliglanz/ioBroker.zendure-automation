'use strict';

/**
 * MultiDeviceManager Module
 * 
 * Manages multiple Zendure devices as a unified system:
 * - Aggregates states from all devices
 * - Distributes power SOC-weighted across devices
 * - Handles per-device emergency states
 * - Excludes devices at safety limits from distribution
 */
class MultiDeviceManager {
    /**
     * @param {object} adapter - ioBroker adapter instance
     * @param {string} solarflowInstance - Base instance path (e.g., 'zendure-solarflow.0')
     * @param {Array} devices - Array of device configs [{productKey, deviceKey, name, enabled}]
     */
    constructor(adapter, solarflowInstance, devices) {
        this.adapter = adapter;
        this.solarflowInstance = solarflowInstance;
        
        // Build device list with base paths
        this.devices = devices
            .filter(d => d.enabled && d.productKey && d.deviceKey)
            .map((d, index) => ({
                id: `device${index + 1}`,
                name: d.name || `Device ${index + 1}`,
                productKey: d.productKey,
                deviceKey: d.deviceKey,
                basePath: `${solarflowInstance}.${d.productKey}.${d.deviceKey}`,
                enabled: true
            }));

        if (this.devices.length === 0) {
            throw new Error('No valid devices configured for multi-device mode');
        }

        this.adapter.log.info(`Multi-Device Manager initialized with ${this.devices.length} device(s)`);
        this.devices.forEach(d => {
            this.adapter.log.info(`  - ${d.name} (${d.id}): ${d.basePath}`);
        });
    }

    /**
     * Aggregate states from all devices
     * @returns {Promise<object>} Aggregated system state
     */
    async aggregateDeviceStates() {
        const deviceStates = [];

        for (const device of this.devices) {
            try {
                // Read device states
                const packPowerState = await this.adapter.getForeignStateAsync(`${device.basePath}.packPower`);
                const socState = await this.adapter.getForeignStateAsync(`${device.basePath}.electricLevel`);
                const minVolState = await this.getMinimumPackVoltage(device.basePath);

                const deviceState = {
                    id: device.id,
                    name: device.name,
                    basePath: device.basePath,
                    powerW: packPowerState?.val ?? null,
                    soc: socState?.val ?? null,
                    minPackVoltageV: minVolState,
                    available: packPowerState !== null && socState !== null
                };

                deviceStates.push(deviceState);
            } catch (err) {
                this.adapter.log.warn(`Failed to read states for ${device.name}: ${err.message}`);
                deviceStates.push({
                    id: device.id,
                    name: device.name,
                    basePath: device.basePath,
                    powerW: null,
                    soc: null,
                    minPackVoltageV: null,
                    available: false
                });
            }
        }

        // Calculate aggregated values
        const availableDevices = deviceStates.filter(d => d.available);
        
        if (availableDevices.length === 0) {
            return {
                devices: deviceStates,
                totalPowerW: null,
                avgSoc: null,
                minPackVoltageV: null,
                availableDevicesCount: 0
            };
        }

        const totalPowerW = availableDevices.reduce((sum, d) => sum + (d.powerW || 0), 0);
        const avgSoc = availableDevices.reduce((sum, d) => sum + (d.soc || 0), 0) / availableDevices.length;
        const minPackVoltageV = Math.min(...availableDevices.map(d => d.minPackVoltageV).filter(v => v !== null));

        return {
            devices: deviceStates,
            totalPowerW,
            avgSoc,
            minPackVoltageV: isFinite(minPackVoltageV) ? minPackVoltageV : null,
            availableDevicesCount: availableDevices.length
        };
    }

    /**
     * Get minimum pack voltage for a device (across all packs)
     * @param {string} deviceBasePath - Device base path
     * @returns {Promise<number|null>}
     */
    async getMinimumPackVoltage(deviceBasePath) {
        try {
            const packDataPath = `${deviceBasePath}.packData`;
            const packStates = await this.adapter.getObjectViewAsync('system', 'state', {
                startkey: `${packDataPath}.`,
                endkey: `${packDataPath}.\u9999`
            });

            const voltages = [];
            for (const row of packStates.rows) {
                if (row.id.endsWith('.minVol')) {
                    const state = await this.adapter.getForeignStateAsync(row.id);
                    if (state && state.val !== null) {
                        voltages.push(state.val);
                    }
                }
            }

            return voltages.length > 0 ? Math.min(...voltages) : null;
        } catch (err) {
            return null;
        }
    }

    /**
     * Distribute total power across devices
     * Distribution strategy:
     * - SOC-weighted: Devices with lower SOC get more charging power, higher SOC get more discharge
     * - Devices at safety limits are excluded
     * - Remaining power is split equally across available devices
     * 
     * @param {number} totalPowerW - Total power to distribute (negative = charge, positive = discharge)
     * @param {object} aggregatedState - Current aggregated state from aggregateDeviceStates()
     * @param {object} config - Adapter configuration
     * @param {object} emergencyManagers - Map of device ID to EmergencyManager instance
     * @returns {Promise<Array>} Array of {deviceId, powerW, reason}
     */
    async distributePower(totalPowerW, aggregatedState, config, emergencyManagers) {
        const availableDevices = aggregatedState.devices.filter(d => d.available);
        
        if (availableDevices.length === 0) {
            this.adapter.log.warn('No available devices for power distribution');
            return [];
        }

        // Check which devices can participate
        const eligibleDevices = [];
        const excludedDevices = [];

        for (const device of availableDevices) {
            const emergencyMgr = emergencyManagers.get(device.id);
            
            // Check if device is in emergency recovery (can only charge)
            if (emergencyMgr && emergencyMgr.inEmergencyRecovery) {
                if (totalPowerW < 0) {
                    // Charging - eligible
                    eligibleDevices.push(device);
                } else {
                    // Discharging - excluded
                    excludedDevices.push({
                        deviceId: device.id,
                        powerW: 0,
                        reason: 'Emergency recovery (discharge blocked)'
                    });
                }
                continue;
            }

            // Check if device is in voltage recovery (can only charge or standby)
            if (emergencyMgr && emergencyMgr.inVoltageRecovery) {
                if (totalPowerW < 0) {
                    eligibleDevices.push(device);
                } else {
                    excludedDevices.push({
                        deviceId: device.id,
                        powerW: 0,
                        reason: 'Voltage recovery (discharge blocked)'
                    });
                }
                continue;
            }

            // Device is eligible
            eligibleDevices.push(device);
        }

        if (eligibleDevices.length === 0) {
            this.adapter.log.warn('All devices excluded from power distribution');
            return excludedDevices;
        }

        // SOC-weighted distribution
        const distribution = this.calculateSOCWeightedDistribution(
            totalPowerW,
            eligibleDevices,
            config
        );

        // Combine with excluded devices
        return [...distribution, ...excludedDevices];
    }

    /**
     * Calculate SOC-weighted power distribution
     * Strategy:
     * - Charging (negative power): Devices with lower SOC get more power
     * - Discharging (positive power): Devices with higher SOC give more power
     * - Weights are normalized so total equals target power
     * 
     * @param {number} totalPowerW - Total power to distribute
     * @param {Array} eligibleDevices - Devices that can participate
     * @param {object} config - Adapter configuration
     * @returns {Array} Distribution result
     */
    calculateSOCWeightedDistribution(totalPowerW, eligibleDevices, config) {
        if (eligibleDevices.length === 1) {
            // Single device - gets all power
            return [{
                deviceId: eligibleDevices[0].id,
                powerW: totalPowerW,
                reason: 'Single eligible device'
            }];
        }

        const avgSoc = eligibleDevices.reduce((sum, d) => sum + d.soc, 0) / eligibleDevices.length;
        
        // Calculate weights based on SOC deviation from average
        // For charging: lower SOC = higher weight (more negative)
        // For discharging: higher SOC = higher weight (more positive)
        const weights = eligibleDevices.map(device => {
            const socDiff = device.soc - avgSoc;
            
            if (totalPowerW < 0) {
                // Charging: invert weight (lower SOC = more charge)
                return { device, weight: -socDiff };
            } else {
                // Discharging: normal weight (higher SOC = more discharge)
                return { device, weight: socDiff };
            }
        });

        // Normalize weights
        const totalWeight = weights.reduce((sum, w) => sum + Math.abs(w.weight), 0);
        
        if (totalWeight === 0) {
            // All SOCs equal - distribute evenly
            const powerPerDevice = totalPowerW / eligibleDevices.length;
            return eligibleDevices.map(device => ({
                deviceId: device.id,
                powerW: Math.round(powerPerDevice),
                reason: 'Equal SOC distribution'
            }));
        }

        // Distribute power proportionally
        const distribution = weights.map(({ device, weight }) => {
            const normalizedWeight = weight / totalWeight;
            const devicePower = totalPowerW * normalizedWeight;
            
            return {
                deviceId: device.id,
                powerW: Math.round(devicePower),
                reason: `SOC-weighted (${device.soc}%)`
            };
        });

        // Adjust rounding errors - ensure sum equals total
        const distributedSum = distribution.reduce((sum, d) => sum + d.powerW, 0);
        const roundingError = totalPowerW - distributedSum;
        if (roundingError !== 0) {
            distribution[0].powerW += roundingError;
        }

        return distribution;
    }

    /**
     * Write power setpoints to all devices
     * @param {Array} distribution - Power distribution from distributePower()
     * @param {object} validationService - Validation service instance
     * @returns {Promise<void>}
     */
    async writePowerSetpoints(distribution, validationService) {
        const writes = distribution.map(async (item) => {
            const device = this.devices.find(d => d.id === item.deviceId);
            if (!device) {
                this.adapter.log.warn(`Device ${item.deviceId} not found for power write`);
                return;
            }

            this.adapter.log.debug(
                `Setting ${device.name} (${device.id}) power: ${item.powerW}W - ${item.reason}`
            );

            try {
                await validationService.writePowerSetpoint(device.basePath, item.powerW);
            } catch (err) {
                this.adapter.log.error(
                    `Failed to write power to ${device.name}: ${err.message}`
                );
            }
        });

        await Promise.all(writes);
    }

    /**
     * Subscribe to all device states
     * @returns {Promise<void>}
     */
    async subscribeToDevices() {
        for (const device of this.devices) {
            await this.adapter.subscribeForeignStatesAsync(`${device.basePath}.packPower`);
            await this.adapter.subscribeForeignStatesAsync(`${device.basePath}.electricLevel`);
            await this.adapter.subscribeForeignStatesAsync(`${device.basePath}.packData.*.minVol`);
            await this.adapter.subscribeForeignStatesAsync(`${device.basePath}.control.lowVoltageBlock`);
            await this.adapter.subscribeForeignStatesAsync(`${device.basePath}.control.fullChargeNeeded`);
        }
    }
}

module.exports = MultiDeviceManager;
