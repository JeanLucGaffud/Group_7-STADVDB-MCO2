import express from 'express';
import cors from 'cors';
import mysql from 'mysql2/promise';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
//This is for testing
dotenv.config();

// Get __dirname equivalent in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// test tesing
const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors({
  origin: [
    'http://localhost:3000',
    'http://localhost:5173',
    'http://ccscloud.dlsu.edu.ph',
    'https://ccscloud.dlsu.edu.ph',
    'http://ccscloud.dlsu.edu.ph:60109',
    'http://ccscloud.dlsu.edu.ph:60110',
    'http://ccscloud.dlsu.edu.ph:60111'
  ],
  credentials: true
}));
app.use(express.json());


// Database Configuration
const dbConfig = {
  node0: {
    host: process.env.DB_HOST_NODE0 || 'ccscloud.dlsu.edu.ph',
    port: parseInt(process.env.DB_PORT_NODE0 || '60709'),
    user: process.env.DB_USER_NODE0 || 'root',
    password: process.env.DB_PASSWORD_NODE0 !== '' ? process.env.DB_PASSWORD_NODE0 : undefined,
    database: process.env.DB_NAME || 'bankdb',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    connectTimeout: 3000,
    authPlugins: {
      mysql_clear_password: () => () => process.env.DB_PASSWORD_NODE0 || ''
    }
  },
  node1: {
    host: process.env.DB_HOST_NODE1 || 'ccscloud.dlsu.edu.ph',
    port: parseInt(process.env.DB_PORT_NODE1 || '60710'),
    user: process.env.DB_USER_NODE1 || 'root',
    password: process.env.DB_PASSWORD_NODE1 !== '' ? process.env.DB_PASSWORD_NODE1 : undefined,
    database: process.env.DB_NAME || 'bankdb',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    connectTimeout: 3000,
    authPlugins: {
      mysql_clear_password: () => () => process.env.DB_PASSWORD_NODE1 || ''
    }
  },
  node2: {
    host: process.env.DB_HOST_NODE2 || 'ccscloud.dlsu.edu.ph',
    port: parseInt(process.env.DB_PORT_NODE2 || '60711'),
    user: process.env.DB_USER_NODE2 || 'root',
    password: process.env.DB_PASSWORD_NODE2 !== '' ? process.env.DB_PASSWORD_NODE2 : undefined,
    database: process.env.DB_NAME || 'bankdb',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    connectTimeout: 3000,
    authPlugins: {
      mysql_clear_password: () => () => process.env.DB_PASSWORD_NODE2 || ''
    }
  }
};

// Connection Pools
let pools = {
  node0: null,
  node1: null,
  node2: null
};

// Node Status Tracking
let nodeStatus = {
  node0: { status: 'offline', lastCheck: null },
  node1: { status: 'offline', lastCheck: null },
  node2: { status: 'offline', lastCheck: null }
};

// Simulated Node Failures (to override actual connectivity)
let simulatedFailures = {
  node0: false,
  node1: false,
  node2: false
};

// Replication Queue
let replicationQueue = [];

// Transaction Log
let transactionLog = [];

// Log file paths for persistence
const LOG_FILE = path.join(__dirname, 'transaction_log.json');
const REPLICATION_QUEUE_FILE = path.join(__dirname, 'replication_queue.json');

// Recovery lock tracking
let recoveryInProgress = {
  node0: false,
  node1: false,
  node2: false
};

// ============================================================================
// LOG PERSISTENCE - Write-Ahead Logging (WAL)
// ============================================================================

/**
 * Load persisted logs from disk on startup
 */
async function loadPersistedLogs() {
  try {
    // Load transaction log
    const logData = await fs.readFile(LOG_FILE, 'utf8');
    const logs = JSON.parse(logData);
    transactionLog.push(...logs);
    console.log(`[RECOVERY] Loaded ${logs.length} transactions from disk`);
  } catch (error) {
    console.log('[RECOVERY] No existing transaction log found (starting fresh)');
  }
  
  try {
    // Load replication queue
    const queueData = await fs.readFile(REPLICATION_QUEUE_FILE, 'utf8');
    const queue = JSON.parse(queueData);
    replicationQueue.push(...queue);
    console.log(`[RECOVERY] Loaded ${queue.length} replication entries from disk`);
  } catch (error) {
    console.log('[RECOVERY] No existing replication queue found (starting fresh)');
  }
}

/**
 * Persist logs to disk (called after each transaction)
 */
async function persistLogs() {
  try {
    // Keep only last 10000 entries to prevent file bloat
    const logsToSave = transactionLog.slice(-10000);
    const queueToSave = replicationQueue.slice(-10000);
    
    await Promise.all([
      fs.writeFile(LOG_FILE, JSON.stringify(logsToSave, null, 2)),
      fs.writeFile(REPLICATION_QUEUE_FILE, JSON.stringify(queueToSave, null, 2))
    ]);
  } catch (error) {
    console.error('[ERROR] Failed to persist logs:', error.message);
  }
}

/**
 * Write-Ahead Log: Log transaction BEFORE execution
 */
function writeAheadLog(transactionId, node, query, isolationLevel) {
  const walEntry = {
    transactionId,
    node,
    query,
    isolationLevel,
    startTime: new Date(),
    status: 'pending', // Will be updated to 'committed' or 'aborted'
    walLogged: true
  };
  
  transactionLog.push(walEntry);
  console.log(`[WAL] Transaction ${transactionId} logged BEFORE execution`);
  
  return walEntry;
}

// ============================================================================
// CUSTOM APPLICATION-LEVEL LOCK MANAGER (NOT using MySQL built-in locking)
// ============================================================================

// =============================================================================
// COMPREHENSIVE CONCURRENCY CONTROL - ISOLATION LEVELS
// =============================================================================

/**
 * Transaction State Tracking
 * Each transaction tracks:
 * - transactionId: Unique identifier
 * - node: Origin node
 * - isolationLevel: READ_UNCOMMITTED, READ_COMMITTED, REPEATABLE_READ, SERIALIZABLE
 * - startTime: When transaction started
 * - readSet: Set of trans_ids this transaction has read
 * - writeSet: Set of trans_ids this transaction has written
 * - locks: { transId: { type: 'read'|'write', acquired: timestamp } }
 * - snapshot: For REPEATABLE_READ, stores data snapshot at transaction start
 * - status: 'active' | 'committed' | 'aborted'
 */
let transactions = {};
// { "txn_uuid": { transactionId, node, isolationLevel, startTime, readSet, writeSet, locks, snapshot, status } }

