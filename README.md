# ioBroker.zendure-automation

Automatic battery control adapter for Zendure Solarflow devices with ZenSDK support (1600AC+, 2400AC+).

## 🎯 What it does

This adapter automatically controls your Zendure Solarflow battery to achieve **zero grid feed-in and zero grid draw**. It continuously monitors your grid power consumption and adjusts battery charging/discharging to balance it out.

### Key Features

- ✅ **Zero Grid Target**: Automatically aims for 0W grid power (configurable)
- ✅ **Dynamic Power Limiter**: Algorithm inspired by OpenDTU-OnBattery
- ✅ **Fast Response**: Updates every 5 seconds (configurable)
- ✅ **Smart Battery Protection**: Respects SOC limits, voltage limits, and device flags
- ✅ **Emergency Charging**: Honors device protection flags (lowVoltageBlock, fullChargeNeeded) and critical voltage thresholds
- ✅ **Multi-Pack Support**: Monitors voltage across all battery packs independently
- ✅ **Smooth Operation**: Configurable hysteresis and ramp rates
- ✅ **Traffic Optimization**: Only writes when values actually change

## 📋 Requirements

- ioBroker installation
- [nograx's zendure-solarflow adapter](https://github.com/nograx/ioBroker.zendure-solarflow) installed and configured
- Zendure device with ZenSDK support:
  - Solarflow 1600AC+
  - Solarflow 2400AC+
  - (Other ZenSDK devices should work too)
- Grid power meter datapoint (from Shelly, Tasmota, etc.)

## 🚀 Installation

### From GitHub Release (Recommended)

1. Create a GitHub release with tag `v0.1.0`
2. The `.tgz` package will be automatically built and attached
3. In ioBroker Admin → Adapters → Install from custom URL:
   ```
   https://github.com/Felliglanz/iobroker.zendure-automation/releases/download/v0.1.0/iobroker.zendure-automation-0.1.0.tgz
   ```

### Manual Installation

1. Clone or download this repository
2. Navigate to the directory:
   ```bash
   cd iobroker.zendure-automation
   npm install
   npm pack
   ```
3. Upload the generated `.tgz` file in ioBroker Admin

## ⚙️ Configuration

### Device Settings

1. **Zendure Solarflow Instance**: Your nograx adapter instance (e.g., `zendure-solarflow.0`)
2. **ProductKey & DeviceKey**: Find these in the zendure-solarflow object tree

### Grid Power Meter

Select the datapoint that provides your current grid power:
- **Positive values** = Drawing power from grid
- **Negative values** = Feeding power to grid

Example sources:
- Shelly 3EM: `shelly.0.SHELLY3EM-XXX.Emeter.0.Power`
- Tasmota: `mqtt.0.tele.tasmota.SENSOR.ENERGY.Power`

### Automation Settings

- **Target Grid Power**: Usually `0` W (can be adjusted for slight grid draw/feed preference)
- **Update Interval**: `5` seconds recommended

### Power Limits

- **Max Charge Power**: Your device's maximum charging power (e.g., 1600W)
- **Max Discharge Power**: Your device's maximum discharging power (e.g., 1600W)

### Battery Protection

- **Min SOC**: Stop discharging below this percentage (e.g., 10%)
- **Max SOC**: Stop charging above this percentage (e.g., 100% - maxVol is NOT considered, full charge = 100% SOC)
- **Discharge Protection Mode**: Choose between:
  - **By SOC (%)**: Traditional SOC-based protection (simpler, default)
  - **By Pack Voltage (V)**: Monitors minimum cell voltage across ALL battery packs
- **Min Pack Cell Voltage**: When using voltage mode, stop discharging if ANY pack's minVol drops below this (typical: 3.0V for LFP cells)

**💡 Multi-Pack Voltage Monitoring:**  
For systems with multiple battery packs (e.g., AB1000 + AB2000 stack), voltage mode reads each pack's `minVol` independently and uses the **lowest value** across all packs. This ensures the weakest pack is protected from deep discharge.

### Emergency Charging

The adapter monitors critical battery conditions and can force emergency charging when needed:

- **Device Protection Flags**:
  - `lowVoltageBlock`: Device signals critical low voltage → Stop discharging immediately
  - `fullChargeNeeded`: Device requests full charge cycle (calibration) → Force charging to 100%
  
- **Critical Voltage Protection**:
  - If ANY pack drops below `emergencyChargeVoltageV` (default: 2.8V) → Force emergency charging
  - Uses `emergencyChargePowerW` (default: 800W) for emergency charging
  - **Highest priority**: Overrides all other automation logic
  
**🚨 Winter Scenario Example:**  
During dark winter days, if a pack voltage drops critically low (e.g., 2.7V from cold temperatures + no solar), the adapter immediately switches to emergency charging mode, ignoring grid power targets to protect the battery from damage.

### Tuning

- **Hysteresis**: Minimum power change to react (reduces frequent small adjustments)
- **Ramp-up/down limits**: How fast power can change per cycle (prevents aggressive jumps)

## 🧮 How it Works

### The Algorithm

Inspired by the [OpenDTU-OnBattery Dynamic Power Limiter](https://github.com/hoylabs/OpenDTU-OnBattery), this adapter uses a simple but effective formula:

```
newBatteryPower = currentBatteryPower + (targetGridPower - actualGridPower)
```

**Example 1**: Grid is drawing 300W, target is 0W, battery is idle
- `newBatteryPower = 0 + (0 - 300) = -300W` → **Discharge 300W**

**Example 2**: Grid is feeding 200W, target is 0W, battery is idle
- `newBatteryPower = 0 + (0 - (-200)) = +200W` → **Charge 200W**

### Sign Convention

- **Battery Power**:
  - Negative = Charging (e.g., -500W = charging at 500W)
  - Positive = Discharging (e.g., +800W = discharging at 800W)
- **Grid Power**:
  - Positive = Drawing from grid
  - Negative = Feeding to grid

This matches the `setDeviceAutomationInOutLimit` convention from the nograx adapter.

## 📊 Status Monitoring

The adapter creates these states under `zendure-automation.0.*`:

### Control States
- `control.enabled`: Enable/disable automation
- `control.targetGridPowerW`: Target grid power (changeable on the fly)

### Status States
- `status.mode`: Current mode (idle/charging/discharging/standby/emergency-charging/error)
- `status.currentPowerW`: Current battery power
- `status.gridPowerW`: Current grid power
- `status.batterySoc`: Current battery SOC
- `status.minPackVoltageV`: Minimum pack cell voltage (when using voltage protection mode)
- `status.emergencyReason`: Reason for emergency mode (if active)
- `status.lastUpdate`: Last update timestamp

## 🔧 Development

### Local Development

```bash
npm install
npm test  # if tests exist
npm pack  # creates installable .tgz
```

### Project Structure

```
iobroker.zendure-automation/
├── admin/
│   ├── jsonConfig.json      # Admin UI configuration
│   └── zendure-automation.png
├── main.js                  # Main adapter logic
├── package.json
├── io-package.json          # Adapter metadata
├── LICENSE
└── README.md
```

## 🐛 Troubleshooting

### Adapter doesn't control the battery

1. Check that `control.enabled` is `true`
2. Verify ProductKey and DeviceKey are correct
3. Check the nograx adapter has `control.setDeviceAutomationInOutLimit` state
4. Enable `debug` log level to see detailed calculations

### Battery power changes too aggressively

- Increase `hysteresis` (e.g., to 100W)
- Decrease `rampUpWPerCycle` and `rampDownWPerCycle`
- Increase `updateIntervalSec` to 10 seconds

### Battery not responding to surplus

- Check that `enableCharge` is enabled
- Verify SOC is below `maxBatterySoc`
- Check grid power meter is providing correct values (negative = surplus)

## 📝 Changelog

### 0.3.0 (2026-03-22)
- **NEW**: Emergency charging mode with highest priority
- **NEW**: Honors device protection flags: `lowVoltageBlock` and `fullChargeNeeded`
- **NEW**: Critical voltage protection (force charge below configurable threshold)
- **NEW**: Config options: `emergencyChargeVoltageV` and `emergencyChargePowerW`
- **NEW**: Status states: `status.emergencyReason` to display emergency condition
- Improved: Battery protection now includes device-level signals
- Improved: Winter/darkness scenarios with automatic emergency charging

### 0.2.0 (2026-03-22)
- **NEW**: Voltage-based discharge protection mode
- **NEW**: Multi-pack voltage monitoring (reads minVol from all packs)
- **NEW**: Status state `minPackVoltageV` for monitoring
- **CHANGED**: Config option `minBatteryVoltageMv` renamed to `minBatteryVoltageV` (now in Volts)
- **CHANGED**: MaxVol is explicitly ignored (full charge = SOC 100%)
- Improved: User can choose between SOC or voltage-based discharge protection

### 0.1.0 (2026-03-21)
- Initial release
- Automatic charge/discharge control
- Zero grid target algorithm
- Battery protection (SOC, voltage)
- Configurable ramp rates and hysteresis

## 📄 License

MIT License - see [LICENSE](LICENSE) file

## 🤝 Credits

- Algorithm inspired by [OpenDTU-OnBattery](https://github.com/hoylabs/OpenDTU-OnBattery) Dynamic Power Limiter
- Works with [nograx's ioBroker.zendure-solarflow](https://github.com/nograx/ioBroker.zendure-solarflow) adapter
- Built with [@iobroker/adapter-core](https://github.com/ioBroker/adapter-core)

## ⚠️ Disclaimer

This is a private adapter for personal use. Use at your own risk. The author is not responsible for any damage to your battery or system.
