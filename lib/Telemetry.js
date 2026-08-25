'use strict';

/**
 * Telemetry Module
 *
 * Accumulates simple, self-contained daily counters/energy totals into
 * telemetry.* states - no external history/statistics adapter dependency.
 * Everything is kept in memory and persisted to states each cycle so it
 * survives adapter restarts; counters reset automatically at local midnight.
 *
 * Deliberately not a PV/energy dashboard - just a handful of "how was my
 * day" numbers meant to be extended later.
 */

const SIGN_TOLERANCE_W = 5; // treat |power| below this as "no flow" for switch detection
const MAX_TICK_HOURS = 0.25; // cap energy integration per call (guards against long adapter downtime)
const HISTORY_SAMPLE_MS = 5 * 60 * 1000; // one power snapshot every 5min, for the dashboard's rolling graphs
const HISTORY_MAX_POINTS = 300; // ~1 day at the sample rate above; also a hard cap if midnight rollover is ever missed (e.g. clock jump)

class Telemetry {
    constructor(adapter) {
        this.adapter = adapter;

        this.today = null;
        this.gridImportWh = 0;
        this.gridExportWh = 0;
        this.pvWh = 0;
        this.batteryChargeWh = 0;
        this.batteryDischargeWh = 0;
        this.modeSwitches = 0;
        this.emergencyEvents = 0;
        this.history = []; // [{t, houseW, gridW, pvW, batteryW}, ...], same-day only

        this._lastTickMs = null;
        this._lastHistorySampleMs = null;
        this._prevBatterySign = 0; // -1 charging, 0 unknown/standby, 1 discharging
        this._prevEmergencyActive = false;
    }

    static _todayKey(date = new Date()) {
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }

    async _readNumber(id) {
        const state = await this.adapter.getStateAsync(id);
        const value = Number(state?.val);
        return Number.isFinite(value) ? value : 0;
    }

    /**
     * Hydrate today's totals from persisted states (adapter restart within the same day),
     * or start fresh if this is a new day.
     */
    async init() {
        const todayKey = Telemetry._todayKey();
        const lastResetState = await this.adapter.getStateAsync('telemetry.lastResetDay');

        if (lastResetState && lastResetState.val === todayKey) {
            this.today = todayKey;
            this.gridImportWh = await this._readNumber('telemetry.gridImportWhToday');
            this.gridExportWh = await this._readNumber('telemetry.gridExportWhToday');
            this.pvWh = await this._readNumber('telemetry.pvWhToday');
            this.batteryChargeWh = await this._readNumber('telemetry.batteryChargeWhToday');
            this.batteryDischargeWh = await this._readNumber('telemetry.batteryDischargeWhToday');
            this.modeSwitches = await this._readNumber('telemetry.modeSwitchesToday');
            this.emergencyEvents = await this._readNumber('telemetry.emergencyEventsToday');
            this.history = await this._readHistory();
        } else {
            this.today = todayKey;
            await this._resetCounters();
            await this._persistAll();
        }

        this._lastTickMs = Date.now();
    }

    async _resetCounters() {
        this.gridImportWh = 0;
        this.gridExportWh = 0;
        this.pvWh = 0;
        this.batteryChargeWh = 0;
        this.batteryDischargeWh = 0;
        this.modeSwitches = 0;
        this.emergencyEvents = 0;
        this.history = [];
        this._lastHistorySampleMs = null;
    }

