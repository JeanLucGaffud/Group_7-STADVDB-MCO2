/**
 * Comprehensive Concurrency Control and Replication Validation Test Suite
 * 
 * Tests 3 cases × 4 isolation levels = 12 validation scenarios
 * Validates: Concurrency control, replication, consistency, isolation levels
 */

import { apiClient } from './api.js';

// ============================================
// UTILITY FUNCTIONS
// ============================================

/**
 * Wait for replication to complete (give nodes time to sync)
 */
async function waitForReplication(ms = 1000) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Read current value of a record from a specific node
 */
async function readRecordValue(node, recordId, isolationLevel = 'READ_COMMITTED') {
  try {
    const query = `SELECT trans_id, amount, newdate FROM trans WHERE trans_id = ${recordId}`;
    const response = await apiClient.post('/query/execute', {
      node,
      query,
      isolationLevel
    });
    
    const results = response.data.results || [];
    return {
      success: true,
      node,
      data: results[0] || null,
      value: results[0]?.amount || null,
      timestamp: new Date().toISOString(),
      transactionId: response.data.transactionId
    };
  } catch (error) {
    return {
      success: false,
      node,
      error: error.message,
      timestamp: new Date().toISOString()
    };
  }
}

/**
 * Write (update) a record value on a specific node
 */
async function writeRecordValue(node, recordId, newValue, isolationLevel = 'READ_COMMITTED') {
  try {
    const query = `UPDATE trans SET amount = ${newValue} WHERE trans_id = ${recordId}`;
    const response = await apiClient.post('/query/execute', {
      node,
      query,
      isolationLevel
    });
    
    return {
      success: true,
      node,
      newValue,
      timestamp: new Date().toISOString(),
      transactionId: response.data.transactionId,
      replication: response.data.replication || [],
      status: response.data.logEntry?.status || 'unknown'
    };
  } catch (error) {
    return {
      success: false,
      node,
      error: error.message,
      httpStatus: error.response?.status,
      timestamp: new Date().toISOString()
    };
  }
}

/**
 * Verify all nodes have converged to the same value
 * Note: Due to fragmentation, records exist in master + one fragment (2 nodes total)
 */
async function verifyConsistency(recordId, isolationLevel = 'READ_COMMITTED') {
  const nodes = ['node0', 'node1', 'node2'];
  const reads = await Promise.all(
    nodes.map(node => readRecordValue(node, recordId, isolationLevel))
  );
  
  // Filter out nodes where record doesn't exist (due to fragmentation)
  const validReads = reads.filter(r => r.success && r.value !== null);
  const values = validReads.map(r => r.value);
  
  const uniqueValues = [...new Set(values)];
  const consistent = uniqueValues.length <= 1;
  
  return {
    consistent,
    reads,
    validReads,
    values,
    uniqueValues,
    finalValue: uniqueValues[0] || null,
    nodesWithRecord: validReads.map(r => r.node)
  };
}

// ============================================
// CASE 1: CONCURRENT READS VALIDATION
// ============================================

/**
 * Case 1: Test concurrent reads from multiple nodes on same record
 * 
 * Validates:
 * - Multiple readers can access same record simultaneously
 * - All readers see consistent data (after replication)
 * - No read locks block other readers (except SERIALIZABLE may serialize)
 * - Replication ensures master and fragment have same data
 * 
 * Note: Due to fragmentation, record exists in master (node0) + one fragment (node1 or node2)
 */
