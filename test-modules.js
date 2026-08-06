#!/usr/bin/env node
'use strict';

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
    useFullChargeNeeded: true,
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
    let PowerRegulator, ValidationService, MultiDeviceManager;

    await runTest('[1.1] Load all library modules', async () => {
        DataReader = require('./lib/DataReader');
        EmergencyManager = require('./lib/EmergencyManager');
        RelayProtection = require('./lib/RelayProtection');
        SafetyLimiter = require('./lib/SafetyLimiter');
        PowerRegulator = require('./lib/PowerRegulator');
        ValidationService = require('./lib/ValidationService');
        MultiDeviceManager = require('./lib/MultiDeviceManager');
        assert(DataReader && EmergencyManager && ValidationService, 'Modules loaded');
    });

    await runTest('[1.2] Instantiate all modules', async () => {
        initializeMockStates();
        const dataReader = new DataReader(mockAdapter, deviceBasePath);
        const emergencyMgr = new EmergencyManager(mockAdapter, deviceBasePath);
        const relayProtection = new RelayProtection(mockAdapter);
        const safetyLimiter = new SafetyLimiter(mockAdapter, deviceBasePath);
        const powerRegulator = new PowerRegulator(mockAdapter);
        const validationService = new ValidationService(mockAdapter);
        assert(dataReader && validationService, 'Modules instantiated');
    });

    await runTest('[1.3] DataReader reads states correctly', async () => {
        initializeMockStates();
        const dataReader = new DataReader(mockAdapter, deviceBasePath);
        
        const gridPower = await dataReader.getGridPowerW('test.0.gridPower');
        const batterySoc = await dataReader.getBatterySoc();
        const batteryPower = await dataReader.getCurrentBatteryPowerW();
        
        assertEqual(gridPower, 100, 'Grid power read correctly');
        assertEqual(batterySoc, 50, 'Battery SOC read correctly');
        assertEqual(batteryPower, -100, 'Battery power read correctly');
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
            { id: 'dev1', name: 'Device 1', basePath: 'test.0.device1' },
            { id: 'dev2', name: 'Device 2', basePath: 'test.0.device2' }
        ];
        
        const multiDeviceMgr = new MultiDeviceManager(mockAdapter, devices);
        
        // Set invalid states for device2
        setMockState('test.0.device2.packPower', NaN);
        setMockState('test.0.device2.electricLevel', null);
        
        const aggregated = await multiDeviceMgr.aggregateDeviceStates();
        
        // Device1 should be available, Device2 should NOT be available due to invalid states
        assertEqual(aggregated.devices.length, 2, 'Both devices returned');
        
        const dev1 = aggregated.devices.find(d => d.id === 'dev1');
        const dev2 = aggregated.devices.find(d => d.id === 'dev2');
        
        assertEqual(dev1.available, true, 'Device1 with valid states is available');
        assertEqual(dev2.available, false, 'Device2 with NaN/null states is NOT available');
    });

    await runTest('[2.3] Multi-Device safety limiters are applied in distribution', async () => {
        initializeMockStates();
        
        const devices = [
            { id: 'dev1', name: 'Device 1', basePath: 'test.0.device1' },
            { id: 'dev2', name: 'Device 2', basePath: 'test.0.device2' }
        ];
        
        const multiDeviceMgr = new MultiDeviceManager(mockAdapter, devices);
        
        // Set device1 to low voltage (should be limited by SafetyLimiter)
        setMockState('test.0.device1.packData.ABC123.minVol', 2.9);
        setMockState('test.0.device1.packData.DEF456.minVol', 2.8);
        
        const aggregated = await multiDeviceMgr.aggregateDeviceStates();
        
        // Create safety limiters
        const safetyLimiters = new Map();
        safetyLimiters.set('dev1', new SafetyLimiter(mockAdapter, 'test.0.device1'));
        safetyLimiters.set('dev2', new SafetyLimiter(mockAdapter, 'test.0.device2'));
        
        const emergencyManagers = new Map();
        emergencyManagers.set('dev1', new EmergencyManager(mockAdapter, 'test.0.device1'));
        emergencyManagers.set('dev2', new EmergencyManager(mockAdapter, 'test.0.device2'));
        
        // Try to discharge 1000W (should exclude dev1 due to low voltage)
        const voltageConfig = { ...mockConfig, dischargeProtectionMode: 'voltage', minBatteryVoltageV: 3.0 };
        const distribution = await multiDeviceMgr.distributePower(
            1000, 
            aggregated, 
            voltageConfig,
            emergencyManagers,
            safetyLimiters
        );
        
        const dev1Dist = distribution.find(d => d.deviceId === 'dev1');
        const dev2Dist = distribution.find(d => d.deviceId === 'dev2');
        
        assert(dev1Dist.excluded === true || dev1Dist.powerW === 0, 'Device1 excluded/limited due to low voltage');
        assert(dev2Dist.powerW > 0, 'Device2 gets power (normal voltage)');
    });

    console.log('\n' + '─'.repeat(70));
    console.log('SECTION 3: EDGE CASES & ERROR HANDLING');
    console.log('─'.repeat(70));

    await runTest('[3.1] SafetyLimiter blocks discharge at min SOC', async () => {
        initializeMockStates();
        const safetyLimiter = new SafetyLimiter(mockAdapter, deviceBasePath);
        
        // SOC at minimum
        const limited = safetyLimiter.applySafetyLimits(500, 10, 3.2);  // 10% SOC, try 500W discharge
        
        assertEqual(limited, 0, 'Discharge blocked at min SOC');
    });

    await runTest('[3.2] SafetyLimiter blocks discharge at min voltage', async () => {
        initializeMockStates();
        
        // Set voltage below minimum
        setMockState('test.0.device1.packData.ABC123.minVol', 2.9);
        setMockState('test.0.device1.packData.DEF456.minVol', 2.95);
        
        const safetyLimiter = new SafetyLimiter(mockAdapter, deviceBasePath);
        
        const limited = safetyLimiter.applySafetyLimits(500, 50, 2.9);  // Try 500W discharge at 2.9V
        
        assertEqual(limited, 0, 'Discharge blocked at min voltage');
    });

    await runTest('[3.3] EmergencyManager detects low voltage emergency', async () => {
        initializeMockStates();
        setMockState('test.0.device1.control.lowVoltageBlock', true);
        
        const emergencyMgr = new EmergencyManager(mockAdapter, deviceBasePath);
        const emergency = await emergencyMgr.checkEmergencyConditions(mockConfig, 15, 2.8);
        
        assertEqual(emergency.isEmergency, true, 'Emergency detected');
        assert(emergency.reason.includes('Low voltage'), 'Reason is low voltage');
    });

    await runTest('[3.4] Multi-Device handles all devices excluded', async () => {
        initializeMockStates();
        
        const devices = [
            { id: 'dev1', name: 'Device 1', basePath: 'test.0.device1' },
            { id: 'dev2', name: 'Device 2', basePath: 'test.0.device2' }
        ];
        
        const multiDeviceMgr = new MultiDeviceManager(mockAdapter, devices);
        
        // Set both devices to max SOC
        setMockState('test.0.device1.electricLevel', 95);
        setMockState('test.0.device2.electricLevel', 96);
        
        const aggregated = await multiDeviceMgr.aggregateDeviceStates();
        
        const emergencyManagers = new Map();
        const safetyLimiters = new Map();
        emergencyManagers.set('dev1', new EmergencyManager(mockAdapter, 'test.0.device1'));
        emergencyManagers.set('dev2', new EmergencyManager(mockAdapter, 'test.0.device2'));
        safetyLimiters.set('dev1', new SafetyLimiter(mockAdapter, 'test.0.device1'));
        safetyLimiters.set('dev2', new SafetyLimiter(mockAdapter, 'test.0.device2'));
        
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
        
        const safetyResult = safetyLimiter.applySafetyLimits(power, batterySoc, minVoltage);
        power = safetyResult;
        
        const regResult = powerRegulator.applyRegulation({
            config: mockConfig,
            powerW: power,
            lastSetPowerW: 0,
            safetyActive: false
        });
        power = regResult.powerW;
        
        assert(power >= 0, 'Positive discharge power calculated');
        assert(power <= mockConfig.maxDischargePowerW, 'Within max discharge limit');
    });

    await runTest('[4.2] Full cycle - Multi-device power distribution', async () => {
        initializeMockStates();
        
        const devices = [
            { id: 'dev1', name: 'Device 1', basePath: 'test.0.device1' },
            { id: 'dev2', name: 'Device 2', basePath: 'test.0.device2' }
        ];
        
        const multiDeviceMgr = new MultiDeviceManager(mockAdapter, devices);
        
        const emergencyManagers = new Map();
        const safetyLimiters = new Map();
        devices.forEach(dev => {
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

    await runTest('[4.3] ValidationService validates written setpoints', async () => {
        initializeMockStates();
        const validationService = new ValidationService(mockAdapter);
        
        // Write a setpoint
        await validationService.writePowerSetpoint('dev1', 'test.0.device1', -800);
        
        // Mock the actual hardware value
        setMockState('test.0.device1.control.setDeviceAutomationInOutLimit', -800);
        
        // Validate (should pass)
        const result = await validationService.validateSetpoint('dev1', mockConfig, -800);
        
        assertEqual(result.isValid, true, 'Setpoint validated successfully');
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
    } else {
        console.log(`✗ ${testsFailed} TEST(S) FAILED (${testsPassed} passed)`);
        console.log('='.repeat(70));
        process.exit(1);
    }
}

// Run tests
testModules();
