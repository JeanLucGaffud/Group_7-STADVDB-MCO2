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
// SIMPLE CONCURRENCY CONTROL - ISOLATION LEVELS
// =============================================================================

// Track active (uncommitted) transactions globally
let activeTransactions = {};
// { "trans_123": { node: "node0", startTime: timestamp } }

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
 * Check if read can proceed based on isolation level
 * Simple rule: If transaction is active, wait (except READ_UNCOMMITTED)
 */
async function canReadProceed(transId, isolationLevel) {
  if (!transId || !activeTransactions[transId]) {
    return true; // No active transaction, proceed
  }
  
  // READ_UNCOMMITTED: Always proceed (dirty reads allowed)
  if (isolationLevel === 'READ_UNCOMMITTED') {
    console.log(`[READ_UNCOMMITTED] Dirty read allowed on trans_id=${transId}`);
    return true;
  }
  
  // All other levels: Wait for transaction to commit
  console.log(`[${isolationLevel}] Waiting for trans_id=${transId} to commit...`);
  const startWait = Date.now();
  
  while (activeTransactions[transId]) {
    if (Date.now() - startWait > TRANSACTION_TIMEOUT) {
      throw new Error(`${isolationLevel}: Timeout waiting for transaction`);
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  
  console.log(`[${isolationLevel}] Transaction committed, proceeding with read`);
  return true;
}

/**
 * Start a transaction (mark as active)
 * If transaction already active, wait for it to complete (prevents concurrent writes)
 */
async function startTransaction(transId, node) {
  if (!transId) return;
  
  // Wait if same transaction is already active (prevents concurrent writes to same record)
  if (activeTransactions[transId]) {
    console.log(`[TXN WAIT] trans_id=${transId} already active on ${activeTransactions[transId].node}, waiting...`);
    const startWait = Date.now();
    
    while (activeTransactions[transId]) {
      if (Date.now() - startWait > TRANSACTION_TIMEOUT) {
        throw new Error(`Transaction ${transId}: Timeout waiting for concurrent write to complete`);
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    
    console.log(`[TXN WAIT] trans_id=${transId} completed, proceeding...`);
  }
  
  // Mark transaction as active
  activeTransactions[transId] = { node, startTime: Date.now() };
  console.log(`[TXN START] trans_id=${transId} on ${node}`);
}

/**
 * Commit a transaction (mark as committed/remove from active)
 */
function commitTransaction(transId) {
  if (transId && activeTransactions[transId]) {
    delete activeTransactions[transId];
    console.log(`[TXN COMMIT] trans_id=${transId}`);
  }
}

// Simple write replication utility (eager, same query forwarded to other nodes)
/**
 * Simple replication: forward write query to appropriate nodes
 * No locking needed - just execute the query
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

  console.log(`[REPLICATION] ${sourceNode} → [${targets.join(', ')}] trans_id=${transId}`);

  // Execute replication to each target
  const results = [];
  for (const target of targets) {
    // Pre-check: Skip replication if target is marked as failed
    if (simulatedFailures[target]) {
      console.log(`[REPLICATION SKIP] ${sourceNode} → ${target}: Node marked as failed`);
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
      continue; // Skip to next target
    }
    const entry = {
      id: uuidv4(),
      source: sourceNode,
      target,
      query,
      status: 'pending',
      time: new Date()
    };

    try {
      // Check if target node is marked as failed BEFORE attempting replication
      if (simulatedFailures[target]) {
        throw new Error(`Node ${target} is offline (simulated failure)`);
      }

      // Double-check node status to ensure it's actually online
      if (nodeStatus[target] && nodeStatus[target].status === 'offline') {
        throw new Error(`Node ${target} is offline (status check)`);
      }

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

  // Check if the target node is marked as failed
  if (simulatedFailures[node]) {
    return res.status(503).json({ 
      error: `Node ${node} is offline (simulated failure)`,
      nodeStatus: 'offline'
    });
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
  const lockTransId = parseTransId(query);
  const effectiveIsolation = isolationLevel || 'READ_COMMITTED';
  
  try {
    connection = await pools[node].getConnection();
    
    // SIMPLE TRANSACTION TRACKING (Custom implementation)
    if (isWrite && lockTransId) {
      // Start transaction - marks it as active globally (waits if already active)
      await startTransaction(lockTransId, node);
      console.log(`[TXN START] trans_id=${lockTransId} on ${node} (${effectiveIsolation})`);
    }
    
    // For reads: Wait for uncommitted transactions (except READ_UNCOMMITTED)
    if (!isWrite && lockTransId) {
      await canReadProceed(lockTransId, effectiveIsolation);
    }

    // Execute query
    const [results] = await connection.query(query);

    logEntry.status = 'committed';
    logEntry.endTime = new Date();
    logEntry.results = results;
    
    // Replicate write to other nodes
    const replicationResults = await replicateWrite(node, query);
    logEntry.replication = replicationResults.map(r => ({ target: r.target, status: r.status }));

    // Commit transaction - removes from active transactions
    if (lockTransId) {
      commitTransaction(lockTransId);
      console.log(`[TXN COMMIT] trans_id=${lockTransId} on ${node}`);
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
    
    // Abort transaction on error
    if (lockTransId) {
      commitTransaction(lockTransId); // Clean up active transaction
      console.log(`[TXN ABORT] trans_id=${lockTransId} on ${node}`);
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

// 6b. Get Active Transactions (for debugging concurrency control)
app.get('/api/locks/status', (req, res) => {
  const activeTxns = Object.keys(activeTransactions).map(transId => ({
    transactionId: transId,
    ...activeTransactions[transId]
  }));
  
  res.json({
    activeTransactions: activeTxns,
    total: activeTxns.length,
    concurrencyControl: 'CUSTOM_TRANSACTION_TRACKING',
    implementation: 'Simple in-memory transaction state tracking'
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