/**
 * Lock Manager
 * Tracks locks on individual trans_ids
 * { "trans_123": { readers: [txn_id1, txn_id2], writer: txn_id3 or null } }
 */
let lockTable = {};

const TRANSACTION_TIMEOUT = 5000; // 5 seconds

// Helper functions
function parseTransId(query) {
  const match = /WHERE\s+trans_id\s*=\s*(\d+)/i.exec(query || '');
  return match ? parseInt(match[1], 10) : null;
}

function isWriteQuery(query) {
  const upper = String(query || '').trim().toUpperCase();
  return upper.startsWith('UPDATE') || upper.startsWith('INSERT') || upper.startsWith('DELETE');
}

/**
 * ISOLATION LEVEL SPECIFIC BEHAVIORS:
 * 
 * READ_UNCOMMITTED:
 * - NO locks acquired (not even for writes!)
 * - Can read uncommitted data (dirty reads)
 * - Highest concurrency, lowest consistency
 * 
 * READ_COMMITTED:
 * - SHORT write locks (released immediately after query)
 * - NO read locks
 * - Cannot read uncommitted data
 * - Locks prevent lost updates but allow non-repeatable reads
 * 
 * REPEATABLE_READ:
 * - LONG write locks (released at commit)
 * - READ locks for snapshot consistency
 * - Uses snapshot isolation
 * - Prevents non-repeatable reads
 * 
 * SERIALIZABLE:
 * - LONG read AND write locks (both released at commit)
 * - Strictest isolation
 * - Simulates serial execution
 */

/**
 * Acquire lock based on isolation level
 * Returns: { success: true } or { success: false, reason: string }
 */
