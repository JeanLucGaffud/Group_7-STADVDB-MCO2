/**
 * Jest Test Setup
 * Global configuration and utilities for distributed DB recovery testing
 */

// Increase timeout for database operations
jest.setTimeout(30000);

// Global test utilities
global.sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Mock environment variables for testing
process.env.NODE_ENV = 'test';
process.env.PORT = Math.floor(Math.random() * 1000) + 5500; // Use random port to avoid conflicts

// Enhanced console logging for tests
const originalLog = console.log;
console.log = (...args) => {
  if (process.env.JEST_VERBOSE || process.env.DEBUG_TESTS) {
    originalLog('[TEST]', new Date().toISOString(), ...args);
  }
};

// Global test data
global.testTransactions = [
  {
    trans_id: 99901,
    account_id: 'TEST001',
    newdate: '1996-12-15',
    amount: 1000.00,
    balance: 5000.00
  },
  {
    trans_id: 99902,
    account_id: 'TEST002', 
    newdate: '1997-06-15',
    amount: 2000.00,
    balance: 7000.00
  },
  {
    trans_id: 99903,
    account_id: 'TEST003',
    newdate: '1998-03-20',
    amount: 1500.00,
    balance: 6500.00
  }
];

// Benchmark tracking
global.benchmarkResults = {
  case1: [],
  case2: [],
  case3: [],
  case4: []
};

// Helper to record benchmark data
global.recordBenchmark = (testCase, operation, startTime, endTime, success, error = null) => {
  const duration = endTime - startTime;
  const result = {
    operation,
    duration,
    success,
    error,
    timestamp: new Date().toISOString()
  };
  
  // Initialize the test case array if it doesn't exist
  if (!global.benchmarkResults[testCase]) {
    global.benchmarkResults[testCase] = [];
  }
  
  global.benchmarkResults[testCase].push(result);
  return result;
};

// Helper to generate benchmark report
global.generateBenchmarkReport = () => {
  const report = {
    summary: {},
    details: global.benchmarkResults,
    generatedAt: new Date().toISOString()
  };

  // Calculate summary statistics
  for (const [caseKey, results] of Object.entries(global.benchmarkResults)) {
    if (results.length > 0) {
      const durations = results.map(r => r.duration);
      const successCount = results.filter(r => r.success).length;
      
      report.summary[caseKey] = {
        totalOperations: results.length,
        successfulOperations: successCount,
        failedOperations: results.length - successCount,
        successRate: (successCount / results.length * 100).toFixed(2) + '%',
        avgDuration: (durations.reduce((a, b) => a + b, 0) / durations.length).toFixed(2) + 'ms',
        minDuration: Math.min(...durations) + 'ms',
        maxDuration: Math.max(...durations) + 'ms'
      };
    }
  }

  return report;
};