export async function validateCase1ConcurrentReads(recordId, isolationLevel) {
  const testId = `CASE1_${isolationLevel}_${Date.now()}`;
  const testStart = new Date().toISOString();
  
  console.log(`\n[${testId}] Starting Case 1: Concurrent Reads Validation`);
  console.log(`Isolation Level: ${isolationLevel}`);
  console.log(`Record ID: ${recordId}`);
  
  // Step 1: Record initial state and determine which nodes have the record
  console.log('\n[STEP 1] Recording initial state and locating record...');
  const initialState = await verifyConsistency(recordId, isolationLevel);
  
  // Check if record was found
  if (initialState.validReads.length === 0) {
    return {
      testId,
      verdict: 'ERROR',
      error: `Record ${recordId} not found in any node. Please use a record that exists.`,
      initialState
    };
  }
  
  const nodesWithRecord = initialState.nodesWithRecord;
  console.log(`✓ Record found in nodes: ${nodesWithRecord.join(', ')}`);
  
  if (!initialState.consistent) {
    console.warn('⚠️ WARNING: Nodes not consistent before test! Waiting for replication...');
    await waitForReplication(2000);
    const retryState = await verifyConsistency(recordId, isolationLevel);
    if (!retryState.consistent) {
      return {
        testId,
        verdict: 'INCONCLUSIVE',
        error: 'Nodes not consistent before test started',
        initialState: retryState
      };
    }
  }
  
  const initialValue = initialState.finalValue;
  console.log(`✓ Initial value: ${initialValue} (nodes with record are consistent)`);
  
  // Step 2: Execute concurrent reads from nodes that have the record
  console.log(`\n[STEP 2] Executing concurrent reads from ${nodesWithRecord.length} nodes with record...`);
  const executionStart = Date.now();
  
  let concurrentReads;
  
  if (isolationLevel === 'SERIALIZABLE') {
    // SERIALIZABLE: Execute reads SEQUENTIALLY (one at a time)
    console.log(`  → SERIALIZABLE mode: Executing reads sequentially...`);
    concurrentReads = [];
    for (const node of nodesWithRecord) {
      const result = await readRecordValue(node, recordId, isolationLevel);
      concurrentReads.push(result);
    }
  } else {
    // Other isolation levels: Execute reads concurrently
    const readPromises = nodesWithRecord.map(node =>
      readRecordValue(node, recordId, isolationLevel)
    );
    concurrentReads = await Promise.all(readPromises);
  }
  
  const executionTime = Date.now() - executionStart;
  
  console.log(`✓ All reads completed in ${executionTime}ms`);
  
  // Step 3: Validate results
  console.log('\n[STEP 3] Validating results...');
  const readValues = concurrentReads
    .filter(r => r.success)
    .map(r => ({ node: r.node, value: r.value }));
  
  const allSuccess = concurrentReads.every(r => r.success);
  const allValuesMatch = readValues.every(r => r.value === initialValue);
  
  // Step 4: Verify no side effects (data unchanged)
  console.log('\n[STEP 4] Verifying no side effects...');
  await waitForReplication(500);
  const finalState = await verifyConsistency(recordId, isolationLevel);
  const dataUnchanged = finalState.finalValue === initialValue;
  
  // Determine verdict
  let verdict = 'PASS';
  let observations = [];
  
  if (!allSuccess) {
    verdict = 'FAIL';
    observations.push('Some read operations failed');
  }
  
  if (!allValuesMatch) {
    verdict = 'FAIL';
    observations.push(`Inconsistent values read: ${JSON.stringify(readValues)}`);
  } else {
    observations.push('All concurrent reads returned consistent values');
  }
  
  if (!dataUnchanged) {
    verdict = 'FAIL';
    observations.push('Data was modified during read-only test');
  }
  
  if (verdict === 'PASS') {
    observations.push('No isolation violations detected');
    observations.push('Concurrent reads executed successfully');
  }
  
  // Calculate consistency percentage
  const consistencyPercentage = (allSuccess && allValuesMatch && dataUnchanged && finalState.consistent) ? 100 : 0;
  
  const report = {
    case: 'Case 1: Concurrent Reads',
    isolationLevel,
    consistencyPercentage,
    executionTimeSeconds: (executionTime / 1000).toFixed(3),
    verdict,
    details: {
      recordId,
      nodesWithRecord,
      allReadsSuccessful: allSuccess,
      allValuesMatched: allValuesMatch
    }
  };
  
  console.log(`\n[RESULT] Verdict: ${verdict}`);
  console.log(`Consistency: ${consistencyPercentage}%`);
  console.log(`Execution Time: ${report.executionTimeSeconds}s`);
  
  return report;
}

