# Changelog

All notable changes to this project are documented in this file.

## v1.1.1 (2026-08-24)

### English
- Fixed a `regulatorGain` (1.0.6) side effect: `hysteresisW` compares against the setpoint delta *after* `regulatorGain` is applied, so a lower gain silently inflated the effective grid-error tolerance to `hysteresisW / gain` instead of the configured `hysteresisW` - e.g. gain 0.4 turned a 50W hysteresis into a 125W dead zone. This caused the regulator to get stuck well away from the target grid power whenever real load stayed inside that inflated zone, sometimes for minutes (issue #30, confirmed via a tester's logs and Grafana charts showing long flat plateaus instead of tracking toward target). `hysteresisW` is now scaled by `regulatorGain` before the comparison, keeping its Watt tolerance constant regardless of the gain value. No effect when `regulatorGain` is disabled (default).
- Fixed a regression from the deadband-churn fix (1.1.0): `RelayProtection`, when freezing its counters because charge/discharge was already vetoed downstream, returned `powerW: 0` itself instead of passing the real request through. That pre-zeroed value then reached `SafetyLimiter`, whose block detection is gated on the sign of the requested power - so it saw "nothing requested", never engaged, and `safetyActive` stayed `false`. That flag decides whether a real 0 is written immediately or held via the zero-avoidance keep-alive path, so an active safety block could silently go through the slower keep-alive route instead of an immediate cutoff.
- **Full-battery charge retry loop:** at `maxBatterySoc`, the Zendure device keeps hard-rejecting a new charge setpoint for a while even after SOC ticks back down by a single percent (rounding/reporting jitter right at the ceiling). Without hysteresis, the adapter immediately re-requested charging on that dip, the device rejected it, and setpoint validation retried every cycle until giving up - a permanent failed-validation loop with needless flash writes for as long as SOC hovered at the top (issue #32). Added a max-SOC recovery hysteresis mirroring the existing min-SOC discharge protection: once `maxBatterySoc` is hit, charging stays blocked until SOC falls to `maxBatterySoc - maxSocRecoveryHysteresis` (default 4%, min. 2%, configurable in the admin UI under Battery Protection). Applies to Single-Device, Multi-Device, and Waterfill.
- **False setpoint-validation failures near full charge:** independent of the above, the Zendure BMS itself tapers actual charge current down in the last stretch before `maxBatterySoc` (a CV-style charge curve), regardless of the requested setpoint - e.g. target -1600W while actual current drifts from -900W down toward -100W as SOC climbs. That's not a communication failure, but the deviation from an unchanged, aggressive target grows as it happens, which the setpoint validator's ramping check read as "device not responding" - erroring out after `setPowerMaxRetries`, repeatedly, for the entire final stretch to full on a sunny day. Setpoint validation now suspends itself (logged once, not spammed) whenever SOC is within 5 percentage points of `maxBatterySoc`; the setpoint write itself is unaffected and still resent normally, and validation resumes automatically once SOC drops back below that margin.

### Deutsch
- Einen Nebeneffekt von `regulatorGain` (1.0.6) behoben: `hysteresisW` wurde gegen die bereits mit `regulatorGain` skalierte Sollwert-Differenz verglichen, wodurch ein niedrigerer Gain die effektive Grid-Fehler-Toleranz unbemerkt auf `hysteresisW / gain` aufblähte statt den konfigurierten `hysteresisW`-Wert zu nutzen - z.B. wurde aus 50W Hysterese bei Gain 0.4 eine 125W-Totzone. Dadurch blieb der Regler manchmal minutenlang weit vom Ziel-Netzwert entfernt hängen, solange die reale Last innerhalb dieser aufgeblähten Zone lag (Issue #30, bestätigt anhand der Logs und Grafana-Charts eines Testers, die lange flache Plateaus statt einer Annäherung ans Ziel zeigten). `hysteresisW` wird jetzt vor dem Vergleich mit `regulatorGain` skaliert, damit die Watt-Toleranz unabhängig vom Gain-Wert konstant bleibt. Kein Effekt, wenn `regulatorGain` deaktiviert ist (Standard).
- Eine Regression aus dem Deadband-Churn-Fix (1.1.0) behoben: `RelayProtection` gab beim Einfrieren der Zähler (weil Laden/Entladen ohnehin downstream blockiert war) selbst `powerW: 0` zurück, statt die echte Anfrage durchzureichen. Dieser bereits genullte Wert erreichte dann `SafetyLimiter`, dessen Blockerkennung am Vorzeichen der angeforderten Leistung hängt - der sah also "nichts angefordert", griff nie ein, und `safetyActive` blieb `false`. Dieses Flag entscheidet, ob eine echte 0 sofort geschrieben oder über den Zero-Avoidance-Keep-Alive-Pfad gehalten wird - eine aktive Sicherheitssperre konnte dadurch unbemerkt über den langsameren Keep-Alive-Weg statt sofort abgeschaltet laufen.
- **Ladefreigabe-Endlosschleife bei vollem Akku:** Bei `maxBatterySoc` lehnt das Zendure-Gerät einen neuen Lade-Sollwert noch eine Weile hart ab, selbst wenn der SOC durch Rundung/Reporting-Jitter kurz um 1% zurückfällt. Ohne Hysterese hat der Adapter bei diesem Rücksprung sofort wieder Ladung angefordert, das Gerät hat abgelehnt, und die Sollwert-Validierung hat jeden Zyklus erneut retried bis zum Abbruch - eine dauerhafte Fehlschlag-Schleife mit unnötiger Schreiblast, solange der SOC um die Obergrenze pendelte (Issue #32). Neue Max-SOC Recovery-Hysterese analog zur bestehenden Min-SOC-Entladeschutz: Nach Erreichen von `maxBatterySoc` bleibt Laden gesperrt, bis der SOC auf `maxBatterySoc - maxSocRecoveryHysteresis` gefallen ist (Standard 4%, min. 2%, einstellbar im Admin-UI unter Akkuschutz). Gilt für Single-Device, Multi-Device und Waterfill.
- **Fälschliche Validierungsfehler kurz vor Vollladung:** Unabhängig vom Punkt oben drosselt die Zendure-BMS selbst die tatsächliche Ladeleistung in der letzten Phase vor `maxBatterySoc` (CV-artige Ladekurve), unabhängig vom angeforderten Sollwert - z.B. Ziel -1600W, während der reale Ladestrom von -900W Richtung -100W abrutscht, während der SOC weiter steigt. Das ist kein Kommunikationsfehler, aber die Abweichung vom unveränderten, aggressiven Ziel wird dabei größer statt kleiner - die Ramping-Erkennung der Sollwert-Validierung deutete das als "Gerät reagiert nicht" und brach nach `setPowerMaxRetries` mit Fehler ab, wiederholt, für die gesamte letzte Ladephase an einem sonnigen Tag. Die Sollwert-Validierung setzt sich jetzt selbst aus (einmalig geloggt, kein Spam), sobald der SOC innerhalb von 5 Prozentpunkten unter `maxBatterySoc` liegt; der Sollwert selbst wird davon unberührt normal weitergeschrieben, und die Validierung läuft automatisch wieder an, sobald der SOC diese Marge wieder unterschreitet.

## v1.1.0 (2026-08-23)

### English
- **Relay-flicker fix (charge + discharge):** `RelayProtection` tracked its hold/release deadband state off the actually-written setpoint, which never changes while an active discharge or charge block (voltage/SOC/minSoc recovery, `maxBatterySoc`, `enableCharge`) forces every write to 0. Every cycle looked like a fresh Standby↔Active transition, so the deadband counter kept alternating internally the whole time the block was active - invisible until the block briefly lifted, at which point whatever the churn was outputting got written for real: an observable 0W/10W/full-power flicker on the physical relay. Both Single- and Multi-Device now tell `RelayProtection` in advance when charge/discharge is already vetoed downstream, so it freezes its counters instead of churning them.
- Fixed a related bug where sustained standby kept re-sending a "real 0W" every ~5 minutes indefinitely instead of staying silent once committed - a new `committedZero` flag now remembers the commit.
- Fixed a Waterfill sticky-single-device bug: the resting (non-active) device wasn't marked `excluded`, so it kept re-arming/disarming a keep-alive and chattered its relay every `smartModeIdleTimeoutSec` - reported live by a tester running a two-device Waterfill setup.
- `control.regulatorGain` (added in 1.0.6) now also re-syncs correctly to the admin-configured value on adapter restart in Single-Device mode, not just Multi-Device.
- Dashboard: added two new live bubbles to the flow diagram - Autarkie (self-sufficiency) and PV-Quote (self-consumption) - computed client-side from existing status values, no new datapoints required. Fixed a broken dashboard link in the admin tile and a header/hamburger overlap on narrow mobile screens.

### Deutsch
- **Relais-Flicker-Fix (Laden + Entladen):** `RelayProtection` führte ihren Halten/Freigeben-Zustand anhand des tatsächlich geschriebenen Sollwerts, der sich nicht ändert, solange eine aktive Entlade- oder Ladesperre (Spannungs-/SOC-/minSoc-Recovery, `maxBatterySoc`, `enableCharge`) jeden Schreibvorgang auf 0 zwingt. Dadurch sah jeder Zyklus wie ein frischer Standby↔Active-Übergang aus, und der Deadband-Zähler alternierte die ganze Zeit intern weiter - unsichtbar, bis die Sperre kurz aufgehoben wurde: dann wurde geschrieben, was die Schwingung gerade lieferte - ein sichtbares 0W/10W/Volllast-Flackern am echten Relais. Single- und Multi-Device teilen `RelayProtection` jetzt vorab mit, wenn Laden/Entladen ohnehin downstream blockiert ist, sodass die Zähler eingefroren statt weiterlaufen.
- Einen verwandten Fehler behoben, bei dem im Dauerstandby alle ~5 Minuten erneut ein "echtes 0W" gesendet wurde, statt nach dem ersten Commit stillzuhalten - ein neues `committedZero`-Flag merkt sich jetzt den bereits erfolgten Commit.
- Einen Waterfill-Fehler im Sticky-Single-Device-Modus behoben: Das ruhende (nicht aktive) Gerät war nicht als `excluded` markiert und hat dadurch bei jedem `smartModeIdleTimeoutSec` erneut einen Keep-Alive scharf-/entschärft und sein Relais geklackert - live gemeldet von einem Tester mit Zwei-Geräte-Waterfill-Setup.
- `control.regulatorGain` (eingeführt in 1.0.6) wird jetzt auch im Single-Device-Modus beim Adapter-Neustart korrekt mit dem Admin-Konfigurationswert synchronisiert, nicht mehr nur im Multi-Device-Modus.
- Dashboard: zwei neue Live-Blasen im Flussdiagramm hinzugefügt - Autarkie und PV-Quote (Eigenverbrauch) - rein clientseitig aus vorhandenen Status-Werten berechnet, keine neuen Datenpunkte nötig. Defekten Dashboard-Link im Admin-Tab sowie eine Kopfzeilen-/Hamburger-Überlappung auf schmalen Mobilbildschirmen behoben.

## v1.0.6 (2026-08-23)

### English
- Added an optional I-Regulator gain (Settings > Zero Grid Control > Regulation Parameters, opt-in checkbox, default off/unchanged behavior). While investigating issue #30, a user's `Grid_filtered - target` error was found to be added to the previous setpoint at full weight (gain=1) every cycle, matching the original design. With a loop delay (grid meter reporting + device response time) close to or exceeding the cycle interval, this can build into a growing oscillation instead of settling - each cycle overcorrects before the previous correction is even reflected in the next grid reading. Lowering the gain (e.g. 0.3-0.5) trades regulation speed for stability margin directly, without needing a longer update interval (which slows reaction to genuine load changes too). Exposed as `control.regulatorGain` for live tuning once enabled in settings, including in the dashboard's control panel.

### Deutsch
- Optionalen I-Regler-Gain hinzugefügt (Einstellungen > Nulleinspeisung > Regelparameter, Opt-in-Checkbox, standardmäßig aus/unverändertes Verhalten). Bei der Untersuchung von Issue #30 stellte sich heraus, dass die Abweichung `Grid_filtered - Ziel` bei einem Nutzer mit vollem Gewicht (Gain=1) pro Zyklus auf den vorherigen Sollwert aufaddiert wird - genau wie im ursprünglichen Design vorgesehen. Liegt die Regelstrecken-Verzögerung (Zähler-Meldung + Geräte-Reaktionszeit) nahe am oder über dem Zyklus-Intervall, kann sich das statt einzupendeln zu einer wachsenden Schwingung aufschaukeln - jeder Zyklus korrigiert nach, bevor die vorherige Korrektur überhaupt in der nächsten Netzmessung sichtbar ist. Ein niedrigerer Gain (z.B. 0.3-0.5) tauscht Regelgeschwindigkeit direkt gegen Stabilitätsreserve, ohne ein längeres Update-Intervall zu benötigen (das auch die Reaktion auf echte Laständerungen verlangsamt). Verfügbar als `control.regulatorGain` für Live-Tuning, sobald in den Einstellungen aktiviert - inklusive im Dashboard-Kontrollpanel.

## v1.0.5 (2026-08-22)

### English
- Fixed: Multi-Device Mode with the Equal-Split strategy failed to start (`undefined is not a valid state value`) if a device's optional per-device Charge W/Discharge W override was left blank. These overrides are only required when using the Waterfill strategy; Equal-Split now falls back to the global charge/discharge limits instead of crashing.
- Multi-Device now logs each pack's minimum voltage at `debug` level (issue #21). Previously only Single-Device logged this, making it impossible to tell a stuck voltage-recovery state apart from a genuinely low or frozen reading in Multi-Device installs.
- Grid power and `gridInputPower` readings in Multi-Device now also detect stale/frozen source values and log a warning instead of silently reusing them, matching the protection Single-Device already had since #27.

### Deutsch
- Fix: Multi-Device-Modus mit Equal-Split-Strategie startete nicht (`undefined is not a valid state value`), wenn die optionalen Pro-Geräte-Felder Charge W/Discharge W leer gelassen wurden. Diese Overrides sind nur bei der Waterfill-Strategie erforderlich; Equal-Split greift jetzt auf die globalen Lade-/Entladelimits zurück statt abzustürzen.
- Multi-Device loggt jetzt pro Pack die minimale Spannung auf `debug`-Level (Issue #21). Bisher tat das nur Single-Device, wodurch sich in Multi-Device-Installationen ein feststeckender Voltage-Recovery-Zustand nicht von einem echten niedrigen oder eingefrorenen Messwert unterscheiden ließ.
- Netzleistung und `gridInputPower` werden in Multi-Device jetzt ebenfalls auf eingefrorene Quellwerte geprüft und loggen eine Warnung statt sie unbemerkt weiterzuverwenden, analog zum bestehenden Schutz bei Single-Device seit #27.

## v1.0.4 (2026-08-22)

### English
- Dashboard: added a daily Telemetry panel, opened via a new hamburger menu (top right of the header) so it stays out of the way until needed. Shows today's grid import/export energy, battery charge/discharge energy, real relay mode switches, and emergency-mode activations - PV energy is included too when the optional PV datapoint is configured.
- New `lib/Telemetry.js` module accumulates these daily totals in new `telemetry.*` states, resetting automatically at local midnight and surviving adapter restarts (hydrated from the persisted states) - no history/statistics adapter dependency, everything is self-contained.
- Mode-switch counting is based on the actually measured battery power direction flipping, not the raw setpoint or relay-protection debounce counters, so it reflects real relay switches only - not the debounce noise around them.
- Fixed: dashboard responses (HTML/JS/CSS/icons and the `/api/*` endpoints) now send `Cache-Control: no-store`. Previously no caching headers were set at all, which could leave a browser serving a stale `app.js`/`style.css` after an update while the freshly-loaded `index.html` already expected the new markup.

### Deutsch
- Dashboard: neues Telemetrie-Panel hinzugefügt, aufrufbar über ein neues Hamburger-Menü (oben rechts im Header), damit es nicht dauerhaft im Weg ist. Zeigt die heutige Netzbezugs-/Einspeise-Energie, Batterie-Lade-/Entlade-Energie, echte Relais-Moduswechsel und Notfallmodus-Aktivierungen - PV-Energie wird ebenfalls einbezogen, sofern der optionale PV-Datenpunkt konfiguriert ist.
- Neues Modul `lib/Telemetry.js` sammelt diese Tageswerte in neuen `telemetry.*`-States, die automatisch um Mitternacht (lokale Zeit) zurückgesetzt werden und Adapter-Neustarts überstehen (werden aus den persistierten States wiederhergestellt) - ganz ohne History-/Statistics-Adapter, komplett eigenständig.
- Moduswechsel werden anhand der tatsächlich gemessenen Batterieleistungsrichtung gezählt, nicht anhand des rohen Sollwerts oder der Entprellzähler der Relaisschutzlogik, damit nur echte Relaisschaltungen gezählt werden - nicht das Rauschen drumherum.
- Fix: Dashboard-Antworten (HTML/JS/CSS/Icons sowie die `/api/*`-Endpunkte) senden jetzt `Cache-Control: no-store`. Bisher wurden gar keine Caching-Header gesetzt, wodurch ein Browser nach einem Update weiterhin ein veraltetes `app.js`/`style.css` ausliefern konnte, während das frisch geladene `index.html` schon das neue Markup erwartete.

## v1.0.3 (2026-08-22)

### English
- Fixed #27: in Multi-Device Mode, the single-device-only `status.currentPowerW`/`status.batterySoc` states are no longer created (and are removed if left over from a previous single-device run). They were never written to in multi-device mode, so they stayed permanently frozen at whatever they last showed - the live equivalents there are `status.totalPowerW`/`status.avgSoc`, plus the per-device `status.devices.<id>.powerW`/`soc` states. Single-device installs are unaffected; these two states are now created dynamically on startup instead of being fixed `instanceObjects`, and are removed if a previous multi-device run left `status.totalPowerW`/`status.avgSoc` behind.

### Deutsch
- Fix #27: Im Multi-Device-Modus werden die nur für den Single-Device-Modus gedachten States `status.currentPowerW`/`status.batterySoc` nicht mehr angelegt (und beim Umstieg von Single- auf Multi-Device entfernt, falls noch vorhanden). Sie wurden im Multi-Device-Modus nie beschrieben und blieben deshalb dauerhaft bei ihrem letzten Wert eingefroren - die live aktuellen Entsprechungen dort sind `status.totalPowerW`/`status.avgSoc` sowie die Pro-Geräte-States `status.devices.<id>.powerW`/`soc`. Single-Device-Installationen sind nicht betroffen; die beiden States werden jetzt dynamisch beim Start angelegt statt als feste `instanceObjects`, und werden entfernt, falls ein vorheriger Multi-Device-Lauf `status.totalPowerW`/`status.avgSoc` hinterlassen hat.

## v1.0.2 (2026-08-20)

### English
- Added a standalone web dashboard, served directly by the adapter - no `vis`/`vis-2` setup required. Shows a live flow diagram (Grid/PV/House/Battery around a central hub) with a real battery-cell visualization for state of charge, works in both single- and multi-device mode, and includes control buttons wired directly to the `control.*` states.
- New admin tab to configure the dashboard: enable/disable, port (default 3005, free to change on conflicts), and optional real house-consumption and PV-production datapoints.
- When a house-consumption datapoint is configured, you can optionally subtract each device's own AC charging draw (`gridInputPower`) from it, so a whole-house meter's reading isn't inflated by the battery's own AC charging - PV-direct charging is intentionally excluded from that correction since it never touches the house meter.
- Clicking the battery (or a device card in multi-device mode) opens a detail view with live per-pack data (cell voltages, temperature, etc.) - dynamically discovered from whatever the connected Zendure device actually reports, not a hardcoded field list.
- The dashboard is installable as a home screen app (PWA) on iOS and Android.
- Automatic dark/light theme based on the browser/OS setting.
- Fixed: the Max Charge/Discharge override modes now keep `status.currentPowerW` (and the related grid/SOC/voltage status fields) live-updated every cycle while active, instead of freezing at whatever they showed right before the override was activated.
- Multi-Device dashboard: the two global Max Charge/Discharge power sliders are now hidden (with an explanatory note) when the Waterfill distribution strategy is active, since they're only a fallback there - the per-device limits configured in the admin devices table are what's actually effective. A gear icon on each device card shows those effective limits.
- The "House" node on the dashboard no longer shows a misleading placeholder value when no house-consumption datapoint is configured; it now shows the flow direction only (derived from Grid + Battery + PV, never a fabricated wattage) so it's still visually clear that energy is flowing toward the house.
- Fixed an Admin warning ("invalid jsonConfig") caused by two header items on the Dashboard config tab missing a required `size` property.
- **Breaking (Multi-Device):** `status.devices.<id>.*` state IDs are now derived from each device's own `deviceKey` (stable per physical unit) instead of its position in the admin devices table (`device1`, `device2`, ...). This prevents a state tree from silently relabeling a different physical device when the table is reordered or a device is removed. Old positional-id state trees are automatically cleaned up on the first start after upgrading; any external reference to the old `device1`/`device2` IDs (vis, scripts, Grafana, etc.) needs to be updated to the new deviceKey-based IDs. Single-device mode is unaffected.
- New: writable per-device control overrides under `control.devices.<id>.*` (`maxChargePowerW`, `maxDischargePowerW`, `chargeAllowed`, `dischargeAllowed`), overlaid on top of the admin-config values for the running session - the same pattern already used for the existing global `control.*` states. The dashboard's per-device gear icon is now a live editor for these instead of a read-only view.
- Fixed a pre-existing bug where the dashboard's per-pack battery detail view never worked in multi-device mode (device lookup compared against a config field that never existed).

### Deutsch
- Ein eigenständiges Web-Dashboard hinzugefügt, das der Adapter selbst ausliefert - kein `vis`/`vis-2`-Setup nötig. Zeigt ein Live-Flussdiagramm (Netz/PV/Haus/Batterie um einen zentralen Knotenpunkt) mit echter Batteriezellen-Visualisierung für den Ladezustand, funktioniert im Single- wie im Multi-Device-Modus, inklusive Steuerbuttons direkt verbunden mit den `control.*`-States.
- Neuer Admin-Tab zur Dashboard-Konfiguration: Aktivieren/Deaktivieren, Port (Standard 3005, bei Kollisionen frei änderbar) sowie optionale Datenpunkte für echten Hausverbrauch und PV-Produktion.
- Ist ein Hausverbrauchs-Datenpunkt konfiguriert, kann optional die eigene AC-Ladeleistung jedes Geräts (`gridInputPower`) davon abgezogen werden, damit ein Gesamthauszähler durch die AC-Ladung der Batterie nicht überhöht anzeigt - PV-Direktladung bleibt bei dieser Korrektur bewusst außen vor, da sie nie über den Hauszähler läuft.
- Klick auf die Batterie (bzw. im Multi-Device-Modus auf eine Gerätekarte) öffnet eine Detailansicht mit Live-Pro-Pack-Daten (Zellspannungen, Temperatur usw.) - dynamisch ermittelt aus dem, was das angeschlossene Zendure-Gerät tatsächlich liefert, keine fest verdrahtete Feldliste.
- Das Dashboard ist als App auf dem Homescreen installierbar (PWA) unter iOS und Android.
- Automatischer Hell-/Dunkelmodus passend zur Browser-/Systemeinstellung.
- Fix: Die Max Charge/Discharge-Override-Modi halten `status.currentPowerW` (und die zugehörigen Netz-/SOC-/Spannungs-Status-Felder) jetzt in jedem Zyklus live aktuell, statt beim zuletzt vor der Aktivierung angezeigten Wert einzufrieren.
- Multi-Device-Dashboard: die beiden globalen Max-Lade-/Entladeleistungs-Regler werden jetzt (mit Hinweistext) ausgeblendet, wenn die Waterfill-Verteilstrategie aktiv ist, da sie dort nur ein Fallback sind - wirksam sind die pro Gerät in der Admin-Geräte-Tabelle konfigurierten Limits. Ein Zahnrad-Icon an jeder Gerätekarte zeigt diese tatsächlich wirksamen Limits an.
- Der "Haus"-Knoten im Dashboard zeigt ohne konfigurierten Hausverbrauchs-Datenpunkt keinen irreführenden Platzhalterwert mehr; stattdessen wird nur noch die Flussrichtung angezeigt (abgeleitet aus Netz + Batterie + PV, nie eine erfundene Wattzahl), sodass weiterhin sichtbar bleibt, dass Energie Richtung Haus fließt.
- Eine Admin-Warnung ("invalid jsonConfig") behoben, die durch zwei Header-Elemente im Dashboard-Konfigurationstab ohne die erforderliche `size`-Eigenschaft verursacht wurde.
- **Breaking Change (Multi-Device):** `status.devices.<id>.*`-State-IDs werden jetzt aus dem `deviceKey` des jeweiligen Geräts abgeleitet (eindeutig pro physischem Gerät) statt aus der Position in der Admin-Geräte-Tabelle (`device1`, `device2`, ...). Das verhindert, dass ein State-Baum beim Umsortieren der Tabelle oder Entfernen eines Geräts stillschweigend einem anderen physischen Gerät zugeordnet wird. Alte, positionsbasierte State-Bäume werden beim ersten Start nach dem Update automatisch aufgeräumt; externe Referenzen auf die alten `device1`/`device2`-IDs (vis, Skripte, Grafana usw.) müssen manuell auf die neuen deviceKey-basierten IDs angepasst werden. Der Single-Device-Modus ist davon nicht betroffen.
- Neu: schreibbare Pro-Gerät-Steuerungs-Overrides unter `control.devices.<id>.*` (`maxChargePowerW`, `maxDischargePowerW`, `chargeAllowed`, `dischargeAllowed`), die für die laufende Session über die Admin-Config-Werte gelegt werden - dasselbe Muster wie bei den bestehenden globalen `control.*`-States. Das Zahnrad-Icon an der Gerätekarte im Dashboard ist jetzt ein Live-Editor dafür statt einer reinen Anzeige.
- Einen bereits bestehenden Fehler behoben, durch den die Pro-Pack-Batteriedetailansicht im Dashboard im Multi-Device-Modus nie funktioniert hat (Geräte-Zuordnung verglich gegen ein Config-Feld, das nie existierte).

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