    async _readHistory() {
        const state = await this.adapter.getStateAsync('telemetry.historyJson');
        if (!state || typeof state.val !== 'string') return [];
        try {
            const parsed = JSON.parse(state.val);
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    }

    async _checkMidnightRollover() {
        const todayKey = Telemetry._todayKey();
        if (todayKey === this.today) return;

        this.today = todayKey;
        await this._resetCounters();
        await this._persistAll();
    }

    async _persistAll() {
        await this.adapter.setStateAsync('telemetry.lastResetDay', this.today, true);
        await this.adapter.setStateAsync('telemetry.gridImportWhToday', Math.round(this.gridImportWh), true);
        await this.adapter.setStateAsync('telemetry.gridExportWhToday', Math.round(this.gridExportWh), true);
        await this.adapter.setStateAsync('telemetry.pvWhToday', Math.round(this.pvWh), true);
        await this.adapter.setStateAsync('telemetry.batteryChargeWhToday', Math.round(this.batteryChargeWh), true);
        await this.adapter.setStateAsync('telemetry.batteryDischargeWhToday', Math.round(this.batteryDischargeWh), true);
        await this.adapter.setStateAsync('telemetry.modeSwitchesToday', this.modeSwitches, true);
        await this.adapter.setStateAsync('telemetry.emergencyEventsToday', this.emergencyEvents, true);
        await this.adapter.setStateAsync('telemetry.historyJson', JSON.stringify(this.history), true);
    }

    /**
     * Record one control-loop cycle. Call this once per automation tick (normal cycle
     * or override mode) with the values that were just written to the status.* states.
     *
     * @param {object} params
     * @param {number|null} params.gridPowerW - Grid power (positive = import, negative = export/feed-in)
     * @param {number|null} params.batteryPowerW - Measured battery power (negative = charging, positive = discharging)
     * @param {number|null} params.pvPowerW - PV production power in W, or null if not configured
     * @param {number|null} params.houseW - House consumption power in W, or null if not configured
     * @param {boolean} params.emergencyActive - Whether emergency mode is currently active
     */
    async recordCycle({ gridPowerW, batteryPowerW, pvPowerW, houseW, emergencyActive }) {
        await this._checkMidnightRollover();

        const nowMs = Date.now();
        const dtHours = this._lastTickMs !== null ? (nowMs - this._lastTickMs) / 3_600_000 : 0;
        this._lastTickMs = nowMs;
        const safeDtHours = Math.max(0, Math.min(dtHours, MAX_TICK_HOURS));

        if (safeDtHours > 0 && typeof gridPowerW === 'number' && Number.isFinite(gridPowerW)) {
            if (gridPowerW > 0) {
                this.gridImportWh += gridPowerW * safeDtHours;
            } else if (gridPowerW < 0) {
                this.gridExportWh += -gridPowerW * safeDtHours;
            }
        }

        if (safeDtHours > 0 && typeof pvPowerW === 'number' && Number.isFinite(pvPowerW) && pvPowerW > 0) {
            this.pvWh += pvPowerW * safeDtHours;
        }

        if (typeof batteryPowerW === 'number' && Number.isFinite(batteryPowerW)) {
            if (safeDtHours > 0) {
                if (batteryPowerW < 0) {
                    this.batteryChargeWh += -batteryPowerW * safeDtHours;
                } else if (batteryPowerW > 0) {
                    this.batteryDischargeWh += batteryPowerW * safeDtHours;
                }
            }

            // Real relay switch: measured battery power actually flipped direction.
            // Readings near 0W (relay protection dwelling before the flip) are ignored
            // rather than treated as "standby", so the switch is counted exactly once
            // when the new direction is confirmed - not once per zero-crossing blip.
            const sign = batteryPowerW > SIGN_TOLERANCE_W ? 1 : (batteryPowerW < -SIGN_TOLERANCE_W ? -1 : 0);
            if (sign !== 0) {
                if (this._prevBatterySign !== 0 && sign !== this._prevBatterySign) {
                    this.modeSwitches++;
                }
                this._prevBatterySign = sign;
            }
        }

        if (emergencyActive && !this._prevEmergencyActive) {
            this.emergencyEvents++;
        }
        this._prevEmergencyActive = !!emergencyActive;

        if (this._lastHistorySampleMs === null || nowMs - this._lastHistorySampleMs >= HISTORY_SAMPLE_MS) {
            this._lastHistorySampleMs = nowMs;
            this.history.push({
                t: nowMs,
                houseW: Number.isFinite(houseW) ? Math.round(houseW) : null,
                gridW: Number.isFinite(gridPowerW) ? Math.round(gridPowerW) : null,
                pvW: Number.isFinite(pvPowerW) ? Math.round(pvPowerW) : null,
                batteryW: Number.isFinite(batteryPowerW) ? Math.round(batteryPowerW) : null
            });
            if (this.history.length > HISTORY_MAX_POINTS) this.history.shift();
        }

        await this._persistAll();
    }
}

module.exports = Telemetry;