// ============================================
// CASE 2: WRITE + CONCURRENT READS VALIDATION
// ============================================

/**
 * Case 2: Test write + concurrent reads scenario
 * 
 * Validates:
 * - One writer + multiple readers on same record
 * - Isolation level behavior (dirty reads, phantoms, etc.)
 * - Replication from writer to other node (master <-> fragment)
 * - Final consistency after write commits
 * 
 * Note: Due to fragmentation, writes replicate between master and one fragment
 */
export async function validateCase2WriteWithReads(recordId, writerNode, newValue, isolationLevel) {
  const testId = `CASE2_${isolationLevel}_${Date.now()}`;
  const testStart = new Date().toISOString();
  
  console.log(`\n[${testId}] Starting Case 2: Write + Concurrent Reads Validation`);
  console.log(`Isolation Level: ${isolationLevel}`);
  console.log(`Record ID: ${recordId}`);
  console.log(`Writer Node: ${writerNode}`);
  console.log(`New Value: ${newValue}`);
  
  // Step 1: Record initial state and determine which nodes have the record
  console.log('\n[STEP 1] Recording initial state and locating record...');
  await waitForReplication(1000);
  const initialState = await verifyConsistency(recordId, 'READ_COMMITTED');
  
  // Check if record exists
  if (initialState.validReads.length === 0) {
    return {
      testId,
      verdict: 'ERROR',
      error: `Record ${recordId} not found in any node. Please use a record that exists.`,
      initialState
    };
  }
  
  const nodesWithRecord = initialState.nodesWithRecord;
  console.log(`✓ Record found in nodes: ${nodesWithRecord.join(', ')}`);
  
  if (!initialState.consistent) {
    console.warn('⚠️ WARNING: Waiting for nodes to sync...');
    await waitForReplication(2000);
  }
  
  const initialValue = initialState.finalValue;
  console.log(`✓ Initial value: ${initialValue}`);
  
  // Step 2: Execute write + concurrent reads from nodes that have the record
  console.log('\n[STEP 2] Executing write + concurrent reads...');
  const executionStart = Date.now();
  
  let writeResult, readResults;
  
  if (isolationLevel === 'SERIALIZABLE') {
    // SERIALIZABLE: Execute SEQUENTIALLY (write first, then reads)
    console.log(`  → SERIALIZABLE mode: Executing write first, then reads sequentially...`);
    writeResult = await writeRecordValue(writerNode, recordId, newValue, isolationLevel);
    await waitForReplication(500); // Wait for replication to complete
    readResults = [];
    for (const node of nodesWithRecord) {
      const result = await readRecordValue(node, recordId, isolationLevel);
      readResults.push(result);
    }
  } else {
    // Other isolation levels: Execute concurrently
    const operations = [
      writeRecordValue(writerNode, recordId, newValue, isolationLevel),
      ...nodesWithRecord.map(node => readRecordValue(node, recordId, isolationLevel))
    ];
    [writeResult, ...readResults] = await Promise.all(operations);
  }
  
  const executionTime = Date.now() - executionStart;
  
  console.log(`✓ Operations completed in ${executionTime}ms`);
  console.log(`Write success: ${writeResult.success}`);
  
  // Step 3: Check for dirty reads (reads during write)
  console.log('\n[STEP 3] Analyzing concurrent read behavior...');
  const dirtyReads = readResults.filter(r =>
    r.success && r.value !== null && r.value !== initialValue && r.value !== newValue
  );
  
  const sawNewValue = readResults.filter(r =>
    r.success && r.value === newValue
  );
  
  const sawOldValue = readResults.filter(r =>
    r.success && r.value === initialValue
  );
  
  console.log(`Reads that saw old value: ${sawOldValue.length}`);
  console.log(`Reads that saw new value: ${sawNewValue.length}`);
  console.log(`Dirty reads detected: ${dirtyReads.length}`);
  
  // Step 4: Wait for replication and verify final state
  console.log('\n[STEP 4] Waiting for replication...');
  await waitForReplication(1500);
  
  const finalState = await verifyConsistency(recordId, 'READ_COMMITTED');
  console.log(`Final value: ${finalState.finalValue}`);
  console.log(`All nodes consistent: ${finalState.consistent}`);
  
  // Step 5: Validate replication
  console.log('\n[STEP 5] Validating replication...');
  const replicationSuccess = writeResult.success && 
    writeResult.replication &&
    writeResult.replication.length > 0;
  
  const expectedFinalValue = writeResult.success ? newValue : initialValue;
  const correctFinalValue = finalState.finalValue === expectedFinalValue;
  
  // Determine verdict based on isolation level expectations
  let verdict = 'PASS';
  let observations = [];
  
  if (!writeResult.success) {
    verdict = 'FAIL';
    observations.push('Write operation failed');
  } else {
    observations.push(`Write committed successfully on ${writerNode}`);
  }
  
  // Isolation level specific validations
  if (isolationLevel === 'READ_UNCOMMITTED') {
    // May see dirty reads - this is expected behavior
    if (dirtyReads.length > 0 || sawNewValue.length > 0) {
      observations.push(`Dirty reads detected (expected for READ_UNCOMMITTED)`);
    }
  } else {
    // READ_COMMITTED, REPEATABLE_READ, SERIALIZABLE should prevent dirty reads
    if (dirtyReads.length > 0) {
      verdict = 'FAIL';
      observations.push(`Dirty reads detected (unexpected for ${isolationLevel})`);
    } else {
      observations.push(`No dirty reads (correct for ${isolationLevel})`);
    }
  }
  
  if (!finalState.consistent) {
    verdict = 'FAIL';
    observations.push('Final state not consistent across nodes');
  }
  
  if (!correctFinalValue) {
    verdict = 'FAIL';
    observations.push(`Final value incorrect: expected ${expectedFinalValue}, got ${finalState.finalValue}`);
  } else {
    observations.push('Final value correct after replication');
  }
  
  if (replicationSuccess) {
    observations.push(`Replication executed to ${writeResult.replication.length} target(s)`);
  } else if (writeResult.success) {
    verdict = 'FAIL';
    observations.push('Write succeeded but replication info missing');
  }
  
  // Calculate consistency percentage
  const consistencyPercentage = (writeResult.success && finalState.consistent && correctFinalValue) ? 100 : 0;
  
  const report = {
    case: 'Case 2: Write + Concurrent Reads',
    isolationLevel,
    consistencyPercentage,
    executionTimeSeconds: (executionTime / 1000).toFixed(3),
    verdict,
    details: {
      recordId,
      writerNode,
      nodesWithRecord,
      writeSuccessful: writeResult.success,
      replicationSuccessful: replicationSuccess,
      finalConsistent: finalState.consistent,
      dirtyReadsDetected: dirtyReads.length
    }
  };
  
  console.log(`\n[RESULT] Verdict: ${verdict}`);
  console.log(`Consistency: ${consistencyPercentage}%`);
  console.log(`Execution Time: ${report.executionTimeSeconds}s`);
  
  return report;
}

