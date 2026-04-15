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
- **EMA Filter für Grid Power** – glättet schnelle Laständerungen (TV, Mikrowelle), konfigurierbar (0.1-1.0)
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
- **Modulare Struktur** – 9 spezialisierte Module (v0.7.0 Controller Extraction)
- **47% Code-Reduktion** – von 1052 auf 554 Zeilen in main.js
- **Controller-basiert** – SingleDeviceController & MultiDeviceController
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

## 🔄 Multi-Device Support

**Steuere mehrere Zendure Geräte als ein gemeinsames System** – perfekt für 2x Solarflow 2400 oder größere Installationen.

### Aktivierung

**⚙️ Basic Settings**
1. Aktiviere Checkbox **"Multi-Device Support aktivieren"**
2. In der Device-Tabelle Geräte hinzufügen:
   - ProductKey (aus zendure-solarflow Objektbaum)
   - DeviceKey (aus zendure-solarflow Objektbaum)
   - Name (optional, z.B. "Garage", "Keller")
   - Enabled (Haken setzen)

### Wie es funktioniert

**Power Distribution:**
- **Equal Split** – Leistung wird gleichmäßig auf alle aktiven Geräte verteilt
- **Dynamische Exclusion** – Geräte an Limits werden automatisch ausgeschlossen
- **Pro-Device Tracking** – Jedes Gerät hat eigene States im Object-Tree

**Beispiel mit 2x Solarflow 2400:**
```
I-Regler berechnet: -1800W (Laden)
→ Device 1: -900W
→ Device 2: -900W

Device 2 erreicht max SOC (95%):
→ Device 1: -1800W (bekommt volle Leistung)
→ Device 2: 0W (excluded)
```

### Konfiguration

**Wichtig:** Alle Einstellungen gelten **global für ALLE Geräte**!

Konfiguriere die Werte so, als hättest du **ein einzelnes Gerät**:

| Parameter | Beispiel 2400AC+ | Erklärung |
|-----------|------------------|-----------|
| **maxDischargePowerW** | 2400 | Leistung **pro Gerät** |
| **maxChargePowerW** | 1200 | Leistung **pro Gerät** |
| **minBatterySoc** | 10% | Gilt für **alle Geräte** |
| **maxBatterySoc** | 95% | Gilt für **alle Geräte** |

Das System multipliziert automatisch:
- 2 Devices × 2400W = **4800W Gesamt-Entladung**
- 2 Devices × 1200W = **2400W Gesamt-Ladung**

> **⚠️ SOC-Grenzen müssen auch im Zendure-System gesetzt werden!**  
> Der Adapter setzt diese Werte nur für seine eigene Regelung.  
> Konfiguriere die **gleichen Werte** in der Zendure App oder im zendure-solarflow Adapter.  
> Siehe Abschnitt "🔋 Batterieschutz-Modi" für Details!

### States (Object-Tree)

Multi-Device erstellt zusätzliche States:

**Global:**
- `status.totalPowerW` – Summe aller Geräte
- `status.avgSoc` – Durchschnittlicher SOC

**Pro Gerät (device1, device2, ...):**
- `status.devices.device1.soc` – SOC des Geräts
- `status.devices.device1.powerW` – Aktuelle Leistung
- `status.devices.device1.emergency` – Emergency-Status
- `status.devices.device1.excluded` – Aus Distribution ausgeschlossen?

### Emergency Handling

**Pro-Device Emergency:**
- Jedes Gerät wird individuell überwacht (SOC, Voltage, Flags)
- **Wenn EIN Gerät Emergency hat** → ALLE eligible Geräte laden
- Emergency-Ladeleistung wird auf aktive Geräte verteilt

**Beispiel:**
```
Device 1: Pack-Spannung 2.95V → EMERGENCY!
System: Lädt beide Geräte mit je 800W (wenn aktiv)
Device 2 erreicht max SOC → Wird excluded, Device 1 lädt allein weiter
```

### Limits & Exclusion

Ein Gerät wird automatisch aus der Distribution ausgeschlossen wenn:
- ✅ **Emergency Recovery aktiv** (darf nur laden)
- ✅ **Voltage Recovery aktiv** (darf nur laden)
- ✅ **Max SOC erreicht** (kein Laden mehr)
- ✅ **Min SOC erreicht** (kein Entladen mehr)

**Ausgeschlossene Geräte** werden auf **0W** gesetzt, die anderen regeln normal weiter.

### Hardware-Schutz