async function acquireLock(txnId, transId, lockType, isolationLevel) {
  // READ_UNCOMMITTED: NO locks at all
  if (isolationLevel === 'READ_UNCOMMITTED') {
    console.log(`[${isolationLevel}] No lock needed for ${lockType} on trans_id=${transId}`);
    return { success: true };
  }
  
  // Initialize lock entry if doesn't exist
  if (!lockTable[transId]) {
    lockTable[transId] = { readers: [], writer: null };
  }
  
  const lock = lockTable[transId];
  const startWait = Date.now();
  
  if (lockType === 'write') {
    // WAIT for conflicts to clear
    while (true) {
      // Check for conflicts: Can't acquire write lock if there are readers or another writer
      if (lock.writer && lock.writer !== txnId) {
        console.log(`[${isolationLevel}] Write waiting for writer ${lock.writer} on trans_id=${transId}...`);
      } else if (lock.readers.length > 0 && !lock.readers.every(r => r === txnId)) {
        console.log(`[${isolationLevel}] Write waiting for ${lock.readers.length} readers on trans_id=${transId}...`);
      } else {
        // No conflicts - can acquire lock
        break;
      }
      
      // Check timeout
      if (Date.now() - startWait > TRANSACTION_TIMEOUT) {
        console.log(`[${isolationLevel}] Write lock TIMEOUT on trans_id=${transId}`);
        return { success: false, reason: `Timeout waiting for lock` };
      }
      
      // Wait a bit before retrying
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    
    // Acquire write lock
    lock.writer = txnId;
    console.log(`[${isolationLevel}] Write lock ACQUIRED on trans_id=${transId} by ${txnId}`);
    
    // Track lock in transaction
    if (!transactions[txnId].locks[transId]) {
      transactions[txnId].locks[transId] = { type: 'write', acquired: Date.now() };
    }
    
  } else if (lockType === 'read') {
    // READ_COMMITTED: Acquire short read lock (released immediately after query)
    if (isolationLevel === 'READ_COMMITTED') {
      // But WAIT for any active writer to commit (prevents dirty reads)
      while (lock.writer && lock.writer !== txnId) {
        console.log(`[${isolationLevel}] Read WAITING for writer to commit on trans_id=${transId}...`);
        
        if (Date.now() - startWait > TRANSACTION_TIMEOUT) {
          console.log(`[${isolationLevel}] Read TIMEOUT on trans_id=${transId}`);
          return { success: false, reason: `Timeout waiting for write to commit` };
        }
        
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      
      // Acquire short read lock (prevents concurrent writes during read)
      if (!lock.readers.includes(txnId)) {
        lock.readers.push(txnId);
        console.log(`[${isolationLevel}] Short read lock ACQUIRED on trans_id=${transId} by ${txnId}`);
      }
      
      // Track in transaction (will be released immediately after query)
      if (!transactions[txnId].locks[transId]) {
        transactions[txnId].locks[transId] = { type: 'read', acquired: Date.now() };
      }
      
      return { success: true };
    }
    
    // REPEATABLE_READ and SERIALIZABLE: Need read locks
    // WAIT for conflicts to clear
    while (lock.writer && lock.writer !== txnId) {
      console.log(`[${isolationLevel}] Read waiting for writer ${lock.writer} on trans_id=${transId}...`);
      
      if (Date.now() - startWait > TRANSACTION_TIMEOUT) {
        console.log(`[${isolationLevel}] Read lock TIMEOUT on trans_id=${transId}`);
        return { success: false, reason: `Timeout waiting for write lock to release` };
      }
      
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    
    // Acquire read lock
    if (!lock.readers.includes(txnId)) {
      lock.readers.push(txnId);
      console.log(`[${isolationLevel}] Read lock ACQUIRED on trans_id=${transId} by ${txnId}`);
      
      // Track lock in transaction
      if (!transactions[txnId].locks[transId]) {
        transactions[txnId].locks[transId] = { type: 'read', acquired: Date.now() };
      }
    }
  }
  
  return { success: true };
}

/**
 * Release lock based on isolation level
 */
function releaseLock(txnId, transId, isolationLevel) {
  if (!lockTable[transId]) return;
  
  const lock = lockTable[transId];
  
  // READ_UNCOMMITTED: No locks to release
  if (isolationLevel === 'READ_UNCOMMITTED') {
    return;
  }
  
  // READ_COMMITTED: Release locks immediately
  // REPEATABLE_READ, SERIALIZABLE: Release at commit (not called here)
  if (lock.writer === txnId) {
    lock.writer = null;
    console.log(`[${isolationLevel}] Write lock RELEASED on trans_id=${transId} by ${txnId}`);
  }
  
  const readerIndex = lock.readers.indexOf(txnId);
  if (readerIndex >= 0) {
    lock.readers.splice(readerIndex, 1);
    console.log(`[${isolationLevel}] Read lock RELEASED on trans_id=${transId} by ${txnId}`);
  }
  
  // Cleanup empty lock entries
  if (lock.writer === null && lock.readers.length === 0) {
    delete lockTable[transId];
  }
}

/**
 * Release all locks held by a transaction (called at commit/abort)
 */
function releaseAllLocks(txnId) {
  const txn = transactions[txnId];
  if (!txn) return;
  
  console.log(`[RELEASE ALL] Releasing all locks for ${txnId}`);
  
  for (const transId in txn.locks) {
    if (lockTable[transId]) {
      const lock = lockTable[transId];
      
      if (lock.writer === txnId) {
        lock.writer = null;
      }
      
      const readerIndex = lock.readers.indexOf(txnId);
      if (readerIndex >= 0) {
        lock.readers.splice(readerIndex, 1);
      }
      
      // Cleanup
      if (lock.writer === null && lock.readers.length === 0) {
        delete lockTable[transId];
      }
    }
  }
  
  txn.locks = {};
}

/**
 * Start a new transaction
 */
function startTransaction(txnId, node, isolationLevel) {
  transactions[txnId] = {
    transactionId: txnId,
    node,
    isolationLevel,
    startTime: Date.now(),
    readSet: new Set(),
    writeSet: new Set(),
    locks: {},
    snapshot: {}, // For REPEATABLE_READ
    status: 'active'
  };
  
  console.log(`[TXN START] ${txnId} on ${node} with ${isolationLevel}`);
}

/**
 * Commit a transaction
 */
function commitTransaction(txnId) {
  const txn = transactions[txnId];
  if (!txn) return;
  
  txn.status = 'committed';
  txn.endTime = Date.now();
  
  // Release all locks (for REPEATABLE_READ and SERIALIZABLE)
  releaseAllLocks(txnId);
  
  console.log(`[TXN COMMIT] ${txnId} (duration: ${txn.endTime - txn.startTime}ms)`);
  
  // Cleanup transaction after a delay
  setTimeout(() => {
    delete transactions[txnId];
  }, 1000);
}

/**
 * Abort a transaction
 */
function abortTransaction(txnId) {
  const txn = transactions[txnId];
  if (!txn) return;
  
  txn.status = 'aborted';
  txn.endTime = Date.now();
  
  // Release all locks
  releaseAllLocks(txnId);
  
  console.log(`[TXN ABORT] ${txnId}`);
  
  // Cleanup
  setTimeout(() => {
    delete transactions[txnId];
  }, 1000);
}

// ============================================================================
// AUTOMATIC NODE SELECTION
// ============================================================================

const FRAG_BOUNDARY_DATE = '1997-01-01';

/**
 * Extract date from INSERT query
 * Looks for patterns like: VALUES(..., '1996-05-15', ...) or INSERT ... newdate = '1996-05-15'
 */
function extractDateFromInsertQuery(query) {
  // Match date in VALUES clause - look for date-like patterns
  const valuesMatch = query.match(/VALUES\s*\([^)]*'(\d{4}-\d{2}-\d{2})'[^)]*\)/i);
  if (valuesMatch) {
    return valuesMatch[1];
  }
  
  // Match SET newdate = 'YYYY-MM-DD'
  const setMatch = query.match(/newdate\s*=\s*'(\d{4}-\d{2}-\d{2})'/i);
  if (setMatch) {
    return setMatch[1];
  }
  
  return null;
}

/**
 * Determine the primary node for a write operation based on:
 * 1. For UPDATE/DELETE: Look up the record's date from an available node
 * 2. For INSERT: Extract date from the query
 * 
 * Fragmentation rules:
 * - node1: Records with date < 1997-01-01
 * - node2: Records with date >= 1997-01-01
 * - node0: Master node (stores all data)
 */
async function determinePrimaryNode(query) {
  const upper = query.trim().toUpperCase();
  const transId = parseTransId(query);
  
  // For INSERT, extract date from query
  if (upper.startsWith('INSERT')) {
    const insertDate = extractDateFromInsertQuery(query);
    if (insertDate) {
      const targetNode = insertDate < FRAG_BOUNDARY_DATE ? 'node1' : 'node2';
      console.log(`[AUTO-NODE] INSERT detected, date=${insertDate}, target=${targetNode}`);
      return { primaryNode: targetNode, recordDate: insertDate, reason: 'date_from_insert' };
    }
    // If no date found, default to master
    console.log(`[AUTO-NODE] INSERT without parseable date, defaulting to node0`);
    return { primaryNode: 'node0', recordDate: null, reason: 'insert_no_date' };
  }
  
  // For UPDATE/DELETE, we need to look up the record's date
  if ((upper.startsWith('UPDATE') || upper.startsWith('DELETE')) && transId) {
    // Try to get the record date from any available node
    const nodesToTry = ['node0', 'node1', 'node2'];
    
    for (const node of nodesToTry) {
      if (simulatedFailures[node] || !pools[node]) continue;
      
      try {
        const conn = await pools[node].getConnection();
        const [rows] = await conn.query(
          'SELECT DATE_FORMAT(DATE(newdate), "%Y-%m-%d") as date_only FROM trans WHERE trans_id = ?', 
          [transId]
        );
        conn.release();
        
        if (rows.length > 0) {
          const recordDate = rows[0].date_only;
          const targetNode = recordDate < FRAG_BOUNDARY_DATE ? 'node1' : 'node2';
          console.log(`[AUTO-NODE] Found record in ${node}: trans_id=${transId}, date=${recordDate}, target=${targetNode}`);
          return { primaryNode: targetNode, recordDate, reason: 'date_lookup', lookupNode: node };
        }
      } catch (e) {
        console.log(`[AUTO-NODE] Could not query ${node}: ${e.message}`);
      }
    }
    
    // Record not found in any node
    console.log(`[AUTO-NODE] Record not found for trans_id=${transId}, defaulting to node0`);
    return { primaryNode: 'node0', recordDate: null, reason: 'record_not_found' };
  }
  
  // For SELECT queries, prefer master node
  console.log(`[AUTO-NODE] SELECT or unknown query type, defaulting to node0`);
  return { primaryNode: 'node0', recordDate: null, reason: 'select_or_unknown' };
}

/**
 * Get the best available node when the primary is offline
 * Fallback order:
 * - If primary is node1/node2 and offline -> try node0 (master has all data)
 * - If node0 is offline -> try the appropriate fragment node
 */
function getAvailableNode(primaryNode, recordDate) {
  if (!simulatedFailures[primaryNode]) {
    return { node: primaryNode, isFallback: false };
  }
  
  console.log(`[AUTO-NODE] Primary node ${primaryNode} is offline, finding fallback...`);
  
  // If a fragment is down, fall back to master
  if (primaryNode === 'node1' || primaryNode === 'node2') {
    if (!simulatedFailures['node0']) {
      console.log(`[AUTO-NODE] Falling back to node0 (master)`);
      return { node: 'node0', isFallback: true, fallbackReason: `${primaryNode} offline` };
    }
  }
  
  // If master is down, try to use the appropriate fragment
  if (primaryNode === 'node0' && recordDate) {
    const fragmentNode = recordDate < FRAG_BOUNDARY_DATE ? 'node1' : 'node2';
    if (!simulatedFailures[fragmentNode]) {
      console.log(`[AUTO-NODE] Falling back to ${fragmentNode} (fragment)`);
      return { node: fragmentNode, isFallback: true, fallbackReason: 'node0 offline' };
    }
  }
  
  // Try any available node
  for (const node of ['node0', 'node1', 'node2']) {
    if (!simulatedFailures[node] && pools[node]) {
      console.log(`[AUTO-NODE] Last resort fallback to ${node}`);
      return { node, isFallback: true, fallbackReason: 'all_preferred_offline' };
    }
  }
  
  return { node: null, isFallback: false, error: 'All nodes offline' };
}

// ============================================================================
// TWO-PHASE COMMIT (2PC) PROTOCOL
// ============================================================================

/**
 * Two-Phase Commit: Ensures atomic replication across nodes
 * Phase 1: PREPARE - All nodes validate and prepare the transaction
 * Phase 2: COMMIT or ABORT - All nodes commit or all rollback
 */
async function twoPhaseCommit(sourceNode, query, targets) {
  console.log(`[2PC] Starting for query from ${sourceNode} to [${targets.join(', ')}]`);
  
  const connections = [];
  const prepareResults = [];
  
  // PHASE 1: PREPARE on all target nodes
  console.log(`[2PC] PHASE 1: PREPARE`);
  
  for (const target of targets) {
    try {
      console.log(`[2PC] Checking target: ${target}, simulatedFailure: ${simulatedFailures[target]}, poolExists: ${!!pools[target]}`);
      
      if (simulatedFailures[target]) {
        prepareResults.push({ target, prepared: false, reason: 'Node offline (simulated failure)' });
        console.log(`[2PC] ${target} SKIPPED (offline)`);
        continue;
      }
      
      if (!pools[target]) {
        prepareResults.push({ target, prepared: false, reason: 'Pool not initialized' });
        console.error(`[2PC] ${target} PREPARE FAILED: Pool not initialized`);
        continue;
      }
      
      const conn = await pools[target].getConnection();
      connections.push({ target, conn });
      
      // Start transaction and validate query
      await conn.query('START TRANSACTION');
      await conn.query(query);
      
      prepareResults.push({ target, prepared: true });
      console.log(`[2PC] ${target} PREPARED`);
    } catch (error) {
      prepareResults.push({ target, prepared: false, reason: error.message });
      console.log(`[2PC] ${target} PREPARE FAILED: ${error.message}`);
    }
  }
  
  // Check if all nodes prepared successfully
  const allPrepared = prepareResults.every(r => r.prepared);
  
  // PHASE 2: COMMIT or ABORT
  console.log(`[2PC] PHASE 2: ${allPrepared ? 'COMMIT' : 'ABORT'}`);
  
  if (allPrepared) {
    // All prepared - commit on all nodes
    for (const { target, conn } of connections) {
      try {
        await conn.query('COMMIT');
        console.log(`[2PC] ${target} COMMITTED`);
      } catch (error) {
        console.error(`[2PC] ${target} COMMIT FAILED: ${error.message}`);
      } finally {
        conn.release();
      }
    }
    
    return { success: true, phase: 'committed', results: prepareResults };
  } else {
    // Some nodes failed - abort on all nodes
    for (const { target, conn } of connections) {
      try {
        await conn.query('ROLLBACK');
        console.log(`[2PC] ${target} ROLLED BACK`);
      } catch (error) {
        console.error(`[2PC] ${target} ROLLBACK FAILED: ${error.message}`);
      } finally {
        conn.release();
      }
    }
    
    return { 
      success: false, 
      phase: 'aborted',
      reason: 'One or more nodes failed to prepare',
      results: prepareResults 
    };
  }
}

/**
 * Replication using Two-Phase Commit
 */
async function replicateWrite(sourceNode, query) {
  const upper = query.trim().toUpperCase();
  if (!upper.startsWith('UPDATE') && !upper.startsWith('INSERT') && !upper.startsWith('DELETE')) {
    return [];
  }

  const FRAG_BOUNDARY = new Date('1997-01-01T00:00:00Z');
  const transId = parseTransId(query);
  let recordDate = null;

  // Get record date to determine target node
  if (transId) {
    try {
      const conn = await pools[sourceNode].getConnection();
      // Get date as formatted string to avoid timezone conversion issues
      const [rows] = await conn.query('SELECT DATE_FORMAT(DATE(newdate), "%Y-%m-%d") as date_only FROM trans WHERE trans_id = ?', [transId]);
      conn.release();
      if (rows.length) {
        recordDate = rows[0].date_only; // This will be a string like '1997-01-01'
        console.log(`[REPLICATION] Fetched from ${sourceNode}: trans_id=${transId}, date_only=${recordDate}, type=${typeof recordDate}`);
      } else {
        console.log(`[REPLICATION] No record found in ${sourceNode} for trans_id=${transId}`);
      }
    } catch (e) {
      console.log(`[REPLICATION] Could not fetch date: ${e.message}`);
    }
  }

  // Determine target nodes based on fragmentation rules
  const targets = [];
  if (sourceNode === 'node0') {
    // Master replicates to fragments
    if (recordDate) {
      // recordDate is now a string like '1997-01-01', compare directly
      const recordDateStr = recordDate.toString();
      const boundaryDateStr = '1997-01-01';
      const targetNode = recordDateStr < boundaryDateStr ? 'node1' : 'node2';
      targets.push(targetNode);
      console.log(`[REPLICATION] Record date: ${recordDateStr}, Boundary: ${boundaryDateStr}, Target: ${targetNode}`);
    } else {
      targets.push('node1', 'node2'); // Unknown date - replicate to both
      console.log(`[REPLICATION] No date found, replicating to both fragments`);
    }
  } else {
    // Fragments replicate back to master
    targets.push('node0');
  }

  console.log(`[REPLICATION] ${sourceNode} → [${targets.join(', ')}] trans_id=${transId}, recordDate=${recordDate}`);

  // Use Two-Phase Commit for atomic replication
  const twoPC_result = await twoPhaseCommit(sourceNode, query, targets);
  
  // Log results to replication queue
  const results = [];
  for (const result of twoPC_result.results) {
    const entry = {
      id: uuidv4(),
      source: sourceNode,
      target: result.target,
      query,
      status: result.prepared ? 'replicated' : 'failed',
      error: result.reason,
      time: new Date(),
      protocol: '2PC'
    };
    replicationQueue.push(entry);
    results.push(entry);
  }
  
  // Persist logs asynchronously
  persistLogs().catch(err => console.error('[ERROR] Failed to persist after replication:', err.message));
  
  return results;
}

/**
 * Replay failed replications to a recovered node with retry mechanism
 * @param {string} recoveredNode - The node that has been recovered (e.g., 'node1')
 * @returns {Object} Summary of replay results
 */
async function replayFailedReplications(recoveredNode) {
  // Find all failed replications where this node is the target
  const failedReplications = replicationQueue.filter(
    entry => entry.target === recoveredNode && entry.status === 'failed'
  );
  
  console.log(`[RECOVERY] Found ${failedReplications.length} failed replications targeting ${recoveredNode}`);
  
  const results = {
    total: failedReplications.length,
    success: 0,
    failed: 0,
    retryable: [],
    details: []
  };
  
  for (const entry of failedReplications) {
    try {
      console.log(`[RECOVERY] Replaying: ${entry.source} → ${entry.target} | ${entry.query.substring(0, 60)}...`);
      
      const conn = await pools[recoveredNode].getConnection();
      await conn.query(entry.query);
      conn.release();
      
      // Update entry status
      entry.status = 'replicated';
      entry.recoveryTime = new Date();
      entry.retryCount = (entry.retryCount || 0) + 1;
      entry.error = undefined;
      
      results.success++;
      results.details.push({
        id: entry.id,
        query: entry.query.substring(0, 100),
        status: 'success',
        attempts: entry.retryCount
      });
      
      console.log(`[RECOVERY] ✓ Successfully replayed transaction ${entry.id}`);
    } catch (error) {
      entry.retryCount = (entry.retryCount || 0) + 1;
      entry.lastError = error.message;
      
      // Decide if retryable (max 3 attempts)
      if (entry.retryCount < 3) {
        entry.status = 'retry_pending';
        results.retryable.push(entry.id);
        console.log(`[RECOVERY] ⚠ Failed (attempt ${entry.retryCount}/3) - will retry: ${error.message}`);
      } else {
        entry.status = 'failed_permanent';
        console.log(`[RECOVERY] ✗ Failed permanently after ${entry.retryCount} attempts: ${error.message}`);
      }
      
      results.failed++;
      results.details.push({
        id: entry.id,
        query: entry.query.substring(0, 100),
        status: entry.status,
        error: error.message,
        attempts: entry.retryCount
      });
    }
  }
  
  // Persist updated queue
  await persistLogs();
  
  console.log(`[RECOVERY] Summary for ${recoveredNode}: ${results.success} succeeded, ${results.failed} failed out of ${results.total} total`);
  if (results.retryable.length > 0) {
    console.log(`[RECOVERY] ${results.retryable.length} transactions pending retry`);
  }
  
  return results;
}

// Initialize connection pools
async function initializePools() {
  try {
    pools.node0 = mysql.createPool(dbConfig.node0);
    pools.node1 = mysql.createPool(dbConfig.node1);
    pools.node2 = mysql.createPool(dbConfig.node2);
    
    console.log('Connection pools initialized');
    
    // Test all connections
    await testAllConnections();
  } catch (error) {
    console.error('Error initializing pools:', error);
  }
}

// Test connections to all nodes
async function testAllConnections() {
  const nodes = ['node0', 'node1', 'node2'];
  console.log('\n[TEST] Testing database connections...\n');
  
  for (const node of nodes) {
    try {
      const connection = await pools[node].getConnection();
      const [result] = await connection.query('SELECT 1 as connected');
      
      // Check if trans table exists
      const [tableInfo] = await connection.query(`
        SELECT COUNT(*) as count FROM information_schema.tables 
        WHERE table_schema = DATABASE() AND table_name = 'trans'
      `);
      
      if (tableInfo[0].count > 0) {
        // Get row count
        const [rowCount] = await connection.query('SELECT COUNT(*) as total FROM trans');
        console.log(`[OK] ${node.toUpperCase()}: Connected | trans table exists with ${rowCount[0].total} rows`);
      } else {
        console.log(`[WARN] ${node.toUpperCase()}: Connected | trans table NOT found`);
      }
      
      connection.release();
    } catch (error) {
      console.error(`[ERROR] ${node.toUpperCase()}: Connection failed - ${error.message}`);
    }
  }
  console.log('');
}

// Check node health
async function checkNodeHealth() {
  for (const node of ['node0', 'node1', 'node2']) {
    if (simulatedFailures[node]) {
      nodeStatus[node] = { status: 'offline', lastCheck: new Date(), error: 'Simulated failure' };
      continue;
    }
    try {
      const conn = await pools[node].getConnection();
      await conn.query('SELECT 1');
      conn.release();
      nodeStatus[node] = { status: 'online', lastCheck: new Date() };
    } catch (err) {
      nodeStatus[node] = { status: 'offline', lastCheck: new Date(), error: err.message };
    }
  }
}

// Routes

// 1. Health Check
app.get('/health', (req, res) => {
  res.json({
    status: 'Backend is running',
    timestamp: new Date()
  });
});

// Health Check (API version)
app.get('/api/health', (req, res) => {
  res.json({
    status: 'Backend is running',
    timestamp: new Date()
  });
});

// 2. Get Node Status
app.get('/api/nodes/status', async (req, res) => {
  try {
    await checkNodeHealth();
    res.json(nodeStatus);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 3.5 Auto-Execute Query (Automatic Node Selection)
app.post('/api/query/auto-execute', async (req, res) => {
  const { query, isolationLevel } = req.body;
  
  if (!query || !query.trim()) {
    return res.status(400).json({ error: 'Query is required' });
  }

  const effectiveIsolation = isolationLevel || 'READ_COMMITTED';
  const transactionId = uuidv4();
  
  console.log(`\n[AUTO-EXECUTE] Starting automatic query execution...`);
  console.log(`[AUTO-EXECUTE] Query: ${query.substring(0, 100)}...`);
  
  try {
    // Step 1: Determine the primary node for this query
    const nodeSelection = await determinePrimaryNode(query);
    console.log(`[AUTO-EXECUTE] Node selection result:`, nodeSelection);
    
    // Step 2: Get an available node (handles failover)
    const availability = getAvailableNode(nodeSelection.primaryNode, nodeSelection.recordDate);
    
    if (!availability.node) {
      return res.status(503).json({
        error: 'All database nodes are offline',
        transactionId,
        nodeSelection,
        message: 'Cannot execute query - no available nodes'
      });
    }
    
    const targetNode = availability.node;
    console.log(`[AUTO-EXECUTE] Target node: ${targetNode} (fallback: ${availability.isFallback})`);
    
    // Step 3: Execute on the target node (reuse existing logic)
    // Write-Ahead Log: Log BEFORE execution
    const logEntry = writeAheadLog(transactionId, targetNode, query, effectiveIsolation);
    logEntry.autoRouted = true;
    logEntry.nodeSelection = nodeSelection;
    logEntry.availability = availability;
    
    // Persist WAL to disk immediately
    await persistLogs();

    let connection = null;
    const isWrite = isWriteQuery(query);
    const transId = parseTransId(query);
    
    connection = await pools[targetNode].getConnection();
    
    // Start transaction tracking
    startTransaction(transactionId, targetNode, effectiveIsolation);
    const txn = transactions[transactionId];
    
    // ISOLATION LEVEL SPECIFIC LOCKING
    if (isWrite && transId) {
      const lockResult = await acquireLock(transactionId, transId, 'write', effectiveIsolation);
      
      if (!lockResult.success) {
        abortTransaction(transactionId);
        connection.release();
        
        logEntry.status = 'timeout';
        logEntry.error = lockResult.reason;
        logEntry.endTime = new Date();
        
        return res.status(408).json({
          transactionId,
          error: `Write timeout: ${lockResult.reason}`,
          isolationLevel: effectiveIsolation,
          targetNode,
          logEntry
        });
      }
      
      txn.writeSet.add(transId);
    } else if (!isWrite && transId) {
      if (effectiveIsolation === 'REPEATABLE_READ' && txn.snapshot[transId]) {
        const cachedResults = txn.snapshot[transId];
        
        logEntry.status = 'committed';
        logEntry.endTime = new Date();
        logEntry.results = cachedResults;
        logEntry.snapshotUsed = true;
        
        connection.release();
        
        return res.json({
          transactionId,
          results: cachedResults,
          snapshotUsed: true,
          targetNode,
          autoRouted: true,
          nodeSelection,
          logEntry
        });
      }
      
      const lockResult = await acquireLock(transactionId, transId, 'read', effectiveIsolation);
      
      if (!lockResult.success) {
        abortTransaction(transactionId);
        connection.release();
        
        logEntry.status = 'timeout';
        logEntry.error = lockResult.reason;
        logEntry.endTime = new Date();
        
        return res.status(408).json({
          transactionId,
          error: `Read timeout: ${lockResult.reason}`,
          isolationLevel: effectiveIsolation,
          targetNode,
          logEntry
        });
      }
      
      txn.readSet.add(transId);
    }

    // Execute query
    const [results] = await connection.query(query);
    
    // Store snapshot for REPEATABLE_READ
    if (!isWrite && transId && effectiveIsolation === 'REPEATABLE_READ') {
      if (!txn.snapshot[transId]) {
        txn.snapshot[transId] = results;
      }
    }

    logEntry.status = 'committed';
    logEntry.endTime = new Date();
    logEntry.results = results;
    logEntry.readSet = Array.from(txn.readSet);
    logEntry.writeSet = Array.from(txn.writeSet);
    
    // Replicate write to other nodes
    const replicationResults = await replicateWrite(targetNode, query);
    logEntry.replication = replicationResults.map(r => ({ target: r.target, status: r.status }));

    // ISOLATION LEVEL SPECIFIC LOCK RELEASE
    if (effectiveIsolation === 'READ_COMMITTED' && transId) {
      releaseLock(transactionId, transId, effectiveIsolation);
    }
    
    commitTransaction(transactionId);
    connection.release();
    
    await persistLogs();

    res.json({
      transactionId,
      results,
      targetNode,
      autoRouted: true,
      nodeSelection,
      isFallback: availability.isFallback,
      fallbackReason: availability.fallbackReason,
      replication: logEntry.replication,
      logEntry
    });
    
  } catch (error) {
    console.error(`[AUTO-EXECUTE] Error:`, error.message);
    
    const logEntry = {
      transactionId,
      status: 'failed',
      error: error.message,
      endTime: new Date()
    };
    transactionLog.push(logEntry);
    
    abortTransaction(transactionId);
    await persistLogs();

    res.status(500).json({
      transactionId,
      error: error.message,
      logEntry
    });
  }
});

// 4. Execute Query on Specific Node (Manual selection - kept for backward compatibility)
app.post('/api/query/execute', async (req, res) => {
  const { node, query, isolationLevel } = req.body;
  
  if (!pools[node]) {
    return res.status(400).json({ error: 'Invalid node' });
  }

  const transactionId = uuidv4();
  const effectiveIsolation = isolationLevel || 'READ_COMMITTED';

  // Check if the TARGET node (where we're executing) is marked as failed
  // Block operations directly on killed nodes - this is critical for simulating node failure
  if (simulatedFailures[node]) {
    console.log(`[BLOCKED] Cannot execute query on killed node ${node} (simulated failure)`);
    return res.status(503).json({ 
      error: `Node ${node} is offline - operations not allowed`,
      nodeStatus: 'offline',
      message: 'Please select a different node or recover this node first',
      transactionId
    });
  }

  console.log(`[QUERY] Executing on ${node} (node is online)`);
  
  // Write-Ahead Log: Log BEFORE execution
  const logEntry = writeAheadLog(transactionId, node, query, effectiveIsolation);
  
  // Persist WAL to disk immediately
  await persistLogs();

  let connection = null;
  const isWrite = isWriteQuery(query);
  const transId = parseTransId(query);
  
  try {
    connection = await pools[node].getConnection();
    
    // Start transaction tracking
    startTransaction(transactionId, node, effectiveIsolation);
    const txn = transactions[transactionId];
    
    // ISOLATION LEVEL SPECIFIC LOCKING
    if (isWrite && transId) {
      // Write operation - acquire write lock
      const lockResult = await acquireLock(transactionId, transId, 'write', effectiveIsolation);
      
      if (!lockResult.success) {
        // Lock timeout - abort transaction
        abortTransaction(transactionId);
        connection.release();
        
        logEntry.status = 'timeout';
        logEntry.error = lockResult.reason;
        logEntry.endTime = new Date();
        transactionLog.push(logEntry);
        
        return res.status(408).json({
          transactionId,
          error: `Write timeout: ${lockResult.reason}`,
          isolationLevel: effectiveIsolation,
          logEntry
        });
      }
      
      txn.writeSet.add(transId);
      console.log(`[WRITE] trans_id=${transId} added to writeSet of ${transactionId}`);
      
    } else if (!isWrite && transId) {
      // Read operation - check for snapshot first (REPEATABLE_READ)
      if (effectiveIsolation === 'REPEATABLE_READ' && txn.snapshot[transId]) {
        console.log(`[REPEATABLE_READ] Using cached snapshot for trans_id=${transId}`);
        const cachedResults = txn.snapshot[transId];
        
        logEntry.status = 'committed';
        logEntry.endTime = new Date();
        logEntry.results = cachedResults;
        logEntry.readSet = Array.from(txn.readSet);
        logEntry.writeSet = Array.from(txn.writeSet);
        logEntry.snapshotUsed = true;
        
        connection.release();
        transactionLog.push(logEntry);
        
        return res.json({
          transactionId,
          results: cachedResults,
          snapshotUsed: true,
          logEntry
        });
      }
      
      // Acquire read lock (if needed by isolation level)
      const lockResult = await acquireLock(transactionId, transId, 'read', effectiveIsolation);
      
      if (!lockResult.success) {
        // Lock timeout - abort transaction
        abortTransaction(transactionId);
        connection.release();
        
        logEntry.status = 'timeout';
        logEntry.error = lockResult.reason;
        logEntry.endTime = new Date();
        transactionLog.push(logEntry);
        
        return res.status(408).json({
          transactionId,
          error: `Read timeout: ${lockResult.reason}`,
          isolationLevel: effectiveIsolation,
          logEntry
        });
      }
      
      txn.readSet.add(transId);
      console.log(`[READ] trans_id=${transId} added to readSet of ${transactionId}`);
    }

    // Execute query
    const [results] = await connection.query(query);
    
    // Store snapshot for REPEATABLE_READ on first read
    if (!isWrite && transId && effectiveIsolation === 'REPEATABLE_READ') {
      if (!txn.snapshot[transId]) {
        txn.snapshot[transId] = results;
        console.log(`[REPEATABLE_READ] Snapshot stored for trans_id=${transId}`);
      }
    }

    logEntry.status = 'committed';
    logEntry.endTime = new Date();
    logEntry.results = results;
    logEntry.readSet = Array.from(txn.readSet);
    logEntry.writeSet = Array.from(txn.writeSet);
    
    // Replicate write to other nodes
    const replicationResults = await replicateWrite(node, query);
    logEntry.replication = replicationResults.map(r => ({ target: r.target, status: r.status }));

    // ISOLATION LEVEL SPECIFIC LOCK RELEASE
    if (effectiveIsolation === 'READ_COMMITTED' && transId) {
      // READ_COMMITTED: Release locks immediately (both read and write)
      releaseLock(transactionId, transId, effectiveIsolation);
      console.log(`[READ_COMMITTED] Lock released immediately for trans_id=${transId} (${isWrite ? 'write' : 'read'})`);
    }
    // For REPEATABLE_READ and SERIALIZABLE: Locks released at commit
    
    // Commit transaction (releases remaining locks for REPEATABLE_READ/SERIALIZABLE)
    commitTransaction(transactionId);
    
    connection.release();
    
    // Update log entry in-place (already in transactionLog from WAL)
    // Persist updated status to disk
    await persistLogs();

    res.json({
      transactionId,
      results,
      replication: logEntry.replication,
      logEntry
    });
  } catch (error) {
    logEntry.status = 'failed';
    logEntry.endTime = new Date();
    logEntry.error = error.message;
    
    // Abort transaction on error (releases all locks)
    abortTransaction(transactionId);
    
    if (connection) {
      connection.release();
    }
    
    // Persist failed transaction
    await persistLogs();

    res.status(500).json({
      transactionId,
      error: error.message,
      logEntry
    });
  }
});

// 5. Get Transaction Log
app.get('/api/logs/transactions', (req, res) => {
  res.json({
    logs: transactionLog,
    total: transactionLog.length
  });
});

// 6. Get Replication Queue
app.get('/api/replication/queue', (req, res) => {
  res.json({
    queue: replicationQueue,
    total: replicationQueue.length
  });
});

// 6b. Get Active Transactions (for debugging concurrency control)
app.get('/api/locks/status', (req, res) => {
  const activeTxns = Object.keys(transactions).map(txnId => ({
    transactionId: txnId,
    ...transactions[txnId],
    readSet: Array.from(transactions[txnId].readSet),
    writeSet: Array.from(transactions[txnId].writeSet)
  }));
  
  const locks = Object.keys(lockTable).map(transId => ({
    trans_id: transId,
    ...lockTable[transId]
  }));
  
  res.json({
    activeTransactions: activeTxns,
    totalTransactions: activeTxns.length,
    locks: locks,
    totalLocks: locks.length,
    concurrencyControl: 'ISOLATION_LEVEL_AWARE_LOCKING',
    implementation: 'READ_UNCOMMITTED=no locks, READ_COMMITTED=short locks, REPEATABLE_READ=long locks, SERIALIZABLE=read+write locks'
  });
});

// 7. Simulate Node Failure
app.post('/api/nodes/kill', (req, res) => {
  const { node } = req.body;
  
  if (nodeStatus[node]) {
    // Mark node for simulated failure
    simulatedFailures[node] = true;
    nodeStatus[node].status = 'offline';
    nodeStatus[node].failureTime = new Date();
    
    console.log(`[FAILURE] KILLING NODE: ${node} - Simulated failure activated`);
    
    res.json({
      message: `${node} has been killed (simulated failure)`,
      nodeStatus: nodeStatus[node]
    });
  } else {
    res.status(400).json({ error: 'Invalid node' });
  }
});

// 8. Simulate Node Recovery with Concurrency Control
app.post('/api/nodes/recover', async (req, res) => {
  const { node } = req.body;
  
  // Check if recovery already in progress
  if (recoveryInProgress[node]) {
    return res.status(409).json({ 
      error: `Recovery already in progress for ${node}`,
      status: 'conflict',
      message: 'Please wait for the current recovery operation to complete'
    });
  }
  
  try {
    if (nodeStatus[node]) {
      // Lock recovery for this node
      recoveryInProgress[node] = true;
      
      // Remove simulated failure flag
      simulatedFailures[node] = false;
      delete nodeStatus[node].failureTime;
      
      console.log(`[RECOVERY] RECOVERING NODE: ${node} - Processing missed transactions...`);
      
      // Replay all failed replications that targeted this node
      const replayResults = await replayFailedReplications(node);
      
      // Check health after removing failure simulation
      await checkNodeHealth();
      
      // Unlock recovery
      recoveryInProgress[node] = false;
      
      res.json({
        message: `${node} recovery completed`,
        nodeStatus: nodeStatus[node],
        replayedTransactions: replayResults.success,
        failedReplays: replayResults.failed,
        totalProcessed: replayResults.total,
        retryable: replayResults.retryable.length,
        details: replayResults.details
      });
    } else {
      res.status(400).json({ error: 'Invalid node' });
    }
  } catch (error) {
    // Unlock recovery on error
    recoveryInProgress[node] = false;
    res.status(500).json({ error: error.message });
  }
});

// 9. Get All Data from a Node with filtering support
app.get('/api/data/:node', async (req, res) => {
  const { node } = req.params;
  const { 
    table = 'trans', 
    filter = 'all',
    trans_id,
    limit = 50,
    updated_since
  } = req.query;

  console.log(`\n[DATA REQUEST] Node: ${node}, Table: ${table}, Filter: ${filter}`);

  if (!pools[node]) {
    console.error(`[ERROR] Invalid node: ${node}`);
    return res.status(400).json({ error: 'Invalid node' });
  }

  let connection = null;
  try {
    console.log(`[CONNECTION] Getting connection for ${node}...`);
    connection = await pools[node].getConnection();
    console.log(`[OK] Connection obtained`);
    
    let baseQuery = `
      SELECT 
        trans_id, 
        account_id, 
        DATE_FORMAT(newdate, '%Y-%m-%d %H:%i:%s') as newdate, 
        amount, 
        balance 
      FROM ?? 
    `;
    let whereClause = '';
    let orderClause = 'ORDER BY newdate ASC';
    let params = [table];

    // Build query based on filter type
    switch (filter) {
      case 'recent_updates':
        // Get recently modified records (last 10 minutes worth of trans_ids from transaction log)
        const recentTransIds = getRecentlyUpdatedTransIds();
        if (recentTransIds.length > 0) {
          const placeholders = recentTransIds.map(() => '?').join(',');
          whereClause = `WHERE trans_id IN (${placeholders})`;
          params.push(...recentTransIds);
          orderClause = 'ORDER BY trans_id ASC';
        }
        break;
      
      case 'by_trans_id':
        if (trans_id) {
          whereClause = 'WHERE trans_id = ?';
          params.push(parseInt(trans_id));
        }
        break;
        
      case 'pre_1997':
        whereClause = "WHERE newdate < '1997-01-01'";
        break;
        
      case 'post_1997':
        whereClause = "WHERE newdate >= '1997-01-01'";
        break;
        
      case 'high_balance':
        whereClause = 'WHERE balance > 5000';
        orderClause = 'ORDER BY balance DESC';
        break;
        
      default: // 'all'
        // No additional filtering
        break;
    }
    
    const finalQuery = `${baseQuery} ${whereClause} ${orderClause} LIMIT ${parseInt(limit)}`;
    console.log(`[QUERY] Querying: ${finalQuery}`);
    
    const [results] = await connection.query(finalQuery, params);
    connection.release();

    console.log(`[OK] Query successful. Results: ${results.length} rows`);

    // Mark recently updated records for highlighting
    const recentTransIds = getRecentlyUpdatedTransIds();
    const enhancedResults = results.map(row => ({
      ...row,
      recently_updated: recentTransIds.includes(row.trans_id)
    }));

    res.json({
      node,
      table,
      filter,
      count: enhancedResults.length,
      data: enhancedResults,
      recent_updates_available: recentTransIds.length > 0
    });
  } catch (error) {
    console.error(`[ERROR] Error fetching data from ${node}:`, error.message);
    console.error(`[ERROR] Error details:`, error);
    if (connection) {
      connection.release();
    }
    res.status(500).json({ error: error.message, details: error.sqlMessage || 'Unknown error' });
  }
});

// Helper function to get recently updated trans_ids from transaction log
function getRecentlyUpdatedTransIds() {
  const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
  const recentTransIds = [];
  
  // Extract trans_ids from recent write operations in transaction log
  transactionLog.forEach(log => {
    if (log.endTime && log.endTime > tenMinutesAgo && isWriteQuery(log.query)) {
      const transId = parseTransId(log.query);
      if (transId && !recentTransIds.includes(transId)) {
        recentTransIds.push(transId);
      }
    }
  });
  
  return recentTransIds;
}

// 10. Clear Logs (for testing)
app.post('/api/logs/clear', async (req, res) => {
  transactionLog = [];
  replicationQueue = [];
  transactions = {};
  lockTable = {};
  
  // Clear persisted files
  try {
    await fs.unlink(LOG_FILE).catch(() => {});
    await fs.unlink(REPLICATION_QUEUE_FILE).catch(() => {});
    console.log('[CLEAR] Persisted log files deleted');
  } catch (error) {
    console.error('[CLEAR] Error deleting log files:', error.message);
  }
  
  res.json({
    message: 'Logs, locks, and persisted files cleared',
    timestamp: new Date()
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error', details: err.message });
});

// Initialize and start server
async function start() {
  await initializePools();
  await loadPersistedLogs(); // Load transaction history from disk
  
  app.listen(PORT, () => {
    console.log(`\n[SERVER] Distributed DB Simulator Backend running on port ${PORT}`);
    console.log(`[SERVER] Health check: http://localhost:${PORT}/health`);
    console.log(`\nNode Configuration:`);
    console.log(`  - Node 0 (Master): ${dbConfig.node0.host}:${dbConfig.node0.port}`);
    console.log(`  - Node 1 (Fragment A): ${dbConfig.node1.host}:${dbConfig.node1.port}`);
    console.log(`  - Node 2 (Fragment B): ${dbConfig.node2.host}:${dbConfig.node2.port}`);
    console.log(`\nFeatures:`);
    console.log(`  - Two-Phase Commit (2PC) for atomic replication`);
    console.log(`  - Write-Ahead Logging (WAL) for crash recovery`);
    console.log(`  - Transaction log persistence`);
    console.log(`  - Automatic retry mechanism (max 3 attempts)`);
  });
}

start().catch(console.error);

export default app;
