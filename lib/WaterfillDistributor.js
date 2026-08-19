'use strict';

const HANDOVER_HOLD_CYCLES = 4;

/**
 * Optional multi-device distribution strategy using per-device limits,
 * state-of-charge weighting, and a sticky single-device mode.
 */
class WaterfillDistributor {
    constructor(adapter = null) {
        this.adapter = adapter;
        this.directionState = {
            charge: this.createDirectionState(),
            discharge: this.createDirectionState()
        };
    }

    createDirectionState() {
        return { mode: 'spread', activeDeviceId: null, previousDeviceId: null, holdCycles: 0, handoverHoldCycles: 0 };
    }

    distribute(totalPowerW, devices, config = {}) {
        if (!Array.isArray(devices) || devices.length === 0) {
            return [];
        }

        const requestedPowerW = Number(totalPowerW);
        if (!Number.isFinite(requestedPowerW) || requestedPowerW === 0) {
            return devices.map(device => this.createResult(device, 0, 'Waterfill standby'));
        }

        const charging = requestedPowerW < 0;
        const direction = charging ? 'charge' : 'discharge';
        const magnitudeW = Math.abs(requestedPowerW);
        const candidates = this.buildCandidates(devices, charging, config);

        if (candidates.length === 0) {
            this.resetDirection(direction);
            return devices.map(device => this.createResult(device, 0, 'Waterfill: no eligible device', true));
        }

        const state = this.directionState[direction];
        const spreadAboveW = this.toFiniteNumber(
            config[direction === 'charge' ? 'waterfillChargeSpreadAboveW' : 'waterfillDischargeSpreadAboveW'],
            1200
        );

        // A big power request always spreads across every eligible device, even
        // while a sticky-device handover is mid-blend - a single device pair
        // should never bottleneck a large request just because a handover
        // happens to be in progress.
        if (magnitudeW > spreadAboveW) {
            return this.enterSpread(direction, devices, candidates, magnitudeW, charging);
        }

        const handoverActive = state.handoverHoldCycles > 0 &&
            candidates.some(candidate => candidate.device.id === state.activeDeviceId);

        let active;
        if (handoverActive) {
            // Mid-blend: keep the frozen (previous, active) pair for the whole
            // hold window instead of re-evaluating candidates every cycle -
            // otherwise a third device briefly becoming "best" could hijack an
            // in-progress blend and drop the original outgoing device straight
            // to 0W instead of continuing its gradual ramp-down.
            state.handoverHoldCycles--;
            this.logDebug(`Waterfill handover hold active (${state.handoverHoldCycles} cycles remaining)`);
            active = candidates.find(candidate => candidate.device.id === state.activeDeviceId);
        } else {
            const mode = this.selectMode(state, magnitudeW, candidates, config, direction);
            if (mode !== 'single') {
                return this.enterSpread(direction, devices, candidates, magnitudeW, charging);
            }
            active = this.selectStickyDevice(state, candidates, config.waterfillSocMargin);
        }

        const previous = state.previousDeviceId && state.handoverHoldCycles > 0
            ? candidates.find(candidate => candidate.device.id === state.previousDeviceId)
            : null;

        if (previous && previous.device.id !== active.device.id) {
            // Blend power from the outgoing to the incoming device over the
            // handover hold window instead of switching instantly, so no single
            // device jumps between 0W and full power in one cycle.
            const blendFraction = 1 - (state.handoverHoldCycles / HANDOVER_HOLD_CYCLES);
            const activeAllocation = Math.min(magnitudeW * blendFraction, active.limitW);
            const previousAllocation = Math.min(magnitudeW * (1 - blendFraction), previous.limitW);
            if (state.handoverHoldCycles === 0) {
                state.previousDeviceId = null;
            }
            return this.createDistribution(devices, candidates, new Map([
                [active.device.id, activeAllocation],
                [previous.device.id, previousAllocation]
            ]), charging, 'Waterfill handover blend');
        }

        state.previousDeviceId = null;
        const allocation = Math.min(magnitudeW, active.limitW);
        return this.createDistribution(devices, candidates, new Map([[active.device.id, allocation]]), charging, 'Waterfill single device');
    }

