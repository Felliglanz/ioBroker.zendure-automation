'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

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
    operatingDeadbandW: { type: 'number', min: 0, max: 5000 }
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

        if (req.method === 'GET' && url.pathname === '/api/battery/details') {
            return this._handleBatteryDetails(res, url.searchParams.get('device'));
        }

        this._send(res, 404, 'text/plain', 'Not found');
    }

    /**
     * Resolves a device's base state path purely from trusted adapter config (never from the
     * request), matching how MultiDeviceManager builds device.basePath.
     * @param {string|null} deviceId only used to pick a device in multi-device mode
     */
    _resolveDeviceBasePath(deviceId) {
        const cfg = this.adapter.config;
        const instance = cfg.zendureSolarflowInstance || 'zendure-solarflow.0';

        if (cfg.multiDeviceEnabled === true) {
            const device = (cfg.devices || []).find(d => d.id === deviceId && d.enabled && d.productKey && d.deviceKey);
            return device ? { basePath: `${instance}.${device.productKey}.${device.deviceKey}`, name: device.name || device.id } : null;
        }

        if (!cfg.deviceProductKey || !cfg.deviceKey) return null;
        return { basePath: `${instance}.${cfg.deviceProductKey}.${cfg.deviceKey}`, name: 'Battery' };
    }

    /**
     * All configured device base paths (one in single-device mode), for readings that need to
     * be summed across every physical Zendure unit.
     */
    _allDeviceBasePaths() {
        const cfg = this.adapter.config;
        const instance = cfg.zendureSolarflowInstance || 'zendure-solarflow.0';

        if (cfg.multiDeviceEnabled === true) {
            return (cfg.devices || [])
                .filter(d => d.enabled && d.productKey && d.deviceKey)
                .map(d => `${instance}.${d.productKey}.${d.deviceKey}`);
        }

        if (!cfg.deviceProductKey || !cfg.deviceKey) return [];
        return [`${instance}.${cfg.deviceProductKey}.${cfg.deviceKey}`];
    }

    /**
     * Sum of AC-sourced charge power across all devices right now, in Watts (always >= 0).
     * Uses gridInputPower specifically (AC charging only) rather than packPower, so PV-direct
     * charging - which never touches the house's own electricity meter - is not subtracted.
     * Mirrors the sign handling in DataReader.getGridInputPowerW(): Zendure reports
     * negative=charge inverted to our positive=discharge/negative=charge convention.
     */
    async _totalBatteryAcChargeW() {
        let total = 0;
        for (const basePath of this._allDeviceBasePaths()) {
            const state = await this.adapter.getForeignStateAsync(`${basePath}.gridInputPower`);
            if (!state || state.val === null || state.val === undefined) continue;
            const gridInputW = -Number(state.val);
            if (Number.isFinite(gridInputW) && gridInputW < 0) total += -gridInputW;
        }
        return total;
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

    async _buildStatus() {
        const isMulti = this.adapter.config.multiDeviceEnabled === true;
        const statusKeys = isMulti ? STATUS_KEYS_MULTI : STATUS_KEYS_SINGLE;

        const result = { multiDevice: isMulti, status: {}, control: {}, devices: [] };

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

            result.devices = Object.values(devices);
        }

        const cfg = this.adapter.config;
        result.house = await this._readHousePower(cfg);
        result.pv = await this._readOptionalDp(cfg.enablePvPower, cfg.pvPowerDp);

        return result;
    }

    async _readOptionalDp(enabled, dp) {
        if (!enabled || !dp) return { enabled: false, powerW: null };
        const st = await this.adapter.getForeignStateAsync(dp);
        return { enabled: true, powerW: st ? st.val : null };
    }

    /**
     * House consumption, optionally corrected for the batteries' own AC charge draw so a
     * whole-house meter (which sees that draw too) doesn't inflate the "real" consumption figure.
     */
    async _readHousePower(cfg) {
        const raw = await this._readOptionalDp(cfg.enableHousePower, cfg.housePowerDp);
        if (!raw.enabled || raw.powerW === null || !cfg.subtractBatteryChargeFromHouse) return raw;

        const acChargeW = await this._totalBatteryAcChargeW();
        return { enabled: true, powerW: raw.powerW - acChargeW };
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
        res.writeHead(statusCode, { 'Content-Type': contentType });
        res.end(body);
    }
}

module.exports = DashboardServer;
