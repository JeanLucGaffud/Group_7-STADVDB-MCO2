# Concurrency Control and Replication Validation Test Suite

## Overview

This validation test suite provides comprehensive testing of the distributed database system's concurrency control and replication mechanisms. It systematically validates all requirements from the course specifications.

## Test Coverage

### Test Matrix
- **3 Test Cases** × **4 Isolation Levels** = **12 Total Tests**

### Test Cases

#### Case 1: Concurrent Reads
**Purpose:** Validate that multiple nodes can read the same record concurrently without conflicts.

**What it tests:**
- Concurrent read operations from 3 nodes simultaneously
- Data consistency across all nodes
- No read locks blocking other readers
- Replication has synchronized all nodes

**Expected Behavior:**
- All reads should succeed
- All nodes should return the same value
- No data modifications should occur

#### Case 2: Write + Concurrent Reads
**Purpose:** Validate isolation level behavior when one transaction writes while others read.

**What it tests:**
- One write operation + 3 concurrent read operations
- Dirty read detection (READ_UNCOMMITTED should allow, others should prevent)
- Replication from writer node to other nodes
- Final consistency after write commits

**Expected Behavior by Isolation Level:**
- **READ_UNCOMMITTED:** May see dirty reads (uncommitted data)
- **READ_COMMITTED:** Should NOT see dirty reads
- **REPEATABLE_READ:** Should NOT see dirty reads or non-repeatable reads
- **SERIALIZABLE:** Full isolation, should NOT see any anomalies

#### Case 3: Concurrent Writes (Cross-Fragment)
**Purpose:** Validate concurrent write capability across different fragments and replication consistency.

**What it tests:**
- Two simultaneous write operations on **different records** from different fragments
- **Record A** (pre-1997): Write from node1 → replicates to node0
- **Record B** (post-1997): Write from node2 → replicates to node0
- Replication to master from both fragments concurrently
- Consistency within each fragment after writes complete

**Note on Fragmentation:**
Due to horizontal fragmentation by date (boundary: 1997-01-01), a single record cannot exist in all 3 nodes. Each record exists in exactly 2 nodes:
- Pre-1997 records: node0 (master) + node1 (fragment)
- Post-1997 records: node0 (master) + node2 (fragment)

Therefore, Case 3 tests concurrent writes on **two different records** (one per fragment) to validate cross-fragment concurrent write behavior and master node replication handling.

**Expected Behavior:**
- Both writes should succeed (no direct conflict - different records)
- Both writes replicate to master (node0) concurrently
- Each record remains consistent within its fragment
- Demonstrates system's ability to handle concurrent updates across fragments

## How to Run

### Prerequisites
1. All 3 database nodes must be online (node0, node1, node2)
2. Backend server must be running
3. Frontend application must be loaded in browser
4. **Test records must exist with proper fragmentation:**
   - **Record A** (pre-1997): Exists in node0 (master) + node1 (fragment)
   - **Record B** (post-1997): Exists in node0 (master) + node2 (fragment)
   - Example: Use trans_id=1001 (pre-1997) and trans_id=1002 (post-1997)

### Running Tests

Each test case button runs that case across all 4 isolation levels and displays simple results:

1. **Case 1: Reads** - Click to test concurrent reads (4 isolation levels)
2. **Case 2: Write+Reads** - Click to test write with concurrent reads (4 isolation levels)
3. **Case 3: Writes** - Click to test concurrent writes across fragments (4 isolation levels)

**Steps:**
1. Click one of the case buttons on the main dashboard
2. A modal opens showing the test is running
3. (Optional) Update the record ID if needed (default: 1001)
4. Results display automatically when complete

**Output includes:**
- **Simple table showing:**
  - Isolation Level
  - Consistency Percentage (0% or 100%)
  - Execution Time in seconds
  - Pass/Fail verdict
- **Summary statistics:**
  - Average consistency across all isolation levels
  - Average execution time
  - Number of tests passed

**What the results mean:**
- Test verdict (PASS/FAIL/ERROR)
- Setup information
- Execution details
- Observations and findings
- Final state verification
- Full test report

## Understanding Test Results

### Verdict Types

- **PASS** ✓ - Test completed successfully, all validations passed
- **FAIL** ✗ - Test detected violation of expected behavior
- **ERROR** ⚠ - Test encountered runtime error
- **INCONCLUSIVE** - Test could not complete due to pre-conditions

### Key Observations to Look For

#### Case 1: Concurrent Reads
- ✓ "All concurrent reads returned consistent values"
- ✓ "No isolation violations detected"
- ✓ "Record found in nodes: node0, nodeX" (shows fragmentation)
- ✗ "Inconsistent values read" (indicates replication issue)

#### Case 2: Write + Concurrent Reads
- ✓ "Write committed successfully"
- ✓ "No dirty reads (correct for READ_COMMITTED+)"
- ✓ "Dirty reads detected (expected for READ_UNCOMMITTED)"
- ✓ "Final value correct after replication"
- ✗ "Dirty reads detected (unexpected for X)" (isolation violation)

#### Case 3: Concurrent Writes (Cross-Fragment)
- ✓ "Both writes committed successfully on different fragments"
- ✓ "Demonstrates concurrent write capability across fragments"
- ✓ "Record A consistent in fragment (node0, node1)"
- ✓ "Record B consistent in fragment (node0, node2)"
- ✗ "Record X not consistent across its nodes" (replication failure)

### Replication Verification

Each test validates:
1. **Initial state:** All nodes consistent before test
2. **Execution:** Operations complete successfully
3. **Replication:** Changes propagate to target nodes
4. **Final state:** All nodes converge to same value

## Technical Report Documentation

### Recommended Structure

