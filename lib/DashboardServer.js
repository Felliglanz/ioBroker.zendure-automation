'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { deviceStateId } = require('./deviceId');
const HousePower = require('./HousePower');

// Only these control.* keys may be written from the dashboard, with their expected type.
// Numbers are clamped to a sane range server-side before ever touching setStateAsync.
const CONTROL_WHITELIST = {
    enabled: { type: 'boolean' },
    enableCharge: { type: 'boolean' },
    enableDischarge: { type: 'boolean' },
    maxCharge: { type: 'boolean' },
    maxDischarge: { type: 'boolean' },
    targetGridPowerW: { type: 'number', min: -20000, max: 20000 },
    maxChargePowerW: { type: 'number', min: 0, max: 20000 },
    maxDischargePowerW: { type: 'number', min: 0, max: 20000 },
    maxBatterySoc: { type: 'number', min: 0, max: 100 },
    minBatterySoc: { type: 'number', min: 0, max: 100 },
    operatingDeadbandW: { type: 'number', min: 0, max: 5000 },
    regulatorGain: { type: 'number', min: 0.1, max: 1 }
};

// Per-device counterpart to CONTROL_WHITELIST, for control.devices.<id>.* (#24).
const DEVICE_CONTROL_WHITELIST = {
    maxChargePowerW: { type: 'number', min: 0, max: 20000 },
    maxDischargePowerW: { type: 'number', min: 0, max: 20000 },
    chargeAllowed: { type: 'boolean' },
    dischargeAllowed: { type: 'boolean' }
};

const STATUS_KEYS_SINGLE = ['status.mode', 'status.currentPowerW', 'status.gridPowerW', 'status.batterySoc', 'status.minPackVoltageV', 'status.emergencyReason', 'status.lastUpdate'];
const STATUS_KEYS_MULTI = ['status.mode', 'status.totalPowerW', 'status.gridPowerW', 'status.avgSoc', 'status.minPackVoltageV', 'status.emergencyReason', 'status.lastUpdate'];
const CONTROL_KEYS = Object.keys(CONTROL_WHITELIST).map(k => `control.${k}`);

const STATIC_FILES = {
    '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
    '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
    '/app.js': { file: 'app.js', type: 'application/javascript; charset=utf-8' },
    '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
    '/manifest.json': { file: 'manifest.json', type: 'application/manifest+json; charset=utf-8' },
    // Served from the root (not /icons/service-worker.js) so its default scope covers the whole
    // origin, matching the manifest's scope "/" - no Service-Worker-Allowed header needed.
    '/service-worker.js': { file: 'service-worker.js', type: 'application/javascript; charset=utf-8' },
    '/icons/icon-192.png': { file: 'icons/icon-192.png', type: 'image/png' },
    '/icons/icon-512.png': { file: 'icons/icon-512.png', type: 'image/png' },
    '/icons/apple-touch-icon.png': { file: 'icons/apple-touch-icon.png', type: 'image/png' }
};

const MAX_BODY_BYTES = 10 * 1024;

const INFLUX_QUERY_TIMEOUT_MS = 15000;
const INFLUX_FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const INFLUX_RELATIVE_RANGE_RE = /^-\d+[smhd]$/;
const INFLUX_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

// Fields InfluxWriter does export but the History picker hides: strings/booleans never render as
// a line (History.js's history/fields endpoint only draws numeric curves) - mode, emergencyReason,
// name and the *Active/available/excluded flags are unchartable by construction, not a curation
// choice. effectiveMinSoc/modeSwitchesToday/emergencyEventsToday are numeric but niche daily
// counters/near-static values, dropped to keep the picker focused on what people actually look at.
// Still queryable directly in Grafana/Influx - this only trims the built-in picker's list.
const HISTORY_PICKER_EXCLUDE_FIELDS = new Set([
    'mode', 'emergencyReason', 'name', 'available', 'excluded',
    'emergencyRecoveryActive', 'voltageRecoveryActive', 'socRecoveryActive',
    'minSocRecoveryActive', 'maxSocRecoveryActive', 'effectiveMinSoc',
    'modeSwitchesToday', 'emergencyEventsToday'
]);

/** Minimal parser for InfluxDB's "annotated CSV" query response - no dependency, but generic
 *  enough to not care about exact column order/presence or how many table blocks the response
 *  is split into (each restates its own header after a blank line). */
