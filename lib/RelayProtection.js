'use strict';

/**
 * RelayProtection Module
 * 
 * Implements mode switching protection to prevent relay wear:
 * - Tick-based counters for sustained condition detection
 * - Relay protection (waits for ~0W before switching)
 * - Hysteresis between charge/discharge thresholds
 * - Operating deadband: Maintains minimum power before allowing mode changes
 */
class RelayProtection {
    constructor(adapter) {
        this.adapter = adapter;
        
        // State counters
        this.feedInCounter = 0;
        this.dischargeCounter = 0;
        
        // Operating deadband state
        this.deadbandCounter = 0;
        this.lastStableSign = 0; // -1 = charging, +1 = discharging, 0 = unknown
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
        // Operating deadband must be ≥10W to survive 10W rounding in PowerRegulator
        const operatingDeadbandW = config.operatingDeadbandW || 10;
        const deadbandHoldTicks = config.deadbandHoldTicks || 3;

        const currentlyCharging = lastSetPowerW < 0;
        const currentlyDischarging = lastSetPowerW > 0;
        const wantsToCharge = newBatteryPowerW < 0;
        const wantsToDischarge = newBatteryPowerW > 0;

        let protectedPowerW = newBatteryPowerW;

        // Enhanced debug logging
        this.adapter.log.debug(
            `RelayProtection: Grid=${gridPowerW}W, Battery=${currentBatteryPowerW}W, ` +
            `LastSet=${lastSetPowerW}W, Calculated=${newBatteryPowerW}W, ` +
            `Mode: ${currentlyCharging ? 'CHG' : currentlyDischarging ? 'DCH' : 'STBY'} → ` +
            `${wantsToCharge ? 'CHG' : wantsToDischarge ? 'DCH' : 'STBY'}`
        );

        if (!currentlyCharging && wantsToCharge) {
            // ========== TRANSITION: Discharge/Standby → Charge ==========
            this.adapter.log.debug(
                `🔄 Transition requested: ${currentlyDischarging ? 'Discharge' : 'Standby'} → Charge ` +
                `(Grid: ${gridPowerW}W, Threshold: ${feedInThresholdW}W)`
            );
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
            this.adapter.log.debug(
                `🔄 Transition requested: Charge → Discharge ` +
                `(Grid: ${gridPowerW}W, Threshold: ${dischargeThresholdW}W)`
            );
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

        // ========== OPERATING DEADBAND: FINAL CHECK - Prevent relay switching at high power ==========
        // This MUST run AFTER mode switch logic to catch all transitions to 0W or sign changes
        // CRITICAL: Relay must ALWAYS switch at ≤10W, never at higher power!
        const finalPowerW = protectedPowerW;
        const absLastPower = Math.abs(lastSetPowerW);
        const absFinalPower = Math.abs(finalPowerW);
        const wasActive = absLastPower >= operatingDeadbandW;
        const wantsStandby = finalPowerW === 0;
        const isSignChange = (lastSetPowerW < 0 && finalPowerW > 0) || (lastSetPowerW > 0 && finalPowerW < 0);
        
        // Detect ANY transition that would cause relay switching:
        // 1. Active mode (≥10W) → Standby (0W)
        // 2. Charge (negative) → Discharge (positive) or vice versa
        // 3. Standby (0W) → Active mode (≥10W)
        const isStandbyToActive = !wasActive && absFinalPower >= operatingDeadbandW;
        
        if ((wasActive && wantsStandby) || (wasActive && isSignChange) || isStandbyToActive) {
            // Determine which mode we were in (or want to go to from standby)
            let holdSign;
            if (lastSetPowerW < 0) {
                holdSign = -1; // Was charging
            } else if (lastSetPowerW > 0) {
                holdSign = 1; // Was discharging
            } else {
                // From standby - use target direction
                holdSign = finalPowerW < 0 ? -1 : 1;
            }
            
            // Update or reset counter
            if (this.lastStableSign === holdSign) {
                this.deadbandCounter++;
            } else {
                this.lastStableSign = holdSign;
                this.deadbandCounter = 1;
            }
            
            if (this.deadbandCounter <= deadbandHoldTicks) {
                // Not held long enough - enforce minimum operating power
                const minOperatingPower = operatingDeadbandW * holdSign;
                this.adapter.log.debug(
                    `⏸️  Operating deadband ACTIVE: Holding at ${minOperatingPower}W ` +
                    `(${this.deadbandCounter}/${deadbandHoldTicks} ticks) - prevents relay switch at ${absLastPower}W`
                );
                protectedPowerW = minOperatingPower;
            } else {
                // Held long enough - allow transition
                this.adapter.log.debug(
                    `✓ Operating deadband RELEASED after ${this.deadbandCounter} ticks, allowing ${wantsStandby ? 'standby (0W)' : 'transition to ' + finalPowerW + 'W'}`
                );
                this.deadbandCounter = 0;
                this.lastStableSign = wantsStandby ? 0 : holdSign; // Update to new mode
            }
        }
        // Power in deadband zone (0 < |power| < 10W) during gradual transitions
        else if (absFinalPower > 0 && absFinalPower < operatingDeadbandW) {
            // Determine which mode to hold
            let holdSign = 0;
            if (lastSetPowerW < -operatingDeadbandW) {
                holdSign = -1; // Was charging
            } else if (lastSetPowerW > operatingDeadbandW) {
                holdSign = 1; // Was discharging
            } else if (this.lastStableSign !== 0) {
                holdSign = this.lastStableSign; // Use last known stable mode
            } else {
                // Unknown, determine from final direction
                holdSign = finalPowerW < 0 ? -1 : 1;
            }
            
            if (this.lastStableSign === holdSign) {
                this.deadbandCounter++;
            } else {
                this.lastStableSign = holdSign;
                this.deadbandCounter = 1;
            }
            
            if (this.deadbandCounter <= deadbandHoldTicks) {
                const minOperatingPower = operatingDeadbandW * holdSign;
                this.adapter.log.debug(
                    `⏸️  Operating deadband ACTIVE (gradual): Holding at ${minOperatingPower}W ` +
                    `(${this.deadbandCounter}/${deadbandHoldTicks} ticks)`
                );
                protectedPowerW = minOperatingPower;
            } else {
                this.adapter.log.debug(
                    `✓ Operating deadband RELEASED after ${this.deadbandCounter} ticks, allowing ${finalPowerW}W`
                );
                this.deadbandCounter = 0;
            }
        }
        // Outside deadband - normal operation
        else if (absFinalPower >= operatingDeadbandW) {
            const newSign = finalPowerW < 0 ? -1 : 1;
            if (this.lastStableSign !== newSign && this.deadbandCounter > 0) {
                this.adapter.log.debug(
                    `Operating deadband: Exited to full power (${finalPowerW}W), counter reset`
                );
            }
            this.lastStableSign = newSign;
            this.deadbandCounter = 0;
        }
        // Already in standby (was 0W, stays 0W) - do nothing
        else if (!wasActive && wantsStandby) {
            if (this.deadbandCounter > 0) {
                this.adapter.log.debug(`Operating deadband: Already in standby, counter reset`);
                this.deadbandCounter = 0;
                this.lastStableSign = 0;
            }
        }
        // ============================================================================

        // Final debug output if power was modified
        if (Math.abs(protectedPowerW - newBatteryPowerW) > 0.1) {
            this.adapter.log.debug(
                `⚡ RelayProtection modified power: ${newBatteryPowerW}W → ${protectedPowerW}W`
            );
        }

        return {
            powerW: protectedPowerW,
            feedInCounter: this.feedInCounter,
            dischargeCounter: this.dischargeCounter,
            deadbandCounter: this.deadbandCounter
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
