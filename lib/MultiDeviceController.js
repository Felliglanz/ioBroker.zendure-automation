'use strict';

const { computeEffectiveChargeLimitW } = require('./pvChargeLimit');
const { isStale } = require('./stateFreshness');

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
        this.deviceRecoveryLogged = new Map(); // Map<deviceId, {emergency: bool, voltage: bool, minSoc: bool}>
        this.emergencyChargingLogged = false;
        this.lastTotalWrittenPowerW = 0; // Track total written power for I-Regulator
    }

    /**
     * Run multi-device automation cycle
     * @param {object} config - Adapter configuration
     */
    async runCycle(config) {
        // ========== AGGREGATE DEVICE STATES ==========
        const aggregatedState = await this.multiDeviceMgr.aggregateDeviceStates();

        // ========== VALIDATE PREVIOUS SETPOINT PER DEVICE (NON-BLOCKING) ==========
        // Each device validates independently based on its configured validation source
        for (const deviceState of aggregatedState.devices) {
            if (!deviceState.available) continue;

            // Find device config to get validationSource - read from the enriched device list
            // (multiDeviceMgr.devices), not the raw admin config, since that's where hasPv
            // devices already have validationSource forced to gridInputPower.
            const deviceConfig = this.multiDeviceMgr.devices.find(d => d.id === deviceState.id);
            const validationSource = deviceConfig?.validationSource || 'packPower';

            // Get validation power based on configured source
            let validationPowerW = null;
            if (validationSource === 'packPower') {
                validationPowerW = deviceState.powerW;
            } else if (validationSource === 'gridInputPower') {
                validationPowerW = deviceState.gridInputPowerW;
            }
            // If validationSource is 'none', validationPowerW stays null (no validation)

            if (validationPowerW !== null) {
                await this.validationService.validateSetpoint(deviceState.id, config, validationPowerW);
            }
        }

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
        let emergencyTotalPowerW = 0;
        if (emergencyDevices.length > 0) {
            emergencyTotalPowerW = await this.handleEmergencyDevices(config, emergencyDevices);
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
        await this.multiDeviceMgr.writePowerSetpoints(distribution, aggregatedState, this.validationService, config);

        // ========== STORE TOTAL FOR NEXT CYCLE ==========
        const totalWritten = distribution
            .filter(d => !d.excluded)
            .reduce((sum, d) => sum + d.powerW, 0);
        this.lastTotalWrittenPowerW = totalWritten + emergencyTotalPowerW;

        // ========== UPDATE DEVICE STATES WITH DISTRIBUTION ==========
        const fullDistribution = this.createFullDistribution(config, emergencyDevices, distribution);
        await this.updateDeviceStates(aggregatedState.devices, fullDistribution);

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
            if (state?.val === null || state?.val === undefined) {
                return null;
            }

            if (isStale(state)) {
                this.adapter.log.warn(`Grid power (${powerMeterDp}) has not been updated recently, ignoring stale value`);
                return null;
            }

            const value = Number(state.val);
            if (!isFinite(value)) {
                this.adapter.log.warn(`Grid power is invalid (NaN/Infinity), ignoring value: ${state.val}`);
                return null;
            }

            return value;
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
            this.adapter.log.warn(`Could not read target grid power: ${err.message}`);
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

                // Emergency/voltage/SOC recovery flags are persisted directly by each device's
                // own EmergencyManager instance (status.devices.<id>.*RecoveryActive), no duplicate write needed here.

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
            await emergencyMgr.updateSocRecovery(config, device.soc);

            // Update minSoc recovery (Zendure hardware protection)
            if (config.useZendureMinSoc !== false && config.dischargeProtectionMode === 'voltage') {
                try {
                    const minSocState = await this.adapter.getForeignStateAsync(
                        `${device.basePath}.minSoc`
                    );
                    if (minSocState && minSocState.val !== null && minSocState.val !== undefined) {
                        const zendureMinSoc = Number(minSocState.val);
                        const margin = config.zendureMinSocMargin || 1;
                        const effectiveMinSoc = zendureMinSoc + margin;
                        
                        // Update state for transparency (per device)
                        await this.adapter.setStateAsync(
                            `status.devices.${device.id}.effectiveMinSoc`,
                            effectiveMinSoc,
                            true
                        );
                        
                        await emergencyMgr.updateMinSocRecovery(config, device.soc, zendureMinSoc);
                    }
                } catch (err) {
                    this.adapter.log.debug(`Could not update minSoc recovery for ${device.id}: ${err.message}`);
                }
            } else {
                // Clear state if feature disabled
                await this.adapter.setStateAsync(`status.devices.${device.id}.effectiveMinSoc`, 0, true);
            }

            // Check if in recovery after update
            if (emergencyMgr.inEmergencyRecovery) {
                emergencyDevices.push(device);
                // Log only once when entering recovery
                const logState = this.deviceRecoveryLogged.get(device.id) || {};
                if (!logState.emergency) {
                    const emergencyExitSoc = config.emergencyExitSoc || 20;
                    this.adapter.log.warn(`⚡ ${device.name} emergency charging: ${device.soc}% → ${emergencyExitSoc}%`);
                    this.deviceRecoveryLogged.set(device.id, { ...logState, emergency: true });
                }
            } else if (emergencyMgr.inVoltageRecovery) {
                // Log only once when entering recovery
                const logState = this.deviceRecoveryLogged.get(device.id) || {};
                if (!logState.voltage) {
                    const emergencyExitVoltage = config.emergencyExitVoltage || 3.1;
                    this.adapter.log.warn(`⚡ ${device.name} voltage recovery: ${device.minPackVoltageV?.toFixed(2) || 'N/A'}V → ${emergencyExitVoltage}V`);
                    this.deviceRecoveryLogged.set(device.id, { ...logState, voltage: true });
                }
                // Voltage recovery blocks discharge, but is not emergency charging.
                // Keep the device in the normal path so distribution writes 0W for
                // discharge without starting emergencyChargePowerW.
                normalDevices.push(device);
            } else {
                if (emergencyMgr.inMinSocRecovery) {
                    this.adapter.log.debug(
                        `⚡ ${device.name} minSoc recovery active: discharge blocked, emergency charging not triggered`
                    );
                }
                // Device exited all recoveries - reset log flags
                this.deviceRecoveryLogged.delete(device.id);
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
                    // Will be logged in next cycle when inEmergencyRecovery is checked
                } else {
                    normalDevices.push(device);
                }
            }
        }

        return { emergencyDevices, normalDevices };
    }

    /**
     * Handle emergency devices - write emergency charge power
     * @returns {number} Total power actually written across all emergency devices (negative, charging)
     */
    async handleEmergencyDevices(config, emergencyDevices) {
        const globalEmergencyChargePowerW = Math.abs(config.emergencyChargePowerW || 800);
        const emergencyDeviceNames = emergencyDevices.map(d => d.name).join(', ');

        // Log only once when emergency charging starts
        if (!this.emergencyChargingLogged) {
            this.adapter.log.warn(`🚨 Emergency Charging: ${emergencyDeviceNames} at up to ${globalEmergencyChargePowerW}W each (capped to each device's configured charge limit)`);
            this.emergencyChargingLogged = true;
        }
        await this.adapter.setStateAsync('status.emergencyReason', `Devices: ${emergencyDeviceNames}`, true);

        // Write emergency charge power to each emergency device, capped to its own
        // configured maxChargePowerW so a large global emergencyChargePowerW can't
        // overshoot a smaller device's limit.
        let totalWrittenPowerW = 0;
        for (const device of emergencyDevices) {
            const deviceConfig = this.multiDeviceMgr.devices.find(d => d.id === device.id);
            if (deviceConfig) {
                // Merge live state (solarInputPowerW) onto the static config (hasPv,
                // maxAcChargePowerW, maxChargePowerW) so a PV device's emergency charge target
                // is also capped to what it can actually deliver - otherwise emergency charging
                // reproduces the same setpoint-validation mismatch this feature fixes elsewhere.
                const merged = { ...device, ...deviceConfig };
                const powerW = -this.getCappedEmergencyChargePowerW(merged, globalEmergencyChargePowerW);
                await this.validationService.writePowerSetpoint(device.id, deviceConfig.basePath, powerW, config, { bypassHoldOff: true });
                totalWrittenPowerW += powerW;
            }
        }

        return totalWrittenPowerW;
    }

    /**
     * Emergency charge power for one device, capped to its own configured
     * maxChargePowerW (or PV-adjusted effective limit) so a large global
     * emergencyChargePowerW can't overshoot a smaller device's limit. Shared by
     * handleEmergencyDevices (which writes the setpoint) and createFullDistribution
     * (which reports it in status).
     */
    getCappedEmergencyChargePowerW(deviceConfig, globalEmergencyChargePowerW) {
        const deviceLimitW = computeEffectiveChargeLimitW(deviceConfig);
        return deviceLimitW > 0
            ? Math.min(globalEmergencyChargePowerW, deviceLimitW)
            : globalEmergencyChargePowerW;
    }

    /**
     * Calculate target power using I-Regulator with anti-windup
     */
    async calculateTargetPower(config, filteredGridPowerW, targetGridPowerW, normalDevices, aggregatedState) {
        // ========== I-REGULATOR: CALCULATE TARGET POWER FOR NORMAL DEVICES ==========
        let lastSetPowerW = this.lastTotalWrittenPowerW;

        const waterfillActive = config.multiDeviceDistributionStrategy === 'waterfill';
        const waterfillLimits = waterfillActive
            ? this.getWaterfillSystemLimits(normalDevices)
            : null;

        // ========== ANTI-WINDUP: Limit based on ALL configured devices ==========
        const totalDevicesCount = this.multiDeviceMgr.devices.length;
        const maxChargePowerW = waterfillLimits
            ? -waterfillLimits.maxChargePowerW
            : -(config.maxChargePowerW || 1200) * totalDevicesCount;
        const maxDischargePowerW = waterfillLimits
            ? waterfillLimits.maxDischargePowerW
            : (config.maxDischargePowerW || 1200) * totalDevicesCount;

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
        
        // Scale deadband by total device count (like power limits)
        const relayConfig = {
            ...config,
            operatingDeadbandW: (config.operatingDeadbandW || 10) * totalDevicesCount
        };
        
        // Mirrors the single-device dischargeBlocked check, aggregated to fleet level:
        // the global RelayProtection instance tracks the fleet TOTAL, so it only needs
        // to freeze when the total is guaranteed to be vetoed downstream too - i.e. every
        // normal device is currently blocked (a lone device counts as "every device").
        // A missing emergency manager is treated as "not blocked" (safe default: no freeze).
        const allNormalDevicesDischargeBlocked = normalDevices.every(d => {
            const em = this.emergencyManagers?.get(d.id);
            return Boolean(em) && (em.inEmergencyRecovery || em.inVoltageRecovery || em.inSocRecovery || em.inMinSocRecovery);
        });
        const dischargeBlocked = !config.enableDischarge || allNormalDevicesDischargeBlocked;

        const relayResult = this.relayProtection.applyProtection({
            config: relayConfig,
            gridPowerW: filteredGridPowerW,
            currentBatteryPowerW: normalDevicesCurrentPowerW,
            lastSetPowerW,
            newBatteryPowerW: newTotalBatteryPowerW,
            dischargeBlocked
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
            maxChargePowerW: waterfillLimits
                ? waterfillLimits.maxChargePowerW
                : config.maxChargePowerW * totalDevicesCount,
            maxDischargePowerW: waterfillLimits
                ? waterfillLimits.maxDischargePowerW
                : config.maxDischargePowerW * totalDevicesCount,
            operatingDeadbandW: (config.operatingDeadbandW || 10) * totalDevicesCount
        };

        const regResult = this.powerRegulator.applyRegulation({
            config: multiDeviceConfig,
            powerW: newTotalBatteryPowerW,
            lastSetPowerW,
            safetyActive: false,  // Safety handled per-device in distribution
            bypassHysteresis: relayResult.relayModified
        });
        newTotalBatteryPowerW = regResult.powerW;

        this.adapter.log.debug(
            `Setting total battery power: ${newTotalBatteryPowerW}W (Grid: ${filteredGridPowerW}W → ${targetGridPowerW}W)`
        );

        return newTotalBatteryPowerW;
    }

    /**
     * Calculate aggregate limits for the normal-device Waterfill rule loop.
     * Emergency charging and manual overrides intentionally use separate paths.
     *
     * Devices with chargeAllowed/dischargeAllowed set to false are excluded from
     * the respective sum, matching the eligibility filter WaterfillDistributor
     * and MultiDeviceManager.distributePower apply at actual distribution time -
     * otherwise this ceiling would overstate what can actually be delivered,
     * feeding an inflated target into anti-windup and the power regulator.
     */
    getWaterfillSystemLimits(normalDevices) {
        // Merge live state (solarInputPowerW) onto static config (hasPv, maxAcChargePowerW,
        // maxChargePowerW) - without solarInputPowerW here, a PV device's contribution to this
        // anti-windup ceiling would stay overstated on sunny days, letting the I-Regulator
        // integrate past what's actually deliverable.
        const mergedDevices = normalDevices
            .map(device => {
                const configuredDevice = this.multiDeviceMgr.devices.find(configured => configured.id === device.id);
                return configuredDevice ? { ...device, ...configuredDevice } : null;
            })
            .filter(Boolean);

        return {
            maxChargePowerW: mergedDevices.reduce(
                (sum, device) => sum + (device.chargeAllowed === false ? 0 : computeEffectiveChargeLimitW(device)),
                0
            ),
            maxDischargePowerW: mergedDevices.reduce(
                (sum, device) => sum + (device.dischargeAllowed === false ? 0 : Math.max(0, Number(device.maxDischargePowerW) || 0)),
                0
            )
        };
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
        const globalEmergencyChargePowerW = Math.abs(config.emergencyChargePowerW || 800);
        const emergencyDistribution = emergencyDevices.map(d => {
            const deviceConfig = this.multiDeviceMgr.devices.find(configured => configured.id === d.id);
            const merged = deviceConfig ? { ...d, ...deviceConfig } : null;
            const powerW = merged
                ? -this.getCappedEmergencyChargePowerW(merged, globalEmergencyChargePowerW)
                : -globalEmergencyChargePowerW;
            return {
                deviceId: d.id,
                deviceName: d.name,
                powerW,
                excluded: false,
                reason: 'emergency'
            };
        });

        return [...emergencyDistribution, ...normalDistribution];
    }

    /**
     * Update adapter mode status
     */
    async updateModeStatus(emergencyDevices, totalBatteryPowerW) {
        let mode = 'standby';
        
        // Emergency mode has highest priority
        if (emergencyDevices.length > 0) {
            mode = 'emergency-charging';
        } else {
            // Reset emergency charging flag when no devices in emergency
            this.emergencyChargingLogged = false;
            
            if (totalBatteryPowerW < -10) {
                mode = 'charging';
            } else if (totalBatteryPowerW > 10) {
                mode = 'discharging';
            }
        }

        // Override if any device in recovery (but not in emergency)
        if (emergencyDevices.length === 0) {
            const anyInRecovery = Array.from(this.emergencyManagers.values()).some(m =>
                m.inEmergencyRecovery || m.inVoltageRecovery || m.inSocRecovery || m.inMinSocRecovery
            );
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
