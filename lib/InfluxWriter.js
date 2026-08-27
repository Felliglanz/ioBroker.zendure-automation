'use strict';

// telemetry.* states never written to Influx - internal bookkeeping / display-only, not
// measurement data: historyJson duplicates what Influx itself now stores, lastResetDay is
// just day-rollover bookkeeping for the in-memory counters.
const TELEMETRY_EXCLUDE_LEAVES = new Set(['historyJson', 'lastResetDay']);

// status.* leaves never written to Influx: lastUpdate is redundant (every point already carries
// its own timestamp), the three *Counter fields are RelayProtection's internal debounce tick
// counters (delay-tick countdowns, not measurement data) - meaningless outside that state machine.
const STATUS_EXCLUDE_LEAVES = new Set(['lastUpdate', 'feedInCounter', 'dischargeCounter', 'deadbandCounter']);

// Single-device-mode-only leaves directly under status.* that describe the one configured
// battery - the exact same data multi-device mode keeps under status.devices.<id>.*. Tagging
// these with the device id in single mode too keeps the Influx schema identical across modes.
// Leaves not listed here (mode, gridPowerW, emergencyReason) stay global/untagged by default -
// see the fallback in _collectStatus().
const SINGLE_DEVICE_IDENTITY_LEAVES = new Set([
    'currentPowerW', 'batterySoc', 'minPackVoltageV', 'emergencyRecoveryActive',
    'voltageRecoveryActive', 'socRecoveryActive', 'minSocRecoveryActive',
    'maxSocRecoveryActive', 'effectiveMinSoc'
]);

// Renames applied when a single-device-mode leaf differs from its multi-device counterpart's
// field name, so both modes end up writing the same field key for the same physical value.
const SINGLE_DEVICE_FIELD_RENAME = { currentPowerW: 'powerW', batterySoc: 'soc' };

const WRITE_TIMEOUT_MS = 10000;

/**
 * Periodically snapshots telemetry.* / status.* states and writes them to an InfluxDB v2
 * bucket as line protocol. Deliberately minimal: one measurement, plain periodic snapshots
 * (no per-change writes), no query/read path - retention, downsampling etc. are Influx's job,
 * not the adapter's.
 */
class InfluxWriter {
    /**
     * @param {object} adapter ioBroker adapter instance
     * @param {object} options
     * @param {string} options.url Influx base URL, e.g. "http://192.168.1.10:8086"
     * @param {string} options.token API token
     * @param {string} options.org Organization
     * @param {string} options.bucket Bucket
     * @param {string} options.measurement Measurement name all fields are written under
     * @param {number} options.intervalSec Write interval in seconds
     * @param {boolean} options.includeTelemetry Write telemetry.* states
     * @param {boolean} options.includeStatus Write status.* states
     * @param {string|null} options.singleDeviceId Stable device id (deviceStateId(deviceKey)) in
     *   single-device mode, so battery-identity fields can be tagged consistently with multi-device
     *   mode; null in multi-device mode (device ids there come from status.devices.<id>.* itself)
     */
    constructor(adapter, options) {
        this.adapter = adapter;
        this.url = options.url.replace(/\/+$/, '');
        this.token = options.token;
        this.org = options.org;
        this.bucket = options.bucket;
        this.measurement = options.measurement;
        this.intervalSec = options.intervalSec;
        this.includeTelemetry = options.includeTelemetry;
        this.includeStatus = options.includeStatus;
        this.singleDeviceId = options.singleDeviceId || null;

        this._timer = null;
        this._consecutiveFailures = 0;
    }

    start() {
        this._writeCycle().catch(err => this._logFailure(err));
        this._timer = this.adapter.setInterval(() => {
            this._writeCycle().catch(err => this._logFailure(err));
        }, this.intervalSec * 1000);
    }

    stop() {
        if (this._timer) {
            this.adapter.clearInterval(this._timer);
            this._timer = null;
        }
    }

    _logFailure(err) {
        this._consecutiveFailures += 1;
        // First failure loud, then throttle to debug so a persistently unreachable Influx
        // doesn't spam the ioBroker log every interval.
        if (this._consecutiveFailures === 1) {
            this.adapter.log.warn(`Influx write failed: ${err.message}`);
        } else {
            this.adapter.log.debug(`Influx write failed (${this._consecutiveFailures}x): ${err.message}`);
        }
    }

