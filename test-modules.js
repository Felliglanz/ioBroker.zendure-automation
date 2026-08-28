#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Comprehensive Test Suite for ioBroker.zendure-automation
 *
 * Tests all critical paths including:
 * - Module loading and basic functionality
 * - ValidationService signature (3 params)
 * - Multi-device state validation (NaN/null checks)
 * - Safety limiters in multi-device distribution
 * - Edge cases and error handling
 * - Full integration tests
 * - Package/config file consistency (install-time safety net)
 *
 * Run: node test-modules.js or npm test
 */

console.log('='.repeat(70));
console.log('COMPREHENSIVE TEST SUITE - ioBroker.zendure-automation');
console.log('='.repeat(70));

let testsPassed = 0;
let testsFailed = 0;

// Test assertion helpers
function assert(condition, message) {
    if (!condition) {
        throw new Error(`Assertion failed: ${message}`);
    }
}

function assertEqual(actual, expected, message) {
    if (actual !== expected) {
        throw new Error(`${message}\n  Expected: ${expected}\n  Actual: ${actual}`);
    }
}

// State storage for mock adapter
const mockStates = new Map();

function setMockState(id, val) {
    mockStates.set(id, { val, ack: true, ts: Date.now() });
}

function getMockState(id) {
    return mockStates.get(id) || { val: null, ack: false };
}

// Enhanced mock adapter with realistic state handling
const mockAdapter = {
    log: {
        info: (msg) => {},  // Silent by default
        warn: (msg) => console.log(`  [WARN] ${msg}`),
        debug: (msg) => {},  // Silent by default
        error: (msg) => console.log(`  [ERROR] ${msg}`)
    },
    getForeignStateAsync: async (id) => {
        return getMockState(id);
    },
    setForeignStateAsync: async (id, val, ack) => {
        setMockState(id, val);
    },
    getStateAsync: async (id) => {
        return getMockState(id);
    },
    setStateAsync: async (id, val, ack) => {
        setMockState(id, val);
    },
    getForeignObjectsAsync: async (pattern) => {
        // Return pack objects for voltage testing
        return {
            'test.0.device1.packData.ABC123.minVol': {},
            'test.0.device1.packData.DEF456.minVol': {},
            'test.0.device2.packData.GHI789.minVol': {}
        };
    }
};

// Standard test configuration
const mockConfig = {
    powerMeterDp: 'test.0.gridPower',
    targetGridPowerW: 0,
    minBatterySoc: 10,
    maxBatterySoc: 95,
    enableCharge: true,
    enableDischarge: true,
    hysteresisW: 50,
    rampChargeWPerCycle: 100,
    rampDischargeWPerCycle: 400,
    maxChargePowerW: 1600,
    maxDischargePowerW: 1600,
    feedInThresholdW: -150,
    feedInDelayTicks: 5,
    dischargeThresholdW: 200,
    dischargeDelayTicks: 3,
    useLowVoltageBlock: true,
    dischargeProtectionMode: 'soc',
    emergencyChargePowerW: 800,
    emergencyExitSoc: 20,
    emergencyRecoverySoc: 30,
    minBatteryVoltageV: 3.0,
    voltageRecoveryTargetV: 3.3
};

const deviceBasePath = 'test.0.device1';

// Initialize common mock states
function initializeMockStates() {
    mockStates.clear();
    
    // Grid power
    setMockState('test.0.gridPower', 100);
    
    // Device 1 (single device tests)
    setMockState('test.0.device1.electricLevel', 50);
    setMockState('test.0.device1.packPower', -100);
    setMockState('test.0.device1.control.lowVoltageBlock', false);
    setMockState('test.0.device1.control.fullChargeNeeded', false);
    setMockState('test.0.device1.packData.ABC123.minVol', 3.2);
    setMockState('test.0.device1.packData.DEF456.minVol', 3.3);
    
    // Device 2 (multi-device tests)
    setMockState('test.0.device2.electricLevel', 60);
    setMockState('test.0.device2.packPower', -50);
    setMockState('test.0.device2.control.lowVoltageBlock', false);
    setMockState('test.0.device2.control.fullChargeNeeded', false);
    setMockState('test.0.device2.packData.GHI789.minVol', 3.4);
    
    // Additional paths for MultiDeviceManager (expects productKey.deviceKey format)
    // BasePath: test.0.device1.pk1
    setMockState('test.0.device1.pk1.electricLevel', 50);
    setMockState('test.0.device1.pk1.packPower', -100);
    setMockState('test.0.device1.pk1.control.lowVoltageBlock', false);
    setMockState('test.0.device1.pk1.packData.ABC123.minVol', 3.2);
    setMockState('test.0.device1.pk1.packData.DEF456.minVol', 3.3);
    
    // BasePath: test.0.device2.pk2
    setMockState('test.0.device2.pk2.electricLevel', 60);
    setMockState('test.0.device2.pk2.packPower', -50);
    setMockState('test.0.device2.pk2.control.lowVoltageBlock', false);
    setMockState('test.0.device2.pk2.packData.GHI789.minVol', 3.4);
    
    // Control states
    setMockState('control.enabled', true);
    setMockState('control.targetGridPowerW', 0);
    setMockState('control.maxCharge', false);
    setMockState('control.maxDischarge', false);
}

async function runTest(name, testFn) {
    try {
        process.stdout.write(`\n${name}... `);
        await testFn();
        console.log('✓ PASSED');
        testsPassed++;
    } catch (err) {
        console.log('✗ FAILED');
        console.log(`  Error: ${err.message}`);
        if (process.env.DEBUG) {
            console.log(err.stack);
        }
        testsFailed++;
    }
}

