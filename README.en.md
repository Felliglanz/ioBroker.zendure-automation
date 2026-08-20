# ioBroker.zendure-automation

## 🌍 Language / Sprache

🇩🇪 **[Deutsche Version](README.md)** | 🇬🇧 **[English Version](README.en.md)**

---

![Logo](admin/zendure-automation.png)

**Intelligent Zero-Grid Automation for Zendure Solarflow** – Automatic battery control for maximum self-sufficiency with local ZenSDK control.

## 🎯 What does this adapter do?

Automatically controls your Zendure Solarflow battery for **zero feed-in** and **zero grid consumption**. Continuously monitors grid power and balances it through intelligent charging/discharging.

**Result:** 97%+ self-sufficiency, minimal grid costs, 100% local control via ZenSDK! ⚡

---

## ✨ Features Overview

### 🎯 Intelligent Control
- **I-Controller Algorithm** (inspired by OpenDTU-OnBattery) – stable, precise control
- **EMA Filter for Grid Power** – smooths rapid load changes (TV, microwave), configurable (0.1-1.0)
- **5s Update Interval** – fast response to load changes
- **Operating Deadband** – prevents relay chattering during oscillation around 0W
- **Asymmetric Ramps** – gentle charging (100W/cycle), fast discharging (400W/cycle)
- **Hysteresis (50W)** – no micro-adjustments for small fluctuations

### 🛡️ Battery & Hardware Protection
- **Multi-Pack Voltage Monitoring** – monitors each pack individually
- **SOC- or Voltage-based** – selectable protection mode
- **Emergency Charging** – automatic emergency charging at critical voltage
- **Recovery Mode** – prevents discharge loops after emergency charging
- **Relay Protection** – minimizes switching operations, extends hardware lifespan
- **Power Validation** – checks if device accepts setpoints (with auto-retry)

### How it Works

**Power Distribution:**
- **Equal Split** – power is distributed evenly across all active devices
- **Waterfill + Sticky Device (optional)** – distributes power using individual device limits and SOC weighting; low demand can be concentrated on one suitable device
- **Dynamic Exclusion** – devices at limits are automatically excluded
- **Per-Device Tracking** – each device has its own states in the object tree

### Waterfill + Sticky Device

Select the optional distribution strategy in the Multi-Device settings. Each enabled device can have its own minimum and maximum SOC limits, charge and discharge power limits, and charge/discharge permissions.

Waterfill first distributes the requested power according to each device's available SOC range. When a device reaches its configured power or SOC limit, the remaining power is redistributed to other eligible devices. At low power demand, the strategy can concentrate power on one device after a configurable hold time. The preferred device is changed only when another device has a sufficient SOC advantage.

Equal Split remains the default strategy. In Waterfill mode, the global SOC protection limits remain active. Power limits and charge/discharge permissions are configured per device in the table; voltage, emergency, and recovery protection remain active.

> **⚠️ Note:** Waterfill is an additional Multi-Device strategy and should initially be checked with the configured device limits and a small test setup. PV headroom and automatic bypass control are not part of this version yet.

**Example with 2x Solarflow 2400:**
```
I-Controller calculates: -1800W (charging)
→ Device 1: -900W
→ Device 2: -900W

Device 2 reaches max SOC (95%):
→ Device 1: -1800W (gets full power)
→ Device 2: 0W (excluded)
```

### Configuration

**Equal Split:** Power and SOC settings apply globally to all devices.

**Waterfill:** Global SOC limits still apply to all devices. Power limits and charge/discharge permissions are configured per device in the table.

Configure values as if you had **a single device**:

| Parameter | Example 2400AC+ | Explanation |
|-----------|------------------|-------------|
| **maxDischargePowerW** | 2400 | Power **per device** |
| **maxChargePowerW** | 1200 | Power **per device** |
| **minBatterySoc** | 10% | Applies to **all devices** |
| **maxBatterySoc** | 95% | Applies to **all devices** |
| **operatingDeadbandW** | 10 | **Per device** (auto-scaled) |