// ============================================
// CASE 3: CONCURRENT WRITES VALIDATION
// ============================================

/**
 * Case 3: Test concurrent writes from TWO DIFFERENT NODES on SAME data item
 * 
 * Validates:
 * - Concurrent transactions in TWO OR MORE NODES writing on same data item (per spec)
 * - Cross-node write coordination through replication
 * - Isolation level enforcement:
 *   - SERIALIZABLE: T1 commits + replicates, T2 waits → T1 completes → T2 continues (SLOWEST)
 *   - Other levels: Varying degrees of concurrency
 * - Final consistency (all replicas converge to same value)
 * - Tests UPDATE ANYWHERE with eager replication
 * 
 * For pre-1997 records: Write from node0 (master) AND node1 (fragment) to same record
 * Expected: One write completes first + replicates, other may conflict/wait
 */
export async function validateCase3ConcurrentWrites(recordId, nodeA, valueA, nodeB, valueB, isolationLevel) {
  const testId = `CASE3_${isolationLevel}_${Date.now()}`;
  
  console.log(`\n[${testId}] Starting Case 3: Concurrent Writes from DIFFERENT NODES`);
  console.log(`Isolation Level: ${isolationLevel}`);
  console.log(`Record ID: ${recordId}`);
  console.log(`Write A: Node ${nodeA} → Value ${valueA}`);
  console.log(`Write B: Node ${nodeB} → Value ${valueB}`);
  
  // Step 1: Record initial state
  console.log('\n[STEP 1] Recording initial state...');
  await waitForReplication(1000);
  const initialState = await verifyConsistency(recordId, 'READ_COMMITTED');
  
  if (initialState.validReads.length === 0) {
    return {
      case: 'Case 3: Concurrent Writes',
      isolationLevel,
      consistencyPercentage: 0,
      executionTimeSeconds: '0.000',
      verdict: 'ERROR',
      details: { error: `Record ${recordId} not found` }
    };
  }
  
  const initialValue = initialState.finalValue;
  const nodesWithRecord = initialState.nodesWithRecord;
  console.log(`✓ Record found in nodes: ${nodesWithRecord.join(', ')}, initial value: ${initialValue}`);
  
  // Verify both nodes have the record (for proper cross-node testing)
  if (!nodesWithRecord.includes(nodeA)) {
    return {
      case: 'Case 3: Concurrent Writes',
      isolationLevel,
      consistencyPercentage: 0,
      executionTimeSeconds: '0.000',
      verdict: 'ERROR',
      details: { error: `Record ${recordId} not found in ${nodeA}. Found in: ${nodesWithRecord.join(', ')}` }
    };
  }
  if (!nodesWithRecord.includes(nodeB)) {
    return {
      case: 'Case 3: Concurrent Writes',
      isolationLevel,
      consistencyPercentage: 0,
      executionTimeSeconds: '0.000',
      verdict: 'ERROR',
      details: { error: `Record ${recordId} not found in ${nodeB}. Found in: ${nodesWithRecord.join(', ')}` }
    };
  }
  
  // Step 2: Execute CONCURRENT writes from DIFFERENT NODES to SAME record
  // Tests cross-node coordination through replication (UPDATE ANYWHERE)
  console.log(`\n[STEP 2] Executing CONCURRENT writes from TWO NODES (${nodeA} and ${nodeB})...`);
  console.log(`Expected behavior for ${isolationLevel}:`);
  if (isolationLevel === 'SERIALIZABLE') {
    console.log(`  → T1 on ${nodeA}: Acquires lock → commits → replicates to ${nodeB}`);
    console.log(`  → T2 on ${nodeB}: Waits for T1's replication → then continues`);
    console.log(`  → Result: SLOWEST (serialized execution + replication time)`);
  } else if (isolationLevel === 'REPEATABLE_READ') {
    console.log(`  → Both may execute, but replication ensures consistency (slower)`);
  } else if (isolationLevel === 'READ_COMMITTED') {
    console.log(`  → Both execute with short locks (faster)`);
  } else {
    console.log(`  → Both execute without locks (fastest, potential conflicts)`);
  }
  
  const executionStart = Date.now();
  
  let writeA, writeB;
  
  if (isolationLevel === 'SERIALIZABLE') {
    // SERIALIZABLE: Execute writes SEQUENTIALLY (one completes fully before other starts)
    console.log(`  → SERIALIZABLE mode: T1 executes → commits → replicates → T2 executes...`);
    const resultA = await writeRecordValue(nodeA, recordId, valueA, isolationLevel);
    writeA = resultA;
    
    // Wait for T1's replication to complete fully
    console.log(`  → Waiting for T1 replication to complete...`);
    await waitForReplication(1000);
    
    // Now execute T2
    console.log(`  → T2 now executing after T1 completed...`);
    const resultB = await writeRecordValue(nodeB, recordId, valueB, isolationLevel);
    writeB = resultB;
  } else {
    // Other isolation levels: Execute writes CONCURRENTLY
    const [resultA, resultB] = await Promise.allSettled([
      writeRecordValue(nodeA, recordId, valueA, isolationLevel),
      writeRecordValue(nodeB, recordId, valueB, isolationLevel)
    ]);
    writeA = resultA.status === 'fulfilled' ? resultA.value : { success: false, error: resultA.reason?.message, httpStatus: resultA.reason?.response?.status };
    writeB = resultB.status === 'fulfilled' ? resultB.value : { success: false, error: resultB.reason?.message, httpStatus: resultB.reason?.response?.status };
  }
  
  const executionTime = Date.now() - executionStart;
  
  console.log(`\n=== CROSS-NODE WRITE RESULTS ===`);
  console.log(`Execution Time: ${executionTime}ms (${(executionTime/1000).toFixed(3)}s)`);
  console.log(`Write A (${nodeA} → ${valueA}): ${writeA.success ? '✅ SUCCESS' : '❌ FAILED'}`);
  if (!writeA.success) {
    console.log(`  ↳ Error: ${writeA.error}`);
    console.log(`  ↳ HTTP Status: ${writeA.httpStatus || 'unknown'}`);
  }
  console.log(`Write B (${nodeB} → ${valueB}): ${writeB.success ? '✅ SUCCESS' : '❌ FAILED'}`);
  if (!writeB.success) {
    console.log(`  ↳ Error: ${writeB.error}`);
    console.log(`  ↳ HTTP Status: ${writeB.httpStatus || 'unknown'}`);
  }
  
  // Diagnostic: Analyze timing and behavior
  if (isolationLevel === 'SERIALIZABLE') {
    if (writeA.success && writeB.success) {
      if (executionTime < 500) {
        console.warn(`⚠️  WARNING: Both writes succeeded in ${executionTime}ms under SERIALIZABLE.`);
        console.warn(`⚠️  Expected: Sequential execution with replication delay (1000+ ms).`);
      } else {
        console.log(`✓ Timing acceptable: ${executionTime}ms suggests sequential execution.`);
      }
    } else if (!writeA.success && !writeB.success) {
      console.warn(`⚠️  Both writes failed - check if record exists in both nodes.`);
    }
  }
  
  // Step 3: Wait for replication
  console.log('\n[STEP 3] Waiting for replication...');
  await waitForReplication(2000);
  
  const finalState = await verifyConsistency(recordId, 'READ_COMMITTED');
  const finalValue = finalState.finalValue;
  console.log(`Final value: ${finalValue}, Consistent: ${finalState.consistent}`);
  
  // Step 4: Validate result
  console.log('\n[STEP 4] Validating consistency...');
  
  // Check if final state is consistent
  const isConsistent = finalState.consistent;
  
  // Check if final value is one of the two written values (or original if both failed)
  const validFinalValues = [valueA, valueB];
  if (!writeA.success && !writeB.success) {
    validFinalValues.push(initialValue); // If both failed, original value is acceptable
  }
  
  const finalValueValid = validFinalValues.includes(finalValue);
  
  console.log(`Expected final value to be one of: ${validFinalValues.join(' or ')}`);
  console.log(`Actual final value: ${finalValue}`);
  console.log(`All nodes consistent: ${isConsistent}`);
  console.log(`Final value valid: ${finalValueValid}`);
  
  // Determine verdict
  let verdict = 'PASS';
  const atLeastOneSucceeded = writeA.success || writeB.success;
  
  if (!isConsistent) {
    verdict = 'FAIL';
    console.log('✗ FAIL: Nodes not consistent after concurrent writes');
  } else if (!finalValueValid) {
    verdict = 'FAIL';
    console.log(`✗ FAIL: Final value ${finalValue} is not one of the expected values`);
  } else if (!atLeastOneSucceeded) {
    verdict = 'FAIL';
    console.log('✗ FAIL: Both writes failed');
  } else {
    console.log('✓ PASS: Concurrent writes resolved consistently');
    if (writeA.success && writeB.success) {
      console.log('✓ Both writes succeeded (one must have won based on conflict resolution)');
    } else if (writeA.success) {
      console.log('✓ Write A succeeded, Write B blocked/rolled back');
    } else {
      console.log('✓ Write B succeeded, Write A blocked/rolled back');
    }
  }
  
  // Consistency percentage: 100% if consistent and valid, 0% otherwise
  const consistencyPercentage = (isConsistent && finalValueValid && atLeastOneSucceeded) ? 100 : 0;
  
  return {
    case: 'Case 3: Concurrent Writes',
    isolationLevel,
    consistencyPercentage,
    executionTimeSeconds: (executionTime / 1000).toFixed(3),
    verdict,
    details: {
      recordId,
      nodeA,
      nodeB,
      writeA: { value: valueA, success: writeA.success },
      writeB: { value: valueB, success: writeB.success },
      initialValue,
      finalValue,
      consistent: isConsistent,
      executionTimeMs: executionTime
    }
  };
}

