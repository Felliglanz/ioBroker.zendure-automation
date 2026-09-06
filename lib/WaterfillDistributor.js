'use strict';

const { computeEffectiveChargeLimitW } = require('./pvChargeLimit');

const HANDOVER_HOLD_CYCLES = 4;
const MODE_TRANSITION_HOLD_CYCLES = 4;

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
        return {
            mode: 'spread',
            activeDeviceId: null,
            // Device IDs currently being blended away from. A plain sticky-device
            // swap has exactly one; a spread -> single collapse can have several.
            previousDeviceIds: null,
            holdCycles: 0,
            handoverHoldCycles: 0,
            handoverTotalCycles: 0,
            // What was actually written last cycle (any mode) - the source snapshot
            // for starting a blend away from spread when concentrating.
            lastAllocation: null,
            // The incoming device's own allocation at the moment the current blend
            // began - 0 for a plain sticky-device handover (it wasn't running
            // before), but non-zero when concentrating out of spread mode, since
            // that device may already have been carrying part of the load.
            blendStartActiveW: 0,
            // Mirrors the previous four fields, but for the opposite transition:
            // single -> spread. The device that was already running (the
            // "anchor") has no ramp-up delay, unlike the device(s) joining it
            // from idle (relay closing, inverter start - issue #40), so it keeps
            // covering as much of the load as it can while the join is blended
            // in over expandTotalCycles.
            expandAnchorId: null,
            expandAnchorStartW: 0,
            expandHoldCycles: 0,
            expandTotalCycles: 0
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
            state.holdCycles = 0;
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
            // Snapshot what spread mode actually wrote last cycle *before*
            // selectMode/selectStickyDevice can change state.mode - this is the
            // source a spread -> single collapse blends away from. Null on a cold
            // start (nothing real has ever been written yet), which deliberately
            // skips the blend below and goes straight to single, same as before.
            const previousSpreadAllocation = state.mode === 'spread' ? state.lastAllocation : null;
            const mode = this.selectMode(state, magnitudeW, candidates, config, direction);
            if (mode !== 'single') {
                return this.enterSpread(direction, devices, candidates, magnitudeW, charging);
            }
            active = this.selectStickyDevice(state, candidates, config.waterfillSocMargin, previousSpreadAllocation);
        }

        const previousCandidates = state.previousDeviceIds && state.handoverHoldCycles > 0
            ? candidates.filter(candidate =>
                state.previousDeviceIds.has(candidate.device.id) && candidate.device.id !== active.device.id)
            : [];

        if (previousCandidates.length > 0) {
            // Blend power away from the outgoing device(s) and onto the incoming
            // single device over the hold window instead of switching instantly.
            // Covers both a plain device-to-device sticky swap (one outgoing
            // device, HANDOVER_HOLD_CYCLES) and a spread -> single collapse
            // (several outgoing devices, the shorter MODE_TRANSITION_HOLD_CYCLES).
            //
            // The incoming device is interpolated from what it actually carried
            // the moment the blend began (state.blendStartActiveW - 0 for a plain
            // handover, since that device wasn't running before) towards its
            // current target, instead of always assuming a 0W start. Assuming 0
            // unconditionally was fine for a 1:1 handover but wrong for a spread
            // collapse, where the incoming device may already have had a real
            // share of the load - it would otherwise be dropped to 0W and back up
            // again, a bigger jump than no blend at all. The outgoing side then
            // just gets whatever's left, split by the same SOC weights waterfill()
            // already uses, so the total never exceeds magnitudeW.
            const blendFraction = 1 - (state.handoverHoldCycles / state.handoverTotalCycles);
            const activeTargetW = Math.min(magnitudeW, active.limitW);
            // Also capped to magnitudeW itself, not just the device limit: if
            // demand drops sharply in the very cycle a blend starts (rare, but
            // possible - e.g. a spread cycle handing off right as the load
            // collapses), blendStartActiveW can already exceed the new, lower
            // magnitudeW. Without this cap the active device would be asked for
            // more power than was actually requested this cycle.
            const activeAllocationW = Math.max(0, Math.min(
                state.blendStartActiveW + (activeTargetW - state.blendStartActiveW) * blendFraction,
                active.limitW,
                magnitudeW
            ));
            const previousPortionW = Math.max(0, magnitudeW - activeAllocationW);
            const allocations = this.waterfill(previousPortionW, previousCandidates);
            allocations.set(active.device.id, activeAllocationW);
            if (state.handoverHoldCycles === 0) {
                state.previousDeviceIds = null;
            }
            state.lastAllocation = allocations;
            return this.createDistribution(devices, candidates, allocations, charging,
                previousCandidates.length === 1 ? 'Waterfill handover blend' : 'Waterfill mode-transition blend');
        }

        state.previousDeviceIds = null;
        const allocation = Math.min(magnitudeW, active.limitW);
        const allocations = new Map([[active.device.id, allocation]]);
        state.lastAllocation = allocations;
        return this.createDistribution(devices, candidates, allocations, charging, 'Waterfill single device');
    }

    enterSpread(direction, devices, candidates, magnitudeW, charging) {
        // Deliberately does not touch state.holdCycles here: this is also the
        // return path for "still counting up towards single mode, threshold not
        // reached yet" (mode stays 'spread' while holdCycles accumulates across
        // calls in selectMode). Resetting it unconditionally on every one of
        // those cycles would make the concentrate-hold threshold unreachable -
        // callers that need a genuine reset (magnitude spike, active device
        // overloaded) already do it themselves before calling in.
        const state = this.directionState[direction];

        // A device already running in single mode has no ramp-up delay; a
        // device about to join it from idle does (relay closing, inverter
        // start - issue #40). Without this, a sudden jump above spreadAboveW
        // instantly commits both devices to their final SOC-weighted split,
        // but the joining device can't actually deliver its share for a
        // cycle or two - the I-Regulator sees the shortfall as grid error and
        // overcorrects, then overshoots once the joiner catches up. Blending
        // the join in over MODE_TRANSITION_HOLD_CYCLES (mirrors the existing
        // spread -> single concentrate blend, just the opposite direction)
        // lets the anchor keep covering the load meanwhile instead.
        // Only recognized on the cycle we're still genuinely in single mode -
        // state.mode is flipped to 'spread' below, so later calls (the
        // ongoing blend itself, or "still above spreadAboveW" continuation)
        // take the continuingExpand branch instead.
        const continuingExpand = state.expandHoldCycles > 0 &&
            candidates.some(candidate => candidate.device.id === state.expandAnchorId);
        const startingExpand = !continuingExpand && state.mode === 'single' && state.activeDeviceId &&
            candidates.some(candidate => candidate.device.id === state.activeDeviceId);

        if (startingExpand) {
            const anchor = candidates.find(candidate => candidate.device.id === state.activeDeviceId);
            state.expandAnchorId = anchor.device.id;
            state.expandAnchorStartW = Math.min(magnitudeW, anchor.limitW);
            state.expandHoldCycles = MODE_TRANSITION_HOLD_CYCLES;
            state.expandTotalCycles = MODE_TRANSITION_HOLD_CYCLES;
            this.logDebug(
                `Waterfill expanding from single (${anchor.device.name}) into spread, holding a ` +
                `${MODE_TRANSITION_HOLD_CYCLES}-cycle ramp-in for the joining device(s)`
            );
        }

        state.mode = 'spread';
        state.activeDeviceId = null;
        state.previousDeviceIds = null;
        state.handoverHoldCycles = 0;
        state.handoverTotalCycles = 0;
        state.blendStartActiveW = 0;

        const targetAllocations = this.waterfill(magnitudeW, candidates);
        const expanding = state.expandHoldCycles > 0 &&
            candidates.some(candidate => candidate.device.id === state.expandAnchorId);

        if (!expanding) {
            state.expandAnchorId = null;
            state.lastAllocation = targetAllocations;
            return this.createDistribution(devices, candidates, targetAllocations, charging, 'Waterfill spread');
        }

        // Not decremented on the cycle that just started the blend above -
        // that cycle should still report blendFraction 0 (anchor holds its
        // captured start value, joiner(s) get whatever's left).
        if (continuingExpand) {
            state.expandHoldCycles--;
        }

        const anchorId = state.expandAnchorId;
        const anchorTargetW = targetAllocations.get(anchorId) || 0;
        const blendFraction = 1 - (state.expandHoldCycles / state.expandTotalCycles);
        const anchorAllocationW = Math.max(0, Math.min(
            state.expandAnchorStartW + (anchorTargetW - state.expandAnchorStartW) * blendFraction,
            magnitudeW
        ));
        const remainingCandidates = candidates.filter(candidate => candidate.device.id !== anchorId);
        const remainingPortionW = Math.max(0, magnitudeW - anchorAllocationW);
        const allocations = this.waterfill(remainingPortionW, remainingCandidates);
        allocations.set(anchorId, anchorAllocationW);

        if (state.expandHoldCycles <= 0) {
            state.expandAnchorId = null;
        }
        state.lastAllocation = allocations;
        return this.createDistribution(devices, candidates, allocations, charging, 'Waterfill spread (ramp-in)');
    }

    buildCandidates(devices, charging, config) {
        const minSoc = this.toFiniteNumber(config.minBatterySoc, 0);
        const maxSoc = this.toFiniteNumber(config.maxBatterySoc, 100);
        const voltageProtection = config.dischargeProtectionMode === 'voltage';

        return devices
            .map(device => {
                const soc = this.toFiniteNumber(device.soc, 0);
                const limitW = charging
                    ? computeEffectiveChargeLimitW(device)
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

    selectStickyDevice(state, candidates, marginW, previousSpreadAllocation) {
        const current = candidates.find(candidate => candidate.device.id === state.activeDeviceId);
        const best = candidates.reduce((selected, candidate) => {
            return !selected || candidate.weight > selected.weight ? candidate : selected;
        }, null);

        if (!current) {
            state.activeDeviceId = best?.device.id ?? null;

            const outgoingIds = previousSpreadAllocation
                ? [...previousSpreadAllocation.keys()].filter(id =>
                    id !== state.activeDeviceId && (previousSpreadAllocation.get(id) || 0) > 0)
                : [];

            if (best && outgoingIds.length > 0) {
                // Just concentrated out of spread mode: blend power away from
                // whatever was actually running last cycle onto the new single
                // device, instead of cutting every other device to 0W in one step.
                // The incoming device keeps its own real previous share as the
                // blend's starting point (see distribute()) rather than being
                // assumed to start at 0 - it may already have been running too.
                state.previousDeviceIds = new Set(outgoingIds);
                state.handoverHoldCycles = MODE_TRANSITION_HOLD_CYCLES;
                state.handoverTotalCycles = MODE_TRANSITION_HOLD_CYCLES;
                state.blendStartActiveW = previousSpreadAllocation.get(state.activeDeviceId) || 0;
                this.logDebug(
                    `Waterfill concentrating onto ${best.device.name}, holding a ` +
                    `${MODE_TRANSITION_HOLD_CYCLES}-cycle mode-transition blend`
                );
            } else {
                // Cold start (nothing written yet), or the previously active device
                // dropped out of candidates entirely (e.g. hit its SOC limit) rather
                // than losing a graceful margin-based handover - nothing real to
                // blend away from.
                state.previousDeviceIds = null;
                state.handoverHoldCycles = 0;
                state.handoverTotalCycles = 0;
                state.blendStartActiveW = 0;
            }
            return best;
        }

        const margin = this.toFiniteNumber(marginW, 10);
        if (best && best.device.id !== current.device.id && best.weight >= current.weight + margin) {
            state.previousDeviceIds = new Set([current.device.id]);
            state.activeDeviceId = best.device.id;
            state.handoverHoldCycles = HANDOVER_HOLD_CYCLES;
            state.handoverTotalCycles = HANDOVER_HOLD_CYCLES;
            // The incoming device is a genuine newcomer - it wasn't running
            // before, so its blend starts at 0W same as always.
            state.blendStartActiveW = 0;
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
            // A candidate not present in this cycle's allocations map (e.g. the resting
            // side of sticky single-device mode - only the active device gets an entry)
            // isn't a transient dip, it's structurally parked for the foreseeable future.
            // It must be flagged excluded so MultiDeviceManager writes a literal 0W and
            // bypasses zero-setpoint avoidance the same way genuinely-ineligible devices
            // do (#28) - otherwise it gets rearmed with a keep-alive and disarmed again
            // every smartModeIdleTimeoutSec, chattering its relay for no reason.
            const isAllocated = isCandidate && allocations.has(device.id);
            const allocationW = isAllocated ? allocations.get(device.id) || 0 : 0;
            const powerW = charging ? -Math.round(allocationW) : Math.round(allocationW);
            if (!isCandidate) {
                return this.createResult(device, powerW, 'Waterfill: device not eligible', true);
            }
            if (!isAllocated) {
                return this.createResult(device, powerW, 'Waterfill: single-device mode, resting', true);
            }
            return this.createResult(device, powerW, reason);
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