function parseInfluxCsv(text) {
    let header = null;
    const rows = [];

    for (const raw of text.split('\n')) {
        const line = raw.replace(/\r$/, '');
        if (line === '') { header = null; continue; }
        if (line.startsWith('#')) continue; // #group/#datatype/#default annotation line
        const cols = splitCsvLine(line);
        if (!header) { header = cols; continue; }

        const row = {};
        header.forEach((h, i) => { row[h] = cols[i]; });
        rows.push(row);
    }
    return rows;
}

function splitCsvLine(line) {
    const out = [];
    let cur = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQuotes) {
            if (ch === '"') {
                if (line[i + 1] === '"') { cur += '"'; i++; } else { inQuotes = false; }
            } else {
                cur += ch;
            }
        } else if (ch === '"') {
            inQuotes = true;
        } else if (ch === ',') {
            out.push(cur);
            cur = '';
        } else {
            cur += ch;
        }
    }
    out.push(cur);
    return out;
}

class DashboardServer {
    /**
     * @param {object} adapter ioBroker adapter instance
     */
    constructor(adapter) {
        this.adapter = adapter;
        this.server = null;
        this._wwwDir = path.join(__dirname, '..', 'www', 'dashboard');
        this._logoPath = path.join(__dirname, '..', 'admin', 'zendure-automation.png');
    }

    /**
     * @param {number} port
     */
    start(port) {
        return new Promise((resolve, reject) => {
            this.server = http.createServer((req, res) => {
                this._handleRequest(req, res).catch(err => {
                    this.adapter.log.error(`Dashboard request failed: ${err.message}`);
                    this._send(res, 500, 'text/plain', 'Internal error');
                });
            });

            this.server.once('error', err => {
                this.adapter.log.error(`Dashboard server could not start on port ${port}: ${err.message}`);
                reject(err);
            });

            this.server.listen(port, () => {
                this.adapter.log.info(`Dashboard listening on http://0.0.0.0:${port}/`);
                resolve();
            });
        });
    }

    stop() {
        return new Promise(resolve => {
            if (!this.server) return resolve();
            this.server.close(() => resolve());
            this.server = null;
        });
    }

    async _handleRequest(req, res) {
        const url = new URL(req.url, 'http://localhost');

        if (req.method === 'GET' && url.pathname === '/logo.png') {
            return this._sendFile(res, this._logoPath, 'image/png');
        }

        if (req.method === 'GET' && STATIC_FILES[url.pathname]) {
            const entry = STATIC_FILES[url.pathname];
            return this._sendFile(res, path.join(this._wwwDir, entry.file), entry.type);
        }

        if (req.method === 'GET' && url.pathname === '/api/status') {
            const status = await this._buildStatus();
            return this._send(res, 200, 'application/json', JSON.stringify(status));
        }

        if (req.method === 'POST' && url.pathname === '/api/control') {
            return this._handleControl(req, res);
        }

        if (req.method === 'POST' && url.pathname === '/api/device-control') {
            return this._handleDeviceControl(req, res);
        }

        if (req.method === 'GET' && url.pathname === '/api/battery/details') {
            return this._handleBatteryDetails(res, url.searchParams.get('device'));
        }

        if (req.method === 'GET' && url.pathname === '/api/telemetry') {
            return this._handleTelemetry(res);
        }

        if (req.method === 'GET' && url.pathname === '/api/telemetry/history') {
            return this._handleTelemetryHistory(res);
        }

        if (req.method === 'GET' && url.pathname === '/api/influx/enabled') {
            const cfg = this.adapter.config;
            return this._send(res, 200, 'application/json', JSON.stringify({
                enabled: cfg.influxEnabled === true && cfg.influxHistoryUiEnabled === true
            }));
        }

        if (req.method === 'GET' && url.pathname === '/api/influx/fields') {
            return this._handleInfluxFields(res);
        }

        if (req.method === 'GET' && url.pathname === '/api/influx/history') {
            return this._handleInfluxHistory(res, url.searchParams);
        }

        this._send(res, 404, 'text/plain', 'Not found');
    }