**The Good News:** Die Solarflow Hardware hat eigene Limits!
- Auch wenn du "zu hohe" Werte konfigurierst → Hardware blockt ab
- Maximale Sicherheit durch doppelten Schutz (Software + Hardware)

**Best Practice:**
- Konfiguriere korrekte Werte für optimale Regelgüte
- Bei Unsicherheit: Hardware schützt sich selbst ✓

---

## ⚙️ Erweiterte Konfiguration

### 🔋 Batterieschutz-Modi im Detail

> **⚠️ WICHTIG: SOC-Grenzen im Zendure-System**  
> 
> **Dieser Adapter setzt die SOC-Limits NUR für seine eigene Regelung!**  
> Die Werte werden **NICHT** ins Zendure-System übertragen.
> 
> **Du MUSST die SOC-Grenzen auch im Zendure-System konfigurieren:**
> - In der Zendure App: Geräteeinstellungen → Batterie-Limits
> - Oder im zendure-solarflow Adapter: `control` States
> 
> **Die Werte MÜSSEN übereinstimmen, sonst:**
> - ❌ Adapter denkt "darf noch entladen" → Zendure blockt → Regelung funktioniert nicht
> - ❌ Zendure entlädt tiefer als Adapter erwartet → Emergency-Modus wird nicht ausgelöst
> 
> **Beispiel korrekte Konfiguration:**
> ```
> Adapter:  minBatterySoc = 10%,  maxBatterySoc = 95%
> Zendure:  minBatterySoc = 10%,  maxBatterySoc = 95%  ✅ IDENTISCH!
> ```

**SOC-Modus (Empfohlen für Single-Pack)**
- Einfach, zuverlässig
- Min/Max SOC Prozent-Grenzen
- Nutzt SOC vom Gerät
- **ACHTUNG:** Werte müssen mit Zendure-System übereinstimmen (siehe Warnung oben!)

**Voltage-Modus (Empfohlen für Multi-Pack)**
- Überwacht `packData.*.minVol` jedes Packs
- Verwendet niedrigsten Wert (schützt schwächstes Pack)
- Voltage Recovery Hysterese verhindert Oszillation durch Relaxation
- Beispiel: Min 3.0V + Hysterese 0.1V → Recovery erst bei 3.1V
- **Zusätzliche Sicherheit** neben SOC-Limits (beide Modi parallel aktiv!)

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
| **EMA Filter Alpha** | 0.5 | Glättung der Netzleistung (0.1-1.0) |

**Tipp:** Höhere Rampen = aggressiver, niedrigere = sanfter & hardware-schonend

### 📊 EMA Filter (Exponential Moving Average)

Glättet das Grid Power Signal um auf schnelle Lastspitzen (TV, Mikrowelle) nicht zu reagieren:

| Alpha | Verhalten | Einsatzbereich |
|-------|-----------|----------------|
| **0.1 - 0.3** | Sehr träge, starke Glättung | Häufige Lastspitzen, gemütliche Regelung |
| **0.4 - 0.6** | ⭐ Ausgewogen (empfohlen) | Standard-Anwendung |
| **0.7 - 0.9** | Schnell, wenig Glättung | Schnelle Reaktion gewünscht |
| **1.0** | Keine Filterung | Purer I-Regler wie v0.6.0 |

**Formel:** `filtered = alpha × new + (1 - alpha) × old`

**Wann anpassen?**
- **Zu träge?** → Alpha erhöhen (z.B. 0.5 → 0.7)
- **Zu zappelig?** → Alpha verringern (z.B. 0.5 → 0.3)
- **Kein Filter?** → Alpha = 1.0 (legacy behavior)

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

### v0.7.0 (2026-04-15) - Controller Refactoring
- 🏗️ **Große Architektur-Verbesserung** – Controller aus main.js extrahiert
- ✨ **SingleDeviceController** – Kompletter Single-Device Zyklus in dediziertem Modul
- ✨ **MultiDeviceController** – Kompletter Multi-Device Zyklus in dediziertem Modul
- 📉 **47% Code-Reduktion in main.js** – von 1052 auf 554 Zeilen
- 📚 **Business-Logic Extraktion** – Alle Automatisierungs-Logik in testbare Controller verschoben
- 🧪 **Verbesserte Testbarkeit** – Controller sind unabhängig und einfach unit-testbar
- 🎯 **Klare Trennung** – main.js nur noch Adapter-Lifecycle, Controller übernehmen Automation

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
