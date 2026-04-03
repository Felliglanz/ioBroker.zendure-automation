'use strict';

/**
 * PowerRegulator Module
 * 
 * Applies power regulation algorithms:
 * - Hysteresis (dead band to prevent oscillation)
 * - Ramp rate limiting (smooth power changes)
 * - Absolute power limits (max charge/discharge)
 * - Power rounding
 */
class PowerRegulator {
    constructor(adapter) {
        this.adapter = adapter;
    }

    /**
     * Apply all power regulation (hysteresis, ramping, limits)
     * @param {object} params - Parameters object
     * @param {object} params.config - Adapter configuration
     * @param {number} params.powerW - Target power before regulation
     * @param {number} params.lastSetPowerW - Last set power value
     * @param {boolean} params.safetyActive - Whether safety limit is active (bypasses regulation)
     * @returns {{powerW: number}} Regulated power value
     */
    applyRegulation(params) {
        const { config, powerW, lastSetPowerW, safetyActive } = params;

        let regulatedPowerW = powerW;

        // Safety limits bypass all regulation
        if (safetyActive) {
            this.adapter.log.debug('Safety limit active, regulation bypassed');
            return { powerW: regulatedPowerW };
        }

        // Apply hysteresis
        regulatedPowerW = this._applyHysteresis(config, regulatedPowerW, lastSetPowerW);

        // Apply ramp rate limits
        regulatedPowerW = this._applyRamping(config, regulatedPowerW, lastSetPowerW);

        // Apply absolute limits
        regulatedPowerW = this._applyAbsoluteLimits(config, regulatedPowerW);

        // Round to nearest 10W
        regulatedPowerW = Math.round(regulatedPowerW / 10) * 10;

        return { powerW: regulatedPowerW };
    }

    /**
     * Apply hysteresis (dead band)
     * @private
     */
    _applyHysteresis(config, powerW, lastSetPowerW) {
        const hysteresisW = config.hysteresisW || 50;
        const powerDelta = Math.abs(powerW - lastSetPowerW);

        if (powerDelta < hysteresisW) {
            this.adapter.log.debug(
                `Power delta ${powerDelta}W below hysteresis, keeping current power`
            );
            return lastSetPowerW;
        }

        return powerW;
    }

    /**
     * Apply ramp rate limiting
     * Ramp is chosen based on CURRENT mode, not direction of change
     * @private
     */
    _applyRamping(config, powerW, lastSetPowerW) {
        const rampChargeLimit = config.rampChargeWPerCycle || 100;
        const rampDischargeLimit = config.rampDischargeWPerCycle || 400;

        const powerChange = powerW - lastSetPowerW;
        const isCurrentlyInDischargeMode = lastSetPowerW > 0;
        const isCurrentlyInChargeMode = lastSetPowerW < 0;

        if (isCurrentlyInDischargeMode) {
            // Currently discharging: use discharge ramp
            if (Math.abs(powerChange) > rampDischargeLimit) {
                if (powerChange > 0) {
                    // Increasing discharge
                    const newPower = lastSetPowerW + rampDischargeLimit;
                    this.adapter.log.debug(
                        `Discharge ramp applied: ${rampDischargeLimit}W/cycle (change: ${powerChange.toFixed(0)}W)`
                    );
                    return newPower;
                } else {
                    // Decreasing discharge (toward zero)
                    const newPower = lastSetPowerW - rampDischargeLimit;
                    this.adapter.log.debug(
                        `Discharge ramp applied: ${rampDischargeLimit}W/cycle (change: ${powerChange.toFixed(0)}W)`
                    );
                    return newPower;
                }
            }
        } else if (isCurrentlyInChargeMode) {
            // Currently charging: use charge ramp
            if (Math.abs(powerChange) > rampChargeLimit) {
                if (powerChange > 0) {
                    // Decreasing charge (toward zero)
                    const newPower = lastSetPowerW + rampChargeLimit;
                    this.adapter.log.debug(
                        `Charge ramp applied: ${rampChargeLimit}W/cycle (change: ${powerChange.toFixed(0)}W)`
                    );
                    return newPower;
                } else {
                    // Increasing charge
                    const newPower = lastSetPowerW - rampChargeLimit;
                    this.adapter.log.debug(
                        `Charge ramp applied: ${rampChargeLimit}W/cycle (change: ${powerChange.toFixed(0)}W)`
                    );
                    return newPower;
                }
            }
        } else {
            // Starting from zero/standby
            if (powerChange > 0 && Math.abs(powerChange) > rampDischargeLimit) {
                // Starting discharge
                this.adapter.log.debug(`Starting discharge with ramp: ${rampDischargeLimit}W/cycle`);
                return rampDischargeLimit;
            } else if (powerChange < 0 && Math.abs(powerChange) > rampChargeLimit) {
                // Starting charge
                this.adapter.log.debug(`Starting charge with ramp: ${rampChargeLimit}W/cycle`);
                return -rampChargeLimit;
            }
        }

        return powerW;
    }

    /**
     * Apply absolute power limits
     * @private
     */
    _applyAbsoluteLimits(config, powerW) {
        const maxCharge = -(config.maxChargePowerW || 1600);
        const maxDischarge = config.maxDischargePowerW || 1600;

        if (powerW < maxCharge) {
            this.adapter.log.debug(`Limiting charge to ${maxCharge}W`);
            return maxCharge;
        }

        if (powerW > maxDischarge) {
            this.adapter.log.debug(`Limiting discharge to ${maxDischarge}W`);
            return maxDischarge;
        }

        return powerW;
    }
}

module.exports = PowerRegulator;
