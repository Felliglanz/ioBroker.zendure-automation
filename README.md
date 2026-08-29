# ioBroker.zendure-automation

## 🌍 Language / Sprache

🇩🇪 **[Deutsche Version](README.md)** | 🇬🇧 **[English Version](README.en.md)**

---

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
- **Zero-Setpoint-Vermeidung** *(experimentell, standardmäßig aus)* – schützt vor unnötigen Flash-Writes bei der Geräteansteuerung

### ⚙️ Mode-Switching Protection
- **Bidirektionaler Schutz** – verzögert beide Richtungen (Charge↔Discharge)
- **Feed-in Delay** – 5 Ticks (25s) nachhaltige Einspeisung bevor Charge
- **Discharge Delay** – 3 Ticks (15s) nachhaltiger Bezug bevor Discharge
- **10W Safe-Switch** – Relais schaltet nur bei minimalem Strom (~0.04A)
- **Operating Deadband (neu)** – hält bei ±5W für 1 Tick vor Nulldurchgang

### 🖥️ Web-Dashboard
- **Eigenständig, keine vis-Einrichtung nötig** – Live-Flussdiagramm (Netz/PV/Haus/Batterie), Steuerelemente, Hell-/Dunkelmodus, als PWA installierbar
- **Tagesansicht** – Verlaufs-Graphen für Hausverbrauch/Netz/PV/Batterie über 1h/2h, ohne History-Adapter
- **Historie (optional)** – bei aktiviertem InfluxDB-Export: frei wählbarer Zeitraum, bis zu zwei überlagerte Felder, Fadenkreuz-Tooltip
- **Optionaler InfluxDB-v2-Export** – periodischer Snapshot von Telemetrie-/Status-Daten in einen eigenen Bucket, Token verschlüsselt gespeichert

### 🏗️ Moderne Architektur
- **Modulare Struktur** – main.js orchestriert nur noch, die eigentliche Logik lebt in fokussierten, einzeln testbaren `lib/`-Modulen (Regelung, Sicherheit, Validierung, Multi-Device-Verteilung, Dashboard)
- **Controller-basiert** – SingleDeviceController & MultiDeviceController
- **Testbar & Wartbar** – klare Trennung der Verantwortlichkeiten, breite automatisierte Testsuite
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
   - **Voltage-Modus**: Min Voltage 3.18V (LFP), Hysterese 0.1V

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
- **Waterfill + Sticky Device (optional)** – verteilt die Leistung anhand individueller Geräte-Limits und SoC-Gewichtung; bei kleiner Leistung kann ein geeignetes Gerät bevorzugt werden
- **Dynamische Exclusion** – Geräte an Limits werden automatisch ausgeschlossen
- **Pro-Device Tracking** – Jedes Gerät hat eigene States im Object-Tree

### Waterfill + Sticky Device

Die optionale Verteilstrategie wird in den Multi-Device-Einstellungen ausgewählt. Für jedes aktivierte Gerät können eigene minimale und maximale SOC-Grenzen, Lade- und Entladeleistungen sowie Lade-/Entladefreigaben festgelegt werden.

Waterfill verteilt die angeforderte Leistung zunächst anhand der verfügbaren SOC-Spanne. Erreicht ein Gerät sein konfiguriertes Leistungs- oder SOC-Limit, wird die verbleibende Leistung auf die anderen geeigneten Geräte verteilt. Bei kleinen Leistungsanforderungen kann die Regelung die Leistung nach einer konfigurierbaren Haltezeit auf ein einzelnes Gerät konzentrieren. Ein Wechsel des bevorzugten Geräts erfolgt erst bei einem ausreichenden SOC-Vorsprung.

Equal Split bleibt die Standardstrategie. Im Waterfill-Modus bleiben die globalen SOC-Schutzgrenzen aktiv. Die Leistungsgrenzen und Lade-/Entladefreigaben kommen zusätzlich pro Gerät aus der Tabelle; Spannungs-, Emergency- und Recovery-Schutz bleiben aktiv.

> **⚠️ Hinweis:** Waterfill ist eine zusätzliche Multi-Device-Strategie und sollte zunächst mit den eigenen Gerätegrenzen und einem kleinen Testaufbau geprüft werden. PV-Headroom und eine automatische Bypass-Steuerung sind in dieser Version noch nicht Bestandteil der Strategie.

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

