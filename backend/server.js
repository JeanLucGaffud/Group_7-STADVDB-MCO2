import express from 'express';
import cors from 'cors';
import mysql from 'mysql2/promise';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
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

// Replication Queue
let replicationQueue = [];

// Transaction Log
let transactionLog = [];

// In-memory Distributed Lock Manager (per trans_id)
// Map: trans_id -> { ownerNode, acquiredAt }
const locks = new Map();

function parseTransId(query) {
  const m = /WHERE\s+trans_id\s*=\s*(\d+)/i.exec(query || '');
  return m ? parseInt(m[1], 10) : null;
}

function isWriteQuery(query) {
  const upper = String(query || '').trim().toUpperCase();
  return upper.startsWith('UPDATE') || upper.startsWith('INSERT') || upper.startsWith('DELETE');
}

function acquireLock(transId, ownerNode) {
  if (transId == null) return { ok: true };
  const existing = locks.get(transId);
  if (!existing) {
    locks.set(transId, { ownerNode, acquiredAt: new Date() });
    return { ok: true };
  }
  if (existing.ownerNode === ownerNode) {
    return { ok: true };
  }
  return { ok: false, error: `Record ${transId} locked by ${existing.ownerNode}` };
}

function releaseLock(transId, ownerNode) {
  if (transId == null) return;
  const existing = locks.get(transId);
  if (existing && existing.ownerNode === ownerNode) {
    locks.delete(transId);
  }
}

