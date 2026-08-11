# Changelog

All notable changes to this project are documented in this file.

## v1.0.0 (2026-08-11)

### English
- Multi-device power limits are recalculated correctly after devices are excluded at their limits.
- Added `NaN`/`Infinity` protection for grid power input.
- Improved multi-device safety and value validation.
- Added and corrected automated tests for controller behavior.

### Deutsch
- Multi-Device-Leistungsgrenzen werden nach dem Ausschluss von Geräten an ihren Limits korrekt neu berechnet.
- `NaN`-/`Infinity`-Schutz für den Netzleistungswert hinzugefügt.
- Multi-Device-Sicherheit und Wertevalidierung verbessert.
- Automatisierte Tests für das Controller-Verhalten ergänzt und korrigiert.

## v0.7.6 (2026-08-01) - Multi-Device Deadband Scaling

### English
- Multi-device operating deadband now scales automatically with the number of devices.
- Example: 2 devices x 10W = 20W total, resulting in 10W per device after equal split.
- Added the `control.operatingDeadbandW` runtime override.
- Added a UI hint for multi-device mode.
- Fixes issue #9.

### Deutsch
- Die Operating Deadband skaliert im Multi-Device-Modus automatisch mit der Geräteanzahl.
- Beispiel: 2 Geräte x 10W = 20W gesamt, nach dem Equal Split 10W pro Gerät.
- Der Runtime-Override `control.operatingDeadbandW` wurde hinzugefügt.
- Ein UI-Hinweis für den Multi-Device-Modus wurde ergänzt.
- Behebt Issue #9.

## v0.7.5

### English
- Set devices to 0W when manually disabling `maxCharge`/`maxDischarge` before a limit is reached.

### Deutsch
- Geräte werden beim manuellen Deaktivieren von `maxCharge`/`maxDischarge` auf 0W gesetzt, bevor ein Limit erreicht ist.

## v0.7.4

### English
- Max discharge safety respects the configured discharge protection mode (SOC/Voltage/Both).
- Blocks `maxDischarge` during emergency and voltage recovery.
- Automatically resets when limits are reached.

### Deutsch
- Die Max-Discharge-Sicherheit berücksichtigt den konfigurierten Entladeschutz-Modus (SOC/Spannung/Beide).
- `maxDischarge` wird während Emergency- und Voltage-Recovery blockiert.
- Automatischer Reset beim Erreichen der Limits.

## v0.7.3

### English
- Added `control.maxCharge` and `control.maxDischarge` manual override switches.
- Manual full-power charging/discharging with automatic reset at SOC limits.
- Works in both single-device and multi-device modes.

### Deutsch
- Die manuellen Override-Schalter `control.maxCharge` und `control.maxDischarge` wurden hinzugefügt.
- Manuelles Volllast-Laden/-Entladen mit automatischem Reset an den SOC-Grenzen.
- Funktioniert im Single- und Multi-Device-Modus.

## v0.7.2

### English
- Added dynamic Zendure `minSoc` protection to prevent a hardware block at approximately 5% SOC.
- Stops at `minSoc` plus margin (default: +1%).
- Added recovery hysteresis (+2%) to prevent flipping.
- Added `status.effectiveMinSoc` to show the effective stop limit.

### Deutsch
- Dynamischer Zendure-`minSoc`-Schutz verhindert einen Hardware-Block bei etwa 5% SOC.
- Stoppt bei `minSoc` plus Sicherheitsmarge (Standard: +1%).
- Recovery-Hysterese (+2%) verhindert Flipping.
- `status.effectiveMinSoc` zeigt die effektive Stopp-Grenze.

## v0.7.1

### English
- Enhanced operating deadband prevents relay switching at high power loads.
- Catches all transitions to 0W and direction changes.
- Holds at a minimum of 10W before allowing relay state changes.
- Eliminates rapid relay cycling during fluctuating conditions.

### Deutsch
- Verbesserte Operating Deadband verhindert Relaisschalten bei hoher Last.
- Erkennt alle Übergänge zu 0W und Richtungswechsel.
- Hält mindestens 10W, bevor Relais-Zustandswechsel erlaubt werden.
- Eliminiert schnelles Relais-Takten bei schwankenden Bedingungen.

## v0.7.0 - Controller Refactoring

### English
- Extracted controllers from `main.js` into dedicated `SingleDeviceController` and `MultiDeviceController` modules.
- Reduced `main.js` by 47% (1052 to 554 lines).
- Improved testability through independently testable controllers.
- Separated adapter lifecycle from automation logic.

### Deutsch
- Controller aus `main.js` in die dedizierten Module `SingleDeviceController` und `MultiDeviceController` extrahiert.
- `main.js` um 47% reduziert (1052 auf 554 Zeilen).
- Verbesserte Testbarkeit durch unabhängig testbare Controller.
- Adapter-Lifecycle und Automationslogik getrennt.

## v0.6.1

### English
- Added operating deadband protection to prevent relay chattering during oscillation.
- Holds at +/-5W for one tick before crossing zero.
- Reduces switching operations without slowing regulation.

### Deutsch
- Operating-Deadband-Schutz verhindert Relais-Flattern bei Oszillation.
- Hält für einen Tick bei +/-5W vor dem Nulldurchgang.
- Reduziert Schaltvorgänge ohne die Regelung zu verlangsamen.

## v0.6.0 (2026-03-28)

### English
- Major refactoring into six specialized modules.
- Reduced `main.js` by 59% (948 to 388 lines).
- Improved maintainability, testability, and documentation.

### Deutsch
- Große Refaktorierung in sechs spezialisierte Module.
- `main.js` um 59% reduziert (948 auf 388 Zeilen).
- Verbesserte Wartbarkeit, Testbarkeit und Dokumentation.

## v0.5.8 (2026-03-27)

- Improved power validation to accept device ramping during charging.
- Verbesserte Leistungsvalidierung akzeptiert Geräte-Ramping während des Ladens.

## v0.5.7 (2026-03-26)

- Added non-blocking power setpoint validation with automatic retry.
- Non-blocking Leistungsvalidierung des Sollwerts mit automatischem Retry hinzugefügt.

## v0.5.5 (2026-03-25)

- Persistent emergency recovery across adapter restarts.
- Persistenter Emergency Recovery über Adapter-Neustarts.

## v0.5.0 (2026-03-25)

- Added voltage recovery hysteresis, bidirectional mode-switching protection, and asymmetric ramp limits.
- Spannungs-Recovery-Hysterese, bidirektionalen Mode-Switching-Schutz und asymmetrische Ramp-Limits hinzugefügt.

## v0.4.0 (2026-03-24)

- Initial release.
- Initiales Release.

[GitHub Releases](https://github.com/Felliglanz/iobroker.zendure-automation/releases)
