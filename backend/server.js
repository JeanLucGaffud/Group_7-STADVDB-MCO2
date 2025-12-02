import express from 'express';
import cors from 'cors';
import mysql from 'mysql2/promise';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';
//This is for testing
dotenv.config();
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

// Prevent caching for all API routes
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  next();
});

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
    // READ_COMMITTED: No read locks needed
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
      
      console.log(`[${isolationLevel}] Read proceeds (no lock needed) on trans_id=${transId}`);
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

// Simple write replication utility (eager, same query forwarded to other nodes)
/**
 * Simple replication: forward write query to appropriate nodes
 * No locking needed - just execute the query
 * For READ_UNCOMMITTED: Fire-and-forget (no retry logic)
 */
async function replicateWrite(sourceNode, query, isolationLevel = 'READ_COMMITTED') {
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
      const [rows] = await conn.query('SELECT newdate FROM trans WHERE trans_id = ?', [transId]);
      conn.release();
      if (rows.length) {
        recordDate = rows[0].newdate instanceof Date ? rows[0].newdate : new Date(rows[0].newdate);
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
      targets.push(recordDate < FRAG_BOUNDARY ? 'node1' : 'node2');
    } else {
      targets.push('node1', 'node2'); // Unknown date - replicate to both
    }
  } else {
    // Fragments replicate back to master
    targets.push('node0');
  }

  console.log(`[REPLICATION] ${sourceNode} → [${targets.join(', ')}] trans_id=${transId} isolation=${isolationLevel}`);

  // For READ_UNCOMMITTED: Fire-and-forget approach (no blocking, no retries)
  if (isolationLevel === 'READ_UNCOMMITTED') {
    console.log(`[REPLICATION] READ_UNCOMMITTED mode - fire-and-forget (no wait)`);
    // Execute replications asynchronously without waiting
    for (const target of targets) {
      if (simulatedFailures[target]) {
        console.log(`[REPLICATION SKIP] ${sourceNode} → ${target}: Node offline`);
        continue;
      }
      // Fire and forget - don't await the result
      pools[target].getConnection()
        .then(conn => {
          return conn.query(query).finally(() => conn.release());
        })
        .then(() => console.log(`[REPLICATION SUCCESS] ${sourceNode} → ${target} (async)`))
        .catch(e => console.log(`[REPLICATION FAILED] ${sourceNode} → ${target}: ${e.message} (ignored)`));
    }
    // Return immediately without waiting
    return [{ source: sourceNode, target: targets[0], status: 'async', note: 'READ_UNCOMMITTED fire-and-forget' }];
  }

  // Execute replication to each target (for other isolation levels)
  const results = [];
  for (const target of targets) {
    // Pre-check: Skip replication if target is marked as failed
    if (simulatedFailures[target]) {
      console.log(`[REPLICATION SKIP] ${sourceNode} → ${target}: Node marked as failed (simulatedFailures[${target}] = true)`);
      const entry = {
        id: uuidv4(),
        source: sourceNode,
        target,
        query,
        status: 'failed',
        error: `Node ${target} is offline (simulated failure)`,
        time: new Date()
      };
      replicationQueue.push(entry);
      results.push(entry);
      continue; // Skip to next target - DO NOT execute query
    }

    // If we get here, the node is NOT marked as failed
    console.log(`[REPLICATION ATTEMPT] ${sourceNode} → ${target}: Node is online (simulatedFailures[${target}] = ${simulatedFailures[target]})`);
    
    const entry = {
      id: uuidv4(),
      source: sourceNode,
      target,
      query,
      status: 'pending',
      time: new Date()
    };

    try {
      const conn = await pools[target].getConnection();
      await conn.query(query);
      conn.release();
      
      entry.status = 'replicated';
      console.log(`[REPLICATION SUCCESS] ${sourceNode} → ${target}`);
    } catch (e) {
      entry.status = 'failed';
      entry.error = e.message;
      console.log(`[REPLICATION FAILED] ${sourceNode} → ${target}: ${e.message}`);
    }

    replicationQueue.push(entry);
    results.push(entry);
  }

  return results;
}

