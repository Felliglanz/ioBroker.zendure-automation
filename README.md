# ioBroker.zendure-automation

![Logo](admin/zendure-automation.png)

Automatische Batteriesteuerung für Zendure Solarflow Geräte mit ZenSDK-Unterstützung (1600AC+, 2400AC+).

## 🎯 Wofür ist der Adapter?

Dieser Adapter steuert deine Zendure Solarflow Batterie vollautomatisch, um **Null-Einspeisung und Null-Netzbezug** zu erreichen. Er überwacht kontinuierlich deine Netz-Leistung und regelt Laden/Entladen der Batterie, um diese auszugleichen.

**Ergebnis:** Maximale Eigenverbrauchsquote und minimale Netzbezugskosten! ⚡

---

## ✨ Hauptfunktionen

### 🎯 Zero-Grid Regelung
- Automatisches Ziel: 0W Netzbezug/-einspeisung (konfigurierbar)
- Dynamischer Power-Limiter Algorithmus (inspiriert von OpenDTU-OnBattery)
- Schnelle Reaktion: Updates alle 5 Sekunden
- Stabile Regelung durch Verwendung des letzten gesetzten Werts (verhindert Oszillation)

### 🛡️ Intelligenter Batterieschutz
- **SOC-basierter Schutz**: Min/Max SOC Limits (10-100%)
- **Spannungsbasierter Schutz**: Min. Zellspannung pro Pack (typisch 3.0V für LFP)
- **Voltage Recovery Hysterese**: Verhindert Oszillation nach Spannungsabschaltung (0.1V default)
- **Emergency Charging**: Automatisches Notladen bei kritischer Spannung (<2.8V)
- **Recovery Mode**: Sicheres Wiederaufladen nach Notladung oder Tiefentladung
- **Multi-Pack Überwachung**: Überwacht alle Batteriepacks individuell

### ⚙️ Mode-Switching Protection (Anti-Oszillation)
- **Feed-in Counter**: Verhindert schnelles Umschalten von Entladen→Laden (25 Sek Verzögerung)
- **Discharge Counter**: Verhindert schnelles Umschalten von Laden→Entladen (15 Sek Verzögerung)
- **Hardware-Schutz**: Minimiert Relais-Schaltvorgänge, verlängert Lebensdauer
- Ideal für bewölkte Tage mit schwankender PV-Produktion!

### 🎚️ Sanfte Regelung
- **Hysterese**: 50W Deadband (verhindert häufige Mini-Anpassungen)
- **Asymmetrische Ramp Limits**:
  - Charge Ramp: 100W/Zyklus (sanftes Laden)
  - Discharge Ramp: 400W/Zyklus (schnelle Reaktion auf Last)
- Ladeleistung passt sich automatisch an Last-Änderungen an

### 📊 Monitoring & Debug
- **Status States**: mode, gridPowerW, batterySoc, currentPowerW, minPackVoltageV
- **Counter States**: feedInCounter, dischargeCounter (Sichtbarkeit der Schaltlogik)
- **Emergency Reason**: Zeigt Grund für Emergency/Recovery Mode
- **Debug Logging**: Detaillierte Logs auf debug-Level für Troubleshooting

---

## 📋 Voraussetzungen

