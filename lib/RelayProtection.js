'use strict';

/**
 * RelayProtection Module
 * 
 * Implements mode switching protection to prevent relay wear:
 * - Tick-based counters for sustained condition detection before a charge/discharge switch
 * - Hysteresis between charge/discharge thresholds
 * - Operating deadband: Maintains minimum power before allowing mode changes
 *
 * Deliberately does NOT also wait for measured battery power to confirm it has
 * settled near the deadband before switching - it used to, but that assumes a hold
 * at holdW makes the *measured* power converge there too, which a PV-equipped
 * device can permanently violate (it keeps charging/discharging from solar
 * regardless of our own small AC-side hold). That turned a bounded, tick-counted
 * wait into an unbounded one - the adapter got stuck refusing to switch for 6+
 * minutes while ignoring several kW of grid draw (issue #40). The tick-counted
 * hold at holdW is itself already the settling time; once it's elapsed we commit.
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
     * @param {boolean} [params.dischargeBlocked] - True when the caller already knows discharge
     *   will be vetoed downstream this cycle (active recovery, enableDischarge=false, ...). See
     *   the freeze block below for why this has to be known before, not after, this call.
     * @param {boolean} [params.chargeBlocked] - Same as dischargeBlocked, mirrored for charge
     *   (maxBatterySoc reached, enableCharge=false, ...).
     * @returns {{powerW: number, feedInCounter: number, dischargeCounter: number}} Protected power value and counters
     */
    applyProtection(params) {
        const {
            config,
            gridPowerW,
            currentBatteryPowerW,
            lastSetPowerW,
            newBatteryPowerW,
            dischargeBlocked,
            chargeBlocked
        } = params;

        const feedInThresholdW = config.feedInThresholdW || -150;
        const feedInDelayTicks = config.feedInDelayTicks || 5;
        const dischargeThresholdW = config.dischargeThresholdW || 200;
        const dischargeDelayTicks = config.dischargeDelayTicks || 3;
        // Operating deadband must be ≥10W per device (scaled by caller in multi-device mode)
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

        // ========== CHARGE/DISCHARGE BLOCKED DOWNSTREAM: FREEZE STATE ==========
        // SafetyLimiter runs AFTER this and, while a block lasts (recovery on the
        // discharge side; maxBatterySoc/enableCharge on the charge side), always
        // clamps the result back to 0 - so lastSetPowerW (the actually written value)
        // never leaves 0 during that whole block. Without this check, every single
        // cycle looks like a fresh Standby->Active transition to the code below, so the
        // deadband counter keeps hold/release-ing forever (visible as alternating
        // "Operating deadband ACTIVE" / "RELEASED" every cycle in the debug log) even
        // though nothing is ever actually written. The moment the block briefly clears
        // (e.g. cell voltage recovers just enough, or SOC ticks back under the ceiling),
        // whatever this churn happened to be outputting that instant gets written for
        // real - producing a real 0/10W/full-power flicker on the device instead of one
        // clean hold-then-release. Freezing here means the deadband/transition state
        // machine stops touching its counters while blocked, so the very next real
        // attempt (once the block actually lifts) starts a single, clean transition.
        //
        // Critically, this must NOT change the returned powerW to 0 itself: SafetyLimiter
        // (single-device) and the totalPowerW>0/<0 gates in MultiDeviceManager.distributePower
        // both decide whether a block is *actually* active by checking whether the incoming
        // power is still non-zero. Handing them an already-zeroed value here would make
        // them think there is nothing left to block, so they'd skip their own clamp and
        // (for single-device) skip setting safetyActive - which is exactly what tells the
        // caller to bypass zero-avoidance and send the real 0 immediately instead of
        // holding a phantom keep-alive while the device is supposed to be protected
        // (issue found 2026-08-24: 350-400W baseline load held at a 10W keep-alive for a
        // full smartModeIdleTimeoutSec during an active voltage recovery, instead of an
        // instant real 0, because this block used to return 0 here).
        if ((dischargeBlocked && wantsToDischarge) || (chargeBlocked && wantsToCharge)) {
            this.feedInCounter = 0;
            this.dischargeCounter = 0;
            this.deadbandCounter = 0;
            this.lastStableSign = 0;
            return {
                powerW: newBatteryPowerW,
                feedInCounter: 0,
                dischargeCounter: 0,
                deadbandCounter: 0,
                relayModified: false
            };
        }

        if (!currentlyCharging && wantsToCharge) {
            // ========== TRANSITION: Discharge/Standby → Charge ==========
            this.adapter.log.debug(
                `🔄 Transition requested: ${currentlyDischarging ? 'Discharge' : 'Standby'} → Charge ` +
                `(Grid: ${gridPowerW}W, Threshold: ${feedInThresholdW}W)`
            );
            protectedPowerW = this._handleTransitionToCharge(
                gridPowerW,
                currentlyDischarging,
                newBatteryPowerW,
                feedInThresholdW,
                feedInDelayTicks,
                operatingDeadbandW
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
                newBatteryPowerW,
                dischargeThresholdW,
                dischargeDelayTicks,
                operatingDeadbandW
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
        // This flag also tells the caller to bypass the downstream hysteresis check:
        // RelayProtection deliberately targets small, specific setpoints (0W to wait
        // for the relay, or ±operatingDeadbandW to hold it) that are frequently
        // smaller than hysteresisW, so a generic hysteresis filter after this point
        // would keep reverting the setpoint and the relay would never actually switch
        // (see issue #21).
        const relayModified = Math.abs(protectedPowerW - newBatteryPowerW) > 0.1;
        if (relayModified) {
            this.adapter.log.debug(
                `⚡ RelayProtection modified power: ${newBatteryPowerW}W → ${protectedPowerW}W`
            );
        }

        return {
            powerW: protectedPowerW,
            feedInCounter: this.feedInCounter,
            dischargeCounter: this.dischargeCounter,
            deadbandCounter: this.deadbandCounter,
            relayModified
        };
    }

    /**
     * Handle transition to charge mode
     * @private
     */
    _handleTransitionToCharge(
        gridPowerW,
        currentlyDischarging,
        newBatteryPowerW,
        feedInThresholdW,
        feedInDelayTicks,
        operatingDeadbandW
    ) {
        // While we're still parked mid-discharge waiting on this transition, hold at the
        // deadband level instead of a literal 0 - a literal 0 gets laundered by
        // config.avoidZeroSetpoint into a non-zero keep-alive in the *old* (discharge)
        // direction, which then reads back as "still discharging" next cycle and restarts
        // this whole transition from scratch. Holding at +operatingDeadbandW ourselves
        // avoids ever asking zero-avoidance for a zero we don't actually mean (issue: adapter
        // gets stuck alternating 0/operatingDeadbandW forever, never reaching the target).
        // Coming from genuine standby (not discharging) there's nothing to hold at - 0 stays 0.
        const holdW = currentlyDischarging ? operatingDeadbandW : 0;

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
                return Math.max(holdW, newBatteryPowerW);
            }
            // Sustained feed-in confirmed - switch now. We've held at holdW for
            // feedInDelayTicks cycles already (real, configurable settling time for
            // the relay), so we commit here instead of also waiting for measured
            // battery power to independently confirm convergence - that check used
            // to gate this switch and could never pass on a PV-equipped device,
            // where the battery keeps charging from solar regardless of our own
            // small AC-side hold, permanently blocking the switch (issue #40:
            // adapter stuck for 6+ minutes ignoring several kW of grid draw).
            this.adapter.log.debug(
                currentlyDischarging
                    ? `✓ Feed-in sustained for ${feedInDelayTicks} cycles, switching to charge: ${newBatteryPowerW}W`
                    : `✓ Feed-in sustained, allowing charge from standby: ${newBatteryPowerW}W`
            );
        } else {
            // Feed-in below threshold
            if (this.feedInCounter > 0) {
                this.adapter.log.debug(`Feed-in below threshold, resetting counter (was ${this.feedInCounter})`);
            }
            this.feedInCounter = 0;
            return Math.max(holdW, newBatteryPowerW);
        }

        return newBatteryPowerW;
    }

    /**
     * Handle transition to discharge mode
     * @private
     */
    _handleTransitionToDischarge(
        gridPowerW,
        newBatteryPowerW,
        dischargeThresholdW,
        dischargeDelayTicks,
        operatingDeadbandW
    ) {
        // Always called while still parked mid-charge (caller gates on currentlyCharging), so
        // hold at -operatingDeadbandW instead of a literal 0 while waiting - same reasoning as
        // the mirrored charge-direction holdW in _handleTransitionToCharge.
        const holdW = -operatingDeadbandW;

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
                return Math.min(holdW, newBatteryPowerW);
            }
            // Sustained grid draw confirmed - switch now, same reasoning as the mirrored
            // charge-direction branch above: holding at holdW for dischargeDelayTicks
            // cycles is the settling time, not a follow-up measured-power check that a
            // PV-equipped device could keep failing forever (issue #40).
            this.adapter.log.debug(
                `✓ Grid draw sustained for ${dischargeDelayTicks} cycles, switching to discharge: ${newBatteryPowerW}W`
            );
        } else {
            // Grid draw below threshold
            if (this.dischargeCounter > 0) {
                this.adapter.log.debug(`Grid draw below threshold, resetting counter (was ${this.dischargeCounter})`);
            }
            this.dischargeCounter = 0;
            return Math.min(holdW, newBatteryPowerW);
        }

        return newBatteryPowerW;
    }
}

module.exports = RelayProtection;
