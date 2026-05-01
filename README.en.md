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

### ⚙️ Mode-Switching Protection
- **Bidirectional Protection** – delays both directions (Charge↔Discharge)
- **Feed-in Delay** – 5 ticks (25s) sustained feed-in before Charge
- **Discharge Delay** – 3 ticks (15s) sustained consumption before Discharge
- **10W Safe-Switch** – relay switches only at minimal current (~0.04A)
- **Operating Deadband (new)** – holds at ±5W for 1 tick before zero crossing

### 🏗️ Modern Architecture
- **Modular Structure** – 9 specialized modules (v0.7.0 Controller Extraction)
- **47% Code Reduction** – from 1052 to 554 lines in main.js
- **Controller-based** – SingleDeviceController & MultiDeviceController
- **Testable & Maintainable** – clear separation of responsibilities
- **Fully Documented** – JSDoc, inline comments, German/English

---

## 📋 Prerequisites

- ioBroker installation
- [nograx's zendure-solarflow adapter](https://github.com/nograx/ioBroker.zendure-solarflow) (installed & configured)
- Zendure device with ZenSDK: Solarflow 1600AC+, 2400AC+ or compatible
- Grid power meter (e.g., Shelly 3EM, Tasmota, etc.)

---

## 🚀 Quick Start

### Installation

In ioBroker Admin → Adapters → Install from custom URL:
```
https://github.com/Felliglanz/iobroker.zendure-automation
```

### Basic Configuration

1. **⚙️ Basic Settings**
   - Zendure Instance: `zendure-solarflow.0`
   - ProductKey & DeviceKey: Copy from zendure-solarflow object tree
   - Power Meter Datapoint: Your grid power sensor (Positive=consumption, Negative=feed-in)

2. **🎯 Zero Grid Control**
   - Target Grid Power: `0` W (for perfect zero feed-in)
   - Update Interval: `5` seconds (recommended)
   - Max Charge/Discharge Power: According to device specifications

3. **🔋 Battery Protection**
   - Choose protection mode: **SOC** (simple) or **Voltage** (precise)
   - **SOC Mode**: Min SOC 10%, Max SOC 100%
   - **Voltage Mode**: Min Voltage 3.18V (LFP), Hysteresis 0.1V

**That's it!** Default values for Relay Protection, Regulation, and Emergency are already optimally configured.

---

## 🔄 Multi-Device Support

**Control multiple Zendure devices as one unified system** – perfect for 2x Solarflow 2400 or larger installations.

### Activation

**⚙️ Basic Settings**
1. Enable checkbox **"Enable Multi-Device Support"**
2. Add devices in the device table:
   - ProductKey (from zendure-solarflow object tree)
   - DeviceKey (from zendure-solarflow object tree)
   - Name (optional, e.g., "Garage", "Basement")
   - Enabled (check box)

### How it Works

**Power Distribution:**
- **Equal Split** – power is distributed evenly across all active devices
- **Dynamic Exclusion** – devices at limits are automatically excluded
- **Per-Device Tracking** – each device has its own states in the object tree

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

**Important:** All settings apply **globally to ALL devices**!

Configure values as if you had **a single device**:

| Parameter | Example 2400AC+ | Explanation |
|-----------|------------------|-------------|
| **maxDischargePowerW** | 2400 | Power **per device** |
| **maxChargePowerW** | 1200 | Power **per device** |
| **minBatterySoc** | 10% | Applies to **all devices** |
| **maxBatterySoc** | 95% | Applies to **all devices** |

The system automatically multiplies:
- 2 Devices × 2400W = **4800W Total Discharge**
- 2 Devices × 1200W = **2400W Total Charge**

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
- `status.devices.device1.emergency` – Emergency status
- `status.devices.device1.excluded` – Excluded from distribution?

### Emergency Handling

**Per-Device Emergency:**
- Each device is monitored individually (SOC, voltage, flags)
- **If ONE device has emergency** → ALL eligible devices charge
- Emergency charge power is distributed across active devices

**Example:**
```
Device 1: Pack voltage 2.95V → EMERGENCY!
System: Charges both devices with 800W each (if active)
Device 2 reaches max SOC → Excluded, Device 1 continues charging alone
```

### Limits & Exclusion

A device is automatically excluded from distribution when:
- ✅ **Emergency Recovery active** (may only charge)
- ✅ **Voltage Recovery active** (may only charge)
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

### ⚡ Relay Protection (Anti-Wear)

Protects hardware from excessive switching, especially in variable weather:

| Parameter | Recommended | Description |
|-----------|-------------|-------------|
| **Feed-in Threshold** | -150W | Feed-in needed for charge start |
| **Feed-in Delay** | 5 Ticks | 25s sustained feed-in |
| **Discharge Threshold** | 200W | Grid consumption needed for discharge start |
| **Discharge Delay** | 3 Ticks | 15s sustained consumption |
| **Operating Deadband** | 5W | Minimum power before zero crossing |

**Operating Deadband (v0.6.1 new):**
- Holds at ±5W for 1 tick before allowing 0W or sign change
- Prevents relay chattering during oscillation around target
- Works together with 10W safe-switch (switches only at ~0.04A)

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

### 🚨 Emergency & Recovery

**Emergency Charging** (highest priority):
- Activated at: `lowVoltageBlock` flag OR voltage < 3.0V
- Charges with 800W until exit SOC (20%)
- Overrides all other automations

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

### v0.7.0 (2026-04-15) - Controller Refactoring
- 🏗️ **Major Architecture Improvement** – Controllers extracted from main.js
- ✨ **SingleDeviceController** – Complete single-device cycle in dedicated module
- ✨ **MultiDeviceController** – Complete multi-device cycle in dedicated module
- 📉 **47% Code Reduction in main.js** – from 1052 to 554 lines
- 📚 **Business Logic Extraction** – All automation logic moved to testable controllers
- 🧪 **Improved Testability** – Controllers are independent and easily unit-testable
- 🎯 **Clear Separation** – main.js only adapter lifecycle, controllers handle automation

### v0.6.1 (2026-04-03)
- ✨ **Operating Deadband Protection** – prevents relay chattering during oscillation
- Holds at ±5W for 1 tick before zero crossing
- Reduces switching operations without slowing control

### v0.6.0 (2026-03-28)
- 🏗️ **Major Refactoring** – Modular architecture with 6 specialized modules
- 59% code reduction (948→388 lines in main.js)
- Improved maintainability, testability, and documentation

### v0.5.8 (2026-03-27)
- 🐛 Power validation accepts device ramping during charge

### v0.5.7 (2026-03-26)
- ✨ Non-blocking power setpoint validation with auto-retry

### v0.5.5 (2026-03-25)
- 🐛 **Critical Fix**: Persistent emergency recovery across adapter restarts

### v0.5.0 (2026-03-25)
- ✨ Voltage recovery hysteresis
- ✨ Bidirectional mode-switching protection
- ✨ Asymmetric ramp limits

### v0.4.0 (2026-03-24)
- 🎉 Initial Release

[Full Changelog](https://github.com/Felliglanz/iobroker.zendure-automation/releases)

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
