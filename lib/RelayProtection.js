'use strict';

/**
 * RelayProtection Module
 * 
 * Implements mode switching protection to prevent relay wear:
 * - Tick-based counters for sustained condition detection
 * - Relay protection (waits for ~0W before switching)
 * - Hysteresis between charge/discharge thresholds
 */
class RelayProtection {
    constructor(adapter) {
        this.adapter = adapter;
        
        // State counters
        this.feedInCounter = 0;
        this.dischargeCounter = 0;
    }

    /**
     * Apply mode switching protection logic
     * @param {object} params - Parameters object
     * @param {object} params.config - Adapter configuration
     * @param {number} params.gridPowerW - Current grid power
     * @param {number} params.currentBatteryPowerW - Measured battery power
     * @param {number} params.lastSetPowerW - Last set power value
     * @param {number} params.newBatteryPowerW - Calculated target power
     * @returns {{powerW: number, feedInCounter: number, dischargeCounter: number}} Protected power value and counters
     */
    applyProtection(params) {
        const {
            config,
            gridPowerW,
            currentBatteryPowerW,
            lastSetPowerW,
            newBatteryPowerW
        } = params;

        const feedInThresholdW = config.feedInThresholdW || -150;
        const feedInDelayTicks = config.feedInDelayTicks || 5;
        const dischargeThresholdW = config.dischargeThresholdW || 200;
        const dischargeDelayTicks = config.dischargeDelayTicks || 3;
        const modeSwitchToleranceW = 10;

        const currentlyCharging = lastSetPowerW < 0;
        const currentlyDischarging = lastSetPowerW > 0;
        const wantsToCharge = newBatteryPowerW < 0;
        const wantsToDischarge = newBatteryPowerW > 0;

        let protectedPowerW = newBatteryPowerW;

        if (!currentlyCharging && wantsToCharge) {
            // ========== TRANSITION: Discharge/Standby → Charge ==========
            protectedPowerW = this._handleTransitionToCharge(
                gridPowerW,
                currentBatteryPowerW,
                currentlyDischarging,
                newBatteryPowerW,
                feedInThresholdW,
                feedInDelayTicks,
                modeSwitchToleranceW
            );
            this.dischargeCounter = 0;

        } else if (currentlyCharging && wantsToDischarge) {
            // ========== TRANSITION: Charge → Discharge ==========
            protectedPowerW = this._handleTransitionToDischarge(
                gridPowerW,
                currentBatteryPowerW,
                newBatteryPowerW,
                dischargeThresholdW,
                dischargeDelayTicks,
                modeSwitchToleranceW
            );
            this.feedInCounter = 0;

        } else if (currentlyCharging && wantsToCharge) {
            // ========== CONTINUE CHARGING ==========
            this.adapter.log.debug('Continuing charge mode, normal regulation applies');
            if (this.feedInCounter < feedInDelayTicks) {
                this.feedInCounter = feedInDelayTicks;
            }
            this.dischargeCounter = 0;

        } else if (currentlyDischarging && wantsToDischarge) {
            // ========== CONTINUE DISCHARGING ==========
            this.adapter.log.debug('Continuing discharge mode, normal regulation applies');
            this.feedInCounter = 0;
            if (this.dischargeCounter < dischargeDelayTicks) {
                this.dischargeCounter = dischargeDelayTicks;
            }

        } else {
            // ========== OTHER TRANSITIONS (Standby, etc.) ==========
            if (this.feedInCounter > 0 || this.dischargeCounter > 0) {
                this.adapter.log.debug('Mode change to standby, resetting counters');
            }
            this.feedInCounter = 0;
            this.dischargeCounter = 0;
        }

        return {
            powerW: protectedPowerW,
            feedInCounter: this.feedInCounter,
            dischargeCounter: this.dischargeCounter
        };
    }

    /**
     * Handle transition to charge mode
     * @private
     */
    _handleTransitionToCharge(
        gridPowerW,
        currentBatteryPowerW,
        currentlyDischarging,
        newBatteryPowerW,
        feedInThresholdW,
        feedInDelayTicks,
        modeSwitchToleranceW
    ) {
        if (gridPowerW < feedInThresholdW) {
            // Sufficient feed-in detected
            this.feedInCounter++;
            this.adapter.log.debug(
                `Feed-in detected (${gridPowerW}W < ${feedInThresholdW}W), counter: ${this.feedInCounter}/${feedInDelayTicks}`
            );

            if (this.feedInCounter < feedInDelayTicks) {
                // Not yet sustained - block transition
                this.adapter.log.debug(
                    `Feed-in not sustained (${this.feedInCounter}/${feedInDelayTicks}), blocking charge transition`
                );
                return Math.max(0, newBatteryPowerW);
            } else {
                // Sustained feed-in confirmed
                if (currentlyDischarging) {
                    // Check relay protection
                    if (Math.abs(currentBatteryPowerW) > modeSwitchToleranceW) {
                        this.adapter.log.debug(
                            `Waiting for battery power near 0W before relay switch (current: ${currentBatteryPowerW}W)`
                        );
                        return Math.max(0, newBatteryPowerW);
                    } else {
                        this.adapter.log.debug(
                            `✓ Feed-in sustained, battery at ${currentBatteryPowerW}W (~0W), relay safe to switch`
                        );
                    }
                } else {
                    // From standby - no relay switch needed
                    this.adapter.log.debug(`✓ Feed-in sustained, allowing charge from standby: ${newBatteryPowerW}W`);
                }
            }
        } else {
            // Feed-in below threshold
            if (this.feedInCounter > 0) {
                this.adapter.log.debug(`Feed-in below threshold, resetting counter (was ${this.feedInCounter})`);
            }
            this.feedInCounter = 0;
            return Math.max(0, newBatteryPowerW);
        }

        return newBatteryPowerW;
    }

    /**
     * Handle transition to discharge mode
     * @private
     */
    _handleTransitionToDischarge(
        gridPowerW,
        currentBatteryPowerW,
        newBatteryPowerW,
        dischargeThresholdW,
        dischargeDelayTicks,
        modeSwitchToleranceW
    ) {
        if (gridPowerW > dischargeThresholdW) {
            // Sufficient grid draw detected
            this.dischargeCounter++;
            this.adapter.log.debug(
                `Grid draw detected (${gridPowerW}W > ${dischargeThresholdW}W), counter: ${this.dischargeCounter}/${dischargeDelayTicks}`
            );

            if (this.dischargeCounter < dischargeDelayTicks) {
                // Not yet sustained - stay in charge mode
                this.adapter.log.debug(
                    `Grid draw not sustained (${this.dischargeCounter}/${dischargeDelayTicks}), staying in charge mode`
                );
                return Math.min(0, newBatteryPowerW);
            } else {
                // Sustained grid draw confirmed - check relay protection
                if (Math.abs(currentBatteryPowerW) > modeSwitchToleranceW) {
                    this.adapter.log.debug(
                        `Waiting for battery power near 0W before relay switch (current: ${currentBatteryPowerW}W)`
                    );
                    return Math.min(0, newBatteryPowerW);
                } else {
                    this.adapter.log.debug(
                        `✓ Grid draw sustained, battery at ${currentBatteryPowerW}W (~0W), relay safe to switch`
                    );
                }
            }
        } else {
            // Grid draw below threshold
            if (this.dischargeCounter > 0) {
                this.adapter.log.debug(`Grid draw below threshold, resetting counter (was ${this.dischargeCounter})`);
            }
            this.dischargeCounter = 0;
            return Math.min(0, newBatteryPowerW);
        }

        return newBatteryPowerW;
    }
}

module.exports = RelayProtection;