    /**
     * Resolves a device's base state path purely from trusted adapter config (never from the
     * request), matching how MultiDeviceManager builds device.basePath and device.id.
     * @param {string|null} deviceId only used to pick a device in multi-device mode
     */
    _resolveDeviceBasePath(deviceId) {
        const cfg = this.adapter.config;
        const instance = cfg.zendureSolarflowInstance || 'zendure-solarflow.0';

        if (cfg.multiDeviceEnabled === true) {
            const device = (cfg.devices || [])
                .filter(d => d.enabled && d.productKey && d.deviceKey)
                .find(d => deviceStateId(d.deviceKey) === deviceId);
            return device ? { basePath: `${instance}.${device.productKey}.${device.deviceKey}`, name: device.name || device.deviceKey } : null;
        }

        if (!cfg.deviceProductKey || !cfg.deviceKey) return null;
        return { basePath: `${instance}.${cfg.deviceProductKey}.${cfg.deviceKey}`, name: 'Battery' };
    }

    /**
     * All configured device base paths (one in single-device mode), for readings that need to
     * be summed across every physical Zendure unit.
     */
    _allDeviceBasePaths() {
        return HousePower.allDeviceBasePaths(this.adapter.config);
    }

    async _handleBatteryDetails(res, deviceId) {
        const resolved = this._resolveDeviceBasePath(deviceId);
        if (!resolved) {
            return this._send(res, 404, 'application/json', JSON.stringify({ error: 'Unknown device' }));
        }

        const packDataPath = `${resolved.basePath}.packData`;
        let rows;
        try {
            const view = await this.adapter.getObjectViewAsync('system', 'state', {
                startkey: `${packDataPath}.`,
                endkey: `${packDataPath}.\u9999`
            });
            rows = view.rows;
        } catch (err) {
            return this._send(res, 500, 'application/json', JSON.stringify({ error: err.message }));
        }

        // Discovers whatever fields the real zendure-solarflow device actually exposes per pack
        // (cell voltages, temperature, ...) instead of assuming a fixed schema.
        const packs = {};
        for (const row of rows) {
            const rel = row.id.slice(packDataPath.length + 1);
            const dotIdx = rel.indexOf('.');
            if (dotIdx === -1) continue;
            const index = rel.slice(0, dotIdx);
            const field = rel.slice(dotIdx + 1);
            const state = await this.adapter.getForeignStateAsync(row.id);
            packs[index] = packs[index] || {};
            packs[index][field] = state ? state.val : null;
        }

        this._send(res, 200, 'application/json', JSON.stringify({ name: resolved.name, packs }));
    }

    async _handleTelemetry(res) {
        const keys = [
            'gridImportWhToday',
            'gridExportWhToday',
            'pvWhToday',
            'batteryChargeWhToday',
            'batteryDischargeWhToday',
            'modeSwitchesToday',
            'emergencyEventsToday',
            'lastResetDay'
        ];

        const result = { pvEnabled: this.adapter.config.enablePvPower === true };
        for (const key of keys) {
            const state = await this.adapter.getStateAsync(`telemetry.${key}`);
            result[key] = state ? state.val : null;
        }

        this._send(res, 200, 'application/json', JSON.stringify(result));
    }

    /**
     * Same-day power history sampled by Telemetry (house/grid/PV/battery, ~5min resolution),
     * for the dashboard's rolling graphs. Cleared at local midnight along with the rest of
     * telemetry.* - the state simply won't exist yet right after a fresh install/restart.
     */
    async _handleTelemetryHistory(res) {
        const state = await this.adapter.getStateAsync('telemetry.historyJson');
        let points = [];
        if (state && typeof state.val === 'string') {
            try {
                points = JSON.parse(state.val);
            } catch {
                points = [];
            }
        }

        this._send(res, 200, 'application/json', JSON.stringify({
            pvEnabled: this.adapter.config.enablePvPower === true,
            houseEnabled: this.adapter.config.enableHousePower === true,
            points
        }));
    }

    /**
     * Read-only counterpart to InfluxWriter: queries the same bucket/measurement back out via
     * Flux for the dashboard's History view. Server-side only - the Influx token never reaches
     * the browser. Kept dependency-free like InfluxWriter (hand-rolled query + a minimal parser
     * for Influx's own "annotated CSV" response format, since /api/v2/query only speaks CSV).
     */
    _influxConfigured() {
        const cfg = this.adapter.config;
        return cfg.influxEnabled === true && cfg.influxHistoryUiEnabled === true &&
            !!(cfg.influxUrl && cfg.influxToken && cfg.influxOrg && cfg.influxBucket && cfg.influxMeasurement);
    }