/**
 * Replay failed replications to a recovered node
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
      entry.error = undefined;
      
      results.success++;
      results.details.push({
        id: entry.id,
        query: entry.query.substring(0, 100),
        status: 'success'
      });
      
      console.log(`[RECOVERY] ✓ Successfully replayed transaction ${entry.id}`);
    } catch (error) {
      results.failed++;
      results.details.push({
        id: entry.id,
        query: entry.query.substring(0, 100),
        status: 'failed',
        error: error.message
      });
      
      console.log(`[RECOVERY] ✗ Failed to replay transaction ${entry.id}: ${error.message}`);
    }
  }
  
  console.log(`[RECOVERY] Summary for ${recoveredNode}: ${results.success} succeeded, ${results.failed} failed out of ${results.total} total`);
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

// 4. Execute Query on Specific Node
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
  
  const logEntry = {
    transactionId,
    node,
    query,
    isolationLevel: effectiveIsolation,
    startTime: new Date(),
    status: 'pending'
  };

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
      // Read operation - acquire read lock (if needed by isolation level)
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

    logEntry.status = 'committed';
    logEntry.endTime = new Date();
    logEntry.results = results;
    logEntry.readSet = Array.from(txn.readSet);
    logEntry.writeSet = Array.from(txn.writeSet);
    
    // Replicate write to other nodes
    const replicationResults = await replicateWrite(node, query, effectiveIsolation);
    logEntry.replication = replicationResults.map(r => ({ target: r.target, status: r.status }));

    // ISOLATION LEVEL SPECIFIC LOCK RELEASE
    if (effectiveIsolation === 'READ_COMMITTED' && transId) {
      // READ_COMMITTED: Release locks immediately
      releaseLock(transactionId, transId, effectiveIsolation);
      console.log(`[READ_COMMITTED] Lock released immediately for trans_id=${transId}`);
    }
    // For REPEATABLE_READ and SERIALIZABLE: Locks released at commit
    
    // Commit transaction (releases remaining locks for REPEATABLE_READ/SERIALIZABLE)
    commitTransaction(transactionId);
    
    connection.release();
    transactionLog.push(logEntry);

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
    
    transactionLog.push(logEntry);

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

// 8. Simulate Node Recovery
app.post('/api/nodes/recover', async (req, res) => {
  const { node } = req.body;
  
  try {
    if (nodeStatus[node]) {
      // Remove simulated failure flag
      simulatedFailures[node] = false;
      delete nodeStatus[node].failureTime;
      
      console.log(`[RECOVERY] RECOVERING NODE: ${node} - Processing missed transactions...`);
      
      // Replay all failed replications that targeted this node
      const replayResults = await replayFailedReplications(node);
      
      // Check health after removing failure simulation
      await checkNodeHealth();
      
      res.json({
        message: `${node} recovery completed`,
        nodeStatus: nodeStatus[node],
        replayedTransactions: replayResults.success,
        failedReplays: replayResults.failed,
        totalProcessed: replayResults.total
      });
    } else {
      res.status(400).json({ error: 'Invalid node' });
    }
  } catch (error) {
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
app.post('/api/logs/clear', (req, res) => {
  transactionLog = [];
  replicationQueue = [];
  transactions = {};
  lockTable = {};
  
  res.json({
    message: 'Logs and locks cleared',
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
  
  app.listen(PORT, () => {
    console.log(`\n[SERVER] Distributed DB Simulator Backend running on port ${PORT}`);
    console.log(`[SERVER] Health check: http://localhost:${PORT}/health`);
    console.log(`\nNode Configuration:`);
    console.log(`  - Node 0 (Master): ${dbConfig.node0.host}:${dbConfig.node0.port}`);
    console.log(`  - Node 1 (Fragment A): ${dbConfig.node1.host}:${dbConfig.node1.port}`);
    console.log(`  - Node 2 (Fragment B): ${dbConfig.node2.host}:${dbConfig.node2.port}`);
  });
}

start().catch(console.error);

export default app;