- ioBroker Installation
- [nograx''s zendure-solarflow Adapter](https://github.com/nograx/ioBroker.zendure-solarflow) installiert und konfiguriert
- Zendure Gerät mit ZenSDK-Unterstützung:
  - Solarflow 1600AC+  
  - Solarflow 2400AC+
  - Andere ZenSDK-Geräte sollten auch funktionieren
- Netz-Leistungsmesser Datenpunkt (von Shelly, Tasmota, etc.)

---

## 🚀 Installation

### Von GitHub (Empfohlen)

1. In ioBroker Admin → Adapter → Von eigener URL installieren:
   ```
   https://github.com/Felliglanz/iobroker.zendure-automation
   ```

### Manuelle Installation

1. Repository klonen oder herunterladen
2. Im Verzeichnis:
   ```bash
   cd iobroker.zendure-automation
   npm install
   npm pack
   ```
3. Generierte `.tgz` Datei in ioBroker Admin hochladen

---

## ⚙️ Konfiguration

### Geräte-Einstellungen

1. **Zendure Solarflow Instanz**: Deine nograx Adapter-Instanz (z.B. `zendure-solarflow.0`)
2. **ProductKey & DeviceKey**: Find

est du im zendure-solarflow Objektbaum
3. **Update-Intervall**: 5 Sekunden empfohlen

### Netz-Leistungsmesser

Wähle den Datenpunkt aus, der deine aktuelle Netzleistung liefert:
- **Positive Werte** = Netzbezug (Strom vom Netz)
- **Negative Werte** = Netzeinspeisung (Strom ins Netz)

Beispiel-Quellen:
- Shelly 3EM: `shelly.0.SHELLY3EM-XXX.Emeter.0.Power`
- Tasmota: `mqtt.0.tele.tasmota.SENSOR.ENERGY.Power`

### Automatisierungs-Einstellungen

- **Target Grid Power**: Normalerweise `0` W (kann angepasst werden für leichten Bezug/Einspeisung)
- **Max. Lade-Leistung**: Maximale Ladeleistung deines Geräts (z.B. 1600W)
- **Max. Entlade-Leistung**: Maximale Entladeleistung deines Geräts (z.B. 1400W bei 1600AC+)

### Batterieschutz

**Schutz-Modus wählen:**
- **SOC (%)**: Traditioneller SOC-basierter Schutz (einfacher, Standard)
- **Spannung (V)**: Überwacht minimale Zellspannung aller Batteriepacks

**SOC-Modus Parameter:**
- **Min SOC**: Entladung stoppen unter diesem Prozentsatz (z.B. 10%)
- **Max SOC**: Ladung stoppen über diesem Prozentsatz (z.B. 100%)

**Spannungs-Modus Parameter:**
- **Min. Pack-Zellspannung**: Entladung stoppen wenn IRGENDEIN Pack unter diese Spannung fällt (typisch: 3.0V für LFP)
- **Voltage Recovery Hysterese**: Spannung muss um diesen Wert steigen bevor Entladung wieder erlaubt (0.1V default)
  - Verhindert Oszillation durch Spannungs-Relaxation nach Lastabschaltung
  - Beispiel: Min.=3.0V, Hysterese=0.1V → Recovery bei 3.1V

💡 **Multi-Pack Überwachung:**  
Bei Systemen mit mehreren Batteriepacks (z.B. AB1000 + AB2000 Stack) liest der Spannungs-Modus jedes Pack''s `minVol` individuell und verwendet den **niedrigsten Wert**. So wird das schwächste Pack vor Tiefentladung geschützt!

### Emergency Charging & Recovery

Der Adapter überwacht kritische Batterie-Zustände:

**Geräte-Schutzflags:**
- `lowVoltageBlock`: Gerät meldet kritische Niedrigspannung → Entladung sofort stoppen
- `fullChargeNeeded`: Gerät fordert Vollladezyklus (Kalibrierung) → Laden auf 100% erzwingen

**Kritische Spannungs-Überwachung:**
- Wenn IRGENDEIN Pack unter `emergencyChargeVoltageV` (default: 2.8V) fällt
  → Emergency Charging mit `emergencyChargePowerW` (default: 800W)
- **Höchste Priorität**: Übersteuert alle anderen Automatisierungen

**Recovery Mode:**
Nach Emergency Charging (bei `emergencyExitSoc`, default 20%):
- Fortsetzung Laden mit **normaler Grid-Automation** (z.B. nur bei PV-Überschuss)
- **Entladung blockiert** bis `emergencyRecoverySoc` erreicht (default: 30%)
- Verhindert Endlos-Schleifen (Emergency → Discharge → Emergency)

### Mode-Switching Protection (Relay-Schutz)

Schützt Hardware-Relais vor übermäßigem Schalten, besonders bei bewölkten Tagen:

**Feed-in Protection (Entladen→Laden):**
- **Feed-in Threshold**: -150W (Einspeisung nötig um Laden zu starten)
- **Feed-in Delay**: 5 Ticks (25 Sekunden) - Einspeisung muss nachhaltig sein

**Discharge Protection (Laden→Entladen):**
- **Discharge Threshold**: 200W (Netzbezug nötig um Entladen zu starten)
- **Discharge Delay**: 3 Ticks (15 Sekunden) - Netzbezug muss nachhaltig sein

⚡ **Bidirektionaler Schutz:**  
Beide Richtungen sind verzögert → Kein Hin-und-Her bei Wolken!

### Feinabstimmung

**Hysterese:**
- Standard: 50W
- Minimale Leistungsänderung die zu einer Aktion führt
- Verhindert häufige Mini-Anpassungen

**Ramp Limits (Änderungsgeschwindigkeit):**
- **Charge Ramp**: 100W/Zyklus (sanftes Laden)
- **Discharge Ramp**: 400W/Zyklus (schnelle Reaktion auf Last)
- Verhindert aggressive Sprünge, schont Hardware

---

## 🧮 Wie es funktioniert

### Der Algorithmus  

Inspiriert vom [OpenDTU-OnBattery Dynamic Power Limiter](https://github.com/hoylabs/OpenDTU-OnBattery):

```javascript
neueBatterieLeistung = letzteBatterieLeistung + (ZielNetzleistung - aktuelleNetzleistung)
```

**Beispiel 1**: Netz zieht 300W, Ziel ist 0W, Batterie idle
- `neueBatterieLeistung = 0 + (0 - 300) = -300W` → **Entladen mit 300W**

**Beispiel 2**: Netz speist 200W ein, Ziel ist 0W, Batterie idle  
- `neueBatterieLeistung = 0 + (0 - (-200)) = +200W` → **Laden mit 200W**

### Vorzeichen-Konvention

- **Batterie-Leistung**:
  - Negativ = Laden (z.B. -500W = laden mit 500W)
  - Positiv = Entladen (z.B. +800W = entladen mit 800W)
- **Netz-Leistung**:
  - Positiv = Netzbezug
  - Negativ = Netzeinspeisung

---

## 📊 Status-Überwachung

Der Adapter erstellt folgende States unter `zendure-automation.0.*`:

### Control States
- `control.enabled`: Automation aktivieren/deaktivieren
- `control.targetGridPowerW`: Ziel-Netzleistung (änderbar zur Laufzeit)

### Status States
- `status.mode`: Aktueller Modus (idle/charging/discharging/standby/emergency-charging/recovery/error)
- `status.currentPowerW`: Aktuelle Batterieleistung
- `status.gridPowerW`: Aktuelle Netzleistung
- `status.batterySoc`: Aktueller Batterie-SOC
- `status.minPackVoltageV`: Minimale Pack-Zellspannung (bei Spannungs-Modus)
- `status.feedInCounter`: Feed-in Delay-Counter (0-5)
- `status.dischargeCounter`: Discharge Delay-Counter (0-3)
- `status.emergencyReason`: Grund für Emergency-Modus (falls aktiv)
- `status.lastUpdate`: Letzter Update-Zeitstempel

---

## 🎯 Erfolgsbeispiel

**Real-World Performance (User-validiert):**
- ✅ 97% Autarkie erreicht (bei 1400W Entladeleistung)
- ✅ Besser als OpenDTU-OnBattery (User-Feedback  

)
- ✅ Stabile Null-Grid-Regelung
- ✅ Schnelle Reaktion auf Lastspitzen (400W Discharge Ramp)
- ✅ Sanftes Laden bei PV-Überschuss (100W Charge Ramp)
- ✅ 100% lokale Steuerung via ZenSDK (keine Cloud!)

---

## 📜 Changelog

### 0.5.0 (2026-03-25)
- ✨ **NEU:** Voltage Recovery Hysterese - Verhindert Oszillation nach Spannungsabschaltung
- ✨ **NEU:** Bidirektionaler Mode-Switching Schutz (Feed-in + Discharge Counter)
- ✨ **NEU:** Separate Ramp Limits für Laden/Entladen (asymmetrisch)
- 🐛 **FIX:** Feed-in Protection nur beim Übergang, nicht während Laden
- 🐛 **FIX:** minPackVoltageV State wird immer aktualisiert (unabhängig vom Protection Mode)
- 🐛 **FIX:** Admin UI Dark Mode - Explizite Textfarben für Info-Boxen
- 🐛 **FIX:** Logging-Optimierung - Routine-Logs auf debug-Level verschoben
- 🔧 Admin UI komplett auf Deutsch/Englisch übersetzt
- 🔧 jsonConfig Schema-Validierung (alle "def" Felder entfernt)
- 📚 README vollständig auf Deutsch

### 0.4.0 (2026-03-24)
- ✨ Initial Release mit Core-Features
- ✨ Zero-Grid Regelung mit dynamischem Power Limiter
- ✨ SOC und Voltage-basierte Batterieschutz-Modi
- ✨ Emergency Charging & Recovery Mode
- ✨ Multi-Pack Voltage Monitoring
- ✨ Feed-in Switching Protection
- 🎨 Vollständige Admin UI mit jsonConfig

---

## 📄 Lizenz

MIT License - Siehe [LICENSE](LICENSE) Datei

---

## 🙏 Credits

- Inspiriert von [OpenDTU-OnBattery Dynamic Power Limiter](https://github.com/hoylabs/OpenDTU-OnBattery)
- Basiert auf [nograx''s ioBroker.zendure-solarflow Adapter](https://github.com/nograx/ioBroker.zendure-solarflow)
- Zendure Logo © Zendure Technology GmbH

---

## ⚠️ Haftungsausschluss

Dieser Adapter wird von der Community entwickelt und ist **nicht offiziell** von Zendure unterstützt.  
Verwendung auf eigene Gefahr. Der Autor übernimmt keine Haftung für Schäden an Hardware oder Datenverlust.

**Wichtig:** Stelle sicher, dass deine Batterie-Schutzeinstellungen (Min/Max SOC, Min. Spannung) korrekt konfiguriert sind!