    async _writeCycle() {
        // tagSuffix ('' or ',device=<escaped id>') -> Map(field -> raw value)
        const points = new Map();
        const addField = (tagSuffix, field, value) => {
            if (value === null || value === undefined) return;
            let fields = points.get(tagSuffix);
            if (!fields) {
                fields = new Map();
                points.set(tagSuffix, fields);
            }
            fields.set(field, value);
        };

        if (this.includeTelemetry) {
            await this._collectTelemetry(addField);
        }
        if (this.includeStatus) {
            await this._collectStatus(addField);
        }

        const lines = [];
        for (const [tagSuffix, fields] of points) {
            const fieldStr = this._serializeFields(fields);
            if (!fieldStr) continue;
            lines.push(`${this._escape(this.measurement)}${tagSuffix} ${fieldStr}`);
        }
        if (!lines.length) return;

        await this._send(lines.join('\n'));
        if (this._consecutiveFailures > 0) {
            this.adapter.log.info('Influx write recovered');
            this._consecutiveFailures = 0;
        }
    }

    async _collectTelemetry(addField) {
        const ns = `${this.adapter.namespace}.telemetry.`;
        const states = (await this.adapter.getStatesAsync('telemetry.*')) || {};

        for (const [fullId, state] of Object.entries(states)) {
            if (!state || !fullId.startsWith(ns)) continue;
            const leaf = fullId.slice(ns.length);
            if (TELEMETRY_EXCLUDE_LEAVES.has(leaf)) continue;
            addField('', leaf, state.val);
        }
    }

    async _collectStatus(addField) {
        const ns = `${this.adapter.namespace}.status.`;
        const states = (await this.adapter.getStatesAsync('status.*')) || {};

        for (const [fullId, state] of Object.entries(states)) {
            if (!state || !fullId.startsWith(ns)) continue;
            const rel = fullId.slice(ns.length); // e.g. "mode" or "devices.<id>.soc"

            if (rel.startsWith('devices.')) {
                const parts = rel.slice('devices.'.length).split('.');
                if (parts.length !== 2) continue; // unexpected nesting - ignore defensively
                const [deviceId, leaf] = parts;
                addField(`,device=${this._escape(deviceId)}`, leaf, state.val);
                continue;
            }

            if (STATUS_EXCLUDE_LEAVES.has(rel)) continue;

            if (this.singleDeviceId && SINGLE_DEVICE_IDENTITY_LEAVES.has(rel)) {
                const leaf = SINGLE_DEVICE_FIELD_RENAME[rel] || rel;
                addField(`,device=${this._escape(this.singleDeviceId)}`, leaf, state.val);
                continue;
            }

            addField('', rel, state.val);
        }
    }

    _serializeFields(fields) {
        const parts = [];
        for (const [key, rawVal] of fields) {
            const val = this._serializeFieldValue(rawVal);
            if (val === null) continue;
            parts.push(`${this._escape(key)}=${val}`);
        }
        return parts.join(',');
    }

    _serializeFieldValue(value) {
        if (typeof value === 'boolean') return value ? 'true' : 'false';
        if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
        if (typeof value === 'string') return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
        return null; // object/array/null - not a valid line protocol field value, skip
    }

    // Covers measurement names, tag keys/values and field keys - all forbid unescaped commas,
    // spaces and equals signs in InfluxDB line protocol.
    _escape(value) {
        return String(value).replace(/([,= ])/g, '\\$1');
    }

    async _send(body) {
        const url = `${this.url}/api/v2/write?${new URLSearchParams({ org: this.org, bucket: this.bucket })}`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), WRITE_TIMEOUT_MS);

        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: {
                    Authorization: `Token ${this.token}`,
                    'Content-Type': 'text/plain; charset=utf-8'
                },
                body,
                signal: controller.signal
            });

            if (!res.ok) {
                const text = await res.text().catch(() => '');
                throw new Error(`HTTP ${res.status} ${res.statusText}${text ? `: ${text.slice(0, 200)}` : ''}`);
            }
        } finally {
            clearTimeout(timeout);
        }
    }
}

module.exports = InfluxWriter;
