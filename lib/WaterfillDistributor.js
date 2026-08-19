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
            charge: { mode: 'spread', activeDeviceId: null, holdCycles: 0, handoverHoldCycles: 0 },
            discharge: { mode: 'spread', activeDeviceId: null, holdCycles: 0, handoverHoldCycles: 0 }
        };
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
            return devices.map(device => this.createResult(device, 0, 'Waterfill: no eligible device'));
        }

        const state = this.directionState[direction];
        const handoverActive = state.handoverHoldCycles > 0 &&
            candidates.some(candidate => candidate.device.id === state.activeDeviceId);
        const mode = handoverActive
            ? this.consumeHandoverHold(state)
            : this.selectMode(state, magnitudeW, candidates, config, direction);

        if (mode === 'single') {
            const active = this.selectStickyDevice(state, candidates, config.waterfillSocMargin);
            if (active) {
                const allocation = Math.min(magnitudeW, active.limitW);
                return this.createDistribution(devices, candidates, new Map([[active.device.id, allocation]]), charging, 'Waterfill single device');
            }
        }

        state.mode = 'spread';
        state.activeDeviceId = null;
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
        const concentrateBelowW = this.toFiniteNumber(
            config[direction === 'charge' ? 'waterfillChargeConcentrateBelowW' : 'waterfillDischargeConcentrateBelowW'],
            600
        );
        const spreadAboveW = this.toFiniteNumber(
            config[direction === 'charge' ? 'waterfillChargeSpreadAboveW' : 'waterfillDischargeSpreadAboveW'],
            1200
        );
        const intervalMs = Math.max(1000, this.toFiniteNumber(config.updateIntervalSec, 5) * 1000);
        const holdMinutes = Math.max(0, this.toFiniteNumber(config.waterfillConcentrateHoldMinutes, 3));
        const holdCycles = Math.max(1, Math.round((holdMinutes * 60000) / intervalMs));
        const current = candidates.find(candidate => candidate.device.id === state.activeDeviceId);
        const currentLimitW = current ? current.limitW : 0;

        if (magnitudeW > spreadAboveW || (current && magnitudeW > currentLimitW)) {
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
            state.activeDeviceId = best?.device.id ?? null;
            return best;
        }

        const margin = this.toFiniteNumber(marginW, 10);
        if (best && best.device.id !== current.device.id && best.weight >= current.weight + margin) {
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

        return rounded;
    }

    createDistribution(devices, candidates, allocations, charging, reason) {
        const candidateIds = new Set(candidates.map(candidate => candidate.device.id));
        return devices.map(device => {
            const allocationW = candidateIds.has(device.id) ? allocations.get(device.id) || 0 : 0;
            const powerW = charging ? -Math.round(allocationW) : Math.round(allocationW);
            return this.createResult(device, powerW, reason);
        });
    }

    createResult(device, powerW, reason) {
        return {
            deviceId: device.id,
            deviceName: device.name,
            powerW,
            reason,
            excluded: false
        };
    }

    resetDirection(direction) {
        this.directionState[direction] = {
            mode: 'spread',
            activeDeviceId: null,
            holdCycles: 0,
            handoverHoldCycles: 0
        };
    }

    consumeHandoverHold(state) {
        state.handoverHoldCycles--;
        this.logDebug(`Waterfill handover hold active (${state.handoverHoldCycles} cycles remaining)`);
        return 'single';
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
