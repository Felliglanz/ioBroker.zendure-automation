# Changelog

All notable changes to this project are documented in this file.

## v1.0.1 (2026-08-19)

### English
- Multi-device recovery states (emergency/voltage/SOC/minSoc) are now tracked per device under `status.devices.<id>.*RecoveryActive` instead of sharing one global state, fixing corruption and incorrect restoration on adapter restart with multiple devices.
- SOC recovery is now evaluated every multi-device cycle (previously only emergency and voltage recovery were checked, so a device could get stuck excluded from discharge indefinitely in the default SOC protection mode).
- Max Charge/Discharge override modes now check each device individually; one device being ineligible (limits, recovery, disabled) no longer blocks the override for the others.
- `chargeAllowed`/`dischargeAllowed` per-device flags are now respected in equal-split mode too, not just Waterfill.
- Emergency charge power is now capped to each device's own configured `maxChargePowerW`, so a large global `emergencyChargePowerW` can no longer exceed a smaller device's limit.
- Waterfill's sticky single-device handover now blends power gradually between the outgoing and incoming device over the handover-hold window instead of jumping instantly between 0W and full power.
- Waterfill's `excluded` status flag now correctly reflects devices that are not eligible for distribution (previously always `false`).
- Corrected documentation: multi-device state names and the description of per-device emergency handling.
- Fixed a regression risk in the new handover blend: a third device becoming momentarily "best" during an in-progress blend could hijack it and drop the original outgoing device straight to 0W. The (outgoing, incoming) pair is now frozen for the full handover-hold window.
- A power request above the configured spread threshold now always spreads across every eligible device immediately, even mid-handover, instead of staying capped to just the two blending devices.
- Waterfill's aggregate charge/discharge system limits (used for anti-windup and the power regulator) now correctly exclude devices with `chargeAllowed`/`dischargeAllowed` set to false, matching the actual per-device distribution limits.
- Removed an orphaned `useFullChargeNeeded` config default that no longer had any corresponding UI option or code path.
- Old per-device state objects (`status.devices.<id>.emergency`/`.voltageRecovery`) are now cleaned up on upgrade instead of being left behind, frozen, in the object tree.
- Fixed a regression that prevented Waterfill from ever reaching single-device (sticky) mode when the concentrate-hold window was more than one cycle (i.e. `waterfillConcentrateHoldMinutes` above the value that makes the hold last exactly one update interval, which includes the default of 3 minutes): the hold-cycle counter was reset on every interim cycle before it could reach its threshold, so the system stayed in spread mode with all devices active indefinitely instead of concentrating low loads onto one device (reported in #14).
- Waterfill now also blends power gradually when concentrating out of spread mode into single-device mode (previously only a device-to-device sticky swap was blended; collapsing from several active devices onto one still jumped instantly). Uses a shorter, dedicated hold window than the device-to-device swap, since the total requested power isn't changing here, only its split across devices. The blend only ever engages on an actual device-set change; a plain power-level change on an unchanged single device or an unchanged spread set is still answered immediately, with no blend (reported in #14).
- Fixed the spread-to-single blend itself starting from a discontinuous jump: the device becoming sticky was always assumed to start the blend at 0W, even when it already carried a real share of the load in spread mode a moment earlier, causing an unnecessary drop-and-recover step right before the gradual ramp began. The blend now starts from each device's actual previous output and interpolates from there, so the first blend cycle matches what was already being delivered instead of jumping away from it first (reported in #14).

### Deutsch
- Multi-Device-Recovery-States (Emergency/Voltage/SOC/MinSoc) werden jetzt pro Gerät unter `status.devices.<id>.*RecoveryActive` geführt statt sich einen globalen State zu teilen – behebt Datenmüll und fehlerhafte Wiederherstellung nach Adapter-Neustart bei mehreren Geräten.
- SOC-Recovery wird jetzt in jedem Multi-Device-Zyklus geprüft (zuvor wurden nur Emergency- und Voltage-Recovery geprüft, wodurch ein Gerät im Standard-SOC-Schutzmodus dauerhaft von der Entladung ausgeschlossen bleiben konnte).
- Max Charge/Discharge-Override prüft jetzt jedes Gerät einzeln; ein einzelnes nicht-eligible Gerät (Limits, Recovery, deaktiviert) blockiert den Override nicht mehr für alle anderen.
- Die Pro-Gerät-Flags `chargeAllowed`/`dischargeAllowed` werden jetzt auch im Equal-Split-Modus beachtet, nicht mehr nur bei Waterfill.
- Die Notladeleistung wird jetzt auf das jeweils konfigurierte `maxChargePowerW` des Geräts gedeckelt, sodass ein großer globaler `emergencyChargePowerW`-Wert das Limit eines kleineren Geräts nicht mehr überschreiten kann.
- Der Waterfill-Gerätewechsel im Sticky-Single-Device-Modus blendet die Leistung jetzt über das Handover-Hold-Fenster graduell zwischen altem und neuem Gerät über, statt hart zwischen 0W und voller Leistung zu springen.
- Das `excluded`-Status-Flag bei Waterfill zeigt jetzt korrekt an, wenn ein Gerät nicht an der Verteilung teilnehmen kann (zuvor immer `false`).
- Dokumentation korrigiert: Multi-Device-State-Namen und Beschreibung des Pro-Gerät-Emergency-Verhaltens.
- Ein Regressions-Risiko im neuen Handover-Blend behoben: Ein drittes Gerät, das kurzzeitig zum "besten" Kandidaten wird, konnte einen laufenden Blend kapern und das ursprüngliche Gerät hart auf 0W fallen lassen. Das (abgebende, übernehmende) Gerätepaar bleibt jetzt für das gesamte Handover-Hold-Fenster fixiert.
- Eine Leistungsanforderung oberhalb der konfigurierten Spread-Schwelle verteilt sich jetzt sofort auf alle eligible Geräte, auch mitten in einem Handover, statt auf die beiden blendenden Geräte begrenzt zu bleiben.
- Die aggregierten Waterfill-Systemlimits (für Anti-Windup und den Leistungsregler) schließen jetzt korrekt Geräte mit chargeAllowed/dischargeAllowed=false aus, passend zu den tatsächlichen Pro-Gerät-Verteilungslimits.
- Einen verwaisten `useFullChargeNeeded`-Konfigurationswert entfernt, der keine zugehörige UI-Option oder Code-Nutzung mehr hatte.
- Alte Pro-Gerät-State-Objekte (`status.devices.<id>.emergency`/`.voltageRecovery`) werden beim Upgrade jetzt aufgeräumt statt eingefroren im Objektbaum liegen zu bleiben.
- Einen Regressionsfehler behoben, durch den Waterfill nie mehr in den Single-Device-Modus (Sticky) wechseln konnte, sobald das Concentrate-Hold-Fenster mehr als einen Zyklus umfasste (also bei `waterfillConcentrateHoldMinutes` oberhalb des Werts, der genau einem Update-Intervall entspricht – was auch den Standardwert von 3 Minuten einschließt): Der Hold-Cycle-Zähler wurde in jedem Zwischenzyklus zurückgesetzt, bevor er seinen Schwellwert erreichen konnte. Das System blieb dadurch dauerhaft im Spread-Modus mit allen aktiven Geräten hängen, statt geringe Lasten auf ein Gerät zu konzentrieren (gemeldet in #14).
- Waterfill blendet die Leistung jetzt auch beim Konzentrieren aus dem Spread- in den Single-Device-Modus graduell über (bisher wurde nur der Gerät-zu-Gerät-Wechsel geblendet; das Zusammenführen mehrerer aktiver Geräte auf eines sprang weiterhin hart). Dafür wird ein kürzeres, eigenes Hold-Fenster verwendet als beim Gerät-zu-Gerät-Wechsel, da sich hier nur die Aufteilung ändert, nicht die angeforderte Gesamtleistung. Das Blending greift ausschließlich bei einem echten Wechsel der aktiven Geräte-Menge; eine reine Leistungsänderung bei unverändertem Single-Device oder unverändertem Spread-Set wird weiterhin sofort und ohne Blending beantwortet (gemeldet in #14).
- Einen Sprung am Anfang des Spread-zu-Single-Blendings selbst behoben: Das neu aktiv werdende Gerät wurde bisher immer so behandelt, als würde es beim Blending bei 0W starten, auch wenn es im Spread-Modus gerade eben schon einen echten Anteil der Last trug – dadurch fiel die Leistung erst unnötig ab und wieder hoch, bevor der eigentliche sanfte Übergang begann. Das Blending startet jetzt bei der tatsächlich zuletzt gelieferten Leistung jedes Geräts und interpoliert von dort aus, sodass der erste Blend-Zyklus genau an das anschließt, was ohnehin schon anlag (gemeldet in #14).

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