    async _queryInflux(flux) {
        const cfg = this.adapter.config;
        const url = `${cfg.influxUrl.replace(/\/+$/, '')}/api/v2/query?${new URLSearchParams({ org: cfg.influxOrg })}`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), INFLUX_QUERY_TIMEOUT_MS);

        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: {
                    Authorization: `Token ${cfg.influxToken}`,
                    'Content-Type': 'application/vnd.flux',
                    Accept: 'application/csv'
                },
                body: flux,
                signal: controller.signal
            });
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 300)}` : ''}`);
            }
            return await res.text();
        } finally {
            clearTimeout(timeout);
        }
    }

    async _handleInfluxFields(res) {
        if (!this._influxConfigured()) {
            return this._send(res, 400, 'application/json', JSON.stringify({ error: 'Influx history not configured' }));
        }

        const cfg = this.adapter.config;
        const measurement = cfg.influxMeasurement.replace(/"/g, '\\"');
        const bucket = cfg.influxBucket.replace(/"/g, '\\"');
        const flux = `import "influxdata/influxdb/schema"
schema.fieldKeys(bucket: "${bucket}", predicate: (r) => r._measurement == "${measurement}", start: -90d)`;

        try {
            const rows = parseInfluxCsv(await this._queryInflux(flux));
            const fields = [...new Set(rows.map(r => r._value).filter(Boolean))]
                .filter(f => !HISTORY_PICKER_EXCLUDE_FIELDS.has(f))
                .sort();
            this._send(res, 200, 'application/json', JSON.stringify({ fields }));
        } catch (err) {
            this._send(res, 502, 'application/json', JSON.stringify({ error: err.message }));
        }
    }

    async _handleInfluxHistory(res, params) {
        if (!this._influxConfigured()) {
            return this._send(res, 400, 'application/json', JSON.stringify({ error: 'Influx history not configured' }));
        }

        const fields = (params.get('fields') || '').split(',').map(f => f.trim()).filter(Boolean);
        if (!fields.length || fields.length > 2 || !fields.every(f => INFLUX_FIELD_RE.test(f))) {
            return this._send(res, 400, 'application/json', JSON.stringify({ error: 'Invalid fields (pick 1-2)' }));
        }

        const start = params.get('start') || '-24h';
        const stop = params.get('stop') || 'now()';
        const startIsIso = INFLUX_ISO_RE.test(start);
        const stopIsIso = INFLUX_ISO_RE.test(stop);
        if (!(startIsIso || INFLUX_RELATIVE_RANGE_RE.test(start)) || !(stopIsIso || stop === 'now()')) {
            return this._send(res, 400, 'application/json', JSON.stringify({ error: 'Invalid time range' }));
        }

        const cfg = this.adapter.config;
        const measurement = cfg.influxMeasurement.replace(/"/g, '\\"');
        const bucket = cfg.influxBucket.replace(/"/g, '\\"');
        const fieldFilter = fields.map(f => `r._field == "${f}"`).join(' or ');
        const startExpr = startIsIso ? `time(v: "${start}")` : start;
        const stopExpr = stopIsIso ? `time(v: "${stop}")` : 'now()';

        const flux = `from(bucket: "${bucket}")
  |> range(start: ${startExpr}, stop: ${stopExpr})
  |> filter(fn: (r) => r._measurement == "${measurement}")
  |> filter(fn: (r) => ${fieldFilter})
  |> map(fn: (r) => ({ _time: r._time, _field: r._field, _value: r._value, device: if exists r.device then r.device else "" }))
  |> keep(columns: ["_time","_field","_value","device"])`;

        try {
            const rows = parseInfluxCsv(await this._queryInflux(flux));

            // Keyed by "field" (no device tag) or "field@device" (tagged) - the frontend renders
            // one line per key, so a field with multiple devices overlays automatically without
            // needing its own device picker. Non-numeric fields (strings/booleans) end up empty -
            // only line-chartable data is meaningful here, filtered out rather than errored.
            const series = {};
            for (const row of rows) {
                if (!row._time || row._value === undefined || row._value === '') continue;
                const v = Number(row._value);
                if (!Number.isFinite(v)) continue;
                const t = Date.parse(row._time);
                if (!Number.isFinite(t)) continue;
                const key = row.device ? `${row._field}@${row.device}` : row._field;
                (series[key] = series[key] || []).push({ t, v });
            }
            for (const key of Object.keys(series)) series[key].sort((a, b) => a.t - b.t);

            this._send(res, 200, 'application/json', JSON.stringify({ series }));
        } catch (err) {
            this._send(res, 502, 'application/json', JSON.stringify({ error: err.message }));
        }
    }

    async _buildStatus() {
        const cfg = this.adapter.config;
        const isMulti = cfg.multiDeviceEnabled === true;
        const statusKeys = isMulti ? STATUS_KEYS_MULTI : STATUS_KEYS_SINGLE;

        const result = {
            multiDevice: isMulti,
            multiDeviceDistributionStrategy: cfg.multiDeviceDistributionStrategy || 'equalSplit',
            status: {},
            control: {},
            devices: []
        };

        for (const key of statusKeys) {
            const st = await this.adapter.getStateAsync(key);
            result.status[key.slice('status.'.length)] = st ? st.val : null;
        }

        for (const key of CONTROL_KEYS) {
            const st = await this.adapter.getStateAsync(key);
            result.control[key.slice('control.'.length)] = st ? st.val : null;
        }

        if (isMulti) {
            const deviceStates = (await this.adapter.getStatesAsync('status.devices.*')) || {};
            const ns = `${this.adapter.namespace}.status.devices.`;
            const devices = {};

            for (const [fullId, state] of Object.entries(deviceStates)) {
                if (!fullId.startsWith(ns)) continue;
                const rel = fullId.slice(ns.length);
                const dotIdx = rel.indexOf('.');
                if (dotIdx === -1) continue;
                const id = rel.slice(0, dotIdx);
                const prop = rel.slice(dotIdx + 1);
                devices[id] = devices[id] || { id };
                devices[id][prop] = state ? state.val : null;
            }

            // Overlay each device's effective Waterfill limits - the live control.devices.<id>.*
            // override if the user set one this session, else the static admin-config value -
            // matching MultiDeviceManager.refreshEffectiveDeviceConfig() (see #22, #23).
            const configuredDevices = (cfg.devices || []).filter(d => d.enabled && d.productKey && d.deviceKey);
            for (const cfgDevice of configuredDevices) {
                const id = deviceStateId(cfgDevice.deviceKey);
                const dev = devices[id];
                if (!dev) continue;
                dev.maxChargePowerW = await this._effectiveDeviceValue(id, 'maxChargePowerW', Number(cfgDevice.maxChargePowerW) || 0);
                dev.maxDischargePowerW = await this._effectiveDeviceValue(id, 'maxDischargePowerW', Number(cfgDevice.maxDischargePowerW) || 0);
                dev.chargeAllowed = await this._effectiveDeviceValue(id, 'chargeAllowed', cfgDevice.chargeAllowed !== false);
                dev.dischargeAllowed = await this._effectiveDeviceValue(id, 'dischargeAllowed', cfgDevice.dischargeAllowed !== false);
                dev.hasPv = cfgDevice.hasPv === true;
            }

            result.devices = Object.values(devices);
        }

        result.house = await this._readHousePower(cfg);
        result.pv = await this._readOptionalDp(cfg.enablePvPower, cfg.pvPowerDp);

        return result;
    }

    /**
     * A device's live control.devices.<id>.<key> override if the user set one this session,
     * else the given static-config fallback (see #23).
     */
    async _effectiveDeviceValue(deviceId, key, fallback) {
        const state = await this.adapter.getStateAsync(`control.devices.${deviceId}.${key}`);
        return state && state.val !== null && state.val !== undefined ? state.val : fallback;
    }

    async _readOptionalDp(enabled, dp) {
        if (!enabled || !dp) return { enabled: false, powerW: null };
        const st = await this.adapter.getForeignStateAsync(dp);
        return { enabled: true, powerW: st ? st.val : null };
    }

    /**
     * House consumption, optionally corrected for the batteries' own AC charge draw so a
     * whole-house meter (which sees that draw too) doesn't inflate the "real" consumption figure.
     * Delegates to HousePower so this matches exactly what Telemetry samples into history.
     */
    async _readHousePower(cfg) {
        if (!cfg.enableHousePower || !cfg.housePowerDp) return { enabled: false, powerW: null };
        const powerW = await HousePower.readHousePowerW(this.adapter);
        return { enabled: true, powerW };
    }

    async _handleControl(req, res) {
        let body;
        try {
            body = await this._readJsonBody(req);
        } catch (err) {
            return this._send(res, 400, 'application/json', JSON.stringify({ error: err.message }));
        }

        const { key, value } = body || {};
        const rule = CONTROL_WHITELIST[key];

        if (!rule) {
            return this._send(res, 400, 'application/json', JSON.stringify({ error: 'Unknown control key' }));
        }

        let val = value;
        if (rule.type === 'boolean') {
            if (typeof val !== 'boolean') return this._send(res, 400, 'application/json', JSON.stringify({ error: 'Expected boolean' }));
        } else if (rule.type === 'number') {
            val = Number(val);
            if (!Number.isFinite(val)) return this._send(res, 400, 'application/json', JSON.stringify({ error: 'Expected number' }));
            val = Math.min(rule.max, Math.max(rule.min, val));
        }

        await this.adapter.setStateAsync(`control.${key}`, val, false);
        this._send(res, 200, 'application/json', JSON.stringify({ ok: true, key, value: val }));
    }

    /**
     * Writes one control.devices.<id>.<key> override (#24). The device id is validated against
     * the currently configured devices (same deviceKey-based resolution as _resolveDeviceBasePath)
     * so a request can't write to an arbitrary/unconfigured state path.
     */
    async _handleDeviceControl(req, res) {
        let body;
        try {
            body = await this._readJsonBody(req);
        } catch (err) {
            return this._send(res, 400, 'application/json', JSON.stringify({ error: err.message }));
        }

        const { device, key, value } = body || {};
        const rule = DEVICE_CONTROL_WHITELIST[key];

        if (!rule) {
            return this._send(res, 400, 'application/json', JSON.stringify({ error: 'Unknown control key' }));
        }

        if (!this._resolveDeviceBasePath(device)) {
            return this._send(res, 404, 'application/json', JSON.stringify({ error: 'Unknown device' }));
        }

        let val = value;
        if (rule.type === 'boolean') {
            if (typeof val !== 'boolean') return this._send(res, 400, 'application/json', JSON.stringify({ error: 'Expected boolean' }));
        } else if (rule.type === 'number') {
            val = Number(val);
            if (!Number.isFinite(val)) return this._send(res, 400, 'application/json', JSON.stringify({ error: 'Expected number' }));
            val = Math.min(rule.max, Math.max(rule.min, val));
        }

        await this.adapter.setStateAsync(`control.devices.${device}.${key}`, val, false);
        this._send(res, 200, 'application/json', JSON.stringify({ ok: true, device, key, value: val }));
    }

    _readJsonBody(req) {
        return new Promise((resolve, reject) => {
            let bytes = 0;
            const chunks = [];

            req.on('data', chunk => {
                bytes += chunk.length;
                if (bytes > MAX_BODY_BYTES) {
                    reject(new Error('Body too large'));
                    req.destroy();
                    return;
                }
                chunks.push(chunk);
            });

            req.on('end', () => {
                try {
                    resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
                } catch {
                    reject(new Error('Invalid JSON'));
                }
            });

            req.on('error', reject);
        });
    }

    _sendFile(res, filePath, type) {
        fs.readFile(filePath, (err, data) => {
            if (err) return this._send(res, 404, 'text/plain', 'Not found');
            this._send(res, 200, type, data);
        });
    }

    _send(res, statusCode, contentType, body) {
        // No caching headers were ever set, so browsers fall back to their own heuristics for
        // static assets (index.html/app.js/style.css) - after a dashboard update, some clients
        // (observed as a stray unstyled/unresponsive hamburger button on both desktop and mobile)
        // kept serving a stale cached app.js/style.css alongside the freshly-loaded index.html,
        // leaving new markup present but unstyled and without its event listeners attached.
        res.writeHead(statusCode, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
        res.end(body);
    }
}

module.exports = DashboardServer;
