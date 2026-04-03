'use strict';

/**
 * DataReader Module
 * 
 * Responsible for reading all sensor data from ioBroker states.
 * Pure data access layer - no business logic.
 */
class DataReader {
    /**
     * @param {object} adapter - ioBroker adapter instance
     * @param {string} deviceBasePath - Base path to Zendure device states
     */
    constructor(adapter, deviceBasePath) {
        this.adapter = adapter;
        this.deviceBasePath = deviceBasePath;
        this._lastBatteryPowerW = 0; // Cached value for fallback
    }

    /**
     * Read grid power from configured datapoint
     * @param {string} powerMeterDp - Datapoint path for power meter
     * @returns {Promise<number|null>} Power in Watts (positive = drawing, negative = feeding)
     */
    async getGridPowerW(powerMeterDp) {
        try {
            const state = await this.adapter.getForeignStateAsync(powerMeterDp);
            if (state && state.val !== null && state.val !== undefined) {
                return Number(state.val);
            }
        } catch (err) {
            this.adapter.log.warn(`Could not read grid power: ${err.message}`);
        }
        return null;
    }

    /**
     * Read battery SOC from Zendure device
     * @returns {Promise<number|null>} SOC in percent (0-100)
     */
    async getBatterySoc() {
        try {
            const state = await this.adapter.getForeignStateAsync(
                `${this.deviceBasePath}.electricLevel`
            );
            if (state && state.val !== null && state.val !== undefined) {
                return Number(state.val);
            }
        } catch (err) {
            this.adapter.log.warn(`Could not read battery SOC: ${err.message}`);
        }
        return null;
    }

    /**
     * Read current battery power from Zendure device
     * Convention: negative = charging, positive = discharging
     * @returns {Promise<number|null>} Power in Watts
     */
    async getCurrentBatteryPowerW() {
        try {
            // Note: Zendure packPower uses inverted convention:
            //   Zendure: negative=discharge, positive=charge
            //   Our code: positive=discharge, negative=charge
            // Therefore we invert the value
            const packPowerState = await this.adapter.getForeignStateAsync(
                `${this.deviceBasePath}.packPower`
            );

            if (packPowerState && packPowerState.val !== null && packPowerState.val !== undefined) {
                const batteryPower = -Number(packPowerState.val);
                this._lastBatteryPowerW = batteryPower;
                return batteryPower;
            }
        } catch (err) {
            this.adapter.log.warn(`Could not read battery power: ${err.message}`);
        }
        return this._lastBatteryPowerW; // Return cached value
    }

    /**
     * Get minimum cell voltage across all battery packs
     * @returns {Promise<number|null>} Minimum voltage in Volts
     */
    async getMinimumPackVoltageV() {
        try {
            const packDataPattern = `${this.deviceBasePath}.packData.`;
            const allStates = await this.adapter.getForeignObjectsAsync(packDataPattern + '*', 'state');
            
            let minVoltage = null;
            let packCount = 0;

            for (const [id, obj] of Object.entries(allStates)) {
                if (id.endsWith('.minVol')) {
                    const state = await this.adapter.getForeignStateAsync(id);
                    if (state && state.val !== null && state.val !== undefined) {
                        const voltage = Number(state.val);
                        packCount++;
                        
                        if (minVoltage === null || voltage < minVoltage) {
                            minVoltage = voltage;
                        }
                        
                        this.adapter.log.debug(`Pack ${id.split('.')[4]}: minVol = ${voltage.toFixed(2)}V`);
                    }
                }
            }

            if (packCount > 0) {
                this.adapter.log.debug(`Found ${packCount} pack(s), minimum voltage: ${minVoltage?.toFixed(2)}V`);
                return minVoltage;
            } else {
                this.adapter.log.warn('No battery packs found for voltage monitoring');
                return null;
            }
        } catch (err) {
            this.adapter.log.warn(`Could not read pack voltages: ${err.message}`);
            return null;
        }
    }

    /**
     * Get target grid power from control state
     * @param {number} fallbackValue - Fallback value if state cannot be read
     * @returns {Promise<number>} Target power in Watts
     */
    async getTargetGridPowerW(fallbackValue = 0) {
        try {
            const state = await this.adapter.getStateAsync('control.targetGridPowerW');
            if (state && state.val !== null && state.val !== undefined) {
                return Number(state.val);
            }
        } catch (err) {
            this.adapter.log.warn(`Could not read target grid power: ${err.message}`);
        }
        return fallbackValue;
    }
}

module.exports = DataReader;