In Waterfill mode, the following additional per-device values are used: `maxChargePowerW`, `maxDischargePowerW`, `chargeAllowed`, and `dischargeAllowed`. `waterfillSocMargin` still controls the SOC advantage required for a sticky-device switch.

The system automatically multiplies:
- 2 Devices × 2400W = **4800W Total Discharge**
- 2 Devices × 1200W = **2400W Total Charge**
- 2 Devices × 10W = **20W Total Deadband** (for equal split)

> **⚠️ Interaction with Zendure App SOC Limits**  
> The adapter controls via ZenSDK (power setpoints in watts).  
> The Zendure app defines the allowed SOC range.  
> The **adapter values must be within the Zendure app limits**!  
> See section "🔋 Battery Protection Modes" for technical details.

### States (Object-Tree)

Multi-Device creates additional states:

**Global:**
- `status.totalPowerW` – Sum of all devices
- `status.avgSoc` – Average SOC

**Per Device (device1, device2, ...):**
- `status.devices.device1.soc` – Device SOC
- `status.devices.device1.powerW` – Current power
- `status.devices.device1.emergencyRecoveryActive` – Emergency charging due to critical voltage active
- `status.devices.device1.voltageRecoveryActive` – Voltage recovery active (discharge blocked)
- `status.devices.device1.socRecoveryActive` – SOC recovery active (discharge blocked)
- `status.devices.device1.minSocRecoveryActive` – Zendure hardware minSoc recovery active
- `status.devices.device1.excluded` – Excluded from distribution?

### Emergency Handling

