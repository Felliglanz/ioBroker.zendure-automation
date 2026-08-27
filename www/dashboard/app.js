(() => {
  'use strict';

  const POLL_MS = 2000;
  const GRAPH_POLL_MS = 60000;

  // Signed metrics (can go positive/negative) get a symmetric zero-centered scale and a
  // direction gradient instead of a fixed hue - see drawGraphCard. Both reuse the flow diagram's
  // existing green/amber (--accent-charge/--accent-discharge), but positiveColor/negativeColor
  // are a deliberate cost framing, not a copy of the flow diagram's own fwd/rev mapping: drawing
  // power (grid import, battery discharge) is amber, feeding power (grid export, battery charge)
  // is green - happens to line up with the flow diagram for Batterie, but is the opposite of it
  // for Netz (there, "into the hub" is import, which the flow diagram colors green).
  const GRAPH_METRICS = [
    { key: 'houseW', label: 'Hausverbrauch', varColor: '--chart-house', houseOnly: true },
    { key: 'gridW', label: 'Netz', signed: true, positiveColor: '--accent-discharge', negativeColor: '--accent-charge' },
    { key: 'pvW', label: 'PV', varColor: '--chart-pv', pvOnly: true },
    { key: 'batteryW', label: 'Batterie', signed: true, positiveColor: '--accent-discharge', negativeColor: '--accent-charge' }
  ];

  const CONTROLS = [
    { key: 'enabled', label: 'Automatik aktiv', type: 'boolean' },
    { key: 'enableCharge', label: 'Laden erlaubt', type: 'boolean' },
    { key: 'enableDischarge', label: 'Entladen erlaubt', type: 'boolean' },
    { key: 'maxCharge', label: 'Max. Laden (Override)', type: 'boolean' },
    { key: 'maxDischarge', label: 'Max. Entladen (Override)', type: 'boolean' },
    { key: 'targetGridPowerW', label: 'Ziel-Netzleistung', type: 'number', unit: 'W' },
    { key: 'maxChargePowerW', label: 'Max. Ladeleistung', type: 'number', unit: 'W' },
    { key: 'maxDischargePowerW', label: 'Max. Entladeleistung', type: 'number', unit: 'W' },
    { key: 'maxBatterySoc', label: 'Max. Batterie-SOC', type: 'number', unit: '%' },
    { key: 'minBatterySoc', label: 'Min. Batterie-SOC', type: 'number', unit: '%' },
    { key: 'operatingDeadbandW', label: 'Deadband', type: 'number', unit: 'W' },
    { key: 'regulatorGain', label: 'Regler-Gain', type: 'number', step: 0.05 }
  ];

  const modeBadge = document.getElementById('modeBadge');
  const connIndicator = document.getElementById('connIndicator');
  const gridPowerValue = document.getElementById('gridPowerValue');
  const housePowerValue = document.getElementById('housePowerValue');
  const pvGroup = document.getElementById('pvGroup');
  const pvPowerValue = document.getElementById('pvPowerValue');
  const batteryPowerValue = document.getElementById('batteryPowerValue');
  const batterySocValue = document.getElementById('batterySocValue');
  const batteryFillRect = document.getElementById('batteryFillRect');
  const flowLineGridHub = document.getElementById('flowLineGridHub');
  const flowLineHausHub = document.getElementById('flowLineHausHub');
  const flowLineBatteryHub = document.getElementById('flowLineBatteryHub');
  const flowLinePvHouse = document.getElementById('flowLinePvHouse');
  const deviceCards = document.getElementById('deviceCards');
  const controlList = document.getElementById('controlList');
  const emergencyReason = document.getElementById('emergencyReason');
  const lastUpdate = document.getElementById('lastUpdate');
  const batteryHero = document.getElementById('batteryHero');
  const nodePv = document.getElementById('nodePv');
  const nodeGrid = document.getElementById('nodeGrid');
  const nodeHaus = document.getElementById('nodeHaus');
  const autarkyValue = document.getElementById('autarkyValue');
  const autarkyRing = document.getElementById('autarkyRing');
  const selfConsumptionValue = document.getElementById('selfConsumptionValue');
  const selfConsumptionRing = document.getElementById('selfConsumptionRing');
  const hub = document.getElementById('hub');
  const detailsOverlay = document.getElementById('detailsOverlay');
  const detailsTitle = document.getElementById('detailsTitle');
  const detailsBody = document.getElementById('detailsBody');
  const detailsClose = document.getElementById('detailsClose');
  const controlHint = document.getElementById('controlHint');
  const menuBtn = document.getElementById('menuBtn');
  const menuOverlay = document.getElementById('menuOverlay');
  const menuTelemetry = document.getElementById('menuTelemetry');
  const telemetryOverlay = document.getElementById('telemetryOverlay');
  const telemetryBody = document.getElementById('telemetryBody');
  const telemetryClose = document.getElementById('telemetryClose');
  const menuHistory = document.getElementById('menuHistory');
  const historyOverlay = document.getElementById('historyOverlay');
  const historyBody = document.getElementById('historyBody');
  const historyClose = document.getElementById('historyClose');
  const flowPanel = document.getElementById('flowPanel');
  const flowFullscreenBtn = document.getElementById('flowFullscreenBtn');
  const graphPanel = document.getElementById('graphPanel');
  const graphFullscreenBtn = document.getElementById('graphFullscreenBtn');
  const graphGrid = document.getElementById('graphGrid');
  const graphRange60 = document.getElementById('graphRange60');
  const graphRange120 = document.getElementById('graphRange120');
  const controlToggle = document.getElementById('controlToggle');
  const controlBody = document.getElementById('controlBody');

  // control.* keys whose global value is only a fallback in multi-device Waterfill mode - the
  // per-device limits from the admin table are what's actually effective there (see issue #22).
  const WATERFILL_AMBIGUOUS_KEYS = ['maxChargePowerW', 'maxDischargePowerW'];

  // Battery cell interior, matches #batteryClip in index.html
  const BATTERY_TOP = 260;
  const BATTERY_HEIGHT = 120;

  const controlInputs = {};
  const controlRows = {};

  function buildControlPanel() {
    for (const def of CONTROLS) {
      const row = document.createElement('div');
      row.className = 'control-item';
      controlRows[def.key] = row;

      const label = document.createElement('label');
      label.textContent = def.label + (def.unit ? ` (${def.unit})` : '');
      label.htmlFor = `ctrl-${def.key}`;

      let input;
      if (def.type === 'boolean') {
        const wrap = document.createElement('label');
        wrap.className = 'switch';
        input = document.createElement('input');
        input.type = 'checkbox';
        input.id = `ctrl-${def.key}`;
        const slider = document.createElement('span');
        slider.className = 'slider';
        wrap.appendChild(input);
        wrap.appendChild(slider);
        input.addEventListener('change', () => sendControl(def.key, input.checked));
        row.appendChild(label);
        row.appendChild(wrap);
      } else {
        input = document.createElement('input');
        input.type = 'number';
        input.id = `ctrl-${def.key}`;
        if (def.step) input.step = def.step;
        input.addEventListener('change', () => sendControl(def.key, Number(input.value)));
        row.appendChild(label);
        row.appendChild(input);
      }

      controlInputs[def.key] = input;
      controlList.appendChild(row);
    }
  }

  function sendControl(key, value) {
    fetch('/api/control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, value })
    }).catch(() => {});
  }

  function updateControls(control) {
    for (const def of CONTROLS) {
      const input = controlInputs[def.key];
      if (!input || document.activeElement === input) continue;
      const val = control[def.key];
      if (def.type === 'boolean') {
        input.checked = !!val;
      } else if (val !== null && val !== undefined) {
        input.value = val;
      }
    }
  }

  // Same kW-switchover convention fmtWh already uses for Wh/kWh, applied everywhere a power
  // value is displayed (flow diagram, device cards, history graphs) so they stay consistent
  // with each other. telemetry.historyJson itself keeps recording raw Watts - display-only.
  function fmtWAuto(val) {
    if (val === null || val === undefined || Number.isNaN(val)) return '– W';
    return Math.abs(val) >= 1000 ? `${(val / 1000).toFixed(2)} kW` : `${Math.round(val)} W`;
  }

  function fmtWh(val) {
    if (val === null || val === undefined || Number.isNaN(val)) return '–';
    return val >= 1000 ? `${(val / 1000).toFixed(2)} kWh` : `${Math.round(val)} Wh`;
  }

  const RING_COLOR_STOPS = [
    [0, [239, 68, 68]], // --accent-error
    [50, [245, 158, 11]], // --accent-discharge
    [100, [16, 185, 129]] // --accent-charge
  ];

  /** Continuous red -> amber -> green ring color for a 0-100 percentage. */
  function pctToRingColor(pct) {
    const p = Math.max(0, Math.min(100, pct));
    let [loStop, hiStop] = [RING_COLOR_STOPS[0], RING_COLOR_STOPS[1]];
    for (let i = 0; i < RING_COLOR_STOPS.length - 1; i++) {
      if (p >= RING_COLOR_STOPS[i][0] && p <= RING_COLOR_STOPS[i + 1][0]) {
        [loStop, hiStop] = [RING_COLOR_STOPS[i], RING_COLOR_STOPS[i + 1]];
        break;
      }
    }
    const span = hiStop[0] - loStop[0];
    const t = span > 0 ? (p - loStop[0]) / span : 0;
    const rgb = loStop[1].map((c, i) => Math.round(c + (hiStop[1][i] - c) * t));
    return `rgb(${rgb.join(',')})`;
  }

  /**
   * Sets a connector's direction/color purely via CSS classes - no arrowhead markers, just
   * color plus which way the dashes travel. 'fwd' = satellite -> hub, 'rev' = hub -> satellite
   * (matches each line's own x1,y1 (satellite) -> x2,y2 (hub) definition in index.html).
   * Also glows the satellite node itself so the active flow is readable at a glance.
   * @param {SVGLineElement} line
   * @param {SVGGElement} node
   * @param {'fwd'|'rev'|null} dir
   */
  function setFlow(line, node, dir) {
    line.classList.remove('flow-fwd', 'flow-rev');
    node.classList.remove('flowing-fwd', 'flowing-rev');
    if (dir) {
      line.classList.add(`flow-${dir}`);
      node.classList.add(`flowing-${dir}`);
    }
  }

  // Below this, a device's own PV production is "not currently flowing" - matches the flow
  // diagram's own THRESHOLD (render()), so both stay in sync about what counts as active.
  const DEVICE_PV_THRESHOLD_W = 5;

  function renderDeviceCards(devices, waterfillActive) {
    if (!devices || devices.length === 0) {
      deviceCards.hidden = true;
      deviceCards.innerHTML = '';
      return;
    }

    deviceCards.hidden = false;
    deviceCards.innerHTML = '';

    for (const dev of devices) {
      const card = document.createElement('div');
      card.className = 'device-card';
      if (dev.available === false) card.classList.add('unavailable');
      if (dev.excluded) card.classList.add('excluded');

      const soc = typeof dev.soc === 'number' ? dev.soc : 0;
      const socPct = Math.max(0, Math.min(100, soc));
      const barClass = socPct < 15 ? 'low' : socPct < 30 ? 'mid' : '';

      // A device with its own PV only reconciles with the flow diagram's totals if you can see
      // that its battery reading is just part of the picture - PV covers some of the output
      // directly, never touching the battery. Shown as "PV + Batterie" (no computed sum) so the
      // viewer adds the two themselves, only while that device's PV is actually producing.
      const pvActive = dev.hasPv && typeof dev.solarInputPowerW === 'number' && dev.solarInputPowerW > DEVICE_PV_THRESHOLD_W;
      const batteryClass = dev.powerW < -DEVICE_PV_THRESHOLD_W ? 'charging' : dev.powerW > DEVICE_PV_THRESHOLD_W ? 'discharging' : '';
      const powerCell = pvActive
        ? `<span class="device-power-pv"><span class="pv-part">☀ ${fmtWAuto(dev.solarInputPowerW)}</span><span class="pv-plus">+</span><span class="battery-part ${batteryClass}">🔋 ${fmtWAuto(dev.powerW)}</span></span>`
        : `<span class="${batteryClass}">${fmtWAuto(dev.powerW)}</span>`;

      card.classList.add('clickable');
      card.innerHTML = `
        <div class="name">
          <span class="dot"></span>${escapeHtml(dev.name || dev.id)}
          <button type="button" class="gear-btn" title="Geräte-Limits" aria-label="Geräte-Limits">⚙</button>
        </div>
        <div class="metrics">${powerCell}<span>${soc}%</span></div>
        <div class="bar-track"><div class="bar-fill ${barClass}" style="width:${socPct}%"></div></div>
      `;
      card.addEventListener('click', () => openDetails(dev.id));
      card.querySelector('.gear-btn').addEventListener('click', e => {
        e.stopPropagation();
        openDeviceLimits(dev, waterfillActive);
      });
      deviceCards.appendChild(card);
    }
  }

  const DEVICE_LIMIT_FIELDS = [
    { key: 'chargeAllowed', label: 'Laden erlaubt', type: 'boolean' },
    { key: 'dischargeAllowed', label: 'Entladen erlaubt', type: 'boolean' },
    { key: 'maxChargePowerW', label: 'Max. Ladeleistung (W)', type: 'number' },
    { key: 'maxDischargePowerW', label: 'Max. Entladeleistung (W)', type: 'number' }
  ];

  /**
   * Editable popup for this device's control.devices.<id>.* overrides (#24) - same
   * live-apply-on-change pattern as the global control panel, built with the same row markup so
   * it reuses the existing .control-item/.switch styling. Values already reflect the live
   * override if one is set (server-side effective-value overlay), else the config default.
   */
  function openDeviceLimits(dev, waterfillActive) {
    detailsTitle.textContent = `Geräte-Limits – ${dev.name || dev.id}`;

    const hint = waterfillActive
      ? 'Waterfill-Modus aktiv: diese Werte werden für dieses Gerät verwendet.'
      : 'Equal-Split-Modus aktiv: diese Werte werden aktuell nicht verwendet – maßgeblich ist die globale Steuerung.';

    detailsBody.innerHTML = `
      <div class="control-list" id="deviceLimitsList"></div>
      <p class="modal-hint">${escapeHtml(hint)}</p>
    `;

    const list = document.getElementById('deviceLimitsList');
    for (const field of DEVICE_LIMIT_FIELDS) {
      const row = document.createElement('div');
      row.className = 'control-item';

      const label = document.createElement('label');
      label.textContent = field.label;
      row.appendChild(label);

      if (field.type === 'boolean') {
        const wrap = document.createElement('label');
        wrap.className = 'switch';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = dev[field.key] !== false;
        const slider = document.createElement('span');
        slider.className = 'slider';
        wrap.appendChild(input);
        wrap.appendChild(slider);
        input.addEventListener('change', () => sendDeviceControl(dev.id, field.key, input.checked));
        row.appendChild(wrap);
      } else {
        const input = document.createElement('input');
        input.type = 'number';
        input.value = dev[field.key] ?? '';
        input.addEventListener('change', () => sendDeviceControl(dev.id, field.key, Number(input.value)));
        row.appendChild(input);
      }

      list.appendChild(row);
    }

    detailsOverlay.hidden = false;
  }

  function sendDeviceControl(deviceId, key, value) {
    fetch('/api/device-control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device: deviceId, key, value })
    }).catch(() => {});
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function prettifyField(field) {
    const spaced = field.replace(/([A-Z])/g, ' $1').trim();
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
  }

  function fmtCell(val, field) {
    if (val === null || val === undefined) return '–';
    if (typeof val === 'number' && /temp/i.test(field)) return escapeHtml(val.toFixed(1));
    return escapeHtml(String(val));
  }

  function isSerialField(field) {
    return /^sn$|serial/i.test(field);
  }

  async function openDetails(deviceId) {
    detailsTitle.textContent = 'Batteriedaten';
    detailsBody.innerHTML = '<div class="modal-empty">Lade…</div>';
    detailsOverlay.hidden = false;

    try {
      const qs = deviceId ? `?device=${encodeURIComponent(deviceId)}` : '';
      const res = await fetch(`/api/battery/details${qs}`, { cache: 'no-store' });
      const data = await res.json();

      if (!res.ok) {
        detailsBody.innerHTML = `<div class="modal-empty">${escapeHtml(data.error || 'Unbekannter Fehler')}${deviceId ? '' : ' – bitte auf eine Gerätekarte klicken.'}</div>`;
        return;
      }

      renderDetails(data);
    } catch {
      detailsBody.innerHTML = '<div class="modal-empty">Verbindung zum Dashboard-Server fehlgeschlagen.</div>';
    }
  }

  function renderDetails(data) {
    detailsTitle.textContent = data.name ? `Batteriedaten – ${data.name}` : 'Batteriedaten';

    const packIds = Object.keys(data.packs || {}).sort((a, b) => Number(a) - Number(b));
    if (packIds.length === 0) {
      detailsBody.innerHTML = '<div class="modal-empty">Keine Pack-Daten gefunden. Ist das Zendure-Gerät verbunden?</div>';
      return;
    }

    const fields = [...new Set(packIds.flatMap(id => Object.keys(data.packs[id])))]
      .sort((a, b) => Number(isSerialField(a)) - Number(isSerialField(b)));

    const head = `<tr><th>Pack</th>${fields.map(f => `<th>${escapeHtml(prettifyField(f))}</th>`).join('')}</tr>`;
    const body = packIds.map(id => {
      const pack = data.packs[id];
      return `<tr><td>${escapeHtml(id)}</td>${fields.map(f => `<td>${fmtCell(pack[f], f)}</td>`).join('')}</tr>`;
    }).join('');

    detailsBody.innerHTML = `<table class="pack-table"><thead>${head}</thead><tbody>${body}</tbody></table>`;
  }

  function closeDetails() {
    detailsOverlay.hidden = true;
  }

  function openMenu() {
    menuOverlay.hidden = false;
  }

  function closeMenu() {
    menuOverlay.hidden = true;
  }

  const TELEMETRY_ITEMS = [
    { key: 'gridImportWhToday', label: 'Netzbezug' },
    { key: 'gridExportWhToday', label: 'Netzeinspeisung' },
    { key: 'pvWhToday', label: 'PV-Ertrag', pvOnly: true },
    { key: 'batteryChargeWhToday', label: 'Batterie geladen' },
    { key: 'batteryDischargeWhToday', label: 'Batterie entladen' },
    { key: 'modeSwitchesToday', label: 'Moduswechsel', raw: true },
    { key: 'emergencyEventsToday', label: 'Notfall-Events', raw: true }
  ];

  async function openTelemetry() {
    closeMenu();
    telemetryBody.innerHTML = '<div class="modal-empty">Lade…</div>';
    telemetryOverlay.hidden = false;

    try {
      const res = await fetch('/api/telemetry', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) {
        telemetryBody.innerHTML = `<div class="modal-empty">${escapeHtml(data.error || 'Unbekannter Fehler')}</div>`;
        return;
      }
      renderTelemetry(data);
    } catch {
      telemetryBody.innerHTML = '<div class="modal-empty">Verbindung zum Dashboard-Server fehlgeschlagen.</div>';
    }
  }

  function renderTelemetry(data) {
    const items = TELEMETRY_ITEMS.filter(item => !item.pvOnly || data.pvEnabled);
    const cards = items.map(item => `
      <div class="telemetry-item">
        <span class="telemetry-label">${escapeHtml(item.label)}</span>
        <span class="telemetry-value">${item.raw ? (data[item.key] ?? '–') : fmtWh(data[item.key])}</span>
      </div>
    `).join('');

    telemetryBody.innerHTML = `<div class="telemetry-grid">${cards}</div>`;
  }

  function closeTelemetry() {
    telemetryOverlay.hidden = true;
  }

  // History view: reads back data InfluxWriter already exported, via DashboardServer's
  // read-only Flux proxy (the Influx token stays server-side). Independent of the live
  // dashboard/Tagesansicht - only shown at all once InfluxDB export + this UI are both enabled.
  const HISTORY_RANGE_PRESETS = [
    { key: '24h', label: '24 Std.', start: '-24h' },
    { key: '7d', label: '7 Tage', start: '-7d' },
    { key: '30d', label: '30 Tage', start: '-30d' },
    { key: 'custom', label: 'Frei' }
  ];
  const HISTORY_LINE_COLORS = ['#2a78d6', '#f59e0b'];

  // Every field InfluxWriter can produce (see lib/InfluxWriter.js / telemetry.* in
  // io-package.json), translated for the field picker/legend/tooltip. Anything not listed here
  // (a future field the writer starts exporting) still works, just falls back to its raw name.
  const HISTORY_FIELD_LABELS = {
    mode: 'Betriebsmodus',
    gridPowerW: 'Netzleistung (W)',
    emergencyReason: 'Notfall-Grund',
    feedInCounter: 'Einspeise-Zähler (intern)',
    dischargeCounter: 'Entlade-Zähler (intern)',
    deadbandCounter: 'Deadband-Zähler (intern)',
    totalPowerW: 'Batterieleistung gesamt (W)',
    avgSoc: 'Batterie-SOC Durchschnitt (%)',
    powerW: 'Batterieleistung (W)',
    soc: 'Batterie-SOC (%)',
    minPackVoltageV: 'Min. Pack-Spannung (V)',
    emergencyRecoveryActive: 'Notfall-Recovery aktiv',
    voltageRecoveryActive: 'Spannungs-Recovery aktiv',
    socRecoveryActive: 'SOC-Recovery aktiv',
    minSocRecoveryActive: 'MinSOC-Recovery aktiv',
    maxSocRecoveryActive: 'MaxSOC-Recovery aktiv',
    effectiveMinSoc: 'Effektives Min-SOC (%)',
    name: 'Gerätename',
    available: 'Gerät verfügbar',
    excluded: 'Von Verteilung ausgeschlossen',
    gridImportWhToday: 'Netzbezug heute (Wh)',
    gridExportWhToday: 'Netzeinspeisung heute (Wh)',
    pvWhToday: 'PV-Ertrag heute (Wh)',
    batteryChargeWhToday: 'Batterie geladen heute (Wh)',
    batteryDischargeWhToday: 'Batterie entladen heute (Wh)',
    modeSwitchesToday: 'Moduswechsel heute',
    emergencyEventsToday: 'Notfall-Events heute',
    housePowerW: 'Hausverbrauch (W)',
    pvPowerW: 'PV-Leistung (W)'
  };

  function historyFieldLabel(rawField) {
    return HISTORY_FIELD_LABELS[rawField] || rawField;
  }

  // seriesMap keys are "field" or "field@device" (see DashboardServer._handleInfluxHistory) -
  // translates the field part, keeps the device suffix so multi-device series stay distinguishable.
  function historySeriesLabel(key) {
    const at = key.indexOf('@');
    if (at === -1) return historyFieldLabel(key);
    return `${historyFieldLabel(key.slice(0, at))} (${key.slice(at + 1)})`;
  }

  let historyFields = null; // fetched once per modal session
  const historyState = { fields: [null, null], rangeKey: '24h', customStart: null, customStop: null };

  function minMax(values) {
    let min = Infinity;
    let max = -Infinity;
    for (const v of values) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
    return [min, max];
  }

  function fmtHistoryDate(ms) {
    return new Date(ms).toLocaleString([], { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  // No fixed unit here (unlike fmtWAuto/fmtWh) - the field picker offers arbitrary telemetry/status
  // fields (W, %, counts, ...), so this just keeps the number itself readable.
  function fmtHistoryValue(v) {
    if (!Number.isFinite(v)) return '–';
    return Number.isInteger(v) ? String(v) : v.toFixed(2);
  }

  function buildHistorySkeleton() {
    if (historyBody.dataset.built) return;
    historyBody.dataset.built = '1';

    historyBody.innerHTML = `
      <div class="history-controls">
        <div class="history-field-row"><select class="history-select" id="historyField1"></select></div>
        <div class="history-field-row"><select class="history-select" id="historyField2"><option value="">+ 2. Feld</option></select></div>
        <div class="graph-range" id="historyRangeButtons"></div>
      </div>
      <div class="history-custom-range" id="historyCustomRange" hidden>
        <input type="datetime-local" id="historyStart">
        <span>bis</span>
        <input type="datetime-local" id="historyStop">
        <button type="button" class="history-btn" id="historyCustomApply">Anwenden</button>
      </div>
      <div class="history-legend" id="historyLegend"></div>
      <div class="history-chart-wrap"><svg class="history-svg" id="historySvg"></svg></div>
      <p class="modal-hint">Nur numerische Felder ergeben eine Kurve. Zweites Feld optional, z.B. um Netz- und Batterieleistung zu vergleichen.</p>
    `;

    const rangeButtonsEl = document.getElementById('historyRangeButtons');
    for (const preset of HISTORY_RANGE_PRESETS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'graph-range-btn';
      btn.textContent = preset.label;
      btn.dataset.key = preset.key;
      btn.addEventListener('click', () => selectHistoryRange(preset.key));
      rangeButtonsEl.appendChild(btn);
    }

    document.getElementById('historyField1').addEventListener('change', e => {
      historyState.fields[0] = e.target.value || null;
      loadHistoryChart();
    });
    document.getElementById('historyField2').addEventListener('change', e => {
      historyState.fields[1] = e.target.value || null;
      loadHistoryChart();
    });
    document.getElementById('historyCustomApply').addEventListener('click', () => {
      const startEl = document.getElementById('historyStart');
      const stopEl = document.getElementById('historyStop');
      if (!startEl.value || !stopEl.value) return;
      historyState.customStart = new Date(startEl.value).toISOString();
      historyState.customStop = new Date(stopEl.value).toISOString();
      loadHistoryChart();
    });
  }

  function selectHistoryRange(key, opts = {}) {
    historyState.rangeKey = key;
    document.getElementById('historyCustomRange').hidden = key !== 'custom';
    for (const btn of document.querySelectorAll('#historyRangeButtons .graph-range-btn')) {
      btn.setAttribute('aria-pressed', String(btn.dataset.key === key));
    }
    if (key !== 'custom' && !opts.skipLoad) loadHistoryChart();
  }

  async function openHistory() {
    closeMenu();
    buildHistorySkeleton();
    historyOverlay.hidden = false;
    selectHistoryRange(historyState.rangeKey, { skipLoad: true });

    if (!historyFields) {
      const field1 = document.getElementById('historyField1');
      const field2 = document.getElementById('historyField2');
      field1.innerHTML = '<option value="">Lade…</option>';

      try {
        const res = await fetch('/api/influx/fields', { cache: 'no-store' });
        const data = await res.json();
        historyFields = (res.ok && Array.isArray(data.fields)) ? data.fields : [];
      } catch {
        historyFields = [];
      }

      const sortedFields = [...historyFields].sort((a, b) => historyFieldLabel(a).localeCompare(historyFieldLabel(b), 'de'));
      const options = sortedFields.map(f => `<option value="${escapeHtml(f)}">${escapeHtml(historyFieldLabel(f))}</option>`).join('');
      field1.innerHTML = options || '<option value="">Keine Felder gefunden</option>';
      field2.innerHTML = '<option value="">+ 2. Feld</option>' + options;

      if (sortedFields.length) {
        historyState.fields[0] = sortedFields[0];
        field1.value = sortedFields[0];
      }
    }

    loadHistoryChart();
  }

  function closeHistory() {
    historyOverlay.hidden = true;
  }

  async function loadHistoryChart() {
    const svg = document.getElementById('historySvg');
    const legend = document.getElementById('historyLegend');
    const fields = historyState.fields.filter(Boolean);
    if (!fields.length) {
      legend.innerHTML = '';
      svg.innerHTML = '';
      return;
    }

    let start;
    let stop = 'now()';
    if (historyState.rangeKey === 'custom') {
      if (!historyState.customStart || !historyState.customStop) return;
      start = historyState.customStart;
      stop = historyState.customStop;
    } else {
      start = HISTORY_RANGE_PRESETS.find(p => p.key === historyState.rangeKey).start;
    }

    legend.innerHTML = '<span class="history-legend-item">Lade…</span>';

    const qs = new URLSearchParams({ fields: fields.join(','), start });
    if (stop !== 'now()') qs.set('stop', stop);

    try {
      const res = await fetch(`/api/influx/history?${qs}`, { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) {
        legend.innerHTML = `<span class="history-legend-item">${escapeHtml(data.error || 'Fehler')}</span>`;
        svg.innerHTML = '';
        return;
      }
      drawHistoryChart(data.series || {});
    } catch {
      legend.innerHTML = '<span class="history-legend-item">Verbindung zum Dashboard-Server fehlgeschlagen.</span>';
      svg.innerHTML = '';
    }
  }

  function drawHistoryChart(seriesMap) {
    const svg = document.getElementById('historySvg');
    const legend = document.getElementById('historyLegend');
    const keys = Object.keys(seriesMap).filter(k => seriesMap[k].length >= 2);

    svg.innerHTML = '';
    if (!keys.length) {
      legend.innerHTML = '<span class="history-legend-item">Keine Daten im gewählten Zeitraum.</span>';
      return;
    }

    const width = svg.clientWidth;
    const height = svg.clientHeight;
    if (width === 0 || height === 0) return;
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);

    const [windowStart, windowEnd] = minMax(keys.flatMap(k => seriesMap[k].map(p => p.t)));
    const span = (windowEnd - windowStart) || 1;
    const xOf = t => GRAPH_PLOT_LEFT + ((t - windowStart) / span) * (width - GRAPH_PLOT_LEFT - GRAPH_PAD_X);

    legend.innerHTML = keys.map((key, i) => {
      const series = seriesMap[key];
      const last = series[series.length - 1].v;
      const color = HISTORY_LINE_COLORS[i % HISTORY_LINE_COLORS.length];
      return `<span class="history-legend-item"><span class="history-legend-dot" style="background:${color}"></span>${escapeHtml(historySeriesLabel(key))}: ${fmtHistoryValue(last)}</span>`;
    }).join('');

    // Each series gets its own independent min/max scale (so two differently-scaled fields, e.g.
    // W and %, still overlay meaningfully) - so unlike a single-metric graph-card, the y-axis needs
    // one min/max label pair per series, color-matched to its curve, stacked to stay legible.
    const seriesRenderData = [];
    keys.forEach((key, i) => {
      const series = seriesMap[key];
      const [min, max] = minMax(series.map(p => p.v));
      const range = (max - min) || 1;
      const yOf = v => GRAPH_PAD_Y + (height - 2 * GRAPH_PAD_Y) * (1 - (v - min) / range);
      const color = HISTORY_LINE_COLORS[i % HISTORY_LINE_COLORS.length];

      const coords = series.map(p => [xOf(p.t), yOf(p.v)]);
      const linePath = buildSmoothPath(coords);
      const baseY = (height - GRAPH_PAD_Y).toFixed(1);
      const areaPath = `${linePath} L${coords[coords.length - 1][0].toFixed(1)},${baseY} L${coords[0][0].toFixed(1)},${baseY} Z`;

      const area = document.createElementNS(SVG_NS, 'path');
      area.setAttribute('d', areaPath);
      area.setAttribute('fill', color);
      area.classList.add('graph-area');
      svg.appendChild(area);

      const line = document.createElementNS(SVG_NS, 'path');
      line.setAttribute('d', linePath);
      line.setAttribute('stroke', color);
      line.classList.add('graph-line');
      svg.appendChild(line);

      const maxLabel = document.createElementNS(SVG_NS, 'text');
      maxLabel.classList.add('graph-axis-label');
      maxLabel.setAttribute('x', String(GRAPH_PLOT_LEFT - 6));
      maxLabel.setAttribute('y', String(GRAPH_PAD_Y + 3 + i * 11));
      maxLabel.setAttribute('text-anchor', 'end');
      maxLabel.setAttribute('fill', color);
      maxLabel.textContent = fmtHistoryValue(max);
      svg.appendChild(maxLabel);

      const minLabel = document.createElementNS(SVG_NS, 'text');
      minLabel.classList.add('graph-axis-label');
      minLabel.setAttribute('x', String(GRAPH_PLOT_LEFT - 6));
      minLabel.setAttribute('y', String(height - GRAPH_PAD_Y - i * 11));
      minLabel.setAttribute('text-anchor', 'end');
      minLabel.setAttribute('fill', color);
      minLabel.textContent = fmtHistoryValue(min);
      svg.appendChild(minLabel);

      seriesRenderData.push({ key, color, coords, series });
    });

    const startLabel = document.createElementNS(SVG_NS, 'text');
    startLabel.classList.add('graph-axis-label');
    startLabel.setAttribute('x', String(GRAPH_PLOT_LEFT));
    startLabel.setAttribute('y', String(height - 2));
    startLabel.textContent = fmtHistoryDate(windowStart);
    svg.appendChild(startLabel);

    const endLabel = document.createElementNS(SVG_NS, 'text');
    endLabel.classList.add('graph-axis-label');
    endLabel.setAttribute('x', String(width - GRAPH_PAD_X));
    endLabel.setAttribute('y', String(height - 2));
    endLabel.setAttribute('text-anchor', 'end');
    endLabel.textContent = fmtHistoryDate(windowEnd);
    svg.appendChild(endLabel);

    setupHistoryCrosshair(svg, seriesRenderData, width, height);
  }

  // One shared crosshair line (by x/time) with one dot per series - each series can sit at a
  // different y since they're independently scaled, but they share the same time axis, so a
  // single vertical line naturally lines them all up. pointermove/pointerdown covers mouse hover
  // *and* touch (a swiping finger keeps firing pointermove; touch-action:none on .history-svg,
  // see style.css, stops the browser from hijacking that swipe as a page scroll instead).
  function setupHistoryCrosshair(svg, seriesRenderData, width, height) {
    const wrap = svg.closest('.history-chart-wrap');
    const tooltip = document.createElement('div');
    tooltip.className = 'graph-tooltip';
    tooltip.hidden = true;
    wrap.appendChild(tooltip);

    const crosshairLine = document.createElementNS(SVG_NS, 'line');
    crosshairLine.classList.add('graph-crosshair');
    crosshairLine.setAttribute('y1', String(GRAPH_PAD_Y));
    crosshairLine.setAttribute('y2', String(height - GRAPH_PAD_Y));
    svg.appendChild(crosshairLine);

    const dots = seriesRenderData.map(entry => {
      const dot = document.createElementNS(SVG_NS, 'circle');
      dot.classList.add('graph-crosshair-dot');
      dot.setAttribute('r', '4');
      dot.style.fill = entry.color;
      svg.appendChild(dot);
      return dot;
    });

    function pointerMove(evt) {
      const rect = svg.getBoundingClientRect();
      if (rect.width === 0 || !seriesRenderData.length) return;
      const px = ((evt.clientX - rect.left) / rect.width) * width;

      // Nearest sample per series independently - series can have gaps/different sample counts,
      // so index-aligning them would drift; matching by x (time) position stays correct either way.
      let sharedX = null;
      const rows = seriesRenderData.map((entry, i) => {
        let nearestIdx = 0;
        let bestDist = Infinity;
        for (let j = 0; j < entry.coords.length; j++) {
          const d = Math.abs(entry.coords[j][0] - px);
          if (d < bestDist) { bestDist = d; nearestIdx = j; }
        }
        const [nx, ny] = entry.coords[nearestIdx];
        const point = entry.series[nearestIdx];
        if (i === 0) sharedX = nx;
        dots[i].setAttribute('cx', nx.toFixed(1));
        dots[i].setAttribute('cy', ny.toFixed(1));
        dots[i].classList.add('active');
        return { key: entry.key, color: entry.color, point };
      });

      crosshairLine.setAttribute('x1', sharedX.toFixed(1));
      crosshairLine.setAttribute('x2', sharedX.toFixed(1));
      crosshairLine.classList.add('active');

      tooltip.hidden = false;
      tooltip.innerHTML = '';
      for (const row of rows) {
        const line = document.createElement('div');
        const dotSpan = document.createElement('span');
        dotSpan.className = 'history-legend-dot';
        dotSpan.style.background = row.color;
        dotSpan.style.display = 'inline-block';
        dotSpan.style.marginRight = '0.35rem';
        const labelSpan = document.createElement('span');
        labelSpan.textContent = `${historySeriesLabel(row.key)}: `;
        const valueEl = document.createElement('strong');
        valueEl.textContent = fmtHistoryValue(row.point.v);
        line.appendChild(dotSpan);
        line.appendChild(labelSpan);
        line.appendChild(valueEl);
        tooltip.appendChild(line);
      }
      const timeEl = document.createElement('span');
      timeEl.textContent = fmtHistoryDate(rows[0].point.t);
      tooltip.appendChild(timeEl);

      const leftPct = (sharedX / width) * 100;
      tooltip.style.left = `${Math.min(78, Math.max(2, leftPct))}%`;
    }

    function pointerLeave() {
      crosshairLine.classList.remove('active');
      for (const dot of dots) dot.classList.remove('active');
      tooltip.hidden = true;
    }

    svg.addEventListener('pointermove', pointerMove);
    svg.addEventListener('pointerdown', pointerMove);
    svg.addEventListener('pointerleave', pointerLeave);
    svg.addEventListener('pointerup', pointerLeave);
  }

  function setControlExpanded(expanded) {
    controlBody.hidden = !expanded;
    controlToggle.setAttribute('aria-expanded', String(expanded));
  }

  const FULLSCREEN_PANELS = [
    { panel: flowPanel, btn: flowFullscreenBtn },
    { panel: graphPanel, btn: graphFullscreenBtn }
  ];

  function exitFullscreen(entry) {
    if (!entry.panel.classList.contains('is-fullscreen')) return;
    entry.panel.classList.remove('is-fullscreen');
    entry.btn.textContent = '⛶';
    entry.btn.setAttribute('aria-label', 'Vollbild');
  }

  function exitAllFullscreen() {
    for (const entry of FULLSCREEN_PANELS) exitFullscreen(entry);
    document.body.classList.remove('fullscreen-active');
  }

  function toggleFullscreen(entry) {
    const goingFullscreen = !entry.panel.classList.contains('is-fullscreen');
    exitAllFullscreen();
    if (goingFullscreen) {
      entry.panel.classList.add('is-fullscreen');
      entry.btn.textContent = '✕';
      entry.btn.setAttribute('aria-label', 'Vollbild schließen');
      document.body.classList.add('fullscreen-active');
    }
    // Card size changes with fullscreen either way (graph-grid's own column count reflows),
    // so the charts need to re-measure and redraw regardless of which panel was toggled.
    renderGraphs();
  }

  // Small-multiples line/area chart, hand-rolled SVG (no charting library) to match the
  // existing flow diagram's own approach. windowStart/windowEnd position points by actual
  // time, not index, so a missed sample doesn't visually compress the gap.
  //
  // The SVG's viewBox is set to the card's *actual measured pixel size* (not a fixed virtual
  // coordinate space stretched via preserveAspectRatio="none") - a non-uniform stretch is what
  // was distorting the end/crosshair dots into ellipses whenever a card's aspect ratio differed
  // from the fixed box (mobile vs. desktop vs. fullscreen all size cards differently). Building
  // the shell first and measuring it once it's laid out avoids that entirely: the coordinate
  // space always equals the rendered pixels 1:1, so a circle is always a circle.
  const GRAPH_PAD_Y = 14;
  const GRAPH_PAD_X = 4;
  const GRAPH_PLOT_LEFT = 44; // reserved gutter for the y-axis min/max labels (incl. "-1.24 kW"), so they never sit under the curve
  const GRAPH_TICK_MS = 10 * 60 * 1000; // minor x-axis tick every 10min
  const GRAPH_MAJOR_TICK_MS = 30 * 60 * 1000; // major (taller) tick every 30min
  const SVG_NS = 'http://www.w3.org/2000/svg';

  let graphHistory = { pvEnabled: false, houseEnabled: false, points: [] };
  let graphWindowMinutes = 60;

  function fmtClock(ms) {
    return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  /**
   * Monotone cubic Hermite tangents (Fritsch-Carlson), i.e. the same curve family as D3's
   * curveMonotoneX: smooth, but - unlike a plain Catmull-Rom spline - never overshoots past a
   * point's neighbors. That matters here: an overshooting spline would draw a small fake bump
   * between two real samples, which for a power graph reads as data that didn't happen.
   */
  function monotoneTangents(xs, ys) {
    const n = xs.length;
    const d = new Array(n - 1);
    for (let i = 0; i < n - 1; i++) {
      const dx = xs[i + 1] - xs[i];
      d[i] = dx !== 0 ? (ys[i + 1] - ys[i]) / dx : 0;
    }

    const m = new Array(n);
    m[0] = d[0];
    m[n - 1] = d[n - 2];
    for (let i = 1; i < n - 1; i++) {
      m[i] = (d[i - 1] === 0 || d[i] === 0 || (d[i - 1] < 0) !== (d[i] < 0)) ? 0 : (d[i - 1] + d[i]) / 2;
    }

    for (let i = 0; i < n - 1; i++) {
      if (d[i] === 0) {
        m[i] = 0;
        m[i + 1] = 0;
        continue;
      }
      const a = m[i] / d[i];
      const b = m[i + 1] / d[i];
      const s = a * a + b * b;
      if (s > 9) {
        const t = 3 / Math.sqrt(s);
        m[i] = t * a * d[i];
        m[i + 1] = t * b * d[i];
      }
    }
    return m;
  }

  function buildSmoothPath(coords) {
    const n = coords.length;
    if (n === 2) {
      return `M${coords[0][0].toFixed(1)},${coords[0][1].toFixed(1)} L${coords[1][0].toFixed(1)},${coords[1][1].toFixed(1)}`;
    }

    const xs = coords.map(c => c[0]);
    const ys = coords.map(c => c[1]);
    const m = monotoneTangents(xs, ys);

    let d = `M${xs[0].toFixed(1)},${ys[0].toFixed(1)}`;
    for (let i = 0; i < n - 1; i++) {
      const dx = xs[i + 1] - xs[i];
      const cp1x = xs[i] + dx / 3;
      const cp1y = ys[i] + (m[i] * dx) / 3;
      const cp2x = xs[i + 1] - dx / 3;
      const cp2y = ys[i + 1] - (m[i + 1] * dx) / 3;
      d += ` C${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${xs[i + 1].toFixed(1)},${ys[i + 1].toFixed(1)}`;
    }
    return d;
  }

  /** Card shell (label, value, empty svg placeholder sized purely by CSS) - no drawing yet,
   *  so it can be measured after layout. Returns svg: null for the "collecting data" case. */
  function buildGraphCardShell(metric, windowStart) {
    const card = document.createElement('div');
    card.className = 'graph-card';

    const series = graphHistory.points
      .filter(p => typeof p[metric.key] === 'number' && Number.isFinite(p[metric.key]) && p.t >= windowStart)
      .map(p => ({ t: p.t, v: p[metric.key] }));

    const head = document.createElement('div');
    head.className = 'graph-card-head';
    const labelEl = document.createElement('span');
    labelEl.className = 'graph-card-label';
    labelEl.textContent = metric.label;
    const valueEl = document.createElement('span');
    valueEl.className = 'graph-card-value';
    valueEl.textContent = series.length ? fmtWAuto(series[series.length - 1].v) : '–';
    head.appendChild(labelEl);
    head.appendChild(valueEl);
    card.appendChild(head);

    if (series.length < 2) {
      const empty = document.createElement('div');
      empty.className = 'graph-card-empty';
      empty.textContent = 'Sammle Daten…';
      card.appendChild(empty);
      return { card, svg: null, series: null };
    }

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.classList.add('graph-svg');
    card.appendChild(svg);

    return { card, svg, series };
  }

  /** Measures the now-laid-out svg and draws into it - see the sizing note above buildSmoothPath. */
  function drawGraphCard({ card, svg, series, metric, windowStart, windowEnd }) {
    const width = svg.clientWidth;
    const height = svg.clientHeight;
    if (width === 0 || height === 0) return;

    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);

    const values = series.map(p => p.v);
    // Signed metrics (Netz/Batterie) get a symmetric scale so 0 always lands exactly on the
    // vertical center, regardless of how skewed the actual min/max are - a fixed reference line
    // instead of one that drifts card to card. Unsigned metrics (Haus/PV) keep 0 pinned to the
    // bottom edge, which Math.min(values, 0) already gives for free since they never go negative.
    let min, max;
    if (metric.signed) {
      const maxAbs = Math.max(...values.map(v => Math.abs(v)), 1);
      min = -maxAbs;
      max = maxAbs;
    } else {
      min = Math.min(...values, 0);
      max = Math.max(...values, 0);
    }
    const range = (max - min) || 1;
    const span = (windowEnd - windowStart) || 1;
    const xOf = t => GRAPH_PLOT_LEFT + ((t - windowStart) / span) * (width - GRAPH_PLOT_LEFT - GRAPH_PAD_X);
    const yOf = v => GRAPH_PAD_Y + (height - 2 * GRAPH_PAD_Y) * (1 - (v - min) / range);

    const coords = series.map(p => [xOf(p.t), yOf(p.v)]);
    const linePath = buildSmoothPath(coords);
    // Signed metrics fill between the curve and the zero-centerline (a proper diverging/baseline
    // area), not down to the card's bottom edge - otherwise the fill would cover the "wrong side"
    // of zero whenever the data stays entirely positive or entirely negative in this window.
    const baseY = (metric.signed ? yOf(0) : height - GRAPH_PAD_Y).toFixed(1);
    const areaPath = `${linePath} L${coords[coords.length - 1][0].toFixed(1)},${baseY} L${coords[0][0].toFixed(1)},${baseY} Z`;
    const last = coords[coords.length - 1];
    const peakPoint = series.reduce((best, p) => (Math.abs(p.v) > Math.abs(best.v) ? p : best), series[0]);

    // Direction paint: signed metrics fade from metric.positiveColor (top) to metric.negativeColor
    // (bottom) - see the cost-framing note above GRAPH_METRICS. userSpaceOnUse ties it to the
    // actual pixel Y, so every mark (line, area, end dot, crosshair dot) reads the correct color
    // for its own position automatically.
    let paint = `var(${metric.varColor})`;
    if (metric.signed) {
      const gradId = `graph-grad-${metric.key}`;
      const defs = document.createElementNS(SVG_NS, 'defs');
      const gradient = document.createElementNS(SVG_NS, 'linearGradient');
      gradient.setAttribute('id', gradId);
      gradient.setAttribute('gradientUnits', 'userSpaceOnUse');
      gradient.setAttribute('x1', '0');
      gradient.setAttribute('x2', '0');
      gradient.setAttribute('y1', String(GRAPH_PAD_Y));
      gradient.setAttribute('y2', String(height - GRAPH_PAD_Y));
      // Holds each hue solid across its own band and only blends in a narrow strip around zero,
      // so real data (which often clusters near zero) still reads as a clear color, not a fade.
      const topColor = `var(${metric.positiveColor})`;
      const bottomColor = `var(${metric.negativeColor})`;
      for (const [offset, color] of [
        [0, topColor],
        [38, topColor],
        [62, bottomColor],
        [100, bottomColor]
      ]) {
        const stop = document.createElementNS(SVG_NS, 'stop');
        stop.setAttribute('offset', `${offset}%`);
        stop.setAttribute('style', `stop-color:${color}`);
        gradient.appendChild(stop);
      }
      defs.appendChild(gradient);
      svg.appendChild(defs);
      paint = `url(#${gradId})`;
    }

    if (metric.signed) {
      const zeroY = yOf(0).toFixed(1);
      const zeroLine = document.createElementNS(SVG_NS, 'line');
      zeroLine.setAttribute('x1', String(GRAPH_PLOT_LEFT));
      zeroLine.setAttribute('x2', String(width - GRAPH_PAD_X));
      zeroLine.setAttribute('y1', zeroY);
      zeroLine.setAttribute('y2', zeroY);
      zeroLine.classList.add('graph-zero-line');
      svg.appendChild(zeroLine);
    }

    // Y-axis: max always (top-left), min too for signed metrics (0 is already implied by the
    // baseline for Haus/PV, so skipping it there avoids a redundant "0 W" in a very small card).
    const maxLabel = document.createElementNS(SVG_NS, 'text');
    maxLabel.classList.add('graph-axis-label');
    maxLabel.setAttribute('x', String(GRAPH_PLOT_LEFT - 6));
    maxLabel.setAttribute('y', String(GRAPH_PAD_Y + 3));
    maxLabel.setAttribute('text-anchor', 'end');
    maxLabel.textContent = fmtWAuto(max);
    svg.appendChild(maxLabel);

    if (metric.signed) {
      const minLabel = document.createElementNS(SVG_NS, 'text');
      minLabel.classList.add('graph-axis-label');
      minLabel.setAttribute('x', String(GRAPH_PLOT_LEFT - 6));
      minLabel.setAttribute('y', String(height - GRAPH_PAD_Y));
      minLabel.setAttribute('text-anchor', 'end');
      minLabel.textContent = fmtWAuto(min);
      svg.appendChild(minLabel);
    }

    // X-axis: a short tick every 10min, a taller one every 30min, between the start/end times
    // already shown as text below - dynamic to whichever window (1h/2h) is selected. Aligned to
    // real clock time (not just "every N samples"), so a missed sample doesn't shift the rhythm.
    const tickBaseY = height - GRAPH_PAD_Y;
    const firstTick = Math.ceil(windowStart / GRAPH_TICK_MS) * GRAPH_TICK_MS;
    for (let t = firstTick; t < windowEnd; t += GRAPH_TICK_MS) {
      const isMajor = t % GRAPH_MAJOR_TICK_MS === 0;
      const tick = document.createElementNS(SVG_NS, 'line');
      const tx = xOf(t).toFixed(1);
      tick.setAttribute('x1', tx);
      tick.setAttribute('x2', tx);
      tick.setAttribute('y1', String(tickBaseY));
      tick.setAttribute('y2', String(tickBaseY + (isMajor ? 7 : 3.5)));
      tick.classList.add('graph-tick');
      if (isMajor) tick.classList.add('graph-tick-major');
      svg.appendChild(tick);
    }

    const area = document.createElementNS(SVG_NS, 'path');
    area.setAttribute('d', areaPath);
    area.classList.add('graph-area');
    area.style.fill = paint;
    svg.appendChild(area);

    const line = document.createElementNS(SVG_NS, 'path');
    line.setAttribute('d', linePath);
    line.classList.add('graph-line');
    line.style.stroke = paint;
    svg.appendChild(line);

    const endDot = document.createElementNS(SVG_NS, 'circle');
    endDot.setAttribute('cx', last[0].toFixed(1));
    endDot.setAttribute('cy', last[1].toFixed(1));
    endDot.setAttribute('r', '4');
    endDot.classList.add('graph-end-dot');
    endDot.style.fill = paint;
    svg.appendChild(endDot);

    const crosshairLine = document.createElementNS(SVG_NS, 'line');
    crosshairLine.classList.add('graph-crosshair');
    crosshairLine.setAttribute('y1', String(GRAPH_PAD_Y));
    crosshairLine.setAttribute('y2', String(height - GRAPH_PAD_Y));
    crosshairLine.setAttribute('x1', last[0].toFixed(1));
    crosshairLine.setAttribute('x2', last[0].toFixed(1));
    svg.appendChild(crosshairLine);

    const crosshairDot = document.createElementNS(SVG_NS, 'circle');
    crosshairDot.classList.add('graph-crosshair-dot');
    crosshairDot.setAttribute('r', '4');
    crosshairDot.style.fill = paint;
    svg.appendChild(crosshairDot);

    // Peak annotation: skipped when the peak *is* the current/last point - the end dot and the
    // card's own header value already mark that one, a second label right next to it would just
    // repeat it. Flips above/below the point (never both) based on which half of the plot it's
    // in, and flips its text-anchor near either edge, so it can never run off the card or land on
    // top of the y-axis labels in the reserved left gutter.
    const peakIdx = series.indexOf(peakPoint);
    if (peakIdx !== series.length - 1) {
      const [px, py] = coords[peakIdx];
      const labelBelow = py < (GRAPH_PAD_Y + height - GRAPH_PAD_Y) / 2;
      // Extra clearance on the "below" side specifically: that's also where the y-axis max
      // label lives, and the peak is very often close to the max (top of the plot).
      const labelY = labelBelow ? py + 21 : py - 8;
      let anchor = 'middle';
      let labelX = px;
      if (px < GRAPH_PLOT_LEFT + 26) {
        anchor = 'start';
        labelX = GRAPH_PLOT_LEFT;
      } else if (px > width - GRAPH_PAD_X - 26) {
        anchor = 'end';
        labelX = width - GRAPH_PAD_X;
      }

      const peakDot = document.createElementNS(SVG_NS, 'circle');
      peakDot.setAttribute('cx', px.toFixed(1));
      peakDot.setAttribute('cy', py.toFixed(1));
      peakDot.setAttribute('r', '3');
      peakDot.classList.add('graph-peak-dot');
      peakDot.style.fill = paint;
      svg.appendChild(peakDot);

      const peakLabel = document.createElementNS(SVG_NS, 'text');
      peakLabel.classList.add('graph-peak-label');
      peakLabel.setAttribute('x', labelX.toFixed(1));
      peakLabel.setAttribute('y', labelY.toFixed(1));
      peakLabel.setAttribute('text-anchor', anchor);
      peakLabel.textContent = `Peak ${fmtWAuto(peakPoint.v)}`;
      svg.appendChild(peakLabel);
    }

    const rangeEl = document.createElement('div');
    rangeEl.className = 'graph-card-range';
    const startLabel = document.createElement('span');
    startLabel.textContent = fmtClock(windowStart);
    const endLabel = document.createElement('span');
    endLabel.textContent = fmtClock(windowEnd);
    rangeEl.appendChild(startLabel);
    rangeEl.appendChild(endLabel);
    card.appendChild(rangeEl);

    const tooltip = document.createElement('div');
    tooltip.className = 'graph-tooltip';
    tooltip.hidden = true;
    card.appendChild(tooltip);

    function pointerMove(evt) {
      const rect = svg.getBoundingClientRect();
      if (rect.width === 0) return;
      const px = ((evt.clientX - rect.left) / rect.width) * width;
      let nearestIdx = 0;
      let bestDist = Infinity;
      for (let i = 0; i < coords.length; i++) {
        const d = Math.abs(coords[i][0] - px);
        if (d < bestDist) { bestDist = d; nearestIdx = i; }
      }
      const [nx, ny] = coords[nearestIdx];
      const point = series[nearestIdx];

      crosshairLine.setAttribute('x1', nx.toFixed(1));
      crosshairLine.setAttribute('x2', nx.toFixed(1));
      crosshairDot.setAttribute('cx', nx.toFixed(1));
      crosshairDot.setAttribute('cy', ny.toFixed(1));
      crosshairLine.classList.add('active');
      crosshairDot.classList.add('active');

      tooltip.hidden = false;
      tooltip.innerHTML = '';
      const valueEl2 = document.createElement('strong');
      valueEl2.textContent = fmtWAuto(point.v);
      const timeEl = document.createElement('span');
      timeEl.textContent = fmtClock(point.t);
      tooltip.appendChild(valueEl2);
      tooltip.appendChild(timeEl);

      const leftPct = (nx / width) * 100;
      tooltip.style.left = `${Math.min(80, Math.max(2, leftPct))}%`;
    }

    function pointerLeave() {
      crosshairLine.classList.remove('active');
      crosshairDot.classList.remove('active');
      tooltip.hidden = true;
    }

    svg.addEventListener('pointermove', pointerMove);
    svg.addEventListener('pointerleave', pointerLeave);
  }

  function renderGraphs() {
    const metrics = GRAPH_METRICS.filter(
      m => (!m.pvOnly || graphHistory.pvEnabled) && (!m.houseOnly || graphHistory.houseEnabled)
    );
    const windowEnd = Date.now();
    const windowStart = windowEnd - graphWindowMinutes * 60000;

    graphGrid.innerHTML = '';
    const shells = metrics.map(metric => ({ metric, ...buildGraphCardShell(metric, windowStart) }));
    for (const shell of shells) graphGrid.appendChild(shell.card);

    // Drawing needs each svg's real laid-out size, which only exists once the shells above are
    // in the document - hence the separate pass instead of measuring while still detached.
    for (const shell of shells) {
      if (shell.svg) drawGraphCard({ ...shell, windowStart, windowEnd });
    }
  }

  let graphResizeTimer = null;
  function scheduleGraphResize() {
    clearTimeout(graphResizeTimer);
    graphResizeTimer = setTimeout(renderGraphs, 150);
  }
  window.addEventListener('resize', scheduleGraphResize);

  function setGraphWindow(minutes) {
    graphWindowMinutes = minutes;
    graphRange60.setAttribute('aria-pressed', String(minutes === 60));
    graphRange120.setAttribute('aria-pressed', String(minutes === 120));
    renderGraphs();
  }

  async function pollGraphHistory() {
    try {
      const res = await fetch('/api/telemetry/history', { cache: 'no-store' });
      if (!res.ok) return;
      graphHistory = await res.json();
      renderGraphs();
    } catch {
      // Transient fetch failure: keep showing the last known graphs rather than blanking them.
    }
  }

  async function poll() {
    try {
      const res = await fetch('/api/status', { cache: 'no-store' });
      if (!res.ok) throw new Error('bad response');
      const data = await res.json();
      render(data);
      connIndicator.classList.remove('offline');
    } catch {
      connIndicator.classList.add('offline');
    } finally {
      setTimeout(poll, POLL_MS);
    }
  }

  function render(data) {
    const mode = data.status.mode || 'idle';
    modeBadge.textContent = mode;
    modeBadge.className = `mode-badge ${mode}`;

    const batteryW = data.multiDevice ? data.status.totalPowerW : data.status.currentPowerW;
    const gridW = data.status.gridPowerW;
    const soc = data.multiDevice ? data.status.avgSoc : data.status.batterySoc;
    const houseEnabled = !!(data.house && data.house.enabled);
    const houseW = houseEnabled ? data.house.powerW : null;
    const pvW = data.pv && data.pv.enabled ? data.pv.powerW : null;

    gridPowerValue.textContent = fmtWAuto(gridW);
    // No house datapoint configured: show the node without a value instead of a placeholder like
    // "– W", which reads as broken/missing data rather than "not measured" (issue #22).
    housePowerValue.textContent = houseEnabled ? fmtWAuto(houseW) : '';
    pvPowerValue.textContent = fmtWAuto(pvW);
    batteryPowerValue.textContent = fmtWAuto(batteryW);
    batterySocValue.textContent = soc !== null && soc !== undefined ? `${Math.round(soc)}%` : '–%';

    // Live-only metrics, not backed by their own datapoint - derived from the same power values
    // already on screen. Without a house meter, house consumption falls back to the hub's own
    // balance (grid + battery + PV), same as houseDir below (#22): always computable, no hiding.
    const houseConsumptionW = houseEnabled ? houseW : (gridW || 0) + (batteryW || 0) + (pvW || 0);
    const gridImportW = Math.max(gridW || 0, 0);
    const gridExportW = Math.max(-(gridW || 0), 0);
    const autarkyPct = houseConsumptionW > 0 ? Math.max(0, Math.min(100, (1 - gridImportW / houseConsumptionW) * 100)) : 100;
    const selfConsumptionPct = pvW > 0 ? Math.max(0, Math.min(100, (1 - gridExportW / pvW) * 100)) : 0;

    autarkyValue.textContent = `${Math.round(autarkyPct)}%`;
    autarkyRing.style.stroke = pctToRingColor(autarkyPct);
    selfConsumptionValue.textContent = `${Math.round(selfConsumptionPct)}%`;
    selfConsumptionRing.style.stroke = pctToRingColor(selfConsumptionPct);

    // SVGElement doesn't reliably reflect the .hidden IDL property to the attribute
    // (unlike HTMLElement), so toggle the attribute directly.
    const pvEnabled = !!(data.pv && data.pv.enabled);
    if (pvEnabled) pvGroup.removeAttribute('hidden');
    else pvGroup.setAttribute('hidden', '');

    const socPct = Math.max(0, Math.min(100, soc || 0));
    const fillHeight = (BATTERY_HEIGHT * socPct) / 100;
    batteryFillRect.setAttribute('height', String(fillHeight));
    batteryFillRect.setAttribute('y', String(BATTERY_TOP + BATTERY_HEIGHT - fillHeight));
    batteryFillRect.classList.toggle('low', socPct < 15);
    batteryFillRect.classList.toggle('mid', socPct >= 15 && socPct < 30);

    const THRESHOLD = 5;
    // PV/Netz/Haus connectors are defined satellite-first, hub-second: 'fwd'(green) = into the
    // hub, 'rev'(amber) = out of it. The battery connector is defined hub-first instead, so
    // 'fwd'(green) = charging and 'rev'(amber) = discharging - matching the mode badge's own
    // green-when-charging/amber-when-discharging convention instead of the generic hub-relative one.
    const gridDir = gridW > THRESHOLD ? 'fwd' : gridW < -THRESHOLD ? 'rev' : null; // import=into hub, export=out
    const batteryDir = batteryW < -THRESHOLD ? 'fwd' : batteryW > THRESHOLD ? 'rev' : null; // charge=fwd, discharge=rev

    // No house datapoint configured: derive flow *direction only* (never a fabricated wattage)
    // from the hub's own power balance - grid net-import + battery net-discharge + PV production
    // is whatever power isn't otherwise accounted for, i.e. it's going to the house (issue #22).
    const houseDir = houseEnabled
      ? (houseW > THRESHOLD ? 'rev' : null)
      : ((gridW || 0) + (batteryW || 0) + (pvW || 0) > THRESHOLD ? 'rev' : null); // consumption only ever flows out of the hub
    const pvDir = pvW > THRESHOLD ? 'fwd' : null; // production only ever flows into the hub

    setFlow(flowLineGridHub, nodeGrid, gridDir);
    setFlow(flowLineBatteryHub, batteryHero, batteryDir);
    setFlow(flowLineHausHub, nodeHaus, houseDir);
    if (pvEnabled) setFlow(flowLinePvHouse, nodePv, pvDir);

    hub.classList.toggle('active', !!(gridDir || batteryDir || houseDir || pvDir));

    const waterfillActive = data.multiDevice && data.multiDeviceDistributionStrategy === 'waterfill';
    for (const key of WATERFILL_AMBIGUOUS_KEYS) {
      const row = controlRows[key];
      if (row) row.hidden = waterfillActive;
    }
    controlHint.hidden = !waterfillActive;

    renderDeviceCards(data.devices, waterfillActive);
    updateControls(data.control);

    emergencyReason.textContent = data.status.emergencyReason || '';
    if (data.status.lastUpdate) {
      lastUpdate.textContent = new Date(data.status.lastUpdate).toLocaleTimeString();
    }
  }

  batteryHero.addEventListener('click', () => openDetails(null));
  detailsClose.addEventListener('click', closeDetails);
  detailsOverlay.addEventListener('click', e => { if (e.target === detailsOverlay) closeDetails(); });

  menuBtn.addEventListener('click', () => menuOverlay.hidden ? openMenu() : closeMenu());
  menuOverlay.addEventListener('click', e => { if (e.target === menuOverlay) closeMenu(); });
  menuTelemetry.addEventListener('click', openTelemetry);
  telemetryClose.addEventListener('click', closeTelemetry);
  telemetryOverlay.addEventListener('click', e => { if (e.target === telemetryOverlay) closeTelemetry(); });

  menuHistory.addEventListener('click', openHistory);
  historyClose.addEventListener('click', closeHistory);
  historyOverlay.addEventListener('click', e => { if (e.target === historyOverlay) closeHistory(); });

  controlToggle.addEventListener('click', () => setControlExpanded(controlBody.hidden));

  flowFullscreenBtn.addEventListener('click', () => toggleFullscreen(FULLSCREEN_PANELS[0]));
  graphFullscreenBtn.addEventListener('click', () => toggleFullscreen(FULLSCREEN_PANELS[1]));
  graphRange60.addEventListener('click', () => setGraphWindow(60));
  graphRange120.addEventListener('click', () => setGraphWindow(120));

  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    closeDetails();
    closeMenu();
    closeTelemetry();
    closeHistory();
    exitAllFullscreen();
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/service-worker.js').catch(() => {});
  }

  fetch('/api/influx/enabled', { cache: 'no-store' })
    .then(res => res.json())
    .then(data => { if (data && data.enabled) menuHistory.hidden = false; })
    .catch(() => {});

  buildControlPanel();
  setControlExpanded(false);
  poll();
  pollGraphHistory();
  setInterval(pollGraphHistory, GRAPH_POLL_MS);
})();
