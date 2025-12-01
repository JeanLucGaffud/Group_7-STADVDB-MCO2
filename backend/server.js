import express from 'express';
import cors from 'cors';
import mysql from 'mysql2/promise';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';

dotenv.config();

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

// Database-level Distributed Lock Manager using MySQL GET_LOCK()
// Locks are propagated to target nodes during replication
const LOCK_TIMEOUT = 10; // seconds to wait for lock acquisition

function parseTransId(query) {
  const m = /WHERE\s+trans_id\s*=\s*(\d+)/i.exec(query || '');
  return m ? parseInt(m[1], 10) : null;
}

function isWriteQuery(query) {
  const upper = String(query || '').trim().toUpperCase();
  return upper.startsWith('UPDATE') || upper.startsWith('INSERT') || upper.startsWith('DELETE');
}

/**
 * Acquire a database-level lock using MySQL GET_LOCK()
 * @param {object} connection - MySQL connection object
 * @param {number} transId - Transaction ID to lock
 * @param {string} ownerNode - Node requesting the lock
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function acquireLock(connection, transId, ownerNode) {
  if (transId == null) return { ok: true };
  
  const lockName = `trans_lock_${transId}`;
  
  try {
    const [result] = await connection.query(
      'SELECT GET_LOCK(?, ?) as lock_result',
      [lockName, LOCK_TIMEOUT]
    );
    
    if (result[0].lock_result === 1) {
      console.log(`Lock acquired: ${lockName} by ${ownerNode}`);
      return { ok: true };
    } else if (result[0].lock_result === 0) {
      return { ok: false, error: `Timeout waiting for lock on trans_id ${transId}` };
    } else {
      return { ok: false, error: `Failed to acquire lock on trans_id ${transId}` };
    }
  } catch (error) {
    return { ok: false, error: `Lock acquisition error: ${error.message}` };
  }
}

/**
 * Release a database-level lock using MySQL RELEASE_LOCK()
 * @param {object} connection - MySQL connection object
 * @param {number} transId - Transaction ID to unlock
 * @param {string} ownerNode - Node releasing the lock
 */
async function releaseLock(connection, transId, ownerNode) {
  if (transId == null) return;
  
  const lockName = `trans_lock_${transId}`;
  
  try {
    const [result] = await connection.query(
      'SELECT RELEASE_LOCK(?) as release_result',
      [lockName]
    );
    
    if (result[0].release_result === 1) {
      console.log(`Lock released: ${lockName} by ${ownerNode}`);
    }
  } catch (error) {
    console.error(`Error releasing lock ${lockName}:`, error.message);
  }
}

/**
 * Acquire locks on target nodes before replication
 * @param {Array<string>} targetNodes - Array of node names to lock
 * @param {number} transId - Transaction ID to lock
 * @param {string} sourceNode - Source node requesting locks
 * @returns {Promise<{success: boolean, lockedNodes: Array, errors: Array}>}
 */
async function acquireDistributedLocks(targetNodes, transId, sourceNode) {
  if (!transId) return { success: true, lockedNodes: [], errors: [] };
  
  const lockedNodes = [];
  const errors = [];
  
  for (const targetNode of targetNodes) {
    if (!pools[targetNode] || simulatedFailures[targetNode]) {
      errors.push({ node: targetNode, error: 'Node unavailable' });
      continue;
    }
    
    try {
      const conn = await pools[targetNode].getConnection();
      const lockResult = await acquireLock(conn, transId, sourceNode);
      conn.release();
      
      if (lockResult.ok) {
        lockedNodes.push(targetNode);
        console.log(`Distributed lock acquired on ${targetNode} for trans_id=${transId}`);
      } else {
        errors.push({ node: targetNode, error: lockResult.error });
      }
    } catch (error) {
      errors.push({ node: targetNode, error: error.message });
    }
  }
  
  return {
    success: lockedNodes.length === targetNodes.length,
    lockedNodes,
    errors
  };
}

/**
 * Release locks on target nodes after replication completes
 * @param {Array<string>} targetNodes - Array of node names to unlock
 * @param {number} transId - Transaction ID to unlock
 * @param {string} sourceNode - Source node releasing locks
 */
async function releaseDistributedLocks(targetNodes, transId, sourceNode) {
  if (!transId) return;
  
  for (const targetNode of targetNodes) {
    if (!pools[targetNode] || simulatedFailures[targetNode]) continue;
    
    try {
      const conn = await pools[targetNode].getConnection();
      await releaseLock(conn, transId, sourceNode);
      conn.release();
      console.log(`Distributed lock released on ${targetNode} for trans_id=${transId}`);
    } catch (error) {
      console.error(`Error releasing distributed lock on ${targetNode}:`, error.message);
    }
  }
}