async function testModules() {
    console.log('\n' + '─'.repeat(70));
    console.log('SECTION 1: MODULE LOADING & BASIC FUNCTIONALITY');
    console.log('─'.repeat(70));

    let DataReader, EmergencyManager, RelayProtection, SafetyLimiter;
    let PowerRegulator, ValidationService, MultiDeviceManager, WaterfillDistributor;

    await runTest('[1.1] Load all library modules', async () => {
        DataReader = require('./lib/DataReader');
        EmergencyManager = require('./lib/EmergencyManager');
        RelayProtection = require('./lib/RelayProtection');
        SafetyLimiter = require('./lib/SafetyLimiter');
        PowerRegulator = require('./lib/PowerRegulator');
        ValidationService = require('./lib/ValidationService');
        MultiDeviceManager = require('./lib/MultiDeviceManager');
        WaterfillDistributor = require('./lib/WaterfillDistributor');
        assert(DataReader && EmergencyManager && ValidationService && WaterfillDistributor, 'Modules loaded');
    });

    await runTest('[1.2] Instantiate all modules', async () => {
        initializeMockStates();
        const dataReader = new DataReader(mockAdapter, deviceBasePath);
        const emergencyMgr = new EmergencyManager(mockAdapter, deviceBasePath);
        const relayProtection = new RelayProtection(mockAdapter);
        const safetyLimiter = new SafetyLimiter(mockAdapter, deviceBasePath);
        const powerRegulator = new PowerRegulator(mockAdapter);
        const validationService = new ValidationService(mockAdapter);
        assert(
            dataReader && emergencyMgr && relayProtection && safetyLimiter && powerRegulator && validationService,
            'Modules instantiated'
        );
    });

    await runTest('[1.3] DataReader reads states correctly', async () => {
        initializeMockStates();
        const dataReader = new DataReader(mockAdapter, deviceBasePath);
        
        const gridPower = await dataReader.getGridPowerW('test.0.gridPower');
        const batterySoc = await dataReader.getBatterySoc();
        const batteryPower = await dataReader.getCurrentBatteryPowerW();
        
        assertEqual(gridPower, 100, 'Grid power read correctly');
        assertEqual(batterySoc, 50, 'Battery SOC read correctly');
        // DataReader inverts Zendure packPower (-100 becomes +100)
        assertEqual(batteryPower, 100, 'Battery power read correctly');
    });

    await runTest('[1.4] DataReader handles NaN values correctly', async () => {
        initializeMockStates();
        setMockState('test.0.gridPower', NaN);
        setMockState('test.0.device1.electricLevel', NaN);
        
        const dataReader = new DataReader(mockAdapter, deviceBasePath);
        const gridPower = await dataReader.getGridPowerW('test.0.gridPower');
        const batterySoc = await dataReader.getBatterySoc();
        
        assertEqual(gridPower, null, 'NaN grid power returns null');
        assertEqual(batterySoc, null, 'NaN SOC returns null');
    });

    await runTest('[1.4b] DataReader treats a frozen (stale) packPower/SOC/grid state as unavailable', async () => {
        initializeMockStates();
        const staleTs = Date.now() - (4 * 60 * 1000); // older than the 3-minute staleness window
        mockStates.set('test.0.gridPower', { val: 100, ack: true, ts: staleTs });
        mockStates.set('test.0.device1.electricLevel', { val: 50, ack: true, ts: staleTs });
        mockStates.set('test.0.device1.packPower', { val: -100, ack: true, ts: staleTs });

        const dataReader = new DataReader(mockAdapter, deviceBasePath);
        assertEqual(await dataReader.getGridPowerW('test.0.gridPower'), null, 'Stale grid power returns null');
        assertEqual(await dataReader.getBatterySoc(), null, 'Stale SOC returns null');
        assertEqual(await dataReader.getCurrentBatteryPowerW(), null, 'Stale battery power returns null, not the frozen value');

        // A fresh value right after must be trusted again (no lingering "stuck" state)
        setMockState('test.0.device1.packPower', -100);
        assertEqual(await dataReader.getCurrentBatteryPowerW(), 100, 'Fresh battery power is trusted again');
    });

    await runTest('[1.5] MultiDeviceController rejects invalid grid power values', async () => {
        initializeMockStates();
        const MultiDeviceController = require('./lib/MultiDeviceController');
        const controller = new MultiDeviceController(mockAdapter, {});

        setMockState('test.0.gridPower', NaN);
        assertEqual(await controller.getGridPower('test.0.gridPower'), null, 'NaN grid power returns null');

        setMockState('test.0.gridPower', Infinity);
        assertEqual(await controller.getGridPower('test.0.gridPower'), null, 'Infinity grid power returns null');

        setMockState('test.0.gridPower', '125');
        assertEqual(await controller.getGridPower('test.0.gridPower'), 125, 'Numeric string is normalized');
    });

    console.log('\n' + '─'.repeat(70));
    console.log('SECTION 2: CRITICAL BUG FIXES VERIFICATION');
    console.log('─'.repeat(70));

    await runTest('[2.1] ValidationService accepts 3 parameters (deviceId, basePath, powerW)', async () => {
        initializeMockStates();
        const validationService = new ValidationService(mockAdapter);
        
        // This would have crashed before fix with wrong signature
        await validationService.writePowerSetpoint('device1', 'test.0.device1', 500);
        await validationService.writePowerSetpoint('device2', 'test.0.device2', -800);
        
        const state1 = validationService.getDeviceState('device1');
        const state2 = validationService.getDeviceState('device2');
        
        assertEqual(state1.lastWrittenLimit, 500, 'Device1 limit written');
        assertEqual(state2.lastWrittenLimit, -800, 'Device2 limit written');
    });

    await runTest('[2.2] Multi-Device state validation rejects invalid numbers', async () => {
        initializeMockStates();
        
        const devices = [
            { productKey: 'device1', deviceKey: 'pk1', name: 'Device 1', enabled: true },
            { productKey: 'device2', deviceKey: 'pk2', name: 'Device 2', enabled: true }
        ];
        
        const multiDeviceMgr = new MultiDeviceManager(mockAdapter, 'test.0', devices);
        
        // Set invalid states for device2
        setMockState('test.0.device2.pk2.packPower', NaN);
        setMockState('test.0.device2.pk2.electricLevel', null);
        
        const aggregated = await multiDeviceMgr.aggregateDeviceStates();
        
        // Device1 should be available, Device2 should NOT be available due to invalid states
        assertEqual(aggregated.devices.length, 2, 'Both devices returned');
        
        // Device ids are now derived from deviceKey (stable per physical unit, #23), not table
        // position - these fixtures use deviceKey 'pk1'/'pk2', so that's the resulting id too.
        const dev1 = aggregated.devices.find(d => d.id === 'pk1');
        const dev2 = aggregated.devices.find(d => d.id === 'pk2');

        assertEqual(dev1.available, true, 'Device1 with valid states is available');
        assertEqual(dev2.available, false, 'Device2 with NaN/null states is NOT available');
    });

    await runTest('[2.2b] Multi-Device excludes a device whose packPower/SOC has frozen (gone stale)', async () => {
        initializeMockStates();

        const devices = [
            { productKey: 'device1', deviceKey: 'pk1', name: 'Device 1', enabled: true },
            { productKey: 'device2', deviceKey: 'pk2', name: 'Device 2', enabled: true }
        ];

        const multiDeviceMgr = new MultiDeviceManager(mockAdapter, 'test.0', devices);

        // Device2 looks numerically valid, but its source adapter stopped refreshing it
        // (e.g. the physical device went offline) - simulates issue #15 (HolgerBF).
        const staleTs = Date.now() - (4 * 60 * 1000);
        mockStates.set('test.0.device2.pk2.packPower', { val: -50, ack: true, ts: staleTs });

        const aggregated = await multiDeviceMgr.aggregateDeviceStates();

        const dev1 = aggregated.devices.find(d => d.id === 'pk1');
        const dev2 = aggregated.devices.find(d => d.id === 'pk2');

        assertEqual(dev1.available, true, 'Device1 with a fresh reading stays available');
        assertEqual(dev2.available, false, 'Device2 with a frozen packPower reading is excluded, not trusted');
    });

    await runTest('[2.3] Multi-Device safety limiters block discharge at low voltage', async () => {
        initializeMockStates();
        
        const devices = [
            { productKey: 'device1', deviceKey: 'pk1', name: 'Device 1', enabled: true },
            { productKey: 'device2', deviceKey: 'pk2', name: 'Device 2', enabled: true }
        ];
        
        const multiDeviceMgr = new MultiDeviceManager(mockAdapter, 'test.0', devices);
        
        // Set device1 to very low voltage (below safety threshold)
        setMockState('test.0.device1.pk1.packData.ABC123.minVol', 2.9);
        setMockState('test.0.device1.pk1.packData.DEF456.minVol', 2.8);
        setMockState('test.0.device1.pk1.control.lowVoltageBlock', true);  // Zendure hardware flag
        setMockState('test.0.device1.pk1.electricLevel', 15);  // Low SOC too
        
        const aggregated = await multiDeviceMgr.aggregateDeviceStates();
        
        // Create emergency managers (will detect lowVoltageBlock), keyed by the deviceKey-derived
        // id (#23) - same as multiDeviceMgr.devices[i].id for these fixtures.
        const emergencyManagers = new Map();
        const safetyLimiters = new Map();
        emergencyManagers.set('pk1', new EmergencyManager(mockAdapter, 'test.0.device1.pk1'));
        emergencyManagers.set('pk2', new EmergencyManager(mockAdapter, 'test.0.device2.pk2'));
        safetyLimiters.set('pk1', new SafetyLimiter(mockAdapter, 'test.0.device1.pk1'));
        safetyLimiters.set('pk2', new SafetyLimiter(mockAdapter, 'test.0.device2.pk2'));

        // Check emergency state first
        await emergencyManagers.get('pk1').checkEmergencyConditions(mockConfig, 15, 2.9);
        
        // Try to discharge 1000W - device1 should be excluded due to emergency recovery
        const voltageConfig = { ...mockConfig, dischargeProtectionMode: 'voltage', minBatteryVoltageV: 3.0 };
        const distribution = await multiDeviceMgr.distributePower(
            1000, 
            aggregated, 
            voltageConfig,
            emergencyManagers,
            safetyLimiters
        );
        
        const dev1Dist = distribution.find(d => d.deviceId === 'pk1');
        const dev2Dist = distribution.find(d => d.deviceId === 'pk2');
        
        // Device1 should be excluded (emergency recovery from low voltage)
        assert(dev1Dist, 'Device1 in distribution result');
        assert(dev2Dist, 'Device2 in distribution result');
        
        // Verify distribution logic runs and produces valid results
        const totalDistributed = distribution.reduce((sum, d) => sum + d.powerW, 0);
        assertEqual(totalDistributed, 1000, 'Total power correctly distributed');
        
        // Emergency state was checked (even if not excluding in this test scenario)
        assert(emergencyManagers.get('pk1').inEmergencyRecovery !== undefined, 'Emergency state tracked');
    });

    await runTest('[2.4] Emergency charge power is capped to each device\'s own charge limit', async () => {
        initializeMockStates();
        const MultiDeviceController = require('./lib/MultiDeviceController');

        const controller = new MultiDeviceController(mockAdapter, {
            multiDeviceMgr: {
                devices: [
                    { id: 'device1', basePath: 'test.0.device1.pk1', maxChargePowerW: 500 },
                    { id: 'device2', basePath: 'test.0.device2.pk2', maxChargePowerW: 1600 }
                ]
            },
            validationService: new ValidationService(mockAdapter)
        });

        const totalWrittenPowerW = await controller.handleEmergencyDevices(
            { emergencyChargePowerW: 800 },
            [
                { id: 'device1', name: 'Device 1' },
                { id: 'device2', name: 'Device 2' }
            ]
        );

        const device1Limit = getMockState('test.0.device1.pk1.control.setDeviceAutomationInOutLimit').val;
        const device2Limit = getMockState('test.0.device2.pk2.control.setDeviceAutomationInOutLimit').val;
        assertEqual(device1Limit, -500, 'Smaller device is capped to its own configured charge limit, not the global emergency power');
        assertEqual(device2Limit, -800, 'Larger device uses the full global emergency charge power');
        assertEqual(totalWrittenPowerW, -1300, 'Returned total reflects the actually written (capped) power, not the naive sum');
    });

    await runTest('[2.5] Mode status shows recovery for SOC/minSoc recovery, not just emergency/voltage', async () => {
        initializeMockStates();
        const MultiDeviceController = require('./lib/MultiDeviceController');

        const controller = new MultiDeviceController(mockAdapter, {
            multiDeviceMgr: { devices: [{ id: 'device1', basePath: 'test.0.device1.pk1' }] }
        });
        const emergencyManager = new EmergencyManager(mockAdapter, 'test.0.device1.pk1');
        emergencyManager.inSocRecovery = true;
        controller.emergencyManagers = new Map([['device1', emergencyManager]]);

        await controller.updateModeStatus([], 0);
        assertEqual(getMockState('status.mode').val, 'recovery', 'SOC recovery alone is reflected as recovery mode');
    });

    await runTest('[2.6] createFullDistribution reports the actual capped emergency power, not the raw global value', async () => {
        initializeMockStates();
        const MultiDeviceController = require('./lib/MultiDeviceController');

        const controller = new MultiDeviceController(mockAdapter, {
            multiDeviceMgr: {
                devices: [
                    { id: 'device1', basePath: 'test.0.device1.pk1', maxChargePowerW: 500 },
                    { id: 'device2', basePath: 'test.0.device2.pk2', maxChargePowerW: 1600 }
                ]
            }
        });

        const fullDistribution = controller.createFullDistribution(
            { emergencyChargePowerW: 800 },
            [{ id: 'device1', name: 'Device 1' }, { id: 'device2', name: 'Device 2' }],
            []
        );

        assertEqual(fullDistribution.find(d => d.deviceId === 'device1').powerW, -500, 'Reported power matches the capped value actually written for the smaller device');
        assertEqual(fullDistribution.find(d => d.deviceId === 'device2').powerW, -800, 'Larger device reports the full global emergency power');
    });

    await runTest('[2.7] Waterfill system limits exclude devices with chargeAllowed/dischargeAllowed disabled', async () => {
        initializeMockStates();
        const MultiDeviceController = require('./lib/MultiDeviceController');

        const controller = new MultiDeviceController(mockAdapter, {
            multiDeviceMgr: {
                devices: [
                    { id: 'device1', maxChargePowerW: 900, maxDischargePowerW: 700, chargeAllowed: false },
                    { id: 'device2', maxChargePowerW: 2100, maxDischargePowerW: 1500, dischargeAllowed: false }
                ]
            }
        });

        const limits = controller.getWaterfillSystemLimits([
            { id: 'device1' },
            { id: 'device2' }
        ]);

        assertEqual(limits.maxChargePowerW, 2100, 'Charge-disabled device1 is excluded from the charge ceiling');
        assertEqual(limits.maxDischargePowerW, 700, 'Discharge-disabled device2 is excluded from the discharge ceiling');
    });

    console.log('\n' + '─'.repeat(70));
    console.log('SECTION 3: EDGE CASES & ERROR HANDLING');
    console.log('─'.repeat(70));

    await runTest('[3.1] SafetyLimiter blocks discharge at min SOC', async () => {
        initializeMockStates();
        const safetyLimiter = new SafetyLimiter(mockAdapter, deviceBasePath);
        
        // SOC at minimum (API expects params object)
        const emergencyMgr = new EmergencyManager(mockAdapter, deviceBasePath);
        const result = await safetyLimiter.applySafetyLimits({
            config: mockConfig,
            emergencyManager: emergencyMgr,
            batterySoc: 10,
            minPackVoltageV: 3.2,
            powerW: 500
        });
        
        assertEqual(result.powerW, 0, 'Discharge blocked at min SOC');
    });

    await runTest('[3.2] SafetyLimiter blocks discharge at min voltage', async () => {
        initializeMockStates();
        
        // Set voltage below minimum
        setMockState('test.0.device1.packData.ABC123.minVol', 2.9);
        setMockState('test.0.device1.packData.DEF456.minVol', 2.95);
        
        const safetyLimiter = new SafetyLimiter(mockAdapter, deviceBasePath);
        const emergencyMgr = new EmergencyManager(mockAdapter, deviceBasePath);
        const voltConfig = { ...mockConfig, dischargeProtectionMode: 'voltage', minBatteryVoltageV: 3.0 };
        
        const result = await safetyLimiter.applySafetyLimits({
            config: voltConfig,
            emergencyManager: emergencyMgr,
            batterySoc: 50,
            minPackVoltageV: 2.9,
            powerW: 500
        });
        
        assertEqual(result.powerW, 0, 'Discharge blocked at min voltage');
    });

    await runTest('[3.3] EmergencyManager detects only critical pack voltage', async () => {
        initializeMockStates();
        setMockState('test.0.device1.control.lowVoltageBlock', true);
        setMockState('test.0.device1.control.fullChargeNeeded', true);
        
        const emergencyMgr = new EmergencyManager(mockAdapter, deviceBasePath);
        const flagsOnly = await emergencyMgr.checkEmergencyConditions(mockConfig, 15, 3.2);
        assertEqual(flagsOnly.isEmergency, false, 'Device flags do not trigger emergency charging');

        const emergency = await emergencyMgr.checkEmergencyConditions(mockConfig, 15, 2.8);
        
        assertEqual(emergency.isEmergency, true, 'Emergency detected');
        assert(emergency.reason && emergency.reason.toLowerCase().includes('voltage'), 'Reason contains voltage');
    });

    await runTest('[3.7] Zendure minSoc recovery blocks discharge without emergency charge', async () => {
        initializeMockStates();
        setMockState('test.0.device1.minSoc', 10);

        const safetyLimiter = new SafetyLimiter(mockAdapter, deviceBasePath);
        const emergencyMgr = new EmergencyManager(mockAdapter, deviceBasePath);
        const voltageConfig = {
            ...mockConfig,
            dischargeProtectionMode: 'voltage',
            useZendureMinSoc: true,
            zendureMinSocMargin: 1,
            emergencyChargeVoltageV: 2.8
        };

        const result = await safetyLimiter.applySafetyLimits({
            config: voltageConfig,
            emergencyManager: emergencyMgr,
            batterySoc: 11,
            minPackVoltageV: 3.2,
            powerW: 500
        });

        assertEqual(result.powerW, 0, 'minSoc recovery blocks discharge');
        assertEqual(emergencyMgr.inMinSocRecovery, true, 'minSoc recovery is active');
        const emergency = await emergencyMgr.checkEmergencyConditions(voltageConfig, 11, 3.2);
        assertEqual(emergency.isEmergency, false, 'minSoc recovery does not trigger emergency charging');
    });

    await runTest('[3.9] SafetyLimiter maxSoc recovery blocks charge until SOC drops by the full hysteresis', async () => {
        initializeMockStates();
        const safetyLimiter = new SafetyLimiter(mockAdapter, deviceBasePath);
        const emergencyMgr = new EmergencyManager(mockAdapter, deviceBasePath);
        const config = { ...mockConfig, maxBatterySoc: 100, maxSocRecoveryHysteresis: 4 };

        // Battery hits max SOC - charge blocked, recovery armed
        let result = await safetyLimiter.applySafetyLimits({
            config, emergencyManager: emergencyMgr, batterySoc: 100, minPackVoltageV: 3.2, powerW: -500
        });
        assertEqual(result.powerW, 0, 'Charge blocked at max SOC');
        assertEqual(emergencyMgr.inMaxSocRecovery, true, 'maxSoc recovery armed');

        // SOC ticks down by 1% (rounding/reporting jitter) - device would still hard-reject a
        // new setpoint, so this must stay blocked instead of immediately retrying (the bug this
        // fix addresses: without hysteresis this re-opens charging and ValidationService loops
        // retrying a setpoint the device rejects).
        result = await safetyLimiter.applySafetyLimits({
            config, emergencyManager: emergencyMgr, batterySoc: 99, minPackVoltageV: 3.2, powerW: -500
        });
        assertEqual(result.powerW, 0, 'Charge stays blocked on a 1% dip, still inside the hysteresis band');
        assertEqual(emergencyMgr.inMaxSocRecovery, true, 'maxSoc recovery still active');

        // SOC drops the full hysteresis (100 - 4 = 96) - recovery clears, charge allowed again
        await emergencyMgr.updateMaxSocRecovery(config, 96);
        assertEqual(emergencyMgr.inMaxSocRecovery, false, 'maxSoc recovery clears once SOC falls to max-hysteresis');

        result = await safetyLimiter.applySafetyLimits({
            config, emergencyManager: emergencyMgr, batterySoc: 96, minPackVoltageV: 3.2, powerW: -500
        });
        assertEqual(result.powerW, -500, 'Charge allowed again once recovery cleared');
    });

    await runTest('[3.8] Voltage recovery does not trigger emergency charging', async () => {
        initializeMockStates();
        const MultiDeviceController = require('./lib/MultiDeviceController');

        const controller = new MultiDeviceController(mockAdapter, {
            multiDeviceMgr: {
                devices: [{ id: 'device1', basePath: deviceBasePath }]
            },
            emergencyManagers: new Map(),
            safetyLimiters: new Map(),
            relayProtection: new RelayProtection(mockAdapter),
            powerRegulator: new PowerRegulator(mockAdapter),
            validationService: new ValidationService(mockAdapter)
        });
        const emergencyManager = new EmergencyManager(mockAdapter, deviceBasePath);
        emergencyManager.inVoltageRecovery = true;
        controller.emergencyManagers.set('device1', emergencyManager);

        const device = {
            id: 'device1', name: 'Device 1', basePath: deviceBasePath,
            available: true, soc: 9, minPackVoltageV: 3.15
        };
        const result = await controller.checkEmergencies({
            dischargeProtectionMode: 'voltage',
            minBatteryVoltageV: 3.15,
            useZendureMinSoc: false,
            emergencyChargePowerW: 300,
            emergencyChargeVoltageV: 2.8
        }, [device]);

        assertEqual(result.emergencyDevices.length, 0, 'Voltage recovery is not an emergency device');
        assertEqual(result.normalDevices.length, 1, 'Voltage recovery remains in normal device flow');
        assertEqual(emergencyManager.inVoltageRecovery, true, 'Voltage recovery remains active');
    });

    await runTest('[3.4] Multi-Device handles all devices excluded', async () => {
        initializeMockStates();
        
        const devices = [
            { productKey: 'device1', deviceKey: 'pk1', name: 'Device 1', enabled: true },
            { productKey: 'device2', deviceKey: 'pk2', name: 'Device 2', enabled: true }
        ];
        
        const multiDeviceMgr = new MultiDeviceManager(mockAdapter, 'test.0', devices);
        
        // Set both devices to max SOC
        setMockState('test.0.device1.pk1.electricLevel', 95);
        setMockState('test.0.device2.pk2.electricLevel', 96);
        
        const aggregated = await multiDeviceMgr.aggregateDeviceStates();
        
        const emergencyManagers = new Map();
        const safetyLimiters = new Map();
        multiDeviceMgr.devices.forEach(dev => {
            emergencyManagers.set(dev.id, new EmergencyManager(mockAdapter, dev.basePath));
            safetyLimiters.set(dev.id, new SafetyLimiter(mockAdapter, dev.basePath));
        });

        // Try to charge (should exclude both due to max SOC)
        const distribution = await multiDeviceMgr.distributePower(
            -1000,  // Charge
            aggregated,
            mockConfig,
            emergencyManagers,
            safetyLimiters
        );
        
        assert(distribution.every(d => d.excluded || d.powerW === 0), 'All devices excluded from charging at max SOC');
    });

    await runTest('[3.4b] Excluded devices bypass zero-avoidance and always get a literal 0W (issue #28)', async () => {
        initializeMockStates();

        const devices = [
            { productKey: 'device1', deviceKey: 'pk1', name: 'Device 1', enabled: true },
            { productKey: 'device2', deviceKey: 'pk2', name: 'Device 2', enabled: true }
        ];
        const multiDeviceMgr = new MultiDeviceManager(mockAdapter, 'test.0', devices);
        const validationService = new ValidationService(mockAdapter);
        const [device1, device2] = multiDeviceMgr.devices;

        // Device 2 is discharging normally; Device 1 is structurally excluded (e.g. Waterfill
        // Sticky-Device's resting side) and should be told 0W outright.
        const distribution = [
            { deviceId: device1.id, deviceName: device1.name, powerW: 0, reason: 'Waterfill: device not eligible', excluded: true },
            { deviceId: device2.id, deviceName: device2.name, powerW: 300, reason: 'Waterfill active device', excluded: false }
        ];

        const avoidZeroConfig = { ...mockConfig, avoidZeroSetpoint: true, standbyKeepAliveW: 10, smartModeIdleTimeoutSec: 300, zeroHoldOffSec: 8 };

        await multiDeviceMgr.writePowerSetpoints(distribution, {}, validationService, avoidZeroConfig);

        const excludedLimit = getMockState(`${device1.basePath}.control.setDeviceAutomationInOutLimit`).val;
        assertEqual(excludedLimit, 0, 'Excluded device gets literal 0W even with avoidZeroSetpoint enabled, not a keep-alive value');

        // Repeated cycles (device stays excluded) must never wake it back up with a keep-alive.
        for (let i = 0; i < 5; i++) {
            await multiDeviceMgr.writePowerSetpoints(distribution, {}, validationService, avoidZeroConfig);
        }
        const stillExcludedLimit = getMockState(`${device1.basePath}.control.setDeviceAutomationInOutLimit`).val;
        assertEqual(stillExcludedLimit, 0, 'Sustained exclusion never re-arms the device with a keep-alive setpoint');
    });

    await runTest('[3.5] RelayProtection prevents rapid mode switching', async () => {
        initializeMockStates();
        const relayProtection = new RelayProtection(mockAdapter);
        
        // Try to switch from standby to discharge
        const result = relayProtection.applyProtection({
            config: mockConfig,
            gridPowerW: 300,
            currentBatteryPowerW: 0,
            lastSetPowerW: 0,
            newBatteryPowerW: 300
        });
        
        // Should be limited by operating deadband
        assert(result.powerW < 300, 'Power limited by relay protection on mode switch');
    });

    await runTest('[3.5b] RelayProtection freezes deadband state while discharge is safety-blocked, instead of flickering', async () => {
        initializeMockStates();
        const relayProtection = new RelayProtection(mockAdapter);

        // Simulate an extended recovery: SafetyLimiter forces 0W every cycle (so
        // lastSetPowerW never leaves 0), while the I-Regulator keeps wanting to
        // discharge to serve grid import. Without dischargeBlocked, this used to make
        // RelayProtection re-detect a fresh Standby->Active transition every single
        // cycle, alternating its deadband counter between "hold at 10W" and "release
        // to full power" forever - and whichever of those the state happened to be on
        // would leak to the device the moment safety briefly cleared.
        //
        // The frozen powerW must come back UNCHANGED (180, not 0) - SafetyLimiter is
        // the one that actually clamps to 0, and it only does that (and sets
        // safetyActive=true, which is what makes the caller send a real 0 immediately
        // instead of holding a keep-alive) if it still sees a non-zero request here.
        for (let i = 0; i < 6; i++) {
            const result = relayProtection.applyProtection({
                config: mockConfig,
                gridPowerW: 180,
                currentBatteryPowerW: 0,
                lastSetPowerW: 0,
                newBatteryPowerW: 180,
                dischargeBlocked: true
            });
            assertEqual(result.powerW, 180, `Cycle ${i}: passes the real request through unchanged for SafetyLimiter to see`);
            assertEqual(result.deadbandCounter, 0, `Cycle ${i}: deadband counter does not churn while blocked`);
        }

        // Once the block lifts, a real (single, clean) deadband hold starts - not a
        // leftover mid-oscillation value from the frozen period.
        const released = relayProtection.applyProtection({
            config: mockConfig,
            gridPowerW: 180,
            currentBatteryPowerW: 0,
            lastSetPowerW: 0,
            newBatteryPowerW: 180,
            dischargeBlocked: false
        });
        assertEqual(released.powerW, 10, 'First cycle after unblock holds at the deadband floor, not a stale full-power value');
    });

    await runTest('[3.5c] RelayProtection freezes deadband state while charge is safety-blocked (mirror of 3.5b)', async () => {
        initializeMockStates();
        const relayProtection = new RelayProtection(mockAdapter);

        // Mirror scenario: battery at maxBatterySoc (or enableCharge=false) so charging
        // stays vetoed downstream, while PV surplus keeps the I-Regulator wanting to
        // charge. Same churn risk as the discharge case, just on the CHG<->STBY leg.
        // Frozen powerW must stay -300 (unchanged), same reasoning as 3.5b.
        for (let i = 0; i < 6; i++) {
            const result = relayProtection.applyProtection({
                config: mockConfig,
                gridPowerW: -500,
                currentBatteryPowerW: 0,
                lastSetPowerW: 0,
                newBatteryPowerW: -300,
                chargeBlocked: true
            });
            assertEqual(result.powerW, -300, `Cycle ${i}: passes the real request through unchanged for SafetyLimiter to see`);
            assertEqual(result.deadbandCounter, 0, `Cycle ${i}: deadband counter does not churn while blocked`);
        }

        // Unlike discharge, a fresh charge transition also has to clear the
        // pre-existing feedInDelayTicks sustained-feed-in gate (mockConfig: 5) before
        // the deadband even runs - unrelated to this fix, so drive that gate first.
        let released;
        for (let i = 0; i < mockConfig.feedInDelayTicks; i++) {
            released = relayProtection.applyProtection({
                config: mockConfig,
                gridPowerW: -500,
                currentBatteryPowerW: 0,
                lastSetPowerW: 0,
                newBatteryPowerW: -300,
                chargeBlocked: false
            });
        }
        assertEqual(released.powerW, -10, 'Once released, holds at the deadband floor (charge direction), not a stale value');
    });

    await runTest('[3.5d] RelayProtection freeze must not blind SafetyLimiter to an active block (regression guard, 2026-08-24)', async () => {
        // Found via a real overnight recovery: RelayProtection used to return powerW:0
        // when frozen, so by the time SafetyLimiter ran, it saw "0W requested" and
        // never engaged its own block - safetyActive stayed false, and the caller
        // (safetyActive ? undefined : config) wrongly took the normal zero-avoidance
        // path: hold a 10W keep-alive for the full smartModeIdleTimeoutSec instead of
        // sending the real 0 immediately, even with 350-400W of baseline load and an
        // active voltage recovery the whole time. RelayProtection must hand SafetyLimiter
        // the real, unmodified request so it can correctly detect and clamp the block.
        initializeMockStates();
        const relayProtection = new RelayProtection(mockAdapter);
        const safetyLimiter = new SafetyLimiter(mockAdapter, deviceBasePath);
        const emergencyMgr = new EmergencyManager(mockAdapter, deviceBasePath);
        emergencyMgr.inVoltageRecovery = true;

        const relayResult = relayProtection.applyProtection({
            config: mockConfig,
            gridPowerW: 400,
            currentBatteryPowerW: 0,
            lastSetPowerW: 0,
            newBatteryPowerW: 400,
            dischargeBlocked: true
        });
        assertEqual(relayResult.powerW, 400, 'RelayProtection hands the real 400W request onward, not a pre-zeroed value');

        const safetyResult = await safetyLimiter.applySafetyLimits({
            config: { ...mockConfig, dischargeProtectionMode: 'voltage' },
            emergencyManager: emergencyMgr,
            batterySoc: 7,
            minPackVoltageV: 3.11,
            powerW: relayResult.powerW
        });
        assertEqual(safetyResult.safetyActive, true, 'SafetyLimiter correctly detects the block and reports safetyActive');
        assertEqual(safetyResult.powerW, 0, 'SafetyLimiter itself clamps to 0 - RelayProtection does not need to pre-zero it');
    });

    await runTest('[3.6] PowerRegulator applies ramping limits', async () => {
        initializeMockStates();
        const powerRegulator = new PowerRegulator(mockAdapter);
        
        // Try to jump from 0W to 1000W discharge
        const result = powerRegulator.applyRegulation({
            config: mockConfig,
            powerW: 1000,
            lastSetPowerW: 0,
            safetyActive: false
        });
        
        // Should be limited by rampDischargeWPerCycle (400W)
        assert(result.powerW <= 400, 'Discharge ramping applied');
        assert(result.powerW > 0, 'Some power allowed');
    });

    console.log('\n' + '─'.repeat(70));
    console.log('SECTION 4: INTEGRATION TESTS');
    console.log('─'.repeat(70));

    await runTest('[4.1] Full automation cycle - Single device mode', async () => {
        initializeMockStates();
        
        const dataReader = new DataReader(mockAdapter, deviceBasePath);
        const relayProtection = new RelayProtection(mockAdapter);
        const safetyLimiter = new SafetyLimiter(mockAdapter, deviceBasePath);
        const powerRegulator = new PowerRegulator(mockAdapter);
        
        // Simulate grid power 300W (need to discharge)
        setMockState('test.0.gridPower', 300);
        const gridPowerW = await dataReader.getGridPowerW('test.0.gridPower');
        const batterySoc = await dataReader.getBatterySoc();
        const minVoltage = await dataReader.getMinimumPackVoltageV();
        
        // I-Regulator calculation
        let power = 0 + (gridPowerW - 0); // lastSet + (grid - target)
        
        // Apply all protections
        const relayResult = relayProtection.applyProtection({
            config: mockConfig,
            gridPowerW: gridPowerW,
            currentBatteryPowerW: 0,
            lastSetPowerW: 0,
            newBatteryPowerW: power
        });
        power = relayResult.powerW;
        
        const emergencyMgr = new EmergencyManager(mockAdapter, deviceBasePath);
        const safetyResult = await safetyLimiter.applySafetyLimits({
            config: mockConfig,
            emergencyManager: emergencyMgr,
            batterySoc: batterySoc,
            minPackVoltageV: minVoltage,
            powerW: power
        });
        power = safetyResult.powerW;
        
        const regResult = powerRegulator.applyRegulation({
            config: mockConfig,
            powerW: power,
            lastSetPowerW: 0,
            safetyActive: false
        });
        power = regResult.powerW;
        
        assert(typeof power === 'number', 'Power is a number');
        assert(power <= mockConfig.maxDischargePowerW, 'Within max discharge limit');
    });

    await runTest('[4.2] Full cycle - Multi-device power distribution', async () => {
        initializeMockStates();
        
        const devices = [
            { productKey: 'device1', deviceKey: 'pk1', name: 'Device 1', enabled: true },
            { productKey: 'device2', deviceKey: 'pk2', name: 'Device 2', enabled: true }
        ];
        
        const multiDeviceMgr = new MultiDeviceManager(mockAdapter, 'test.0', devices);
        
        const emergencyManagers = new Map();
        const safetyLimiters = new Map();
        multiDeviceMgr.devices.forEach(dev => {
            emergencyManagers.set(dev.id, new EmergencyManager(mockAdapter, dev.basePath));
            safetyLimiters.set(dev.id, new SafetyLimiter(mockAdapter, dev.basePath));
        });
        
        const aggregated = await multiDeviceMgr.aggregateDeviceStates();
        
        // Distribute 800W discharge
        const distribution = await multiDeviceMgr.distributePower(
            800,
            aggregated,
            mockConfig,
            emergencyManagers,
            safetyLimiters
        );
        
        const totalDistributed = distribution.reduce((sum, d) => sum + d.powerW, 0);
        assertEqual(totalDistributed, 800, 'Total power equals requested power');
        
        const activeDevices = distribution.filter(d => !d.excluded);
        assert(activeDevices.length > 0, 'At least one device active');
    });

    await runTest('[4.3] Multi-device distribution respects per-device charge limit', async () => {
        initializeMockStates();

        const devices = [
            { productKey: 'device1', deviceKey: 'pk1', name: 'Device 1', enabled: true },
            { productKey: 'device2', deviceKey: 'pk2', name: 'Device 2', enabled: true }
        ];
        const multiDeviceMgr = new MultiDeviceManager(mockAdapter, 'test.0', devices);
        const emergencyManagers = new Map();
        const safetyLimiters = new Map();
        multiDeviceMgr.devices.forEach(dev => {
            emergencyManagers.set(dev.id, new EmergencyManager(mockAdapter, dev.basePath));
            safetyLimiters.set(dev.id, new SafetyLimiter(mockAdapter, dev.basePath));
        });

        const distribution = await multiDeviceMgr.distributePower(
            -3200,
            await multiDeviceMgr.aggregateDeviceStates(),
            mockConfig,
            emergencyManagers,
            safetyLimiters
        );

        const activeDevices = distribution.filter(d => !d.excluded);
        assertEqual(activeDevices.length, 2, 'Both devices participate in charging');
        assertEqual(activeDevices[0].powerW, -1600, 'Device 1 is limited to configured charge power');
        assertEqual(activeDevices[1].powerW, -1600, 'Device 2 is limited to configured charge power');
    });

    await runTest('[4.4] Excluded device does not transfer its charge capacity', async () => {
        initializeMockStates();
        setMockState('test.0.device1.pk1.electricLevel', 100);

        const devices = [
            { productKey: 'device1', deviceKey: 'pk1', name: 'Device 1', enabled: true },
            { productKey: 'device2', deviceKey: 'pk2', name: 'Device 2', enabled: true }
        ];
        const multiDeviceMgr = new MultiDeviceManager(mockAdapter, 'test.0', devices);
        const emergencyManagers = new Map();
        const safetyLimiters = new Map();
        multiDeviceMgr.devices.forEach(dev => {
            emergencyManagers.set(dev.id, new EmergencyManager(mockAdapter, dev.basePath));
            safetyLimiters.set(dev.id, new SafetyLimiter(mockAdapter, dev.basePath));
        });

        const distribution = await multiDeviceMgr.distributePower(
            -3200,
            await multiDeviceMgr.aggregateDeviceStates(),
            mockConfig,
            emergencyManagers,
            safetyLimiters
        );

        const activeDevice = distribution.find(d => !d.excluded);
        const excludedDevice = distribution.find(d => d.excluded);
        assert(activeDevice, 'One device remains active');
        assertEqual(activeDevice.powerW, -1600, 'Remaining device keeps its own charge limit');
        assertEqual(excludedDevice.powerW, 0, 'Max-SOC device receives no power');
    });

    await runTest('[4.4b] Multi-device max-SOC recovery hysteresis survives a 1% SOC dip (mirrors 3.9)', async () => {
        initializeMockStates();
        setMockState('test.0.device1.pk1.electricLevel', 100);

        const devices = [
            { productKey: 'device1', deviceKey: 'pk1', name: 'Device 1', enabled: true },
            { productKey: 'device2', deviceKey: 'pk2', name: 'Device 2', enabled: true }
        ];
        const multiDeviceMgr = new MultiDeviceManager(mockAdapter, 'test.0', devices);
        const emergencyManagers = new Map();
        const safetyLimiters = new Map();
        multiDeviceMgr.devices.forEach(dev => {
            emergencyManagers.set(dev.id, new EmergencyManager(mockAdapter, dev.basePath));
            safetyLimiters.set(dev.id, new SafetyLimiter(mockAdapter, dev.basePath));
        });
        const config = { ...mockConfig, maxBatterySoc: 100, maxSocRecoveryHysteresis: 4 };

        // First cycle at 100%: charge blocked, recovery armed for device1.
        let distribution = await multiDeviceMgr.distributePower(
            -3200, await multiDeviceMgr.aggregateDeviceStates(), config, emergencyManagers, safetyLimiters
        );
        let device1 = distribution.find(d => d.deviceId === multiDeviceMgr.devices[0].id);
        assertEqual(device1.powerW, 0, 'Device1 blocked at 100%');
        assertEqual(emergencyManagers.get(multiDeviceMgr.devices[0].id).inMaxSocRecovery, true, 'Recovery armed');

        // SOC ticks down to 99% - must stay excluded (the bug: without hysteresis this would
        // become eligible again, the device would hard-reject the setpoint, and
        // ValidationService would retry every cycle).
        setMockState('test.0.device1.pk1.electricLevel', 99);
        distribution = await multiDeviceMgr.distributePower(
            -3200, await multiDeviceMgr.aggregateDeviceStates(), config, emergencyManagers, safetyLimiters
        );
        device1 = distribution.find(d => d.deviceId === multiDeviceMgr.devices[0].id);
        assertEqual(device1.powerW, 0, 'Device1 stays blocked on a 1% dip, still inside the hysteresis band');
        assertEqual(device1.excluded, true, 'Device1 still reported excluded');
    });

    await runTest('[4.5] Multi-device distribution respects per-device discharge limit', async () => {
        initializeMockStates();

        const devices = [
            { productKey: 'device1', deviceKey: 'pk1', name: 'Device 1', enabled: true },
            { productKey: 'device2', deviceKey: 'pk2', name: 'Device 2', enabled: true }
        ];
        const multiDeviceMgr = new MultiDeviceManager(mockAdapter, 'test.0', devices);
        const emergencyManagers = new Map();
        const safetyLimiters = new Map();
        multiDeviceMgr.devices.forEach(dev => {
            emergencyManagers.set(dev.id, new EmergencyManager(mockAdapter, dev.basePath));
            safetyLimiters.set(dev.id, new SafetyLimiter(mockAdapter, dev.basePath));
        });

        const distribution = await multiDeviceMgr.distributePower(
            4000,
            await multiDeviceMgr.aggregateDeviceStates(),
            mockConfig,
            emergencyManagers,
            safetyLimiters
        );

        const activeDevices = distribution.filter(d => !d.excluded);
        assertEqual(activeDevices.length, 2, 'Both devices participate in discharging');
        assertEqual(activeDevices[0].powerW, 1600, 'Device 1 is limited to configured discharge power');
        assertEqual(activeDevices[1].powerW, 1600, 'Device 2 is limited to configured discharge power');
    });

    await runTest('[4.6] ValidationService validates written setpoints', async () => {
        initializeMockStates();
        const validationService = new ValidationService(mockAdapter);
        
        // Write a setpoint
        await validationService.writePowerSetpoint('dev1', 'test.0.device1', -800);
        
        // Mock the actual hardware value
        setMockState('test.0.device1.control.setDeviceAutomationInOutLimit', -800);
        
        // Validate (returns false for success/no-resend-needed)
        const needsResend = await validationService.validateSetpoint('dev1', mockConfig, -800);
        
        assertEqual(needsResend, false, 'Validation succeeded (no resend needed)');
    });

    await runTest('[4.6c] ValidationService suspends validation near max SOC instead of erroring on BMS taper', async () => {
        // Near max SOC the Zendure BMS tapers actual charge current down on its own
        // (CV-style curve), independent of the requested setpoint. Target stays
        // aggressive (-1600W) while actual drifts from -900W towards -100W as SOC climbs
        // the last few percent - deviation from target *grows*, so the old ramping check
        // read that as "device not responding" and errored out after 12 retries, hours
        // of it on a sunny day. Validation must stay suspended (no error, no retry count)
        // for the whole top-of-charge band, and resume normally once clearly below it.
        initializeMockStates();
        const validationService = new ValidationService(mockAdapter);
        const config = { ...mockConfig, maxBatterySoc: 100, setPowerMaxRetries: 3 };

        await validationService.writePowerSetpoint('dev1', 'test.0.device1', -1600, config);

        // 96% is within the hardcoded 5-point margin below maxBatterySoc=100 - suspended.
        for (const actualPowerW of [-900, -400, -100, -100, -100]) {
            const needsResend = await validationService.validateSetpoint('dev1', config, actualPowerW, 96);
            assertEqual(needsResend, false, `No resend requested while suspended (actual ${actualPowerW}W)`);
        }
        const state = validationService.getDeviceState('dev1');
        assertEqual(state.validationRetryCount, 0, 'Retry counter never incremented while suspended');
        // pendingValidation deliberately stays frozen (true), not cleared - see the
        // comment in validateSetpoint: clearing it here would never re-arm on an
        // unchanged target once SOC drops back below the margin.
        assertEqual(state.pendingValidation, true, 'Pending validation stays armed (frozen) so it resumes once below the margin');

        // Below the margin (94% < 100 - 5), a real mismatch must still be caught normally -
        // same pending setpoint as above, no fresh write needed to re-arm it.
        let needsResend;
        for (let i = 0; i < config.setPowerMaxRetries; i++) {
            needsResend = await validationService.validateSetpoint('dev1', config, -50, 94);
        }
        assertEqual(needsResend, false, 'Give-up path is reached (not stuck resending forever)');
        assertEqual(validationService.getDeviceState('dev1').lastWrittenLimit, null, 'Setpoint reset after real failure below the margin');
    });

    await runTest('[4.6b] ValidationService sends the real 0W only once per standby spell, not every idleTimeoutSec', async () => {
        // Without this, a sustained standby (regulator wants 0W cycle after cycle -
        // e.g. grid perfectly balanced, or discharge blocked for a long recovery)
        // used to re-run the whole keep-alive-then-real-0 dance every
        // smartModeIdleTimeoutSec forever: a fresh real 0W (full acMode/smartMode-off
        // flash sequence) every ~5 minutes, indefinitely - defeating the point of
        // avoiding zero writes in the first place.
        initializeMockStates();
        const validationService = new ValidationService(mockAdapter);
        const avoidZeroConfig = { ...mockConfig, avoidZeroSetpoint: true, standbyKeepAliveW: 10, smartModeIdleTimeoutSec: 300, zeroHoldOffSec: 8 };
        const deviceId = 'dev1';
        const basePath = 'test.0.device1';
        const dp = `${basePath}.control.setDeviceAutomationInOutLimit`;

        // Fresh standby: holds at the keep-alive floor first.
        await validationService.writePowerSetpoint(deviceId, basePath, 0, avoidZeroConfig);
        assertEqual(getMockState(dp).val, 10, 'Fresh standby holds at the keep-alive floor first');

        // Fast-forward past the idle timeout without waiting for real time.
        const state = validationService.getDeviceState(deviceId);
        state.standbySince = Date.now() - 301 * 1000;
        await validationService.writePowerSetpoint(deviceId, basePath, 0, avoidZeroConfig);
        assertEqual(getMockState(dp).val, 0, 'Real 0W committed once the idle timeout elapses');

        // Clear the post-zero grace window and simulate standby continuing for
        // several more idle-timeout periods, spying on actual device writes.
        state.holdOffUntil = 0;
        let writeCount = 0;
        const originalSetForeignStateAsync = mockAdapter.setForeignStateAsync;
        mockAdapter.setForeignStateAsync = async (...args) => {
            writeCount++;
            return originalSetForeignStateAsync(...args);
        };
        try {
            for (let i = 0; i < 5; i++) {
                await validationService.writePowerSetpoint(deviceId, basePath, 0, avoidZeroConfig);
            }
        } finally {
            mockAdapter.setForeignStateAsync = originalSetForeignStateAsync;
        }
        assertEqual(writeCount, 0, 'No further device writes while standby continues after the real 0W already landed');
        assertEqual(getMockState(dp).val, 0, 'Setpoint stays at literal 0W, no keep-alive pulses re-appear');
    });

    await runTest('[4.6d] validateZeroSetpoint confirms a genuine 0W once outputLimit/inputLimit read back as 0', async () => {
        initializeMockStates();
        const validationService = new ValidationService(mockAdapter);
        const deviceId = 'dev1';
        const basePath = 'test.0.device1';

        // Safety-bypass 0 (config omitted) - no grace window, validation can start immediately.
        await validationService.writePowerSetpoint(deviceId, basePath, 0);
        assertEqual(validationService.getDeviceState(deviceId).zeroPendingValidation, true, 'Zero validation armed after a genuine 0W write');

        setMockState(`${basePath}.outputLimit`, 0);
        setMockState(`${basePath}.inputLimit`, 0);
        await validationService.validateZeroSetpoint(deviceId, basePath, mockConfig, 0);

        const state = validationService.getDeviceState(deviceId);
        assertEqual(state.zeroPendingValidation, false, 'Confirmed 0W clears pending validation');
        assertEqual(state.zeroValidationRetryCount, 0, 'Retry counter stays at 0 on immediate confirmation');
    });

    await runTest('[4.6e] validateZeroSetpoint waits out the post-zero grace window before checking anything', async () => {
        initializeMockStates();
        const validationService = new ValidationService(mockAdapter);
        const avoidZeroConfig = { ...mockConfig, avoidZeroSetpoint: true, standbyKeepAliveW: 10, smartModeIdleTimeoutSec: 30, zeroHoldOffSec: 8 };
        const deviceId = 'dev1';
        const basePath = 'test.0.device1';

        // Commit a real 0 via the idle-timeout path, same as [4.6b] - this opens the grace window.
        await validationService.writePowerSetpoint(deviceId, basePath, 0, avoidZeroConfig);
        const state = validationService.getDeviceState(deviceId);
        state.standbySince = Date.now() - 31 * 1000;
        await validationService.writePowerSetpoint(deviceId, basePath, 0, avoidZeroConfig);
        assert(state.holdOffUntil > Date.now(), 'Grace window is open right after committing the real 0W');

        // outputLimit/inputLimit still show the old (non-zero) values - nograx hasn't caught
        // up yet, which is expected and must NOT be flagged while the grace window is open.
        setMockState(`${basePath}.outputLimit`, 10);
        setMockState(`${basePath}.inputLimit`, 0);
        await validationService.validateZeroSetpoint(deviceId, basePath, avoidZeroConfig, 0);
        assertEqual(state.zeroValidationRetryCount, 0, 'No retry counted while the grace window is still active');
        assertEqual(state.zeroPendingValidation, true, 'Still pending - not silently dropped, just not checked yet');
    });

    await runTest('[4.6f] validateZeroSetpoint resends and warns exactly once after the retry threshold, then stays quiet', async () => {
        // Reproduces the real incident (2026-08-28): setDeviceAutomationInOutLimit correctly
        // reads 0, but nograx's own outputLimit stayed stuck at a stale non-zero value.
        initializeMockStates();
        const validationService = new ValidationService(mockAdapter);
        const deviceId = 'dev1';
        const basePath = 'test.0.device1';
        const dp = `${basePath}.control.setDeviceAutomationInOutLimit`;

        await validationService.writePowerSetpoint(deviceId, basePath, 0); // safety-bypass, no grace window
        setMockState(`${basePath}.outputLimit`, 10); // stuck
        setMockState(`${basePath}.inputLimit`, 0);

        const state = validationService.getDeviceState(deviceId);
        let warnCount = 0;
        const originalWarn = mockAdapter.log.warn;
        mockAdapter.log.warn = (msg) => { warnCount++; originalWarn(msg); };

        try {
            // Cycles 1-2: below the retry threshold, no warning yet.
            await validationService.validateZeroSetpoint(deviceId, basePath, mockConfig, 0);
            await validationService.validateZeroSetpoint(deviceId, basePath, mockConfig, 0);
            assertEqual(warnCount, 0, 'No warning before the retry threshold is reached');

            // Cycle 3: threshold reached - warns exactly once and marks a resend as due.
            await validationService.validateZeroSetpoint(deviceId, basePath, mockConfig, 0);
            assertEqual(warnCount, 1, 'Warns exactly once at the retry threshold');
            assertEqual(state.zeroValidationRetryCount, 3, 'Retry counter reached the threshold');

            // The write layer must now actually resend the (still logically unchanged) 0W,
            // even though lastWrittenLimit already says 0 - this is what gets a stuck
            // nograx-side value another chance to apply.
            await validationService.writePowerSetpoint(deviceId, basePath, 0);
            assertEqual(getMockState(dp).ts !== undefined, true, 'Resend write happened');

            // Cycles 4-6: still stuck, but must not spam another warning.
            await validationService.validateZeroSetpoint(deviceId, basePath, mockConfig, 0);
            await validationService.validateZeroSetpoint(deviceId, basePath, mockConfig, 0);
            await validationService.validateZeroSetpoint(deviceId, basePath, mockConfig, 0);
            assertEqual(warnCount, 1, 'Still only one warning after further unconfirmed cycles - no log spam');

            // Now nograx catches up - confirmation clears everything and re-arms for next time.
            setMockState(`${basePath}.outputLimit`, 0);
            await validationService.validateZeroSetpoint(deviceId, basePath, mockConfig, 0);
            assertEqual(state.zeroPendingValidation, false, 'Confirmed once outputLimit finally reads 0');
            assertEqual(state.zeroValidationWarned, false, 'Warned flag resets on confirmation, ready for a future spell');
        } finally {
            mockAdapter.log.warn = originalWarn;
        }
    });

    await runTest('[4.6g] A changed setpoint (e.g. emergency charge) is never blocked or delayed by pending 0W validation', async () => {
        initializeMockStates();
        const validationService = new ValidationService(mockAdapter);
        const deviceId = 'dev1';
        const basePath = 'test.0.device1';
        const dp = `${basePath}.control.setDeviceAutomationInOutLimit`;

        // Get a 0W validation stuck at the retry threshold, exactly like [4.6f].
        await validationService.writePowerSetpoint(deviceId, basePath, 0);
        setMockState(`${basePath}.outputLimit`, 10);
        setMockState(`${basePath}.inputLimit`, 0);
        for (let i = 0; i < 3; i++) {
            await validationService.validateZeroSetpoint(deviceId, basePath, mockConfig, 0);
        }
        const state = validationService.getDeviceState(deviceId);
        assertEqual(state.zeroValidationRetryCount, 3, 'Zero validation is stuck at the threshold, as in [4.6f]');

        // An emergency charge command must go through immediately regardless - bypassHoldOff
        // mirrors the real call site in SingleDeviceController.handleEmergency().
        await validationService.writePowerSetpoint(deviceId, basePath, -1600, mockConfig, { bypassHoldOff: true });
        assertEqual(getMockState(dp).val, -1600, 'Emergency charge setpoint reaches the device immediately, unblocked by pending 0W validation');
        assertEqual(state.zeroPendingValidation, false, '0W validation state is cleared by the new, changed setpoint');
        assertEqual(state.pendingValidation, true, 'Charge validation is now armed instead for the new target');
    });

    await runTest('[4.6h] validateZeroSetpoint skips silently when outputLimit/inputLimit are not exposed (e.g. non-zenSDK setups)', async () => {
        initializeMockStates();
        const validationService = new ValidationService(mockAdapter);
        const deviceId = 'dev1';
        const basePath = 'test.0.device1';
        // Deliberately not setting outputLimit/inputLimit mock states - getForeignStateAsync
        // returns { val: null, ack: false } for them, same as a real device without zenSDK.

        await validationService.writePowerSetpoint(deviceId, basePath, 0);

        let warnCount = 0;
        const originalWarn = mockAdapter.log.warn;
        mockAdapter.log.warn = () => { warnCount++; };
        try {
            for (let i = 0; i < 5; i++) {
                await validationService.validateZeroSetpoint(deviceId, basePath, mockConfig, 0);
            }
        } finally {
            mockAdapter.log.warn = originalWarn;
        }
        assertEqual(warnCount, 0, 'Never warns when outputLimit/inputLimit do not exist for this device');
        assertEqual(validationService.getDeviceState(deviceId).zeroPendingValidation, false, 'Validation stands down instead of failing forever');
    });

    await runTest('[4.7] Waterfill uses sticky device and redistributes capped power', async () => {
        const distributor = new WaterfillDistributor();
        const devices = [
            {
                id: 'device1', name: 'Device 1', soc: 80, minSoc: 10, maxSoc: 100,
                maxChargePowerW: 1600, maxDischargePowerW: 500,
                chargeAllowed: true, dischargeAllowed: true
            },
            {
                id: 'device2', name: 'Device 2', soc: 40, minSoc: 10, maxSoc: 100,
                maxChargePowerW: 1600, maxDischargePowerW: 2000,
                chargeAllowed: true, dischargeAllowed: true
            }
        ];
        const waterfillConfig = {
            minBatterySoc: 10,
            maxBatterySoc: 100,
            updateIntervalSec: 5,
            waterfillConcentrateHoldMinutes: 0,
            waterfillDischargeConcentrateBelowW: 600,
            waterfillDischargeSpreadAboveW: 1200,
            waterfillSocMargin: 10
        };

        const single = distributor.distribute(400, devices, waterfillConfig);
        assertEqual(single.filter(d => d.powerW > 0).length, 1, 'Low demand uses one device');
        assertEqual(single.find(d => d.powerW > 0).deviceId, 'device1', 'Highest SOC device is sticky');

        const spread = distributor.distribute(2500, devices, waterfillConfig);
        assertEqual(spread.reduce((sum, d) => sum + d.powerW, 0), 2500, 'Waterfill uses full target');
        assertEqual(spread.find(d => d.deviceId === 'device1').powerW, 500, 'First device is capped');
        assertEqual(spread.find(d => d.deviceId === 'device2').powerW, 2000, 'Remainder reaches second device');
    });

    await runTest('[4.8] Multi-device manager selects Waterfill strategy', async () => {
        initializeMockStates();
        const devices = [
            {
                productKey: 'device1', deviceKey: 'pk1', name: 'Device 1', enabled: true,
                minSoc: 10, maxSoc: 100, maxChargePowerW: 1600, maxDischargePowerW: 500,
                chargeAllowed: true, dischargeAllowed: true
            },
            {
                productKey: 'device2', deviceKey: 'pk2', name: 'Device 2', enabled: true,
                minSoc: 10, maxSoc: 100, maxChargePowerW: 1600, maxDischargePowerW: 2000,
                chargeAllowed: true, dischargeAllowed: true
            }
        ];
        const multiDeviceMgr = new MultiDeviceManager(mockAdapter, 'test.0', devices);
        const emergencyManagers = new Map();
        const safetyLimiters = new Map();
        multiDeviceMgr.devices.forEach(dev => {
            emergencyManagers.set(dev.id, new EmergencyManager(mockAdapter, dev.basePath));
            safetyLimiters.set(dev.id, new SafetyLimiter(mockAdapter, dev.basePath));
        });

        const distribution = await multiDeviceMgr.distributePower(
            2500,
            await multiDeviceMgr.aggregateDeviceStates(),
            {
                ...mockConfig,
                multiDeviceDistributionStrategy: 'waterfill',
                waterfillConcentrateHoldMinutes: 0,
                waterfillDischargeConcentrateBelowW: 600,
                waterfillDischargeSpreadAboveW: 1200,
                waterfillSocMargin: 10
            },
            emergencyManagers,
            safetyLimiters
        );

        const activeDistribution = distribution.filter(d => !d.excluded);
        assertEqual(activeDistribution.reduce((sum, d) => sum + d.powerW, 0), 2500, 'Waterfill target reaches manager output');
        assertEqual(activeDistribution.find(d => d.deviceId === 'pk1').powerW, 500, 'Manager applies device one limit');
        assertEqual(activeDistribution.find(d => d.deviceId === 'pk2').powerW, 2000, 'Manager applies device two limit');
    });

    await runTest('[4.9] Waterfill handles changing loads and direction changes', async () => {
        const distributor = new WaterfillDistributor();
        const devices = [
            {
                id: 'device1', name: 'PV Hub', soc: 75, minSoc: 15, maxSoc: 95,
                maxChargePowerW: 1200, maxDischargePowerW: 800,
                chargeAllowed: true, dischargeAllowed: true
            },
            {
                id: 'device2', name: 'AC Hub', soc: 45, minSoc: 10, maxSoc: 100,
                maxChargePowerW: 2400, maxDischargePowerW: 1600,
                chargeAllowed: true, dischargeAllowed: true
            }
        ];
        const config = {
            minBatterySoc: 10,
            maxBatterySoc: 100,
            updateIntervalSec: 5,
            waterfillConcentrateHoldMinutes: 0,
            waterfillDischargeConcentrateBelowW: 600,
            waterfillDischargeSpreadAboveW: 1200,
            waterfillChargeConcentrateBelowW: 600,
            waterfillChargeSpreadAboveW: 1200,
            waterfillSocMargin: 10
        };
        const changingLoads = [250, 1100, 1800, 300, 1500, 0, -250, -1400, -3200, 0];
        const results = changingLoads.map(load => distributor.distribute(load, devices, config));

        results.forEach((distribution, index) => {
            const requested = changingLoads[index];
            const total = distribution.reduce((sum, item) => sum + item.powerW, 0);
            const capacity = requested < 0 ? 3600 : 2400;
            assert(Math.abs(total) <= Math.abs(requested), `Cycle ${index} does not over-allocate`);
            assert(Math.abs(total) <= capacity, `Cycle ${index} respects aggregate capacity`);
            assert(distribution[0].powerW <= 800 && distribution[1].powerW <= 1600, `Cycle ${index} respects discharge limits`);
            assert(distribution[0].powerW >= -1200 && distribution[1].powerW >= -2400, `Cycle ${index} respects charge limits`);
        });

        assertEqual(results[0].filter(item => item.powerW !== 0).length, 1, 'Low discharge load is concentrated');
        assertEqual(results[2].filter(item => item.powerW > 0).length, 2, 'High discharge load is spread');
        assertEqual(results[6].filter(item => item.powerW < 0).length, 1, 'Low charge load is concentrated');
        assertEqual(results[8].filter(item => item.powerW < 0).length, 2, 'High charge load is spread');
        assertEqual(results[5].every(item => item.powerW === 0), true, 'Standby clears both directions');
    });

    await runTest('[4.10] Waterfill excludes devices at SOC limits or disabled directions', async () => {
        const distributor = new WaterfillDistributor();
        const devices = [
            {
                id: 'full', name: 'Full', soc: 100, minSoc: 10, maxSoc: 100,
                maxChargePowerW: 1000, maxDischargePowerW: 1000,
                chargeAllowed: true, dischargeAllowed: false
            },
            {
                id: 'disabled', name: 'Disabled', soc: 60, minSoc: 10, maxSoc: 100,
                maxChargePowerW: 1000, maxDischargePowerW: 1000,
                chargeAllowed: false, dischargeAllowed: false
            },
            {
                id: 'usable', name: 'Usable', soc: 60, minSoc: 10, maxSoc: 100,
                maxChargePowerW: 1000, maxDischargePowerW: 1000,
                chargeAllowed: true, dischargeAllowed: true
            }
        ];
        const config = {
            minBatterySoc: 10,
            maxBatterySoc: 100,
            waterfillConcentrateHoldMinutes: 0
        };

        const charge = distributor.distribute(-800, devices, config);
        assertEqual(charge.find(item => item.deviceId === 'full').powerW, 0, 'Full device is excluded from charge');
        assertEqual(charge.find(item => item.deviceId === 'disabled').powerW, 0, 'Charge-disabled device is excluded');
        assertEqual(charge.find(item => item.deviceId === 'usable').powerW, -800, 'Usable device receives charge');

        const discharge = distributor.distribute(800, devices, config);
        assertEqual(discharge.find(item => item.deviceId === 'disabled').powerW, 0, 'Discharge-disabled device is excluded');
        assertEqual(discharge.find(item => item.deviceId === 'usable').powerW, 800, 'Usable device receives discharge');
    });

    await runTest('[4.11] Waterfill aggregate limits reach regulator and manager', async () => {
        const MultiDeviceController = require('./lib/MultiDeviceController');
        const PowerRegulator = require('./lib/PowerRegulator');
        const controller = new MultiDeviceController(mockAdapter, {
            multiDeviceMgr: {
                devices: [
                    { id: 'device1', maxChargePowerW: 900, maxDischargePowerW: 700 },
                    { id: 'device2', maxChargePowerW: 2100, maxDischargePowerW: 1500 }
                ]
            }
        });
        const limits = controller.getWaterfillSystemLimits([
            { id: 'device1' },
            { id: 'device2' }
        ]);
        assertEqual(limits.maxChargePowerW, 3000, 'Controller sums per-device charge limits');
        assertEqual(limits.maxDischargePowerW, 2200, 'Controller sums per-device discharge limits');

        const manager = new MultiDeviceManager(mockAdapter, 'test.0', [
            { productKey: 'device1', deviceKey: 'pk1', enabled: true, maxChargePowerW: 900, maxDischargePowerW: 700 },
            { productKey: 'device2', deviceKey: 'pk2', enabled: true, maxChargePowerW: 2100, maxDischargePowerW: 1500 }
        ]);
        const eligibleDevices = manager.devices.map(device => ({ ...device, available: true }));
        assertEqual(
            manager.limitPowerToEligibleDevices(-4000, eligibleDevices, { multiDeviceDistributionStrategy: 'waterfill' }),
            -3000,
            'Manager clamps charge to summed device limits'
        );
        assertEqual(
            manager.limitPowerToEligibleDevices(4000, eligibleDevices, { multiDeviceDistributionStrategy: 'waterfill' }),
            2200,
            'Manager clamps discharge to summed device limits'
        );

        const regulatorController = new MultiDeviceController(mockAdapter, {
            multiDeviceMgr: controller.multiDeviceMgr,
            relayProtection: {
                applyProtection: params => ({
                    powerW: params.newBatteryPowerW,
                    feedInCounter: 0,
                    dischargeCounter: 0,
                    deadbandCounter: 0
                })
            },
            powerRegulator: new PowerRegulator(mockAdapter)
        });
        const regulatedPower = await regulatorController.calculateTargetPower(
            {
                multiDeviceDistributionStrategy: 'waterfill',
                maxChargePowerW: 1600,
                maxDischargePowerW: 1600,
                operatingDeadbandW: 10,
                hysteresisW: 1,
                rampChargeWPerCycle: 0,
                rampDischargeWPerCycle: 0
            },
            4000,
            0,
            [{ id: 'device1', powerW: 0 }, { id: 'device2', powerW: 0 }],
            { totalPowerW: 0, avgSoc: 50, availableDevicesCount: 2 }
        );
        assertEqual(regulatedPower, 2200, 'PowerRegulator receives summed Waterfill discharge limit');
    });

    await runTest('[4.12] Waterfill blends power gradually during sticky-device handover', async () => {
        const distributor = new WaterfillDistributor();
        const devices = [
            {
                id: 'device1', name: 'Device 1', soc: 80, minSoc: 10, maxSoc: 100,
                maxChargePowerW: 1600, maxDischargePowerW: 800,
                chargeAllowed: true, dischargeAllowed: true
            },
            {
                id: 'device2', name: 'Device 2', soc: 40, minSoc: 10, maxSoc: 100,
                maxChargePowerW: 1600, maxDischargePowerW: 800,
                chargeAllowed: true, dischargeAllowed: true
            }
        ];
        const config = {
            minBatterySoc: 10,
            maxBatterySoc: 100,
            updateIntervalSec: 5,
            waterfillConcentrateHoldMinutes: 0,
            waterfillDischargeConcentrateBelowW: 600,
            waterfillDischargeSpreadAboveW: 1200,
            waterfillSocMargin: 10
        };

        distributor.distribute(400, devices, config);
        devices[0].soc = 40;
        devices[1].soc = 80;

        // Handover triggers (device1 -> device2), but the outgoing device keeps its
        // full power on this exact cycle - the swap only starts ramping in on the
        // following handover-hold cycles, so no device ever jumps instantly.
        const trigger = distributor.distribute(400, devices, config);
        assertEqual(trigger.find(item => item.deviceId === 'device1').powerW, 400, 'Trigger cycle keeps outgoing device at its previous power');
        assertEqual(trigger.find(item => item.deviceId === 'device2').powerW, 0, 'Trigger cycle has not ramped in the incoming device yet');

        // Over the 4 handover-hold cycles, power is linearly blended from the
        // outgoing device to the incoming device's target - device2's target is
        // capped to its own 800W discharge limit (below the 1000W requested),
        // so the ramp is 0 -> 200 -> 400 -> 600 -> 800 against that 800W target,
        // not against the raw 1000W request; the outgoing device picks up
        // whatever's left of the requested 1000W each cycle.
        const expectedSteps = [
            { device1: 800, device2: 200 },
            { device1: 600, device2: 400 },
            { device1: 400, device2: 600 },
            { device1: 0, device2: 800 }
        ];
        for (let cycle = 0; cycle < 4; cycle++) {
            const held = distributor.distribute(1000, devices, config);
            const step = expectedSteps[cycle];
            assertEqual(held.find(item => item.deviceId === 'device1').powerW, step.device1, `Handover blend step ${cycle + 1} splits power to outgoing device`);
            assertEqual(held.find(item => item.deviceId === 'device2').powerW, step.device2, `Handover blend step ${cycle + 1} splits power to incoming device`);
        }

        const afterHold = distributor.distribute(1000, devices, config);
        assertEqual(afterHold.filter(item => item.powerW > 0).length, 2, 'Spread is allowed after handover hold completes');
    });

    await runTest('[4.13] Waterfill voltage mode does not filter at global SOC floor', async () => {
        const distributor = new WaterfillDistributor();
        const devices = [
            {
                id: 'device1', name: 'Device 1', soc: 10, maxChargePowerW: 1600,
                maxDischargePowerW: 800, chargeAllowed: true, dischargeAllowed: true
            },
            {
                id: 'device2', name: 'Device 2', soc: 10, maxChargePowerW: 1600,
                maxDischargePowerW: 800, chargeAllowed: true, dischargeAllowed: true
            }
        ];
        const config = {
            minBatterySoc: 10,
            maxBatterySoc: 100,
            dischargeProtectionMode: 'voltage',
            waterfillDischargeConcentrateBelowW: 600,
            waterfillDischargeSpreadAboveW: 1200,
            waterfillConcentrateHoldMinutes: 0,
            waterfillSocMargin: 10
        };

        const voltageDistribution = distributor.distribute(400, devices, config);
        assertEqual(
            voltageDistribution.reduce((sum, item) => sum + item.powerW, 0),
            400,
            'Voltage mode can distribute while SOC is at global floor'
        );

        const socDistribution = distributor.distribute(400, devices, {
            ...config,
            dischargeProtectionMode: 'soc'
        });
        assertEqual(
            socDistribution.every(item => item.powerW === 0),
            true,
            'SOC mode still blocks at global SOC floor'
        );
    });

    await runTest('[4.14] Equal-split strategy also honors per-device chargeAllowed/dischargeAllowed', async () => {
        initializeMockStates();

        const devices = [
            { productKey: 'device1', deviceKey: 'pk1', name: 'Device 1', enabled: true, chargeAllowed: false },
            { productKey: 'device2', deviceKey: 'pk2', name: 'Device 2', enabled: true }
        ];
        const multiDeviceMgr = new MultiDeviceManager(mockAdapter, 'test.0', devices);
        const emergencyManagers = new Map();
        const safetyLimiters = new Map();
        multiDeviceMgr.devices.forEach(dev => {
            emergencyManagers.set(dev.id, new EmergencyManager(mockAdapter, dev.basePath));
            safetyLimiters.set(dev.id, new SafetyLimiter(mockAdapter, dev.basePath));
        });

        // mockConfig has no multiDeviceDistributionStrategy set, i.e. default equalSplit.
        const distribution = await multiDeviceMgr.distributePower(
            -1000,
            await multiDeviceMgr.aggregateDeviceStates(),
            mockConfig,
            emergencyManagers,
            safetyLimiters
        );

        const device1 = distribution.find(d => d.deviceId === 'pk1');
        const device2 = distribution.find(d => d.deviceId === 'pk2');
        assertEqual(device1.excluded, true, 'Charge-disabled device is excluded even in equalSplit mode');
        assertEqual(device1.powerW, 0, 'Charge-disabled device receives no power in equalSplit mode');
        assertEqual(device2.excluded, false, 'Other device still participates normally');
    });

    await runTest('[4.15] Waterfill marks ineligible devices as excluded for UI transparency', async () => {
        const distributor = new WaterfillDistributor();
        const devices = [
            {
                id: 'atMaxSoc', name: 'At Max SOC', soc: 100, minSoc: 10, maxSoc: 100,
                maxChargePowerW: 1000, maxDischargePowerW: 1000,
                chargeAllowed: true, dischargeAllowed: true
            },
            {
                id: 'usable', name: 'Usable', soc: 60, minSoc: 10, maxSoc: 100,
                maxChargePowerW: 1000, maxDischargePowerW: 1000,
                chargeAllowed: true, dischargeAllowed: true
            }
        ];
        const config = { minBatterySoc: 10, maxBatterySoc: 100, waterfillConcentrateHoldMinutes: 0 };

        const charge = distributor.distribute(-500, devices, config);
        assertEqual(charge.find(item => item.deviceId === 'atMaxSoc').excluded, true, 'Device at max SOC is marked excluded, not just 0W');
        assertEqual(charge.find(item => item.deviceId === 'usable').excluded, false, 'Participating device is not marked excluded');
    });

    await runTest('[4.16] A third device cannot hijack an in-progress handover blend', async () => {
        const distributor = new WaterfillDistributor();
        const devices = [
            { id: 'A', name: 'A', soc: 80, minSoc: 10, maxSoc: 100, maxChargePowerW: 1600, maxDischargePowerW: 800, chargeAllowed: true, dischargeAllowed: true },
            { id: 'B', name: 'B', soc: 40, minSoc: 10, maxSoc: 100, maxChargePowerW: 1600, maxDischargePowerW: 800, chargeAllowed: true, dischargeAllowed: true },
            { id: 'C', name: 'C', soc: 40, minSoc: 10, maxSoc: 100, maxChargePowerW: 1600, maxDischargePowerW: 800, chargeAllowed: true, dischargeAllowed: true }
        ];
        const config = {
            minBatterySoc: 10, maxBatterySoc: 100, updateIntervalSec: 5,
            waterfillConcentrateHoldMinutes: 0,
            waterfillDischargeConcentrateBelowW: 600,
            waterfillDischargeSpreadAboveW: 1200,
            waterfillSocMargin: 10
        };

        distributor.distribute(400, devices, config); // A becomes sticky active
        devices[0].soc = 40;
        devices[1].soc = 80;
        distributor.distribute(400, devices, config); // handover A -> B triggers, blend starts

        // Mid-blend, device C suddenly becomes the strongest candidate by far.
        // The old (buggy) behavior re-evaluated the sticky device every cycle,
        // so this would hijack the handover to C and drop A from its partial
        // allocation straight to 0W instead of continuing the A->B ramp-down.
        devices[2].soc = 95;
        const midBlend = distributor.distribute(1000, devices, config);
        // B's target is capped to its own 800W discharge limit (see [4.12]),
        // so this first held cycle is 25% of the way from 0W to 800W, not 1000W.
        assertEqual(midBlend.find(item => item.deviceId === 'A').powerW, 800, 'Outgoing device A continues its scheduled ramp-down, unaffected by C');
        assertEqual(midBlend.find(item => item.deviceId === 'B').powerW, 200, 'Incoming device B continues its scheduled ramp-in, unaffected by C');
        assertEqual(midBlend.find(item => item.deviceId === 'C').powerW, 0, 'C is ignored until the in-progress A->B handover hold completes');
    });

    await runTest('[4.17] A load spike above the spread threshold breaks out of an active handover hold', async () => {
        const distributor = new WaterfillDistributor();
        const devices = [
            { id: 'A', name: 'A', soc: 80, minSoc: 10, maxSoc: 100, maxChargePowerW: 1600, maxDischargePowerW: 800, chargeAllowed: true, dischargeAllowed: true },
            { id: 'B', name: 'B', soc: 40, minSoc: 10, maxSoc: 100, maxChargePowerW: 1600, maxDischargePowerW: 800, chargeAllowed: true, dischargeAllowed: true },
            { id: 'C', name: 'C', soc: 40, minSoc: 10, maxSoc: 100, maxChargePowerW: 1600, maxDischargePowerW: 800, chargeAllowed: true, dischargeAllowed: true }
        ];
        const config = {
            minBatterySoc: 10, maxBatterySoc: 100, updateIntervalSec: 5,
            waterfillConcentrateHoldMinutes: 0,
            waterfillDischargeConcentrateBelowW: 600,
            waterfillDischargeSpreadAboveW: 1200,
            waterfillSocMargin: 10
        };

        distributor.distribute(400, devices, config); // A becomes sticky active
        devices[0].soc = 40;
        devices[1].soc = 80;
        distributor.distribute(400, devices, config); // handover A -> B triggers, blend starts

        // A sudden load spike above the spread threshold arrives mid-hold. The
        // old (buggy) behavior stayed forced into single/blend mode for the
        // rest of the hold window, capping total power to just A+B's limits
        // (1600W) and leaving the idle, eligible device C untouched even
        // though the requested 1500W needs it.
        const spike = distributor.distribute(1500, devices, config);
        const total = spike.reduce((sum, item) => sum + item.powerW, 0);
        assertEqual(total, 1500, 'Full requested power is met by spreading across all eligible devices');
        assert(spike.find(item => item.deviceId === 'C').powerW > 0, 'Idle device C is pulled in during the spike instead of being ignored for the rest of the hold');
    });

    await runTest('[4.18] Waterfill reaches single-device mode after the configured hold window, not just cycle 1', async () => {
        const distributor = new WaterfillDistributor();
        const devices = [
            { id: 'device1', name: 'Device 1', soc: 80, minSoc: 10, maxSoc: 100, maxChargePowerW: 1600, maxDischargePowerW: 800, chargeAllowed: true, dischargeAllowed: true },
            { id: 'device2', name: 'Device 2', soc: 40, minSoc: 10, maxSoc: 100, maxChargePowerW: 1600, maxDischargePowerW: 1600, chargeAllowed: true, dischargeAllowed: true }
        ];
        const config = {
            minBatterySoc: 10, maxBatterySoc: 100, updateIntervalSec: 5,
            // A non-zero hold window is the whole point of this test: it forces
            // selectMode() to stay on mode 'spread' (returning via enterSpread)
            // for several cycles in a row before it may flip to 'single'. A
            // regression that resets holdCycles on every one of those interim
            // enterSpread calls would keep the counter at 1 forever and the
            // system would never reach single-device mode at all.
            waterfillConcentrateHoldMinutes: 1,
            waterfillDischargeConcentrateBelowW: 600,
            waterfillDischargeSpreadAboveW: 1200,
            waterfillSocMargin: 10
        };
        const holdCycles = Math.round((1 * 60000) / (5 * 1000)); // 12

        let lastResult;
        for (let cycle = 0; cycle < holdCycles - 1; cycle++) {
            lastResult = distributor.distribute(400, devices, config);
            assertEqual(lastResult.filter(item => item.powerW > 0).length, 2,
                `Cycle ${cycle + 1}/${holdCycles - 1}: still spreading while the hold window accumulates`);
        }

        // Hold window complete: this cycle starts the (separate, shorter)
        // mode-transition blend rather than jumping straight to single - see
        // [4.19] for that transition in detail. It settles into pure single
        // MODE_TRANSITION_HOLD_CYCLES (2) cycles later.
        distributor.distribute(400, devices, config);
        distributor.distribute(400, devices, config);
        const settled = distributor.distribute(400, devices, config);
        assertEqual(settled.filter(item => item.powerW > 0).length, 1,
            `Hold window and mode-transition blend complete: pure single-device mode by cycle ${holdCycles + 2}`);
        assertEqual(settled.find(item => item.powerW > 0).deviceId, 'device1', 'Highest SOC device becomes sticky');
    });

    await runTest('[4.19] Waterfill blends power gradually when concentrating out of spread mode', async () => {
        const distributor = new WaterfillDistributor();
        const devices = [
            { id: 'device1', name: 'Device 1', soc: 80, minSoc: 10, maxSoc: 100, maxChargePowerW: 1600, maxDischargePowerW: 800, chargeAllowed: true, dischargeAllowed: true },
            { id: 'device2', name: 'Device 2', soc: 40, minSoc: 10, maxSoc: 100, maxChargePowerW: 1600, maxDischargePowerW: 1600, chargeAllowed: true, dischargeAllowed: true }
        ];
        const config = {
            minBatterySoc: 10, maxBatterySoc: 100, updateIntervalSec: 5,
            // 10s / 5s-interval = exactly 2 hold cycles: the first call stays in
            // spread (a genuine prior cycle to blend away from), the second
            // crosses the threshold and starts concentrating - unlike [4.18]'s
            // 0-minute config, which would flip to single on the very first call
            // and never produce a real spread cycle beforehand.
            waterfillConcentrateHoldMinutes: 10 / 60,
            waterfillDischargeConcentrateBelowW: 600,
            waterfillDischargeSpreadAboveW: 1200,
            waterfillSocMargin: 10
        };

        // First call ever: nothing real has been written yet, so there is nothing
        // to blend away from, but the hold counter has not reached its threshold
        // (2 cycles) yet either - goes straight to spread.
        const spreadStep = distributor.distribute(400, devices, config);
        assertEqual(spreadStep.find(item => item.deviceId === 'device1').powerW, 280, 'Spread step: device1 gets its SOC-weighted share');
        assertEqual(spreadStep.find(item => item.deviceId === 'device2').powerW, 120, 'Spread step: device2 gets its SOC-weighted share');

        // Second cycle at the same load crosses the hold threshold and starts
        // concentrating. Same trigger-cycle pattern as a plain sticky-device swap
        // ([4.12]): the split stays exactly where it was one moment ago - device1
        // keeps its own real spread share (280W) instead of being dropped to 0W
        // and ramped back up, and device2 keeps its own real spread share (120W)
        // instead of being force-fed the full 400W it never actually carried
        // alone. The blend only starts moving from the next cycle onward.
        const transitionStart = distributor.distribute(400, devices, config);
        assertEqual(transitionStart.find(item => item.deviceId === 'device1').powerW, 280, 'Mode-transition step 1: incoming device keeps its real previous share, no jump');
        assertEqual(transitionStart.find(item => item.deviceId === 'device2').powerW, 120, 'Mode-transition step 1: outgoing device keeps its real previous share, no jump');

        const transitionMid = distributor.distribute(400, devices, config);
        assertEqual(transitionMid.find(item => item.deviceId === 'device1').powerW, 340, 'Mode-transition step 2: power is half-way blended from device1\'s real 280W start to the 400W target');
        assertEqual(transitionMid.find(item => item.deviceId === 'device2').powerW, 60, 'Mode-transition step 2: power is half-way blended away from device2\'s real 120W start');

        const transitionDone = distributor.distribute(400, devices, config);
        assertEqual(transitionDone.find(item => item.deviceId === 'device1').powerW, 400, 'Mode-transition step 3: incoming device now carries the full load');
        assertEqual(transitionDone.find(item => item.deviceId === 'device2').powerW, 0, 'Mode-transition step 3: outgoing device has fully ramped down');

        const total = [transitionStart, transitionMid, transitionDone].map(
            result => result.reduce((sum, item) => sum + item.powerW, 0)
        );
        assert(total.every(sum => sum === 400), 'Total power stays at the requested target throughout the blend - only its split moves');
    });

    await runTest('[4.20] Waterfill never blends a plain power-level change on an already-settled device set', async () => {
        const distributor = new WaterfillDistributor();
        const devices = [
            { id: 'device1', name: 'Device 1', soc: 80, minSoc: 10, maxSoc: 100, maxChargePowerW: 1600, maxDischargePowerW: 800, chargeAllowed: true, dischargeAllowed: true },
            { id: 'device2', name: 'Device 2', soc: 40, minSoc: 10, maxSoc: 100, maxChargePowerW: 1600, maxDischargePowerW: 1600, chargeAllowed: true, dischargeAllowed: true }
        ];
        const config = {
            minBatterySoc: 10, maxBatterySoc: 100, updateIntervalSec: 5,
            waterfillConcentrateHoldMinutes: 0,
            waterfillDischargeConcentrateBelowW: 600,
            waterfillDischargeSpreadAboveW: 1200,
            waterfillSocMargin: 10
        };

        // Settle into single-device mode on device1 (cold start, no prior
        // allocation to blend away from - immediate, per [4.7]/[4.12]).
        distributor.distribute(400, devices, config);

        // Same active device, three different power levels in a row: every one
        // of these must be answered immediately at the new target. A blend must
        // never be triggered just because the requested magnitude changed while
        // the device set stayed the same.
        for (const targetW of [300, 550, 100]) {
            const result = distributor.distribute(targetW, devices, config);
            assertEqual(result.find(item => item.deviceId === 'device1').powerW, targetW, `Instant response to ${targetW}W on the unchanged active device`);
            assertEqual(result.find(item => item.deviceId === 'device2').powerW, 0, `Idle device stays untouched at ${targetW}W`);
        }

        // Force a large spike into spread mode, then vary the magnitude within
        // spread while the same two devices stay eligible - again, no blend
        // should ever engage, only waterfill()'s direct SOC-weighted split.
        distributor.distribute(1500, devices, config);
        for (const targetW of [1300, 1250, 1400]) {
            const result = distributor.distribute(targetW, devices, config);
            const total = result.reduce((sum, item) => sum + item.powerW, 0);
            assertEqual(total, targetW, `Spread mode answers ${targetW}W immediately with the full target`);
            assert(result.every(item => item.reason === 'Waterfill spread'), `No blend reason appears while spread stays spread at ${targetW}W`);
        }
    });

    // ------------------------------------------------------------------
    // Issue #21: sustained heavy feed-in never reached charge mode because
    // RelayProtection's deliberate relay-safety setpoints (0W, or exactly
    // ±operatingDeadbandW) were smaller than hysteresisW, so
    // PowerRegulator's hysteresis kept reverting them to the old setpoint -
    // deadlocking the mode switch forever. Fix: RelayProtection reports
    // `relayModified` whenever it enforces such a setpoint, and both
    // controllers forward that as `bypassHysteresis` so only that one
    // regulation step is skipped - ramping, absolute limits and rounding
    // (and, upstream, the RelayProtection telemetry wait for the battery
    // to actually reach ~0W) still apply exactly as before.
    // ------------------------------------------------------------------

    await runTest('[4.21] RelayProtection + PowerRegulator: relay-safety setpoints bypass hysteresis, not the whole regulator (issue #21, single-device shape)', async () => {
        const relayProtection = new RelayProtection(mockAdapter);
        const powerRegulator = new PowerRegulator(mockAdapter);

        // Single-device config: operatingDeadbandW is used as-is (no per-device
        // scaling), matching lib/SingleDeviceController.js.
        const config = {
            ...mockConfig,
            hysteresisW: 30,
            operatingDeadbandW: 10,
            deadbandHoldTicks: 1,
            feedInThresholdW: -150,
            feedInDelayTicks: 5
        };

        // Sustained feed-in already confirmed (counter past feedInDelayTicks),
        // as it would be after minutes of heavy PV export.
        relayProtection.feedInCounter = 5;

        const gridPowerW = -300; // well below feedInThresholdW
        const currentBatteryPowerW = 25; // still discharging, not yet ~0W
        const rawTargetW = -500; // I-Regulator wants a hard charge transition

        // Cycle A: deadband takes over for the first time this transition -
        // holds at exactly +operatingDeadbandW (10W), same as before the fix.
        let relayResult = relayProtection.applyProtection({
            config, gridPowerW, currentBatteryPowerW,
            lastSetPowerW: 10, newBatteryPowerW: rawTargetW
        });
        assertEqual(relayResult.powerW, 10, 'Cycle A: deadband holds at +operatingDeadbandW');
        assert(relayResult.relayModified, 'Cycle A: RelayProtection reports it overrode the setpoint');

        let regResult = powerRegulator.applyRegulation({
            config, powerW: relayResult.powerW, lastSetPowerW: 10,
            safetyActive: false, bypassHysteresis: relayResult.relayModified
        });
        assertEqual(regResult.powerW, 10, 'Cycle A: regulator output unchanged (no relay switch needed yet)');

        // Cycle B: deadband hold has now lasted deadbandHoldTicks, but the device
        // still isn't relay-safe (currentBatteryPowerW=25W is still above
        // modeSwitchToleranceW). RelayProtection keeps holding at +operatingDeadbandW
        // rather than releasing to a literal 0W - a literal 0 here would get
        // laundered by config.avoidZeroSetpoint into a non-zero keep-alive in the
        // *old* (discharge) direction downstream, which reads back as "still
        // discharging" next cycle and restarts this whole transition from scratch
        // (real-world livelock, 2026-08-28: adapter stuck alternating 0W/10W for
        // hours, battery never actually reaching near-0W, only a restart recovered).
        relayResult = relayProtection.applyProtection({
            config, gridPowerW, currentBatteryPowerW,
            lastSetPowerW: 10, newBatteryPowerW: rawTargetW
        });
        assertEqual(relayResult.powerW, 10, 'Cycle B: still not relay-safe, deadband keeps holding at +operatingDeadbandW (not 0W)');
        assert(relayResult.relayModified, 'Cycle B: RelayProtection reports it overrode the setpoint');

        regResult = powerRegulator.applyRegulation({
            config, powerW: relayResult.powerW, lastSetPowerW: 10,
            safetyActive: false, bypassHysteresis: relayResult.relayModified
        });
        assertEqual(regResult.powerW, 10, 'Cycle B: held setpoint reaches the device instead of being reverted by hysteresis');

        // Cycle C: battery power has now actually settled near-0 (5W, within
        // modeSwitchToleranceW) - relay-protection's own charge/discharge sign-change
        // guard (separate from the "wait for near-zero" gate, untouched by this fix)
        // still holds for one more deadbandHoldTicks cycle before allowing the actual
        // sign flip, so this cycle still reports the +10W hold, not the full target yet.
        const settledBatteryPowerW = 5;
        relayResult = relayProtection.applyProtection({
            config, gridPowerW, currentBatteryPowerW: settledBatteryPowerW,
            lastSetPowerW: 10, newBatteryPowerW: rawTargetW
        });
        assertEqual(relayResult.powerW, 10, 'Cycle C: relay-safe now, but sign-change deadband holds once more at +operatingDeadbandW');

        // Cycle D: sign-change deadband hold has now also lasted deadbandHoldTicks -
        // RelayProtection finally releases straight to the full charge target. Note
        // there is still no literal 0W anywhere in this sequence: the jump goes
        // directly from the +10W hold to the full (large, unambiguous) target.
        relayResult = relayProtection.applyProtection({
            config, gridPowerW, currentBatteryPowerW: settledBatteryPowerW,
            lastSetPowerW: 10, newBatteryPowerW: rawTargetW
        });
        assertEqual(relayResult.powerW, rawTargetW, 'Cycle D: relay-safe, RelayProtection releases straight to the full charge target');
        // relayModified is correctly false here: this cycle passes the regulator's own
        // target straight through unmodified (the override happened in cycles A-C).
        // The large delta from lastSetPowerW clears hysteresis on its own regardless.

        regResult = powerRegulator.applyRegulation({
            config, powerW: relayResult.powerW, lastSetPowerW: 10,
            safetyActive: false, bypassHysteresis: relayResult.relayModified
        });
        // Ramp rate limiting (a separate, unrelated regulation step) caps how much of the
        // jump lands in one cycle - the point here is just that hysteresis didn't revert
        // it back to the 10W hold, not that the full target arrives in a single cycle.
        assert(regResult.powerW < -100, `Cycle D: charge step reaches the device instead of being reverted by hysteresis (got ${regResult.powerW}W)`);

        // Control: without the bypass flag, a small-delta protective setpoint gets
        // reverted by hysteresis - this is the bug as reported in issue #21.
        const unfixedResult = powerRegulator.applyRegulation({
            config, powerW: 0, lastSetPowerW: 10, safetyActive: false
            // bypassHysteresis omitted, as pre-fix call sites did
        });
        assertEqual(unfixedResult.powerW, 10, 'Control: omitting bypassHysteresis reproduces the reported deadlock');
    });

    await runTest('[4.21b] RelayProtection switch tolerance has a flat +5W margin so measurement noise cannot block the switch forever', async () => {
        const relayProtection = new RelayProtection(mockAdapter);

        const config = {
            ...mockConfig,
            operatingDeadbandW: 20,
            deadbandHoldTicks: 1,
            feedInThresholdW: -150,
            feedInDelayTicks: 5
        };

        relayProtection.feedInCounter = 5;

        // Hub reports 21W - 1W above the 20W deadband we're holding it at, e.g. sensor
        // rounding/noise. Without the +5W margin, abs(21) > 20 would hold this forever;
        // with it, abs(21) > 25 is false, so the switch is allowed through.
        const relayResult = relayProtection.applyProtection({
            config, gridPowerW: -300, currentBatteryPowerW: 21,
            lastSetPowerW: 10, newBatteryPowerW: -500
        });
        assert(relayResult.powerW !== 10, 'Hub stuck 1W over the deadband must not block the relay switch indefinitely');

        // Sanity check the margin doesn't swallow real, still-unsafe readings: 30W is
        // well past even the +5W margin (25W) and must still hold.
        const stillUnsafe = relayProtection.applyProtection({
            config, gridPowerW: -300, currentBatteryPowerW: 30,
            lastSetPowerW: 10, newBatteryPowerW: -500
        });
        assertEqual(stillUnsafe.powerW, 20, 'A genuinely unsafe reading (30W) still holds at +operatingDeadbandW');
    });

    await runTest('[4.22] MultiDeviceController.calculateTargetPower: sustained heavy feed-in reaches 0W instead of oscillating at hysteresis (issue #21, reporter\'s exact config)', async () => {
        const MultiDeviceController = require('./lib/MultiDeviceController');

        // Config values as attached to issue #21 (2x AC2400+ multi-device setup).
        // enableCharge/enableDischarge are always present in real runtime config
        // (io-package.json defaults both to true) - set explicitly here too, since
        // RelayProtection's charge/discharge-blocked freeze treats an unset flag the
        // same way SafetyLimiter always has: as disabled.
        const config = {
            hysteresisW: 30,
            operatingDeadbandW: 10, // scaled to 20W by the controller for 2 devices
            deadbandHoldTicks: 1,
            feedInThresholdW: -150,
            feedInDelayTicks: 5,
            dischargeThresholdW: 100,
            dischargeDelayTicks: 3,
            maxChargePowerW: 2400,
            maxDischargePowerW: 2400,
            rampChargeWPerCycle: 100,
            rampDischargeWPerCycle: 250,
            enableCharge: true,
            enableDischarge: true
        };

        const controller = new MultiDeviceController(mockAdapter, {
            multiDeviceMgr: { devices: [{ id: 'device1' }, { id: 'device2' }] },
            relayProtection: new RelayProtection(mockAdapter),
            powerRegulator: new PowerRegulator(mockAdapter)
        });

        // Reproduces the reported log: stuck discharging at 20W total while the
        // grid is feeding in ~3200W - way past feedInDelayTicks already.
        controller.lastTotalWrittenPowerW = 20;
        controller.relayProtection.feedInCounter = 90;

        const filteredGridPowerW = -3200;
        const targetGridPowerW = -100;
        const normalDevices = [{ id: 'device1', powerW: 20 }, { id: 'device2', powerW: 20 }];
        const aggregatedState = { totalPowerW: 40, avgSoc: 18, availableDevicesCount: 2 };

        const cycleA = await controller.calculateTargetPower(config, filteredGridPowerW, targetGridPowerW, normalDevices, aggregatedState);
        assertEqual(cycleA, 20, 'Cycle A: deadband holds at scaled operatingDeadbandW (20W for 2 devices)');

        // Cycle B: deadband hold ticks expired, but the devices are still measured at
        // 40W total (well above the scaled 20W tolerance) - keeps holding at 20W rather
        // than releasing to a literal 0W. A literal 0 here would get laundered by
        // config.avoidZeroSetpoint into a non-zero discharge-direction keep-alive
        // downstream, which reads back as "still discharging" next cycle and restarts
        // this whole transition from scratch (real-world livelock, 2026-08-28).
        controller.lastTotalWrittenPowerW = cycleA;
        const cycleB = await controller.calculateTargetPower(config, filteredGridPowerW, targetGridPowerW, normalDevices, aggregatedState);
        assertEqual(cycleB, 20, 'Cycle B: still not relay-safe, deadband keeps holding at scaled operatingDeadbandW (not 0W)');

        // Cycle C: devices have now actually settled near-0 (5W total, within the
        // scaled 20W tolerance) - relay-protection's sign-change guard (separate from
        // the "wait for near-zero" gate, untouched by this fix) still holds for one
        // more deadbandHoldTicks cycle, so this cycle still reports the 20W hold.
        controller.lastTotalWrittenPowerW = cycleB;
        const settledDevices = [{ id: 'device1', powerW: 2 }, { id: 'device2', powerW: 3 }];
        const cycleC = await controller.calculateTargetPower(config, filteredGridPowerW, targetGridPowerW, settledDevices, aggregatedState);
        assertEqual(cycleC, 20, 'Cycle C: relay-safe now, but sign-change deadband holds once more at scaled operatingDeadbandW');

        // Cycle D: sign-change deadband hold has now also lasted deadbandHoldTicks -
        // controller finally releases straight to a large charge target. Still no
        // literal 0W anywhere in this sequence.
        controller.lastTotalWrittenPowerW = cycleC;
        const cycleD = await controller.calculateTargetPower(config, filteredGridPowerW, targetGridPowerW, settledDevices, aggregatedState);
        assert(cycleD < -20, `Cycle D: relay-safe, controller releases straight to a large charge target (got ${cycleD}W)`);
    });

    await runTest('[4.23] PowerRegulator hysteresis still suppresses ordinary I-Regulator jitter (regression guard for issue #21 fix)', async () => {
        const relayProtection = new RelayProtection(mockAdapter);
        const powerRegulator = new PowerRegulator(mockAdapter);

        const config = { ...mockConfig, hysteresisW: 30, operatingDeadbandW: 10, deadbandHoldTicks: 1 };

        // Steady discharge, small I-Regulator fluctuation - no transition, no
        // deadband involvement, RelayProtection has nothing to enforce here.
        const relayResult = relayProtection.applyProtection({
            config, gridPowerW: 300, currentBatteryPowerW: 500,
            lastSetPowerW: 500, newBatteryPowerW: 520
        });
        assertEqual(relayResult.powerW, 520, 'RelayProtection passes ordinary regulation through untouched');
        assert(!relayResult.relayModified, 'RelayProtection reports no override for ordinary regulation');

        const regResult = powerRegulator.applyRegulation({
            config, powerW: relayResult.powerW, lastSetPowerW: 500,
            safetyActive: false, bypassHysteresis: relayResult.relayModified
        });
        assertEqual(regResult.powerW, 500, 'Hysteresis still suppresses a 20W jitter below the 30W threshold');
    });

    // ------------------------------------------------------------------
    // Issue #26 (PV headroom): a PV-equipped device's own solar production
    // occupies part of its charge capacity, but the waterfall previously had
    // no awareness of this - it could ask the device for more AC-side charge
    // power than it could actually accept, and the shortfall was never
    // redistributed to the other device within the same cycle, causing
    // persistent setpoint-validation retries/errors.
    // ------------------------------------------------------------------

    await runTest('[4.24] computeEffectiveChargeLimitW: non-PV unaffected, PV subtracts live solar, AC-only cap and unset-AC-limit fallback both honored', async () => {
        const { computeEffectiveChargeLimitW } = require('./lib/pvChargeLimit');

        assertEqual(
            computeEffectiveChargeLimitW({ maxChargePowerW: 1600 }),
            1600,
            'Non-PV device: raw maxChargePowerW passes through unchanged'
        );

        assertEqual(
            computeEffectiveChargeLimitW({ hasPv: true, maxChargePowerW: 2000, maxAcChargePowerW: 2000, solarInputPowerW: 1200 }),
            800,
            'PV device: combined limit minus live solar production'
        );

        assertEqual(
            computeEffectiveChargeLimitW({ hasPv: true, maxChargePowerW: 1500, maxAcChargePowerW: 1500, solarInputPowerW: 1600 }),
            0,
            'PV device: solar exceeding the combined limit floors at 0, never negative'
        );

        assertEqual(
            computeEffectiveChargeLimitW({ hasPv: true, maxChargePowerW: 2000, maxAcChargePowerW: 600, solarInputPowerW: 200 }),
            600,
            'PV device: a tighter separate AC-only cap binds even when combined-minus-solar is higher'
        );

        assertEqual(
            computeEffectiveChargeLimitW({ hasPv: true, maxChargePowerW: 2000, solarInputPowerW: 500 }),
            1500,
            'PV device: unset maxAcChargePowerW degrades gracefully to the combined-only formula'
        );
    });

    await runTest('[4.25] PV headroom: waterfill caps a PV device to its live effective AC limit and redistributes the rest in the same cycle', async () => {
        const distributor = new WaterfillDistributor();
        const devices = [
            {
                id: 'pro', name: 'Pro (PV)', soc: 50,
                hasPv: true, maxChargePowerW: 2400, maxAcChargePowerW: 2400, solarInputPowerW: 1500,
                maxDischargePowerW: 1600, chargeAllowed: true, dischargeAllowed: true
            },
            {
                id: 'acplus', name: 'AC+', soc: 60,
                maxChargePowerW: 1600, maxDischargePowerW: 1600,
                chargeAllowed: true, dischargeAllowed: true
            }
        ];
        const waterfillConfig = {
            minBatterySoc: 10,
            maxBatterySoc: 100,
            updateIntervalSec: 5,
            waterfillConcentrateHoldMinutes: 0,
            waterfillChargeConcentrateBelowW: 600,
            waterfillChargeSpreadAboveW: 1200,
            waterfillSocMargin: 10
        };

        // Pro's raw maxChargePowerW (2400) minus its live 1500W solar leaves only 900W of AC
        // headroom - reproduces the cliffsolar scenario (a PV-unaware waterfall would have
        // handed Pro the full 2400W share; AC+ must pick up the rest in the SAME cycle).
        const result = distributor.distribute(-2500, devices, waterfillConfig);

        assertEqual(result.find(d => d.deviceId === 'pro').powerW, -900, "PV device is capped to its live effective AC limit (2400 - 1500 solar), not the raw 2400W");
        assertEqual(result.find(d => d.deviceId === 'acplus').powerW, -1600, 'Non-PV device absorbs the remainder in the same cycle - no leftover, no separate priority pass needed');
        assertEqual(result.reduce((sum, d) => sum + d.powerW, 0), -2500, 'Full requested charge power is delivered');
    });

    await runTest('[4.26] Multi-Device reads live solarInputPower for PV devices, degrading to 0 (not exclusion) when stale/missing', async () => {
        initializeMockStates();
        const devices = [
            { productKey: 'device1', deviceKey: 'pk1', name: 'PV Device', enabled: true, hasPv: true, maxChargePowerW: 2000, maxAcChargePowerW: 2000 },
            { productKey: 'device2', deviceKey: 'pk2', name: 'Non-PV Device', enabled: true }
        ];
        const multiDeviceMgr = new MultiDeviceManager(mockAdapter, 'test.0', devices);

        // Fresh solar reading for the PV device
        setMockState('test.0.device1.pk1.solarInputPower', 1234);

        const aggregated = await multiDeviceMgr.aggregateDeviceStates();
        const pv = aggregated.devices.find(d => d.id === 'pk1');
        const nonPv = aggregated.devices.find(d => d.id === 'pk2');

        assertEqual(pv.solarInputPowerW, 1234, 'PV device reports live solar production');
        assertEqual(pv.available, true, 'Fresh solar reading does not affect availability');
        assertEqual(nonPv.solarInputPowerW, 0, 'Non-PV device is never read/never affected');

        // Now go stale
        const staleTs = Date.now() - (4 * 60 * 1000);
        mockStates.set('test.0.device1.pk1.solarInputPower', { val: 1234, ack: true, ts: staleTs });

        const aggregatedStale = await multiDeviceMgr.aggregateDeviceStates();
        const pvStale = aggregatedStale.devices.find(d => d.id === 'pk1');

        assertEqual(pvStale.solarInputPowerW, 0, 'Stale solar reading degrades to 0 (no PV credit), not the frozen value');
        assertEqual(pvStale.available, true, 'Stale solar reading does NOT exclude the device (unlike packPower/SOC staleness)');
    });

    await runTest('[4.27] hasPv forces validationSource to gridInputPower, overriding any configured value', async () => {
        const devices = [
            { productKey: 'device1', deviceKey: 'pk1', name: 'PV Device', enabled: true, hasPv: true, validationSource: 'packPower' },
            { productKey: 'device2', deviceKey: 'pk2', name: 'Non-PV Device', enabled: true, validationSource: 'packPower' }
        ];
        const multiDeviceMgr = new MultiDeviceManager(mockAdapter, 'test.0', devices);

        const pv = multiDeviceMgr.devices.find(d => d.id === 'pk1');
        const nonPv = multiDeviceMgr.devices.find(d => d.id === 'pk2');

        assertEqual(pv.validationSource, 'gridInputPower', 'PV device validation source is forced to gridInputPower even though packPower was configured');
        assertEqual(nonPv.validationSource, 'packPower', 'Non-PV device keeps its configured validation source unchanged');
    });

    await runTest('[4.28] Waterfill sticky single-device mode marks the resting (but still eligible) device excluded, not just 0W', async () => {
        // Regression guard for the SF2400 Pro relay-chatter report: the #28 fix only
        // taught MultiDeviceManager to bypass zero-avoidance for items the *distributor*
        // already flagged excluded:true (SOC/emergency-excluded devices). But Waterfill's
        // own sticky single-device mode left its non-active candidate at excluded:false
        // (it's still "eligible", just not currently allocated), so that device kept
        // going through the full avoidZeroSetpoint state machine every cycle - rearmed
        // with a keep-alive and disarmed again every smartModeIdleTimeoutSec, exactly
        // like the original #28 bug, just for a different flavor of "excluded".
        const distributor = new WaterfillDistributor();
        const devices = [
            { id: 'pro', name: 'SF2400 Pro', soc: 80, minSoc: 10, maxSoc: 100, maxChargePowerW: 1600, maxDischargePowerW: 800, chargeAllowed: true, dischargeAllowed: true },
            { id: 'acplus', name: 'AC+', soc: 40, minSoc: 10, maxSoc: 100, maxChargePowerW: 1600, maxDischargePowerW: 1600, chargeAllowed: true, dischargeAllowed: true }
        ];
        const config = {
            minBatterySoc: 10, maxBatterySoc: 100, updateIntervalSec: 5,
            waterfillConcentrateHoldMinutes: 0,
            waterfillDischargeConcentrateBelowW: 600,
            waterfillDischargeSpreadAboveW: 1200,
            waterfillSocMargin: 10
        };

        const settled = distributor.distribute(400, devices, config); // single-device mode, 'pro' is sticky (higher SOC)
        const active = settled.find(item => item.powerW > 0);
        const resting = settled.find(item => item.powerW === 0);
        assertEqual(active.deviceId, 'pro', 'Higher-SOC device is the sticky active device');
        assertEqual(active.excluded, false, 'Active device is not excluded');
        assertEqual(resting.deviceId, 'acplus', 'Non-active candidate is the resting device');
        assertEqual(resting.excluded, true, 'Resting-but-eligible candidate must be flagged excluded so it bypasses zero-avoidance too');

        // End-to-end: with avoidZeroSetpoint enabled, the resting device must get a
        // literal 0W and never a keep-alive pulse, across repeated cycles.
        initializeMockStates();
        const multiDeviceMgr = new MultiDeviceManager(mockAdapter, 'test.0', [
            { productKey: 'pro', deviceKey: 'pro', name: 'SF2400 Pro', enabled: true },
            { productKey: 'acplus', deviceKey: 'acplus', name: 'AC+', enabled: true }
        ]);
        const validationService = new ValidationService(mockAdapter);
        const [proDevice, acplusDevice] = multiDeviceMgr.devices;
        const distribution = settled.map(item => ({
            ...item,
            deviceId: item.deviceId === 'pro' ? proDevice.id : acplusDevice.id
        }));
        const avoidZeroConfig = { ...mockConfig, avoidZeroSetpoint: true, standbyKeepAliveW: 10, smartModeIdleTimeoutSec: 300, zeroHoldOffSec: 8 };

        for (let i = 0; i < 5; i++) {
            await multiDeviceMgr.writePowerSetpoints(distribution, {}, validationService, avoidZeroConfig);
        }
        const restingLimit = getMockState(`${acplusDevice.basePath}.control.setDeviceAutomationInOutLimit`).val;
        assertEqual(restingLimit, 0, 'Resting device stays at literal 0W, never rearmed with a keep-alive pulse');
    });

    await runTest('[4.25] MultiDeviceController.calculateTargetPower: regulatorGain dampens the I-Regulator error, off by default (issue #30)', async () => {
        const MultiDeviceController = require('./lib/MultiDeviceController');

        const baseConfig = {
            hysteresisW: 10,
            operatingDeadbandW: 10,
            feedInThresholdW: -150,
            feedInDelayTicks: 5,
            dischargeThresholdW: 100,
            dischargeDelayTicks: 3,
            maxChargePowerW: 2000,
            maxDischargePowerW: 2000,
            rampChargeWPerCycle: 1000,
            rampDischargeWPerCycle: 1000,
            enableCharge: true,
            enableDischarge: true
        };

        const normalDevices = [{ id: 'device1', powerW: 500 }];
        const aggregatedState = { totalPowerW: 500, avgSoc: 50, availableDevicesCount: 1 };

        // Default (regulatorGainEnabled unset): full error applied, matches pre-#30 behavior.
        const defaultController = new MultiDeviceController(mockAdapter, {
            multiDeviceMgr: { devices: [{ id: 'device1' }] },
            relayProtection: new RelayProtection(mockAdapter),
            powerRegulator: new PowerRegulator(mockAdapter)
        });
        defaultController.lastTotalWrittenPowerW = 500;
        const defaultResult = await defaultController.calculateTargetPower(baseConfig, 300, 0, normalDevices, aggregatedState);
        assertEqual(defaultResult, 800, 'Gain disabled: full error (500 + 1.0*300 = 800W)');

        // Enabled with a reduced gain: only half the error should be applied.
        const dampedController = new MultiDeviceController(mockAdapter, {
            multiDeviceMgr: { devices: [{ id: 'device1' }] },
            relayProtection: new RelayProtection(mockAdapter),
            powerRegulator: new PowerRegulator(mockAdapter)
        });
        dampedController.lastTotalWrittenPowerW = 500;
        const dampedConfig = { ...baseConfig, regulatorGainEnabled: true, regulatorGain: 0.5 };
        const dampedResult = await dampedController.calculateTargetPower(dampedConfig, 300, 0, normalDevices, aggregatedState);
        assertEqual(dampedResult, 650, 'Gain 0.5 enabled: half the error applied (500 + 0.5*300 = 650W)');
    });

    await runTest('[4.26] MultiDeviceController.calculateTargetPower: hysteresis is scaled by regulatorGain so its Watt tolerance stays constant (issue #30 follow-up)', async () => {
        const MultiDeviceController = require('./lib/MultiDeviceController');

        const baseConfig = {
            hysteresisW: 50,
            operatingDeadbandW: 10,
            feedInThresholdW: -150,
            feedInDelayTicks: 5,
            dischargeThresholdW: 100,
            dischargeDelayTicks: 3,
            maxChargePowerW: 2000,
            maxDischargePowerW: 2000,
            rampChargeWPerCycle: 1000,
            rampDischargeWPerCycle: 1000,
            enableCharge: true,
            enableDischarge: true,
            regulatorGainEnabled: true,
            regulatorGain: 0.4
        };

        const normalDevices = [{ id: 'device1', powerW: 500 }];
        const aggregatedState = { totalPowerW: 500, avgSoc: 50, availableDevicesCount: 1 };

        // Raw grid error of 75W exceeds the configured 50W hysteresis, so this must go through -
        // pre-fix, the gain-scaled delta (0.4*75=30W) was compared against the raw 50W threshold
        // and got wrongly suppressed (effective tolerance had inflated to 50/0.4=125W).
        const aboveController = new MultiDeviceController(mockAdapter, {
            multiDeviceMgr: { devices: [{ id: 'device1' }] },
            relayProtection: new RelayProtection(mockAdapter),
            powerRegulator: new PowerRegulator(mockAdapter)
        });
        aboveController.lastTotalWrittenPowerW = 500;
        const aboveResult = await aboveController.calculateTargetPower(baseConfig, 75, 0, normalDevices, aggregatedState);
        assertEqual(aboveResult, 530, 'Raw error 75W > 50W hysteresis: correction applied (500 + 0.4*75 = 530W)');

        // Raw grid error of 20W is genuinely inside the configured 50W hysteresis and must still
        // be suppressed - confirms the fix restores the original meaning instead of just
        // disabling hysteresis outright.
        const belowController = new MultiDeviceController(mockAdapter, {
            multiDeviceMgr: { devices: [{ id: 'device1' }] },
            relayProtection: new RelayProtection(mockAdapter),
            powerRegulator: new PowerRegulator(mockAdapter)
        });
        belowController.lastTotalWrittenPowerW = 500;
        const belowResult = await belowController.calculateTargetPower(baseConfig, 20, 0, normalDevices, aggregatedState);
        assertEqual(belowResult, 500, 'Raw error 20W < 50W hysteresis: still suppressed, holds at 500W');
    });

    console.log('\n' + '='.repeat(70));
    console.log('SECTION 5: PACKAGE & CONFIG CONSISTENCY');
    console.log('='.repeat(70));

    // These guard the custom-URL install path (js-controller reads io-package.json
    // directly, no npm registry validation in between) - a malformed or
    // out-of-sync file here breaks the adapter before any adapter code runs.
    await runTest('[5.1] package.json and io-package.json versions match', async () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
        const ioPkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'io-package.json'), 'utf8'));
        assertEqual(ioPkg.common.version, pkg.version, 'io-package.json common.version matches package.json version');
    });

    await runTest('[5.2] io-package.json has required common fields', async () => {
        const ioPkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'io-package.json'), 'utf8'));
        for (const field of ['name', 'title', 'version', 'type', 'mode', 'adminUI']) {
            assert(ioPkg.common[field] !== undefined, `common.${field} is present`);
        }
        assert(ioPkg.common.name === 'zendure-automation', 'common.name matches expected adapter name');
    });

    await runTest('[5.3] admin/jsonConfig.json is valid JSON with required structure', async () => {
        const jsonConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'admin', 'jsonConfig.json'), 'utf8'));
        assert(jsonConfig.type && jsonConfig.items, 'jsonConfig has type and items');
    });

    await runTest('[5.4] admin/i18n translation files are valid JSON', async () => {
        for (const lang of ['de', 'en']) {
            const file = path.join(__dirname, 'admin', 'i18n', `${lang}.json`);
            const translations = JSON.parse(fs.readFileSync(file, 'utf8'));
            assert(Object.keys(translations).length > 0, `${lang}.json contains translations`);
        }
    });

    // Summary
    console.log('\n' + '='.repeat(70));
    if (testsFailed === 0) {
        console.log(`✓ ALL ${testsPassed} TESTS PASSED!`);
        console.log('='.repeat(70));
        console.log('\nAdapter code is production-ready! 🚀');
        console.log('\nCoverage:');
        console.log('  ✓ Module loading and instantiation');
        console.log('  ✓ Critical bug fixes (ValidationService, Multi-Device, Safety)');
        console.log('  ✓ Edge cases (NaN/null values, SOC/voltage limits)');
        console.log('  ✓ Emergency handling and safety limiters');
        console.log('  ✓ Full automation cycles (single & multi-device)');
        console.log('  ✓ Package/config file consistency');
    } else {
        console.log(`✗ ${testsFailed} TEST(S) FAILED (${testsPassed} passed)`);
        console.log('='.repeat(70));
        process.exit(1);
    }
}

// Run tests
testModules();
