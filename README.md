# ioBroker.zendure-automation

![Logo](admin/zendure-automation.png)

**Intelligente Zero-Grid Automation für Zendure Solarflow** – Automatische Batteriesteuerung für maximale Autarkie mit lokaler ZenSDK-Kontrolle.

## 🎯 Was macht dieser Adapter?

Steuert deine Zendure Solarflow Batterie vollautomatisch für **Null-Einspeisung** und **Null-Netzbezug**. Überwacht kontinuierlich die Netzleistung und gleicht sie durch intelligentes Laden/Entladen aus.

**Ergebnis:** 97%+ Autarkie, minimale Netzbezugskosten, 100% lokal via ZenSDK! ⚡

---

## ✨ Features im Überblick

### 🎯 Intelligente Regelung
- **I-Regler Algorithmus** (inspiriert von OpenDTU-OnBattery) – stabile, präzise Regelung
- **5s Update-Intervall** – schnelle Reaktion auf Lastwechsel
- **Operating Deadband** – verhindert Relais-Flattern bei Schwingung um 0W
- **Asymmetrische Rampen** – sanftes Laden (100W/Zyklus), schnelles Entladen (400W/Zyklus)
- **Hysterese (50W)** – keine Mini-Anpassungen bei kleinen Schwankungen

### 🛡️ Batterie- & Hardware-Schutz
- **Multi-Pack Voltage Monitoring** – überwacht jedes Pack individuell
- **SOC- oder Spannungs-basiert** – wählbarer Schutz-Modus
- **Emergency Charging** – automatisches Notladen bei kritischer Spannung
- **Recovery Mode** – verhindert Entlade-Schleifen nach Notladung
- **Relay Protection** – minimiert Schaltvorgänge, verlängert Hardware-Lebensdauer
- **Power Validation** – prüft ob Gerät Setpoints annimmt (mit Auto-Retry)

### ⚙️ Mode-Switching Protection
- **Bidirektionaler Schutz** – verzögert beide Richtungen (Charge↔Discharge)
- **Feed-in Delay** – 5 Ticks (25s) nachhaltige Einspeisung bevor Charge
- **Discharge Delay** – 3 Ticks (15s) nachhaltiger Bezug bevor Discharge
- **10W Safe-Switch** – Relais schaltet nur bei minimalem Strom (~0.04A)
- **Operating Deadband (neu)** – hält bei ±5W für 1 Tick vor Nulldurchgang

### 🏗️ Moderne Architektur
- **Modulare Struktur** – 6 spezialisierte Module (v0.6.0 Refactoring)
- **59% Code-Reduktion** – von 948 auf 388 Zeilen in main.js
- **Testbar & Wartbar** – klare Trennung der Verantwortlichkeiten
- **Vollständig dokumentiert** – JSDoc, inline comments, deutsch/englisch

---

## 📋 Voraussetzungen