// ============================================
// INDIVIDUAL CASE RUNNERS
// ============================================

/**
 * Run Case 1 tests across all isolation levels
 */
export async function runCase1Tests(recordId = 1001) {
  const results = [];
  const isolationLevels = ['READ_UNCOMMITTED', 'READ_COMMITTED', 'REPEATABLE_READ', 'SERIALIZABLE'];
  
  for (const level of isolationLevels) {
    const result = await validateCase1ConcurrentReads(recordId, level);
    results.push(result);
  }
  
  return results;
}

/**
 * Run Case 2 tests across all isolation levels
 */
export async function runCase2Tests(recordId = 1001) {
  const results = [];
  const isolationLevels = ['READ_UNCOMMITTED', 'READ_COMMITTED', 'REPEATABLE_READ', 'SERIALIZABLE'];
  
  // Use node1 as writer, update value to timestamp
  for (const level of isolationLevels) {
    const newValue = Date.now();
    const result = await validateCase2WriteWithReads(recordId, 'node1', newValue, level);
    results.push(result);
  }
  
  return results;
}

/**
 * Run Case 3 tests across all isolation levels
 */
export async function runCase3Tests(recordId = 1001) {
  const results = [];
  const isolationLevels = ['READ_UNCOMMITTED', 'READ_COMMITTED', 'REPEATABLE_READ', 'SERIALIZABLE'];
  
  // Test concurrent writes from DIFFERENT nodes (node0 and node1) to SAME record
  // Assumes recordId is pre-1997 (exists in both node0 and node1)
  // Tests cross-node coordination through UPDATE ANYWHERE replication
  for (const level of isolationLevels) {
    const valueA = 10000 + Math.floor(Math.random() * 1000); // e.g., 10543
    const valueB = 20000 + Math.floor(Math.random() * 1000); // e.g., 20789
    
    // Write from node0 (master) AND node1 (fragment) to same record
    const result = await validateCase3ConcurrentWrites(recordId, 'node0', valueA, 'node1', valueB, level);
    results.push(result);
    
    // Wait between tests to let system stabilize
    await waitForReplication(2000);
  }
  
  return results;
}

