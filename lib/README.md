# Library Modules - Zendure Automation

## Modulare Architektur

Die Automation-Logik ist in 6 unabhängige Module aufgeteilt:

### 📊 **DataReader.js**
**Verantwortlich für:** Alle Datenabfragen aus ioBroker States
- Grid Power (Netzleistung)
- Battery SOC (Ladestand)
- Battery Power (Batterieleistung)
- Pack Voltage (Zellspannung aller Packs)
- Target Grid Power (Ziel-Netzleistung)

**Keine Business-Logik** - nur reine Datenabfrage.

---

### 🚨 **EmergencyManager.js**
**Verantwortlich für:** Notfall-Erkennung und Recovery-Modi
- Emergency Charging (kritische Zustände)
- Emergency Recovery (Entlade-Blockade nach Notfall)
- Voltage Recovery (Spannungsschutz mit Hysterese)
- Wiederherstellung persistenter States beim Neustart

**Höchste Priorität** - kann alle anderen Module überschreiben.

---

### 🔄 **RelayProtection.js**
**Verantwortlich für:** Schutz der Hardware-Relais
- Tick-Counter für Discharge → Charge (-150W, 5 Zyklen)
- Tick-Counter für Charge → Discharge (+200W, 3 Zyklen)
- Relay-Schutz (wartet auf ~0W vor dem Schalten)
- 350W Hysterese-Zone zwischen Modi

**Verhindert:** Übermäßigen Relay-Verschleiß durch häufiges Schalten.

---

### 🛡️ **SafetyLimiter.js**
**Verantwortlich für:** Alle Safety-Checks (nicht überschreibbar)
- SOC-basierter Entladeschutz (z.B. < 20%)
- Spannungsbasierter Entladeschutz (z.B. < 3.0V)
- Emergency Recovery Blocking
- Device-Flags (lowVoltageBlock, fullChargeNeeded)
- Enable/Disable Flags (Charge/Discharge)

**Absolute Priorität** - überschreibt Regelung und Ramping.

---

### ⚙️ **PowerRegulator.js**
**Verantwortlich für:** Leistungsregelung und Glättung
- Hysteresis (50W Totzone gegen Oszillation)
- Ramping (Charge: 100W/s, Discharge: 400W/s)
- Absolute Limits (max charge/discharge 1600W)
- Power Rounding (auf 10W)

**I-Regler Basis** - nutzt `lastSetPower` für stabile Regelung.

---

### ✅ **ValidationService.js**
**Verantwortlich für:** Setpoint-Validierung (non-blocking)
- Validiert **nur Charge-Setpoints** (Discharge ändert zu oft)
- Retry-Logik (5 Versuche à 5s)
- Erkennt API-Kommunikationsprobleme
- Vermeidet unnötige Schreiboperationen

**Non-blocking** - validiert im nächsten Zyklus.

---

## Datenfluss

```
┌─────────────────────────────────────────────────────┐
│  1. DataReader: Liest alle Sensordaten             │
└─────────────────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────┐
│  2. EmergencyManager: Prüft Notfälle                │
│     → Emergency? → Sofort 800W laden, exit          │
└─────────────────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────┐
│  3. I-Regler Berechnung:                            │
│     newPower = lastSetPower + (grid - target)       │
└─────────────────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────┐
│  4. RelayProtection: Mode Switching Guards          │
│     → Tick-Counter + 10W Relay-Check                │
└─────────────────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────┐
│  5. SafetyLimiter: Absolute Safety Checks           │
│     → SOC/Voltage/Recovery → KANN AUF 0W SETZEN     │
└─────────────────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────┐
│  6. PowerRegulator: Glättung & Limits               │
│     → Hysteresis → Ramping → Absolute Limits        │
│     (nur wenn kein Safety-Limit aktiv!)             │
└─────────────────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────┐
│  7. ValidationService: Schreibt + validiert         │
│     → Nur Charge-Setpoints werden validiert         │
└─────────────────────────────────────────────────────┘
```

## Verwendung in main.js

```javascript
const DataReader = require('./lib/DataReader');
const EmergencyManager = require('./lib/EmergencyManager');
const RelayProtection = require('./lib/RelayProtection');
const SafetyLimiter = require('./lib/SafetyLimiter');
const PowerRegulator = require('./lib/PowerRegulator');
const ValidationService = require('./lib/ValidationService');

// In constructor:
this.dataReader = new DataReader(this, this._deviceBasePath);
this.emergencyMgr = new EmergencyManager(this, this._deviceBasePath);
this.relayProtection = new RelayProtection(this);
this.safetyLimiter = new SafetyLimiter(this, this._deviceBasePath);
this.powerRegulator = new PowerRegulator(this);
this.validationService = new ValidationService(this);

// In runAutomationCycle():
// 1. Validate previous setpoint
await this.validationService.validateSetpoint(this.config, actualPowerW);

// 2. Read data
const gridPowerW = await this.dataReader.getGridPowerW(this.config.powerMeterDp);
const batterySoc = await this.dataReader.getBatterySoc();
// ... etc

// 3. Check emergency
const emergencyState = await this.emergencyMgr.checkEmergencyConditions(...);

// 4. Calculate new power (I-Regler)
let newPowerW = lastSetPower + (gridPowerW - targetGridPowerW);

// 5. Apply relay protection
const relayResult = this.relayProtection.applyProtection({...});
newPowerW = relayResult.powerW;

// 6. Apply safety limits
const safetyResult = await this.safetyLimiter.applySafetyLimits({...});
newPowerW = safetyResult.powerW;

// 7. Apply regulation (if no safety active)
const regResult = this.powerRegulator.applyRegulation({...});
newPowerW = regResult.powerW;

// 8. Write power
await this.validationService.writePowerSetpoint(this._deviceBasePath, newPowerW);
```

## Testing

Jedes Modul ist **isoliert testbar**:
- Mock den adapter
- Teste einzelne Funktionen
- Keine Abhängigkeiten zwischen Modulen (außer EmergencyManager ↔ SafetyLimiter)

## Vorteile

✅ **Klare Verantwortlichkeiten** - jedes Modul macht nur eine Sache  
✅ **Testbarkeit** - Module können einzeln getestet werden  
✅ **Wartbarkeit** - Änderungen lokal begrenzt  
✅ **Wiederverwendbarkeit** - z.B. RelayProtection für andere Projekte  
✅ **Debugging** - Fehler schnell lokalisierbar  

## Migration

Die Integration erfolgt **schrittweise**:
1. Module existieren parallel zum alten Code
2. Nach und nach werden Funktionen durch Modul-Aufrufe ersetzt
3. Alte Code-Teile werden entfernt
4. Vollständige Tests nach jedem Schritt