- ioBroker Installation
- [nograx's zendure-solarflow Adapter](https://github.com/nograx/ioBroker.zendure-solarflow) (installiert & konfiguriert)
- Zendure Gerät mit ZenSDK: Solarflow 1600AC+, 2400AC+ oder kompatibel
- Netz-Leistungsmesser (z.B. Shelly 3EM, Tasmota, etc.)

---

## 🚀 Quick Start

### Installation

In ioBroker Admin → Adapter → Von eigener URL:
```
https://github.com/Felliglanz/iobroker.zendure-automation
```

### Basis-Konfiguration

1. **⚙️ Basic Settings**
   - Zendure Instanz: `zendure-solarflow.0`
   - ProductKey & DeviceKey: Aus zendure-solarflow Objektbaum kopieren
   - Power Meter Datapoint: Dein Netzleistungs-Sensor (Positiv=Bezug, Negativ=Einspeisung)

2. **🎯 Zero Grid Control**
   - Target Grid Power: `0` W (für perfekte Nulleinspeisung)
   - Update Interval: `5` Sekunden (empfohlen)
   - Max Charge/Discharge Power: Laut Geräte-Spezifikation

3. **🔋 Battery Protection**
   - Wähle Schutz-Modus: **SOC** (einfach) oder **Voltage** (präzise)
   - **SOC-Modus**: Min SOC 10%, Max SOC 100%
   - **Voltage-Modus**: Min Voltage 3.0V (LFP), Hysterese 0.1V

**Das war's!** Standardwerte für Relay Protection, Regulation und Emergency sind bereits optimal eingestellt.

---

## ⚙️ Erweiterte Konfiguration

### 🔋 Batterieschutz-Modi im Detail

**SOC-Modus (Empfohlen für Single-Pack)**
- Einfach, zuverlässig
- Min/Max SOC Prozent-Grenzen
- Nutzt SOC vom Gerät

**Voltage-Modus (Empfohlen für Multi-Pack)**
- Überwacht `packData.*.minVol` jedes Packs
- Verwendet niedrigsten Wert (schützt schwächstes Pack)
- Voltage Recovery Hysterese verhindert Oszillation durch Relaxation
- Beispiel: Min 3.0V + Hysterese 0.1V → Recovery erst bei 3.1V

### ⚡ Relay Protection (Anti-Verschleiß)

Schützt Hardware vor übermäßigem Schalten, speziell bei wechselhaftem Wetter:

| Parameter | Emp. Wert | Beschreibung |
|-----------|-----------|--------------|
| **Feed-in Threshold** | -150W | Einspeisung nötig für Charge-Start |
| **Feed-in Delay** | 5 Ticks | 25s nachhaltige Einspeisung |
| **Discharge Threshold** | 200W | Netzbezug nötig für Discharge-Start |
| **Discharge Delay** | 3 Ticks | 15s nachhaltiger Bezug |
| **Operating Deadband** | 5W | Minimum-Power vor Nulldurchgang |

**Operating Deadband (v0.6.1 neu):**
- Hält bei ±5W für 1 Tick bevor 0W oder Vorzeichenwechsel erlaubt
- Verhindert Relais-Flattern bei Oszillation um Zielwert
- Arbeitet mit 10W Safe-Switch zusammen (Schaltet nur bei ~0.04A)

### 🎚️ Regelparameter

| Parameter | Default | Zweck |
|-----------|---------|-------|
| **Hysteresis** | 50W | Mindest-Änderung für Reaktion |
| **Charge Ramp** | 100W/Zyklus | Sanftes Laden |
| **Discharge Ramp** | 400W/Zyklus | Schnelle Last-Reaktion |

**Tipp:** Höhere Rampen = aggressiver, niedrigere = sanfter & hardware-schonend

### 🚨 Emergency & Recovery

**Emergency Charging** (höchste Priorität):
- Aktiviert bei: `lowVoltageBlock` Flag ODER Spannung < 2.8V
- Lädt mit 800W bis Exit-SOC (20%)
- Übersteuert alle anderen Automatisierungen

**Recovery Mode**:
- Aktiv von 20% bis 30% SOC (konfigurierbar)
- **Entladung blockiert**, weiter Laden erlaubt (nur bei PV-Überschuss)
- Verhindert Emergency-Schleifen

---

## 🧮 Wie funktioniert der Algorithmus?

**I-Regler Formel** (inspiriert von OpenDTU-OnBattery):
```javascript
neueBatterieLeistung = letzteBatterieLeistung + (aktuelleNetzleistung - ZielNetzleistung)
```

**Beispiele:**
- Netz zieht 300W, Ziel 0W → Batterie entlädt mit 300W
- Netz speist 200W ein, Ziel 0W → Batterie lädt mit 200W

**Vorzeichen:**
- Batterie: Negativ=Laden, Positiv=Entladen
- Netz: Positiv=Bezug, Negativ=Einspeisung

---

## 📊 States & Monitoring

### Control
- `control.enabled` – Automation an/aus
- `control.targetGridPowerW` – Zielwert änderbar

### Status
- `status.mode` – Modus: idle/charging/discharging/standby/emergency/recovery/error
- `status.currentPowerW` – Aktuelle Batterieleistung
- `status.gridPowerW` – Aktuelle Netzleistung
- `status.batterySoc` – Aktueller SOC
- `status.minPackVoltageV` – Minimale Pack-Spannung
- `status.feedInCounter` / `dischargeCounter` – Delay-Counter (Debug)
- `status.emergencyReason` – Grund für Emergency-Modus

---

## 📜 Changelog

### v0.6.1 (2026-04-03)
- ✨ **Operating Deadband Protection** – verhindert Relais-Flattern bei Oszillation
- Hält bei ±5W für 1 Tick vor Nulldurchgang
- Reduziert Schaltvorgänge ohne Regelung zu verlangsamen

### v0.6.0 (2026-03-28)
- 🏗️ **Major Refactoring** – Modulare Architektur mit 6 spezialisierten Modulen
- 59% Code-Reduktion (948→388 Zeilen in main.js)
- Verbesserte Wartbarkeit, Testbarkeit und Dokumentation

### v0.5.8 (2026-03-27)
- 🐛 Power Validation akzeptiert Geräte-Ramping während Charge

### v0.5.7 (2026-03-26)
- ✨ Non-blocking Power Setpoint Validation mit Auto-Retry

### v0.5.5 (2026-03-25)
- 🐛 **Critical Fix**: Persistenter Emergency Recovery über Adapter-Neustarts

### v0.5.0 (2026-03-25)
- ✨ Voltage Recovery Hysterese
- ✨ Bidirektionaler Mode-Switching Schutz
- ✨ Asymmetrische Ramp Limits

### v0.4.0 (2026-03-24)
- 🎉 Initial Release

[Vollständiger Changelog](https://github.com/Felliglanz/iobroker.zendure-automation/releases)

---

## 🎯 Real-World Performance

**User-validierte Ergebnisse:**
- ✅ **97% Autarkie** erreicht (1400W Entladeleistung)
- ✅ Besser als OpenDTU-OnBattery (User-Feedback)
- ✅ Stabile Null-Grid-Regelung auch bei Wolken
- ✅ Schnelle Reaktion auf Lastspitzen
- ✅ 100% lokale Steuerung via ZenSDK (keine Cloud!)

---

## 📄 Lizenz

MIT License – Siehe [LICENSE](LICENSE) Datei

---

## 🙏 Credits

- Inspiriert von [OpenDTU-OnBattery Dynamic Power Limiter](https://github.com/hoylabs/OpenDTU-OnBattery)
- Basiert auf [nograx's ioBroker.zendure-solarflow](https://github.com/nograx/ioBroker.zendure-solarflow)
- Zendure Logo © Zendure Technology GmbH

---

## ⚠️ Haftungsausschluss

Community-entwickelt, **nicht offiziell** von Zendure unterstützt.  
Verwendung auf eigene Gefahr. Stelle sicher, dass Batterie-Schutzeinstellungen korrekt konfiguriert sind!