    enterSpread(direction, devices, candidates, magnitudeW, charging) {
        const state = this.directionState[direction];
        state.mode = 'spread';
        state.activeDeviceId = null;
        state.previousDeviceId = null;
        state.handoverHoldCycles = 0;
        state.holdCycles = 0;
        const allocations = this.waterfill(magnitudeW, candidates);
        return this.createDistribution(devices, candidates, allocations, charging, 'Waterfill spread');
    }

    buildCandidates(devices, charging, config) {
        const minSoc = this.toFiniteNumber(config.minBatterySoc, 0);
        const maxSoc = this.toFiniteNumber(config.maxBatterySoc, 100);
        const voltageProtection = config.dischargeProtectionMode === 'voltage';

        return devices
            .map(device => {
                const soc = this.toFiniteNumber(device.soc, 0);
                const limitW = charging
                    ? this.toFiniteNumber(device.maxChargePowerW, 0)
                    : this.toFiniteNumber(device.maxDischargePowerW, 0);
                const allowed = charging
                    ? device.chargeAllowed !== false && soc < maxSoc
                    : device.dischargeAllowed !== false && (voltageProtection || soc > minSoc);
                const weight = charging
                    ? Math.max(0, maxSoc - soc)
                    : voltageProtection ? Math.max(0, soc) : Math.max(0, soc - minSoc);

                return { device, soc, limitW: Math.max(0, limitW), weight, allowed };
            })
            .filter(candidate => candidate.allowed && candidate.limitW > 0 && candidate.weight > 0);
    }

    selectMode(state, magnitudeW, candidates, config, direction) {
        // The caller already forces spread mode when magnitudeW exceeds the
        // configured spread-above threshold (checked once, before any
        // handover-hold framing) - this only needs to catch the case where
        // demand exceeds what the currently active single device can supply.
        const concentrateBelowW = this.toFiniteNumber(
            config[direction === 'charge' ? 'waterfillChargeConcentrateBelowW' : 'waterfillDischargeConcentrateBelowW'],
            600
        );
        const intervalMs = Math.max(1000, this.toFiniteNumber(config.updateIntervalSec, 5) * 1000);
        const holdMinutes = Math.max(0, this.toFiniteNumber(config.waterfillConcentrateHoldMinutes, 3));
        const holdCycles = Math.max(1, Math.round((holdMinutes * 60000) / intervalMs));
        const current = candidates.find(candidate => candidate.device.id === state.activeDeviceId);
        const currentLimitW = current ? current.limitW : 0;

        if (current && magnitudeW > currentLimitW) {
            state.mode = 'spread';
            state.holdCycles = 0;
            return state.mode;
        }

        if (magnitudeW < concentrateBelowW) {
            state.holdCycles++;
            if (state.holdCycles >= holdCycles) {
                state.mode = 'single';
                state.holdCycles = 0;
            }
            return state.mode;
        }

        return state.mode;
    }

    selectStickyDevice(state, candidates, marginW) {
        const current = candidates.find(candidate => candidate.device.id === state.activeDeviceId);
        const best = candidates.reduce((selected, candidate) => {
            return !selected || candidate.weight > selected.weight ? candidate : selected;
        }, null);

        if (!current) {
            // Previously active device dropped out of candidates entirely (e.g. hit
            // its SOC limit) rather than losing a graceful margin-based handover -
            // don't blend with a now-stale previous device.
            state.previousDeviceId = null;
            state.handoverHoldCycles = 0;
            state.activeDeviceId = best?.device.id ?? null;
            return best;
        }

        const margin = this.toFiniteNumber(marginW, 10);
        if (best && best.device.id !== current.device.id && best.weight >= current.weight + margin) {
            state.previousDeviceId = current.device.id;
            state.activeDeviceId = best.device.id;
            state.handoverHoldCycles = HANDOVER_HOLD_CYCLES;
            this.logDebug(
                `Waterfill handover: ${current.device.name} -> ${best.device.name}, ` +
                `holding single-device mode for ${HANDOVER_HOLD_CYCLES} cycles`
            );
            return best;
        }

        return current;
    }