**Equal Split:** Die Leistungs- und SOC-Einstellungen gelten global für alle Geräte.

**Waterfill:** Die globalen SOC-Grenzen gelten weiterhin für alle Geräte. Die Leistungsgrenzen und Lade-/Entladefreigaben werden pro Gerät in der Device-Tabelle festgelegt.

Konfiguriere die Werte so, als hättest du **ein einzelnes Gerät**:

| Parameter | Beispiel 2400AC+ | Erklärung |
|-----------|------------------|-----------|
| **maxDischargePowerW** | 2400 | Leistung **pro Gerät** |
| **maxChargePowerW** | 1200 | Leistung **pro Gerät** |
| **minBatterySoc** | 10% | Gilt für **alle Geräte** |
| **maxBatterySoc** | 95% | Gilt für **alle Geräte** |
| **operatingDeadbandW** | 10 | **Pro Gerät** (auto-skaliert) |

Im Waterfill-Modus werden zusätzlich pro Gerät `maxChargePowerW`, `maxDischargePowerW`, `chargeAllowed` und `dischargeAllowed` verwendet. `waterfillSocMargin` steuert weiterhin den erforderlichen SOC-Vorsprung für einen Sticky-Device-Wechsel.

Das System multipliziert automatisch:
- 2 Devices × 2400W = **4800W Gesamt-Entladung**
- 2 Devices × 1200W = **2400W Gesamt-Ladung**
- 2 Devices × 10W = **20W Gesamt-Deadband** (für Equal Split)

> **⚠️ Zusammenspiel mit Zendure-App SOC-Grenzen**  
> Der Adapter regelt via ZenSDK (Power-Setpoints in Watt).  
> Die Zendure-App definiert den erlaubten SOC-Bereich.  
> Die **Adapter-Werte müssen innerhalb der Zendure-App Grenzen** liegen!  
> Siehe Abschnitt "🔋 Batterieschutz-Modi" für technische Details.

### States (Object-Tree)

Multi-Device erstellt zusätzliche States:

**Global:**
- `status.totalPowerW` – Summe aller Geräte
- `status.avgSoc` – Durchschnittlicher SOC

**Pro Gerät (device1, device2, ...):**
- `status.devices.device1.soc` – SOC des Geräts
- `status.devices.device1.powerW` – Aktuelle Leistung
- `status.devices.device1.emergencyRecoveryActive` – Notladung wegen kritischer Spannung aktiv
- `status.devices.device1.voltageRecoveryActive` – Spannungs-Recovery aktiv (Entladung blockiert)
- `status.devices.device1.socRecoveryActive` – SOC-Recovery aktiv (Entladung blockiert)
- `status.devices.device1.minSocRecoveryActive` – Zendure Hardware-MinSoc-Recovery aktiv
- `status.devices.device1.maxSocRecoveryActive` – Max-SOC Recovery aktiv (Ladung blockiert, siehe Hysterese oben)
- `status.devices.device1.excluded` – Aus Distribution ausgeschlossen?

### Emergency Handling

**Pro-Device Emergency:**
- Jedes Gerät wird individuell überwacht (SOC, Voltage, Flags) und unabhängig entschieden
- Nur das/die Gerät(e), die selbst die Notlade-Kriterien erreichen, werden mit `emergencyChargePowerW` (gedeckelt auf das jeweilige `maxChargePowerW`) geladen
- Andere Geräte laufen unbeeinflusst im normalen I-Regler-Betrieb weiter

**Beispiel:**
```
Device 1: Pack-Spannung 2.95V → EMERGENCY!
System: Lädt nur Device 1 (bis zu 800W, gedeckelt auf dessen maxChargePowerW)
Device 2 bleibt im Normalbetrieb und folgt weiter dem Netz-Zielwert
```

### Limits & Exclusion