// Simple write replication utility (eager, same query forwarded to other nodes)
async function replicateWrite(sourceNode, query, isolationLevel) {
  const upper = query.trim().toUpperCase();
  const isWrite = upper.startsWith('UPDATE') || upper.startsWith('INSERT') || upper.startsWith('DELETE');
  if (!isWrite) return [];
  // Fragmentation rule:
  // node0: all rows
  // node1: trans newdate < 1997-01-01
  // node2: trans newdate >= 1997-01-01
  // For writes originating from node0 replicate ONLY to the correct fragment.
  // For writes from a fragment replicate back to node0 (and validate the date range).
  const FRAG_BOUNDARY = new Date('1997-01-01T00:00:00Z');

  // Attempt to extract trans_id for UPDATE/DELETE pattern: WHERE trans_id = <id>
  let transId = null;
  const idMatch = /WHERE\s+trans_id\s*=\s*(\d+)/i.exec(query);
  if (idMatch) {
    transId = parseInt(idMatch[1], 10);
  }

  let recordDate = null;
  if (transId != null) {
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

  const targets = [];
  if (sourceNode === 'node0') {
    if (recordDate) {
      if (recordDate < FRAG_BOUNDARY) {
        targets.push('node1');
      } else {
        targets.push('node2');
      }
    } else {
      // Fallback if we cannot determine date: replicate to both fragments
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
  const results = [];
  for (const tgt of targets) {
    if (!pools[tgt]) continue;
    const entry = { id: uuidv4(), source: sourceNode, target: tgt, query, status: 'pending', time: new Date(), fragmentRouting: { transId, recordDate } };
    try {
      const conn = await pools[tgt].getConnection();
      if (isolationLevel) {
        const iso = String(isolationLevel).replace(/_/g, ' ');
        await conn.query(`SET SESSION TRANSACTION ISOLATION LEVEL ${iso}`);
      }
      await conn.query(query);
      conn.release();
      entry.status = 'replicated';
    } catch (e) {
      entry.status = 'failed';
      entry.error = e.message;
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
  console.log('\n🔍 Testing database connections...\n');
  
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
        console.log(`✅ ${node.toUpperCase()}: Connected | trans table exists with ${rowCount[0].total} rows`);
      } else {
        console.log(`⚠️  ${node.toUpperCase()}: Connected | ❌ trans table NOT found`);
      }
      
      connection.release();
    } catch (error) {
      console.error(`❌ ${node.toUpperCase()}: Connection failed - ${error.message}`);
    }
  }
  console.log('');
}

// Check node health
async function checkNodeHealth() {
  const nodes = ['node0', 'node1', 'node2'];
  
  for (const node of nodes) {
    try {
      const connection = await pools[node].getConnection();
      await connection.query('SELECT 1');
      connection.release();
      nodeStatus[node] = { status: 'online', lastCheck: new Date() };
    } catch (error) {
      nodeStatus[node] = { status: 'offline', lastCheck: new Date(), error: error.message };
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

  try {
    // Acquire per-record lock for writes
    const isWrite = isWriteQuery(query);
    const lockTransId = isWrite ? parseTransId(query) : null;
    if (isWrite) {
      const lock = acquireLock(lockTransId, node);
      if (!lock.ok) {
        logEntry.status = 'failed';
        logEntry.endTime = new Date();
        logEntry.error = lock.error;
        transactionLog.push(logEntry);
        return res.status(423).json({ transactionId, error: lock.error, logEntry });
      }
    }

    const connection = await pools[node].getConnection();
    
    // Set isolation level (normalize values like READ_COMMITTED -> READ COMMITTED)
    if (isolationLevel) {
      const iso = String(isolationLevel).replace(/_/g, ' ');
      await connection.query(`SET SESSION TRANSACTION ISOLATION LEVEL ${iso}`);
    }

    const [results] = await connection.query(query);
    connection.release();

    logEntry.status = 'committed';
    logEntry.endTime = new Date();
    logEntry.results = results;
    // Attempt simple replication if write
    const replicationResults = await replicateWrite(node, query, isolationLevel);
    logEntry.replication = replicationResults.map(r => ({ target: r.target, status: r.status }));

    // Release lock after commit & replication attempt
    if (isWrite) {
      releaseLock(lockTransId, node);
    }

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
    const lockTransId = parseTransId(query);
    releaseLock(lockTransId, node);
    
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
    nodeStatus[node].status = 'offline';
    nodeStatus[node].failureTime = new Date();
    
    res.json({
      message: `${node} has been marked as offline`,
      nodeStatus
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
      await checkNodeHealth();
      
      res.json({
        message: `${node} recovery initiated`,
        nodeStatus: nodeStatus[node]
      });
    } else {
      res.status(400).json({ error: 'Invalid node' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 9. Get All Data from a Node (first 50 rows)
app.get('/api/data/:node', async (req, res) => {
  const { node } = req.params;
  const table = req.query.table || 'trans';

  console.log(`\n📊 [DATA REQUEST] Node: ${node}, Table: ${table}`);

  if (!pools[node]) {
    console.error(`❌ Invalid node: ${node}`);
    return res.status(400).json({ error: 'Invalid node' });
  }

  try {
    console.log(`🔌 Getting connection for ${node}...`);
    const connection = await pools[node].getConnection();
    console.log(`✅ Connection obtained`);
    
    // Query with date formatting and ordering
    console.log(`🔍 Querying: SELECT * FROM ${table} ORDER BY newdate ASC LIMIT 50`);
    const [results] = await connection.query(`
      SELECT 
        trans_id, 
        account_id, 
        DATE_FORMAT(newdate, '%Y-%m-%d') as newdate, 
        amount, 
        balance 
      FROM ?? 
      ORDER BY newdate ASC 
      LIMIT 50
    `, [table]);
    connection.release();

    console.log(`✅ Query successful. Results: ${results.length} rows`);

    res.json({
      node,
      table,
      count: results.length,
      data: results
    });
  } catch (error) {
    console.error(`❌ Error fetching data from ${node}:`, error.message);
    console.error(`📋 Error details:`, error);
    res.status(500).json({ error: error.message, details: error.sqlMessage || 'Unknown error' });
  }
});

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
    console.log(`\n🚀 Distributed DB Simulator Backend running on port ${PORT}`);
    console.log(`📊 Health check: http://localhost:${PORT}/health`);
    console.log(`\nNode Configuration:`);
    console.log(`  - Node 0 (Master): ${dbConfig.node0.host}:${dbConfig.node0.port}`);
    console.log(`  - Node 1 (Fragment A): ${dbConfig.node1.host}:${dbConfig.node1.port}`);
    console.log(`  - Node 2 (Fragment B): ${dbConfig.node2.host}:${dbConfig.node2.port}`);
  });
}

start().catch(console.error);

export default app;