    waterfill(targetW, candidates) {
        const allocations = new Map(candidates.map(candidate => [candidate.device.id, 0]));
        const remainingCapacity = new Map(candidates.map(candidate => [candidate.device.id, candidate.limitW]));
        let remainingW = targetW;
        let active = candidates.slice();

        while (remainingW > 0.0001 && active.length > 0) {
            const weightSum = active.reduce((sum, candidate) => sum + candidate.weight, 0);
            if (weightSum <= 0) break;

            let allocatedThisRound = 0;
            const nextActive = [];
            for (const candidate of active) {
                const desiredW = remainingW * candidate.weight / weightSum;
                const allocationW = Math.min(desiredW, remainingCapacity.get(candidate.device.id));
                allocations.set(candidate.device.id, allocations.get(candidate.device.id) + allocationW);
                remainingCapacity.set(candidate.device.id, remainingCapacity.get(candidate.device.id) - allocationW);
                allocatedThisRound += allocationW;

                if (remainingCapacity.get(candidate.device.id) > 0.0001) {
                    nextActive.push(candidate);
                }
            }

            if (allocatedThisRound <= 0.0001) break;
            remainingW -= allocatedThisRound;
            active = nextActive;
        }

        return this.roundAllocations(allocations, candidates, Math.round(targetW));
    }

    roundAllocations(allocations, candidates, targetW) {
        const rounded = new Map();
        let roundedSum = 0;

        for (const candidate of candidates) {
            const value = Math.min(candidate.limitW, allocations.get(candidate.device.id) || 0);
            const wholeW = Math.floor(value + 0.000001);
            rounded.set(candidate.device.id, wholeW);
            roundedSum += wholeW;
        }

        let remainingW = Math.max(0, Math.min(targetW, Math.round(
            candidates.reduce((sum, candidate) => sum + candidate.limitW, 0)
        )) - roundedSum);
        const byFraction = candidates.slice().sort((left, right) => {
            const leftFraction = (allocations.get(left.device.id) || 0) % 1;
            const rightFraction = (allocations.get(right.device.id) || 0) % 1;
            return rightFraction - leftFraction;
        });

        while (remainingW > 0) {
            let changed = false;
            for (const candidate of byFraction) {
                const currentW = rounded.get(candidate.device.id);
                if (currentW < Math.floor(candidate.limitW)) {
                    rounded.set(candidate.device.id, currentW + 1);
                    remainingW--;
                    changed = true;
                    if (remainingW === 0) break;
                }
            }
            if (!changed) break;
        }

        if (remainingW > 0) {
            this.logDebug(`Waterfill rounding left ${remainingW}W undistributed - all candidates already at their capped limit`);
        }

        return rounded;
    }

    createDistribution(devices, candidates, allocations, charging, reason) {
        const candidateIds = new Set(candidates.map(candidate => candidate.device.id));
        return devices.map(device => {
            const isCandidate = candidateIds.has(device.id);
            const allocationW = isCandidate ? allocations.get(device.id) || 0 : 0;
            const powerW = charging ? -Math.round(allocationW) : Math.round(allocationW);
            return isCandidate
                ? this.createResult(device, powerW, reason)
                : this.createResult(device, powerW, 'Waterfill: device not eligible', true);
        });
    }

    createResult(device, powerW, reason, excluded = false) {
        return {
            deviceId: device.id,
            deviceName: device.name,
            powerW,
            reason,
            excluded
        };
    }

    resetDirection(direction) {
        this.directionState[direction] = this.createDirectionState();
    }

    logDebug(message) {
        if (this.adapter?.log?.debug) {
            this.adapter.log.debug(message);
        }
    }

    toFiniteNumber(value, fallback) {
        const number = Number(value);
        return Number.isFinite(number) ? number : fallback;
    }
}

module.exports = WaterfillDistributor;