Ein Gerät wird automatisch aus der Distribution ausgeschlossen wenn:
- ✅ **Emergency Recovery aktiv** (darf nur laden)
- ✅ **Voltage Recovery aktiv** (darf nur laden)
- ✅ **SOC Recovery aktiv** (darf nur laden)
- ✅ **MinSoc Recovery aktiv** (Zendure Hardware-Schutz, darf nur laden)
- ✅ **Max SOC erreicht** (kein Laden mehr, bleibt gesperrt bis SOC um die Recovery-Hysterese gefallen ist – siehe oben)
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

> **⚠️ WICHTIG: Zusammenspiel Adapter ↔ Zendure-System**  
> 
> **Was macht der Adapter?**
> - Schreibt **nur Power-Setpoints** (Watt) via ZenSDK: `setDeviceAutomationInOutLimit`
> - Liest SOC, Voltage, etc. zum Überwachen
> - Setzt **NICHT** die SOC-Boundaries im Zendure-System
> 
> **Wie funktioniert die Regelung?**
> ```  
> Zendure-App:  Definiert erlaubten SOC-Bereich (Hardware-Limit)
> Adapter:      Regelt innerhalb dieses Bereichs (Software-Limit)
> ```
> 
> **Technischer Ablauf:**
> 1. Du konfigurierst in der Zendure-App: z.B. 5% - 100%
> 2. Du konfigurierst im Adapter: z.B. 10% - 90%
> 3. Adapter regelt zwischen 10% und 90%
> 4. Zendure-Hardware erlaubt maximal 5% bis 100%
> 
> **Was passiert bei Konflikt?**
> ```
> Zendure-App:  10% - 90%   ← Enge Grenzen
> Adapter:       5% - 95%   ← Will mehr nutzen
> → Adapter sendet Lade-Befehl bei 91% SOC
> → Zendure-Hardware blockiert (Max 90%)
> → Validation-Fehler im Adapter-Log
> → Regelung funktioniert nicht korrekt
> ```
> 
> **Konfigurationsregel:**
> Die Adapter-Werte müssen **innerhalb** der Zendure-App Grenzen liegen.  
> Wo genau du deine Limits setzt, hängt von deinem Anwendungsfall ab.

**SOC-Modus**
- Einfach, zuverlässig
- Min/Max SOC Prozent-Grenzen
- Nutzt SOC vom Gerät
- **ACHTUNG:** Adapter-Werte müssen innerhalb der Zendure-App Grenzen liegen (siehe Warnung oben!)

**Voltage-Modus (Empfohlen für Multi-Pack)**
- Überwacht `packData.*.minVol` jedes Packs
- Verwendet niedrigsten Wert (schützt schwächstes Pack)
- Voltage Recovery Hysterese verhindert Oszillation durch Relaxation
- Beispiel: Min 3.18V + Hysterese 0.1V → Recovery erst bei 3.28V
- **Zusätzliche Sicherheit** neben SOC-Limits (beide Modi parallel aktiv!)

**🛡️ Zendure minSoc Protection (NEU in v0.7.2)**

Verhindert Hardware-Block durch Zendure's internen 5% SOC-Schutz:

- **Problem:** Zendure blockt hardware-seitig bei ~5% SOC, selbst wenn minVol noch OK ist (ungenauer SOC-Algorithmus)
- **Lösung:** Liest `minSoc` State vom Zendure-Device dynamisch aus
- **Funktionsweise:** Stoppt Entladung bei `minSoc + margin` (Standard: 5% + 1% = **6%**)
- **Recovery:** Entladung erst wieder erlaubt bei `6% + hysteresis` (Standard: +2% = **8%**)
- **Transparenz:** State `status.effectiveMinSoc` zeigt aktuelle effektive Grenze

**Konfiguration:**
- **Use Zendure minSoc:** Ein/Aus (Standard: **aktiviert**)
- **minSoc Margin:** Safety-Marge in % (Standard: **1%**)
- **Recovery Hysteresis:** Verhindert Flipping in % (Standard: **2%**)

**Beispiel:** Device minSoc=5%, Margin=1%, Hysteresis=2%
- Stopp bei 6% → Batterie lädt → Freigabe bei 8% → Kein Flipping! ✅

**🔝 Max-SOC Recovery Hysterese (NEU in v1.1.1)**

Verhindert eine Ladefreigabe-Endlosschleife bei vollem Akku:

- **Problem:** Nach Erreichen von `maxBatterySoc` lehnt das Zendure-Gerät einen neuen Lade-Sollwert noch eine Weile hart ab – auch wenn der SOC durch Rundung/Reporting-Jitter kurz um nur 1% zurückfällt. Ohne Hysterese fordert der Adapter bei diesem Rücksprung sofort wieder Ladung an, das Gerät lehnt ab, die Sollwert-Validierung retried jeden Zyklus erneut bis zum Abbruch – eine Dauerschleife mit unnötiger Schreiblast, solange der SOC um die Obergrenze pendelt (Issue #32).
- **Lösung:** Analog zur Min-SOC-Entladeschutz-Hysterese: Nach Erreichen von `maxBatterySoc` bleibt Laden gesperrt, bis der SOC auf `maxBatterySoc - Hysterese` gefallen ist.
- **Transparenz:** State `status.maxSocRecoveryActive` (Single-Device) bzw. `status.devices.device1.maxSocRecoveryActive` (Multi-Device) zeigt, ob die Sperre gerade aktiv ist.

**Konfiguration** (unter Akkuschutz):
- **Max-SOC Recovery-Hysterese:** in % (Standard: **4%**, Minimum: **2%**)

**Beispiel:** Max SOC=100%, Hysterese=4%
- Laden gesperrt bei 100% → SOC fällt → Freigabe erst wieder bei 96% → Kein Flipping! ✅

**🌡️ Ladekurven-Tapering nahe Vollladung (NEU in v1.1.1)**

Unabhängig von der Hysterese oben drosselt die Zendure-BMS selbst die tatsächliche Ladeleistung in den letzten Prozentpunkten vor `maxBatterySoc` (CV-artige Ladekurve) – unabhängig vom angeforderten Sollwert. Das ist kein Kommunikationsfehler, sah für die Sollwert-Validierung aber wie einer aus (die Abweichung vom unveränderten Ziel wächst statt zu schrumpfen) und führte zu wiederholten Fehler-Logs über die gesamte letzte Ladephase, teils stundenlang an sonnigen Tagen.

Der Adapter pausiert die Sollwert-Validierung deshalb automatisch, sobald der SOC bis auf 5 Prozentpunkte an `maxBatterySoc` heran ist (fest codiert, kein UI-Setting) – der Sollwert selbst wird davon unberührt normal weitergeschrieben, es wird nur einmalig geloggt statt gespammt, und die Validierung läuft automatisch wieder an, sobald der SOC diese Marge wieder unterschreitet.

### ⚡ Relay Protection (Anti-Verschleiß)

Schützt Hardware vor übermäßigem Schalten, speziell bei wechselhaftem Wetter:

| Parameter | Emp. Wert | Beschreibung |
|-----------|-----------|--------------|
| **Feed-in Threshold** | -150W | Einspeisung nötig für Charge-Start |
| **Feed-in Delay** | 5 Ticks | 25s nachhaltige Einspeisung |
| **Discharge Threshold** | 200W | Netzbezug nötig für Discharge-Start |
| **Discharge Delay** | 3 Ticks | 15s nachhaltiger Bezug |
| **Operating Deadband** | 10W | Minimum-Power pro Gerät vor Nulldurchgang |

**Operating Deadband (aktualisiert v0.7.6):**
- Konfigurierbar pro Gerät (Standard: 10W)
- Automatisch skaliert im Multi-Device-Modus (z.B. 2 Geräte × 10W = 20W gesamt)
- Verhindert Relais-Flattern bei Oszillation um Zielwert
- Arbeitet mit 10W Safe-Switch zusammen (Schaltet nur bei ~0.04A)
- Verfügbar als Runtime-Override: `control.operatingDeadbandW`

### 🔌 Zero-Setpoint-Vermeidung (Flash-Schutz, experimentell)

**Hintergrund:** Wird das Automatisierungslimit exakt auf `0` gesetzt, löst das in der zugrunde liegenden Solarflow-Integration eine verzögerte Abfolge aus, die `acMode`/`smartMode` einige Sekunden später abschaltet. Trifft in der Zeit ein neuer Sollwert ein, kann das Flash-Writes duplizieren oder mit dem neuen Befehl kollidieren ([Forum-Thread](https://forum.iobroker.net/post/1352076)). Jeder Wert **ungleich** 0 läuft dagegen über einen sofortigen Pfad ohne verzögerte Abfolge – daher genügt es, eine reine `0` möglichst zu vermeiden.

**⚠️ Standardmäßig deaktiviert.** Ist die Option aus, verhält sich der Adapter exakt wie zuvor (reine `0` wird direkt geschrieben) – kein zusätzliches Risiko gegenüber dem bisherigen Verhalten, nur eben ohne den zusätzlichen Schutz. Muss also bewusst im Adapter-Setup aktiviert werden.

| Parameter | Default | Beschreibung |
|-----------|---------|--------------|
| **Avoid Zero Setpoint** | aus | Master-Schalter für den gesamten Mechanismus |
| **Standby Keep-Alive (W)** | 10W | Wird bei kurzem Standby statt 0 gesendet, in der zuletzt aktiven Richtung |
| **smartMode Idle Timeout** | 300s | Wie lange Standby anhalten muss, bevor doch eine echte 0 gesendet wird (damit der Wechselrichter entkoppelt und Standby-Strom spart) |
| **Post-Zero Grace Window** | 8s (Minimum 6s) | Nach einer echten 0 wird für diese Zeit nichts anderes geschrieben, damit die verzögerte Abschalt-Abfolge der zugrunde liegenden Integration ungestört durchläuft |

Notladen umgeht das Grace Window immer – Hardware-Schutz hat Vorrang vor Flash-Schonung.

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

### 🔍 Validation Source (Für Geräte mit PV-Modulen)

**Problem:** Bei Geräten mit direkt angeschlossenen PV-Modulen (z.B. Solarflow Pro) ist die `packPower` nicht gleich dem API-Setpoint:
```
packPower = API-Setpoint + PV-Einspeisung + AC-Ladung
```

**Beispiel:**
- Adapter setzt: -1020W (Ladung)
- PV-Module liefern: ~720W
- `packPower` zeigt: -1740W
- **Validation schlägt fehl!** (Erwartet: -1020W, Ist: -1740W)

**Lösung: Wählbare Validation Source**

| Source | Beschreibung | Wann nutzen? |
|--------|-------------|--------------|
| **packPower** | Gesamt-Batterieleistung (API + PV) | Standard für Geräte **ohne** PV-Module |
| **gridInputPower** | Nur AC-Ladeleistung (API-Setpoint) | Für Geräte **mit** PV-Modulen (Pro, AC+) |
| **none** | Validation deaktiviert | Als letzten Ausweg bei Problemen |

**Konfiguration:**
- **Single-Device Mode:** Dropdown "Validation Source" unter Device-Einstellungen
- **Multi-Device Mode:** Pro Device in der Devices-Table

**Empfehlung:**
- **2400 Pro / 2000 Pro** mit PV → `gridInputPower` wählen
- **AC+ / Hyper** ohne PV → `packPower` (Standard)
- Bei Unsicherheit → `packPower` testen, bei Validation-Fehlern → `gridInputPower`

**Wann anpassen?**
- **Zu träge?** → Alpha erhöhen (z.B. 0.5 → 0.7)
- **Zu zappelig?** → Alpha verringern (z.B. 0.5 → 0.3)
- **Kein Filter?** → Alpha = 1.0 (legacy behavior)

### 🚨 Emergency & Recovery

**Emergency Charging** (höchste Priorität):
- Aktiviert ausschließlich bei kritischer Pack-Spannung gemäß `emergencyChargeVoltageV`
- Lädt mit 800W bis Exit-SOC (20%)
- Übersteuert alle anderen Automatisierungen

`lowVoltageBlock` blockiert ausschließlich die Entladung als zusätzlicher Geräteschutz und löst kein Notladen aus.

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
- `status.emergencyRecoveryActive` / `voltageRecoveryActive` / `socRecoveryActive` / `minSocRecoveryActive` / `maxSocRecoveryActive` – Recovery-Sperren aktiv (siehe "🚨 Emergency & Recovery" und "🔋 Batterieschutz-Modi im Detail")

---

## 📜 Changelog

Die vollständige Versionshistorie steht in der [CHANGELOG.md](CHANGELOG.md).

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
