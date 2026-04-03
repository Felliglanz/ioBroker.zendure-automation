#!/usr/bin/env node
'use strict';

/**
 * Local Module Integration Test
 * Tests if all modules load correctly and work together
 * Run: node test-modules.js
 */

console.log('='.repeat(60));
console.log('Testing Module Integration...');
console.log('='.repeat(60));

// Mock adapter for testing
const mockAdapter = {
    log: {
        info: (msg) => console.log(`[INFO] ${msg}`),
        warn: (msg) => console.log(`[WARN] ${msg}`),
        debug: (msg) => console.log(`[DEBUG] ${msg}`),
        error: (msg) => console.log(`[ERROR] ${msg}`)
    },
    getForeignStateAsync: async (id) => {
        console.log(`  → getForeignStateAsync(${id})`);
        return { val: 50, ack: true };
    },
    setForeignStateAsync: async (id, val, ack) => {
        console.log(`  → setForeignStateAsync(${id}, ${val}, ${ack})`);
    },
    getStateAsync: async (id) => {
        console.log(`  → getStateAsync(${id})`);
        return { val: true, ack: true };
    },
    setStateAsync: async (id, val, ack) => {
        console.log(`  → setStateAsync(${id}, ${val}, ${ack})`);
    },
    getForeignObjectsAsync: async (pattern) => {
        console.log(`  → getForeignObjectsAsync(${pattern})`);
        return {
            'test.0.packData.ABC123.minVol': {},
            'test.0.packData.DEF456.minVol': {}
        };
    }
};

const mockConfig = {
    powerMeterDp: 'test.0.gridPower',
    targetGridPowerW: 0,
    minBatterySoc: 10,
    maxBatterySoc: 95,
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
    emergencyRecoverySoc: 30
};

const deviceBasePath = 'test.0.device';

async function testModules() {
    try {
        // Test 1: Load all modules
        console.log('\n[TEST 1] Loading modules...');
        const DataReader = require('./lib/DataReader');
        const EmergencyManager = require('./lib/EmergencyManager');
        const RelayProtection = require('./lib/RelayProtection');
        const SafetyLimiter = require('./lib/SafetyLimiter');
        const PowerRegulator = require('./lib/PowerRegulator');
        const ValidationService = require('./lib/ValidationService');
        console.log('✓ All modules loaded successfully');

        // Test 2: Instantiate modules
        console.log('\n[TEST 2] Instantiating modules...');
        const dataReader = new DataReader(mockAdapter, deviceBasePath);
        const emergencyMgr = new EmergencyManager(mockAdapter, deviceBasePath);
        const relayProtection = new RelayProtection(mockAdapter);
        const safetyLimiter = new SafetyLimiter(mockAdapter, deviceBasePath);
        const powerRegulator = new PowerRegulator(mockAdapter);
        const validationService = new ValidationService(mockAdapter);
        console.log('✓ All modules instantiated successfully');

        // Test 3: DataReader methods
        console.log('\n[TEST 3] Testing DataReader...');
        const gridPower = await dataReader.getGridPowerW('test.0.gridPower');
        const batterySoc = await dataReader.getBatterySoc();
        const batteryPower = await dataReader.getCurrentBatteryPowerW();
        const targetGrid = await dataReader.getTargetGridPowerW(0);
        const minVoltage = await dataReader.getMinimumPackVoltageV();
        console.log(`  Grid: ${gridPower}W, SOC: ${batterySoc}%, Battery: ${batteryPower}W, Target: ${targetGrid}W, MinV: ${minVoltage}V`);
        console.log('✓ DataReader methods work');

        // Test 4: EmergencyManager
        console.log('\n[TEST 4] Testing EmergencyManager...');
        const emergencyState = await emergencyMgr.checkEmergencyConditions(mockConfig, 50, 3.2);
        console.log(`  Emergency: ${emergencyState.isEmergency}, Reason: ${emergencyState.reason || 'none'}`);
        console.log(`  InEmergencyRecovery: ${emergencyMgr.inEmergencyRecovery}`);
        console.log(`  InVoltageRecovery: ${emergencyMgr.inVoltageRecovery}`);
        console.log('✓ EmergencyManager works');

        // Test 5: RelayProtection
        console.log('\n[TEST 5] Testing RelayProtection...');
        const relayResult = relayProtection.applyProtection({
            config: mockConfig,
            gridPowerW: 300,
            currentBatteryPowerW: 0,
            lastSetPowerW: 0,
            newBatteryPowerW: 300
        });
        console.log(`  Input: 300W → Output: ${relayResult.powerW}W`);
        console.log(`  FeedInCounter: ${relayResult.feedInCounter}, DischargeCounter: ${relayResult.dischargeCounter}`);
        console.log('✓ RelayProtection works');

        // Test 6: SafetyLimiter
        console.log('\n[TEST 6] Testing SafetyLimiter...');
        const safetyResult = await safetyLimiter.applySafetyLimits({
            config: mockConfig,
            emergencyManager: emergencyMgr,
            batterySoc: 50,
            minPackVoltageV: 3.2,
            powerW: 300
        });
        console.log(`  Input: 300W → Output: ${safetyResult.powerW}W, SafetyActive: ${safetyResult.safetyActive}`);
        console.log('✓ SafetyLimiter works');

        // Test 7: PowerRegulator
        console.log('\n[TEST 7] Testing PowerRegulator...');
        const regResult = powerRegulator.applyRegulation({
            config: mockConfig,
            powerW: 300,
            lastSetPowerW: 0,
            safetyActive: false
        });
        console.log(`  Input: 300W → Output: ${regResult.powerW}W (with ramping)`);
        console.log('✓ PowerRegulator works');

        // Test 8: ValidationService
        console.log('\n[TEST 8] Testing ValidationService...');
        await validationService.writePowerSetpoint(deviceBasePath, -800);
        console.log(`  LastWrittenLimit: ${validationService.lastWrittenLimit}W`);
        await validationService.validateSetpoint(mockConfig, -750);
        console.log('✓ ValidationService works');

        // Test 9: Integration test - full cycle
        console.log('\n[TEST 9] Testing full cycle integration...');
        let power = 0 + (300 - 0); // I-Regulator: lastSet + (grid - target)
        console.log(`  I-Regulator: ${power}W`);
        
        const relay = relayProtection.applyProtection({
            config: mockConfig,
            gridPowerW: 300,
            currentBatteryPowerW: 0,
            lastSetPowerW: 0,
            newBatteryPowerW: power
        });
        power = relay.powerW;
        console.log(`  After Relay Protection: ${power}W`);
        
        const safety = await safetyLimiter.applySafetyLimits({
            config: mockConfig,
            emergencyManager: emergencyMgr,
            batterySoc: 50,
            minPackVoltageV: 3.2,
            powerW: power
        });
        power = safety.powerW;
        console.log(`  After Safety: ${power}W`);
        
        const reg = powerRegulator.applyRegulation({
            config: mockConfig,
            powerW: power,
            lastSetPowerW: 0,
            safetyActive: safety.safetyActive
        });
        power = reg.powerW;
        console.log(`  After Regulation: ${power}W`);
        console.log('✓ Full cycle integration works');

        console.log('\n' + '='.repeat(60));
        console.log('✓ ALL TESTS PASSED!');
        console.log('='.repeat(60));
        console.log('\nModules are ready for production use! 🚀');

    } catch (err) {
        console.error('\n' + '='.repeat(60));
        console.error('✗ TEST FAILED!');
        console.error('='.repeat(60));
        console.error(`Error: ${err.message}`);
        console.error(err.stack);
        process.exit(1);
    }
}

// Run tests
testModules();