**Per-Device Emergency:**
- Each device is monitored individually (SOC, voltage, flags) and decided independently
- Only the device(s) that actually meet the emergency criteria are charged with `emergencyChargePowerW` (capped to that device's own `maxChargePowerW`)
- Other devices are unaffected and keep running under normal I-regulator control

**Example:**
```
Device 1: Pack voltage 2.95V → EMERGENCY!
System: Charges only Device 1 (up to 800W, capped to its maxChargePowerW)
Device 2 stays in normal operation, still following the grid target
```

### Limits & Exclusion

A device is automatically excluded from distribution when:
- ✅ **Emergency Recovery active** (may only charge)
- ✅ **Voltage Recovery active** (may only charge)
- ✅ **SOC Recovery active** (may only charge)
- ✅ **MinSoc Recovery active** (Zendure hardware protection, may only charge)
- ✅ **Max SOC reached** (no more charging)
- ✅ **Min SOC reached** (no more discharging)

**Excluded devices** are set to **0W**, others continue regulating normally.

### Hardware Protection

**The Good News:** Solarflow hardware has its own limits!
- Even if you configure "too high" values → hardware blocks them
- Maximum safety through dual protection (software + hardware)

**Best Practice:**
- Configure correct values for optimal control quality
- When in doubt: hardware protects itself ✓

---

## ⚙️ Advanced Configuration

### 🔋 Battery Protection Modes in Detail

> **⚠️ IMPORTANT: Adapter ↔ Zendure System Interaction**  
> 
> **What does the adapter do?**
> - Writes **only power setpoints** (watts) via ZenSDK: `setDeviceAutomationInOutLimit`
> - Reads SOC, voltage, etc. for monitoring
> - Does **NOT** set SOC boundaries in the Zendure system
> 
> **How does the control work?**
> ```  
> Zendure App:  Defines allowed SOC range (hardware limit)
> Adapter:      Controls within this range (software limit)
> ```
> 
> **Technical Process:**
> 1. You configure in Zendure app: e.g., 5% - 100%
> 2. You configure in adapter: e.g., 10% - 90%
> 3. Adapter controls between 10% and 90%
> 4. Zendure hardware allows maximum 5% to 100%
> 
> **What happens on conflict?**
> ```
> Zendure App:  10% - 90%   ← Narrow limits
> Adapter:       5% - 95%   ← Wants to use more
> → Adapter sends charge command at 91% SOC
> → Zendure hardware blocks (max 90%)
> → Validation error in adapter log
> → Control doesn't work correctly
> ```
> 
> **Configuration Rule:**
> Adapter values must be **within** Zendure app limits.  
> Where exactly you set your limits depends on your use case.

**SOC Mode**
- Simple, reliable
- Min/Max SOC percentage limits
- Uses SOC from device
- **ATTENTION:** Adapter values must be within Zendure app limits (see warning above!)

**Voltage Mode (Recommended for Multi-Pack)**
- Monitors `packData.*.minVol` of each pack
- Uses lowest value (protects weakest pack)
- Voltage recovery hysteresis prevents oscillation through relaxation
- Example: Min 3.18V + Hysteresis 0.1V → Recovery only at 3.28V
- **Additional safety** beside SOC limits (both modes active in parallel!)

**🛡️ Zendure minSoc Protection (NEW in v0.7.2)**

Prevents hardware block from Zendure's internal 5% SOC protection:

- **Problem:** Zendure blocks hardware-side at ~5% SOC, even when minVol is still OK (inaccurate SOC algorithm)
- **Solution:** Reads `minSoc` state from Zendure device dynamically
- **How it works:** Stops discharge at `minSoc + margin` (default: 5% + 1% = **6%**)
- **Recovery:** Discharge allowed again at `6% + hysteresis` (default: +2% = **8%**)
- **Transparency:** State `status.effectiveMinSoc` shows current effective limit

**Configuration:**
- **Use Zendure minSoc:** On/Off (default: **enabled**)
- **minSoc Margin:** Safety margin in % (default: **1%**)
- **Recovery Hysteresis:** Prevents flipping in % (default: **2%**)

**Example:** Device minSoc=5%, Margin=1%, Hysteresis=2%
- Stop at 6% → Battery charges → Release at 8% → No flipping! ✅

### ⚡ Relay Protection (Anti-Wear)

Protects hardware from excessive switching, especially in variable weather:

| Parameter | Recommended | Description |
|-----------|-------------|-------------|
| **Feed-in Threshold** | -150W | Feed-in needed for charge start |
| **Feed-in Delay** | 5 Ticks | 25s sustained feed-in |
| **Discharge Threshold** | 200W | Grid consumption needed for discharge start |
| **Discharge Delay** | 3 Ticks | 15s sustained consumption |
| **Operating Deadband** | 10W | Minimum power per device before zero crossing |

**Operating Deadband (updated v0.7.6):**
- Configurable per device (default: 10W)
- Automatically scaled in multi-device mode (e.g., 2 devices × 10W = 20W total)
- Prevents relay chattering during oscillation around target
- Works together with 10W safe-switch (switches only at ~0.04A)
- Available as runtime override: `control.operatingDeadbandW`

### 🎚️ Control Parameters

| Parameter | Default | Purpose |
|-----------|---------|---------|
| **Hysteresis** | 50W | Minimum change for reaction |
| **Charge Ramp** | 100W/cycle | Gentle charging |
| **Discharge Ramp** | 400W/cycle | Fast load response |
| **EMA Filter Alpha** | 0.5 | Grid power smoothing (0.1-1.0) |

**Tip:** Higher ramps = more aggressive, lower = gentler & hardware-friendly

### 📊 EMA Filter (Exponential Moving Average)

Smooths the grid power signal to avoid reacting to fast load spikes (TV, microwave):

| Alpha | Behavior | Use Case |
|-------|-----------|----------|
| **0.1 - 0.3** | Very sluggish, strong smoothing | Frequent load spikes, relaxed control |
| **0.4 - 0.6** | ⭐ Balanced (recommended) | Standard application |
| **0.7 - 0.9** | Fast, little smoothing | Fast response desired |
| **1.0** | No filtering | Pure I-controller like v0.6.0 |

**Formula:** `filtered = alpha × new + (1 - alpha) × old`

**When to adjust?**
- **Too sluggish?** → Increase alpha (e.g., 0.5 → 0.7)
- **Too jittery?** → Decrease alpha (e.g., 0.5 → 0.3)
- **No filter?** → Alpha = 1.0 (legacy behavior)

### 🔍 Validation Source (For Devices with PV Modules)

**Problem:** For devices with directly connected PV modules (e.g., Solarflow Pro), `packPower` is not equal to the API setpoint:
```
packPower = API setpoint + PV input + AC charging
```

**Example:**
- Adapter sets: -1020W (charging)
- PV modules deliver: ~720W
- `packPower` shows: -1740W
- **Validation fails!** (Expected: -1020W, Actual: -1740W)

**Solution: Selectable Validation Source**

| Source | Description | When to use? |
|--------|-------------|--------------|
| **packPower** | Total battery power (API + PV) | Default for devices **without** PV modules |
| **gridInputPower** | AC charging power only (API setpoint) | For devices **with** PV modules (Pro, AC+) |
| **none** | Validation disabled | As last resort if issues occur |

**Configuration:**
- **Single-Device Mode:** "Validation Source" dropdown under device settings
- **Multi-Device Mode:** Per device in the devices table

**Recommendation:**
- **2400 Pro / 2000 Pro** with PV → select `gridInputPower`
- **AC+ / Hyper** without PV → `packPower` (default)
- If unsure → test `packPower`, if validation errors occur → switch to `gridInputPower`

### 🚨 Emergency & Recovery

**Emergency Charging** (highest priority):
- Activated only at critical pack voltage according to `emergencyChargeVoltageV`
- Charges with 800W until exit SOC (20%)
- Overrides all other automations

`lowVoltageBlock` only stops discharging as additional device protection and does not trigger emergency charging.

**Recovery Mode**:
- Active from 20% to 30% SOC (configurable)
- **Discharge blocked**, further charging allowed (only with PV surplus)
- Prevents emergency loops

---

## 🧮 How does the Algorithm work?

**I-Controller Formula** (inspired by OpenDTU-OnBattery):
```javascript
newBatteryPower = lastBatteryPower + (currentGridPower - targetGridPower)
```

**Examples:**
- Grid draws 300W, target 0W → Battery discharges with 300W
- Grid feeds 200W, target 0W → Battery charges with 200W

**Sign Convention:**
- Battery: Negative=charging, Positive=discharging
- Grid: Positive=consumption, Negative=feed-in

---

## 📊 States & Monitoring

### Control
- `control.enabled` – Automation on/off
- `control.targetGridPowerW` – Target value changeable

### Status
- `status.mode` – Mode: idle/charging/discharging/standby/emergency/recovery/error
- `status.currentPowerW` – Current battery power
- `status.gridPowerW` – Current grid power
- `status.batterySoc` – Current SOC
- `status.minPackVoltageV` – Minimum pack voltage
- `status.feedInCounter` / `dischargeCounter` – Delay counters (debug)
- `status.emergencyReason` – Reason for emergency mode

---

## 📜 Changelog

See the complete version history in [CHANGELOG.md](CHANGELOG.md).

---

## 🎯 Real-World Performance

**User-validated results:**
- ✅ **97% self-sufficiency** achieved (1400W discharge power)
- ✅ Better than OpenDTU-OnBattery (user feedback)
- ✅ Stable zero-grid control even in cloudy conditions
- ✅ Fast response to load spikes
- ✅ 100% local control via ZenSDK (no cloud!)

---

## 📄 License

MIT License – See [LICENSE](LICENSE) file

---

## 🙏 Credits

- Inspired by [OpenDTU-OnBattery Dynamic Power Limiter](https://github.com/hoylabs/OpenDTU-OnBattery)
- Based on [nograx's ioBroker.zendure-solarflow](https://github.com/nograx/ioBroker.zendure-solarflow)
- Zendure logo © Zendure Technology GmbH

---

## ⚠️ Disclaimer

Community-developed, **not officially** supported by Zendure.  
Use at your own risk. Ensure battery protection settings are correctly configured!