// Simple write replication utility (eager, same query forwarded to other nodes)
async function replicateWrite(sourceNode, query, isolationLevel) {
  const upper = query.trim().toUpperCase();
  const isWrite = upper.startsWith('UPDATE') || upper.startsWith('INSERT') || upper.startsWith('DELETE');
  if (!isWrite) return [];
  // Fragmentation rule:
  // node0: all rows
  // node1: trans trans_date < 1997-01-01
  // node2: trans trans_date >= 1997-01-01
  // For writes originating from node0 replicate ONLY to the correct fragment.
  // For writes from a fragment replicate back to node0 (and validate the date range).
  const FRAG_BOUNDARY = new Date('1997-01-01T00:00:00Z');

  // Attempt to extract trans_id 
  let transId = null;
  
  // For INSERT: extract from VALUES clause - first number after VALUES (
  if (upper.startsWith('INSERT')) {
    const insertIdMatch = /VALUES\s*\(\s*(\d+)/i.exec(query);
    if (insertIdMatch) {
      transId = parseInt(insertIdMatch[1], 10);
      console.log(`[INSERT] Extracted trans_id: ${transId}`);
    }
  }
  // For UPDATE/DELETE: extract from WHERE clause
  else {
    const idMatch = /WHERE\s+trans_id\s*=\s*(\d+)/i.exec(query);
    if (idMatch) {
      transId = parseInt(idMatch[1], 10);
    }
  }

  let recordDate = null;
  
  // For INSERT, extract date from the query itself
  if (upper.startsWith('INSERT')) {
    // Try multiple patterns to extract date from INSERT statement
    // Pattern 1: Find date in VALUES clause (most reliable for our INSERT format)
    const valuesMatch = /VALUES\s*\([^)]*'(\d{4}-\d{2}-\d{2})'[^)]*\)/i.exec(query);
    if (valuesMatch) {
      recordDate = new Date(valuesMatch[1]);
      console.log(`[INSERT] Extracted date: ${valuesMatch[1]} => ${recordDate}`);
    } else {
      // Pattern 2: Find any date-like string after newdate/trans_date column
      const dateMatch = /(?:trans_date|newdate)[^']*'([^']+)'/i.exec(query);
      if (dateMatch) {
        recordDate = new Date(dateMatch[1]);
        console.log(`[INSERT] Extracted date (fallback): ${dateMatch[1]} => ${recordDate}`);
      }
    }
  }
  // For UPDATE/DELETE, fetch date from database
  else if (transId != null) {
    try {
      const conn = await pools[sourceNode].getConnection();
      const [rows] = await conn.query('SELECT newdate FROM trans WHERE trans_id = ?', [transId]);
      conn.release();
      if (rows.length) {
        recordDate = rows[0].newdate instanceof Date ? rows[0].newdate : new Date(rows[0].newdate);
      }
    } catch (e) {
      // ignore date fetch failure, proceed with broad replication
    }
  }
  
  console.log(`[REPLICATION] Decision - Source: ${sourceNode}, Date: ${recordDate}, Boundary: ${FRAG_BOUNDARY}`);

  const targets = [];
  if (sourceNode === 'node0') {
    if (recordDate) {
      if (recordDate < FRAG_BOUNDARY) {
        targets.push('node1');
        console.log(`[TARGET] Replicating to node1 (pre-1997): ${recordDate} < ${FRAG_BOUNDARY}`);
      } else {
        targets.push('node2');
        console.log(`[TARGET] Replicating to node2 (1997+): ${recordDate} >= ${FRAG_BOUNDARY}`);
      }
    } else {
      // Fallback if we cannot determine date: replicate to both fragments
      console.log(`[WARNING] Could not determine date, replicating to both fragments`);
      targets.push('node1', 'node2');
    }
  } else {
    // Writing on a fragment: replicate to master only AFTER validating fragment rule
    if (recordDate) {
      const violatesNode1 = sourceNode === 'node1' && recordDate >= FRAG_BOUNDARY;
      const violatesNode2 = sourceNode === 'node2' && recordDate < FRAG_BOUNDARY;
      if (violatesNode1 || violatesNode2) {
        // Push a failed replication entry noting violation
        const violationEntry = { id: uuidv4(), source: sourceNode, target: 'node0', query, status: 'failed', error: 'Fragment rule violation (date outside fragment range)', time: new Date(), fragmentRouting: { transId, recordDate } };
        replicationQueue.push(violationEntry);
        return [violationEntry];
      }
    }
    targets.push('node0');
  }
  // Step 1: Acquire distributed locks on all target nodes BEFORE replication
  const lockResult = await acquireDistributedLocks(targets, transId, sourceNode);
  
  const results = [];
  
  // If we couldn't acquire all locks, fail fast and release any acquired locks
  if (!lockResult.success && lockResult.errors.length > 0) {
    console.warn(`Failed to acquire all distributed locks for trans_id=${transId}:`, lockResult.errors);
    // Release any locks we did acquire
    await releaseDistributedLocks(lockResult.lockedNodes, transId, sourceNode);
    
    // Return failed entries for nodes we couldn't lock
    for (const error of lockResult.errors) {
      const entry = {
        id: uuidv4(),
        source: sourceNode,
        target: error.node,
        query,
        status: 'failed',
        error: `Lock acquisition failed: ${error.error}`,
        time: new Date(),
        fragmentRouting: { transId, recordDate }
      };
      replicationQueue.push(entry);
      results.push(entry);
    }
  }
  
  // Step 2: Replicate to targets (only those we successfully locked)
  console.log(`[REPLICATION] Starting to targets: [${lockResult.lockedNodes.join(', ')}]`);
  
  for (const tgt of lockResult.lockedNodes) {
    if (!pools[tgt]) continue;
    const entry = { id: uuidv4(), source: sourceNode, target: tgt, query, status: 'pending', time: new Date(), fragmentRouting: { transId, recordDate } };
    try {
      // Check if target node is in simulated failure state
      if (simulatedFailures[tgt]) {
        throw new Error(`Node ${tgt} is offline (simulated failure)`);
      }
      
      console.log(`[REPLICATION] Replicating to ${tgt}...`);
      const conn = await pools[tgt].getConnection();
      if (isolationLevel) {
        const iso = String(isolationLevel).replace(/_/g, ' ');
        await conn.query(`SET SESSION TRANSACTION ISOLATION LEVEL ${iso}`);
      }
      await conn.query(query);
      conn.release();
      entry.status = 'replicated';
      console.log(`[SUCCESS] Replicated to ${tgt}`);
    } catch (e) {
      entry.status = 'failed';
      entry.error = e.message;
      console.error(`[ERROR] Replication to ${tgt} FAILED: ${e.message}`);
      console.error(`Query was: ${query}`);
    }
    replicationQueue.push(entry);
    results.push(entry);
  }
  
  // Step 3: Release distributed locks on all target nodes AFTER replication
  await releaseDistributedLocks(lockResult.lockedNodes, transId, sourceNode);
  
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
  const nodes = ['node0', 'node1', 'node2'];
  
  const checks = nodes.map(async (node) => {
    // If node is simulating failure, don't check actual connectivity
    if (simulatedFailures[node]) {
      nodeStatus[node] = { 
        status: 'offline', 
        lastCheck: new Date(), 
        error: 'Simulated node failure',
        failureTime: nodeStatus[node].failureTime || new Date()
      };
      return;
    }

    try {
      const connection = await pools[node].getConnection();
      await connection.query('SELECT 1');
      connection.release();
      nodeStatus[node] = { status: 'online', lastCheck: new Date() };
    } catch (error) {
      nodeStatus[node] = { status: 'offline', lastCheck: new Date(), error: error.message };
    }
  });

  await Promise.all(checks);
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

// 2. Initialize Database
app.post('/api/db/init', async (req, res) => {
  try {
    const nodes = ['node0', 'node1', 'node2'];
    const results = {};

    // Just check connection, tables should already exist
    for (const node of nodes) {
      try {
        const connection = await pools[node].getConnection();
        await connection.query('SELECT COUNT(*) as count FROM trans');
        connection.release();
        results[node] = 'Connected and trans table exists';
      } catch (error) {
        results[node] = error.message;
      }
    }

    checkNodeHealth();
    
    res.json({
      message: 'Database verification completed',
      results,
      nodeStatus
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 3. Get Node Status
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
  const logEntry = {
    transactionId,
    node,
    query,
    isolationLevel: isolationLevel || 'READ_COMMITTED',
    startTime: new Date(),
    status: 'pending'
  };

  let connection = null;
  const isWrite = isWriteQuery(query);
  const lockTransId = isWrite ? parseTransId(query) : null;
  
  try {
    connection = await pools[node].getConnection();
    
    // Acquire database-level lock for writes BEFORE executing query
    if (isWrite && lockTransId) {
      const lock = await acquireLock(connection, lockTransId, node);
      if (!lock.ok) {
        connection.release();
        logEntry.status = 'failed';
        logEntry.endTime = new Date();
        logEntry.error = lock.error;
        transactionLog.push(logEntry);
        return res.status(423).json({ transactionId, error: lock.error, logEntry });
      }
    }
    
    // Set isolation level (normalize values like READ_COMMITTED -> READ COMMITTED)
    if (isolationLevel) {
      const iso = String(isolationLevel).replace(/_/g, ' ');
      await connection.query(`SET SESSION TRANSACTION ISOLATION LEVEL ${iso}`);
    }

    const [results] = await connection.query(query);

    logEntry.status = 'committed';
    logEntry.endTime = new Date();
    logEntry.results = results;
    
    // Attempt simple replication if write (includes distributed lock propagation)
    const replicationResults = await replicateWrite(node, query, isolationLevel);
    logEntry.replication = replicationResults.map(r => ({ target: r.target, status: r.status }));

    // Release lock after commit & replication attempt
    if (isWrite && lockTransId) {
      await releaseLock(connection, lockTransId, node);
    }
    
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
    
    // Ensure lock release on error
    if (connection && isWrite && lockTransId) {
      await releaseLock(connection, lockTransId, node);
    }
    
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
      
      console.log(`[RECOVERY] RECOVERING NODE: ${node} - Simulated failure removed`);
      
      // Check health after removing failure simulation
      await checkNodeHealth();
      
      res.json({
        message: `${node} recovery completed`,
        nodeStatus: nodeStatus[node]
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
  
  res.json({
    message: 'Logs cleared',
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