#### 1. Test Setup
- Database topology (3-node setup)
- Fragmentation strategy (date boundary: 1997-01-01)
- Replication mechanism (eager/synchronous)
- Update strategy (UPDATE ANYWHERE)

#### 2. Methodology
```
For each isolation level (4 total):
  For each test case (3 total):
    1. Record initial state across all nodes
    2. Execute concurrent operations
    3. Capture intermediate states
    4. Wait for replication to complete
    5. Verify final consistency
    6. Record observations and verdict
```

#### 3. Test Results Table

| Test ID | Isolation Level | Case | Verdict | Observations |
|---------|----------------|------|---------|--------------|
| CASE1_READ_UNCOMMITTED_xxx | READ_UNCOMMITTED | Concurrent Reads | PASS | All reads consistent |
| CASE2_READ_UNCOMMITTED_xxx | READ_UNCOMMITTED | Write+Reads | PASS | Dirty reads detected (expected) |
| ... | ... | ... | ... | ... |

#### 4. Analysis by Isolation Level

**READ_UNCOMMITTED:**
- Highest throughput (no read locks)
- Allows dirty reads
- Not suitable for consistency-critical operations

**READ_COMMITTED:**
- Balanced throughput and consistency
- Prevents dirty reads
- Good default for most applications

**REPEATABLE_READ:**
- Stronger consistency guarantees
- Prevents non-repeatable reads
- Moderate performance impact

**SERIALIZABLE:**
- Strongest consistency
- Full isolation between transactions
- Lowest throughput due to strict serialization

#### 5. Recommendations

Based on test results, document:
- Which isolation level provides best balance for your use case
- Trade-offs between consistency and performance
- Specific scenarios where each level is appropriate

## Validation Checklist

Use this checklist when reviewing test results for technical report:

- [ ] All 12 tests executed successfully
- [ ] Pass rate documented (should be >80%)
- [ ] Isolation-specific behaviors confirmed:
  - [ ] READ_UNCOMMITTED allows dirty reads
  - [ ] READ_COMMITTED prevents dirty reads
  - [ ] REPEATABLE_READ prevents non-repeatable reads
  - [ ] SERIALIZABLE provides full isolation
- [ ] Replication verified:
  - [ ] Central node → Fragment nodes
  - [ ] Fragment nodes → Central node
- [ ] Concurrency control validated:
  - [ ] Read-read: No conflicts
  - [ ] Write-read: Proper isolation
  - [ ] Write-write: Conflict resolution
- [ ] Final consistency achieved in all tests
- [ ] Performance trade-offs documented

## Troubleshooting

### Common Issues

**Issue: "Nodes not consistent before test started"**
- **Cause:** Replication lag from previous operations
- **Solution:** Wait a few seconds and re-run test

**Issue: "Write operation failed"**
- **Cause:** Node offline or connectivity issue
- **Solution:** Check node status, ensure all nodes are online

**Issue: "Lock timeout detected"**
- **Cause:** Expected behavior for concurrent writes with strict isolation
- **Solution:** This is normal for REPEATABLE_READ/SERIALIZABLE

**Issue: Test takes too long**
- **Cause:** Network latency or high system load
- **Solution:** Run tests during low-traffic periods

### Debug Tips

1. **Check browser console** for detailed execution logs
2. **Monitor backend logs** for replication and lock activity
3. **Verify node status** before running tests
4. **Use single tests** to isolate specific issues
5. **Check transaction logs** for detailed operation history

## Test Data Requirements

### Recommended Test Records

**IMPORTANT:** Due to horizontal fragmentation by date, records are distributed as follows:
- **Pre-1997 records** (newdate < '1997-01-01'): Exist in node0 + node1
- **Post-1997 records** (newdate >= '1997-01-01'): Exist in node0 + node2

Use records that:
- Span both date ranges (one pre-1997, one post-1997)
- Have reasonable initial values (e.g., 1000-5000)
- Are not actively being modified by other processes

**Example test records:**
```sql
-- Record A: Before 1997 (will be in node0 and node1)
INSERT INTO trans (trans_id, amount, newdate) 
VALUES (1001, 5000, '1996-06-15');

-- Record B: After 1997 (will be in node0 and node2)
INSERT INTO trans (trans_id, amount, newdate) 
VALUES (1002, 3000, '1998-03-20');
```

**For validation tests:**
- Use **1001** as the base record ID (pre-1997)
- The test suite will automatically use **1002** for Case 3 (post-1997)
- This ensures proper testing across both fragments

## Integration with Technical Report

### Screenshots to Include

1. Full suite summary showing pass rate
2. Individual test results for each isolation level
3. Example of PASS verdict with observations
4. Example of isolation-specific behavior (e.g., dirty reads)
5. Replication verification section

### Data to Extract

The test suite generates JSON reports that can be processed for:
- Performance metrics (execution times)
- Success rates by isolation level
- Anomaly detection statistics
- Replication latency measurements

### Literature References

When discussing results, cite:
- ANSI SQL isolation level specifications
- Database replication strategies (Özsu & Valduriez)
- Concurrency control mechanisms (Gray & Reuter)
- CAP theorem implications (Brewer)

## Source Code Reference

**Implementation files:**
- `frontend/src/validation-tests.js` - Test suite implementation
- `frontend/index.html` - UI integration
- `backend/server.js` - Lock manager and replication logic

**Key functions:**
- `validateCase1ConcurrentReads()` - Case 1 validation
- `validateCase2WriteWithReads()` - Case 2 validation
- `validateCase3ConcurrentWrites()` - Case 3 validation
- `runComprehensiveValidation()` - Full suite runner
- `verifyConsistency()` - Cross-node consistency checker
