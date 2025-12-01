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

let pools = {
  node0: null,
  node1: null,
  node2: null
};

let nodeStatus = {
  node0: { status: 'offline', lastCheck: null },
  node1: { status: 'offline', lastCheck: null },
  node2: { status: 'offline', lastCheck: null }
};

let simulatedFailures = {
  node0: false,
  node1: false,
  node2: false
};

let replicationQueue = [];
let transactionLog = [];
let activeTransactions = {};


const TRANSACTION_TIMEOUT = 5000; // 5 seconds

function parseTransId(query) {
  const match = /WHERE\s+trans_id\s*=\s*(\d+)/i.exec(query || '');
  return match ? parseInt(match[1], 10) : null;
}

function isWriteQuery(query) {
  const upper = String(query || '').trim().toUpperCase();
  return upper.startsWith('UPDATE') || upper.startsWith('INSERT') || upper.startsWith('DELETE');
}


async function canReadProceed(transId, isolationLevel) {
  if (!transId || !activeTransactions[transId]) {
    return true; 
  }
  
  if (isolationLevel === 'READ_UNCOMMITTED') {
    console.log(`[READ_UNCOMMITTED] Dirty read allowed on trans_id=${transId}`);
    return true;
  }
  
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


async function startTransaction(transId, node) {
  if (!transId) return;
  
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
  
  activeTransactions[transId] = { node, startTime: Date.now() };
  console.log(`[TXN START] trans_id=${transId} on ${node}`);
}


function commitTransaction(transId) {
  if (transId && activeTransactions[transId]) {
    delete activeTransactions[transId];
    console.log(`[TXN COMMIT] trans_id=${transId}`);
  }
}


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
      targets.push('node1', 'node2'); 
    }
  } else {
    targets.push('node0');
  }

  console.log(`[REPLICATION] ${sourceNode} → [${targets.join(', ')}] trans_id=${transId}`);

  const results = [];
  for (const target of targets) {
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
      continue; 
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

// Replay failed replications for a recovered node
async function replayFailedReplications(recoveredNode) {
  const failedReplications = replicationQueue.filter(
    entry => entry.target === recoveredNode && entry.status === 'failed'
  );
  
  console.log(`[RECOVERY] Found ${failedReplications.length} failed replications for ${recoveredNode}`);
  
  const results = {
    total: failedReplications.length,
    success: 0,
    failed: 0,
    details: []
  };
  
  for (const entry of failedReplications) {
    try {
      console.log(`[RECOVERY] Replaying: ${entry.source} → ${entry.target} | ${entry.query.substring(0, 50)}...`);
      
      const conn = await pools[recoveredNode].getConnection();
      await conn.query(entry.query);
      conn.release();
      
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
  
  console.log(`[RECOVERY] Summary: ${results.success} succeeded, ${results.failed} failed out of ${results.total} total`);
  return results;
}

// Initialize connection pools
async function initializePools() {
  try {
    pools.node0 = mysql.createPool(dbConfig.node0);
    pools.node1 = mysql.createPool(dbConfig.node1);
    pools.node2 = mysql.createPool(dbConfig.node2);
    
    console.log('Connection pools initialized');
    
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


// 1. Health Check
app.get('/health', (req, res) => {
  res.json({
    status: 'Backend is running',
    timestamp: new Date()
  });
});

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
    
    if (isWrite && lockTransId) {
      await startTransaction(lockTransId, node);
      console.log(`[TXN START] trans_id=${lockTransId} on ${node} (${effectiveIsolation})`);
    }
    
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
    
    if (lockTransId) {
      commitTransaction(lockTransId); 
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
      simulatedFailures[node] = false;
      delete nodeStatus[node].failureTime;
      
      console.log(`[RECOVERY] RECOVERING NODE: ${node} - Processing missed transactions...`);
      
      const replayResults = await replayFailedReplications(node);
      
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

    switch (filter) {
      case 'recent_updates':
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
        
      default:
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

function getRecentlyUpdatedTransIds() {
  const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
  const recentTransIds = [];
  
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

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error', details: err.message });
});

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