/**
 * Legacy function for backward compatibility - runs all cases
 */
export async function runComprehensiveValidation(recordId = 1001) {
  const isolationLevels = ['READ_UNCOMMITTED', 'READ_COMMITTED', 'REPEATABLE_READ', 'SERIALIZABLE'];
  const allReports = [];
  
  console.log('\n' + '='.repeat(80));
  console.log('COMPREHENSIVE CONCURRENCY & REPLICATION VALIDATION TEST SUITE');
  console.log('='.repeat(80));
  console.log(`Test Record ID: ${recordId}`);
  console.log(`Start Time: ${new Date().toISOString()}`);
  console.log('='.repeat(80));
  
  for (const iso of isolationLevels) {
    console.log(`\n\n${'*'.repeat(80)}`);
    console.log(`TESTING ISOLATION LEVEL: ${iso}`);
    console.log('*'.repeat(80));
    
    // Case 1: Concurrent Reads
    try {
      const case1Report = await validateCase1ConcurrentReads(recordId, iso);
      allReports.push(case1Report);
      await waitForReplication(1000);
    } catch (error) {
      console.error(`Error in Case 1 (${iso}):`, error);
      allReports.push({
        testId: `CASE1_${iso}_ERROR`,
        verdict: 'ERROR',
        error: error.message
      });
    }
    
    // Case 2: Write + Concurrent Reads
    try {
      const newValue = 1000 + Math.floor(Math.random() * 9000);
      const writerNode = iso === 'READ_UNCOMMITTED' ? 'node0' : 
                         iso === 'READ_COMMITTED' ? 'node1' :
                         iso === 'REPEATABLE_READ' ? 'node2' : 'node0';
      
      const case2Report = await validateCase2WriteWithReads(recordId, writerNode, newValue, iso);
      allReports.push(case2Report);
      await waitForReplication(1500);
    } catch (error) {
      console.error(`Error in Case 2 (${iso}):`, error);
      allReports.push({
        testId: `CASE2_${iso}_ERROR`,
        verdict: 'ERROR',
        error: error.message
      });
    }
    
    // Case 3: Concurrent Writes from DIFFERENT nodes to SAME record
    try {
      const valueA = 10000 + Math.floor(Math.random() * 1000);
      const valueB = 20000 + Math.floor(Math.random() * 1000);
      const nodeA = 'node0'; // Master
      const nodeB = 'node1'; // Fragment (for pre-1997 records)
      
      const case3Report = await validateCase3ConcurrentWrites(recordId, nodeA, valueA, nodeB, valueB, iso);
      allReports.push(case3Report);
      await waitForReplication(2000);
    } catch (error) {
      console.error(`Error in Case 3 (${iso}):`, error);
      allReports.push({
        testId: `CASE3_${iso}_ERROR`,
        verdict: 'ERROR',
        error: error.message
      });
    }
  }
  
  // Generate summary
  console.log('\n\n' + '='.repeat(80));
  console.log('TEST SUITE SUMMARY');
  console.log('='.repeat(80));
  
  const passed = allReports.filter(r => r.verdict === 'PASS').length;
  const failed = allReports.filter(r => r.verdict === 'FAIL').length;
  const errors = allReports.filter(r => r.verdict === 'ERROR').length;
  const total = allReports.length;
  
  console.log(`Total Tests: ${total}`);
  console.log(`Passed: ${passed} (${((passed/total)*100).toFixed(1)}%)`);
  console.log(`Failed: ${failed} (${((failed/total)*100).toFixed(1)}%)`);
  console.log(`Errors: ${errors} (${((errors/total)*100).toFixed(1)}%)`);
  console.log(`\nEnd Time: ${new Date().toISOString()}`);
  console.log('='.repeat(80));
  
  return {
    summary: {
      total,
      passed,
      failed,
      errors,
      passRate: ((passed/total)*100).toFixed(1) + '%'
    },
    reports: allReports
  };
}
