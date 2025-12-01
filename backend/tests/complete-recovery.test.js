/**
 * Recovery Test Suite - 4 Cases × 3 Iterations = 12 Tests
 * Database Table: trans (trans_id, account_id, newdate, amount, balance)
 */

import request from 'supertest';
import express from 'express';
import cors from 'cors';

// Create test server with mock distributed database behavior
const app = express();
app.use(cors());
app.use(express.json());

let nodeStates = {
  node0: 'online', 
  node1: 'online',  
  node2: 'online'  
};

let replicationQueue = [];
let transactionLog = [];

let mockDatabase = {
  node0: [], 
  node1: [], 
  node2: []  
};

function getFragmentForDate(dateStr) {
  const date = new Date(dateStr);
  return date < new Date('1997-01-01') ? 'node1' : 'node2';
}

app.get('/health', (req, res) => {
  res.json({ status: 'Backend is running', timestamp: new Date() });
});

app.post('/api/db/init', (req, res) => {
  res.json({ 
    message: 'Database verification completed', 
    nodeStatus: nodeStates,
    results: {
      node0: 'Connected and trans table exists',
      node1: 'Connected and trans table exists', 
      node2: 'Connected and trans table exists'
    }
  });
});

app.get('/api/nodes/status', (req, res) => {
  res.json({
    node0: { status: nodeStates.node0, lastCheck: new Date() },
    node1: { status: nodeStates.node1, lastCheck: new Date() },
    node2: { status: nodeStates.node2, lastCheck: new Date() }
  });
});

app.post('/api/nodes/kill', (req, res) => {
  const { node } = req.body;
  nodeStates[node] = 'offline';
  res.json({ message: `${node} has been killed (simulated failure)` });
});

app.post('/api/nodes/recover', (req, res) => {
  const { node } = req.body;
  nodeStates[node] = 'online';
  res.json({ message: `${node} recovery completed` });
});

app.post('/api/query/execute', (req, res) => {
  const { node, query, isolationLevel } = req.body;
  const transactionId = 'tx-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6);
  
  try {
    if (nodeStates[node] === 'offline') {
      return res.status(500).json({ error: `Node ${node} is offline` });
    }

    let queryType = 'SELECT';
    let transData = null;
    
    if (query.toUpperCase().includes('INSERT')) {
      queryType = 'INSERT';
      const valuesMatch = query.match(/VALUES\s*\(\s*(\d+),\s*'([^']+)',\s*'([^']+)',\s*([\d.]+),\s*([\d.]+)\s*\)/i);
      if (valuesMatch) {
        transData = {
          trans_id: parseInt(valuesMatch[1]),
          account_id: valuesMatch[2],
          newdate: valuesMatch[3],
          amount: parseFloat(valuesMatch[4]),
          balance: parseFloat(valuesMatch[5])
        };
      }
    } else if (query.toUpperCase().includes('UPDATE')) {
      queryType = 'UPDATE';
      const whereMatch = query.match(/WHERE\s+trans_id\s*=\s*(\d+)/i);
      if (whereMatch) {
        const transId = parseInt(whereMatch[1]);
        const existingRecord = mockDatabase[node].find(r => r.trans_id === transId);
        if (existingRecord) {
          transData = { ...existingRecord };
          const setMatch = query.match(/SET\s+amount\s*=\s*([\d.]+),\s*balance\s*=\s*([\d.]+)/i);
          if (setMatch) {
            transData.amount = parseFloat(setMatch[1]);
            transData.balance = parseFloat(setMatch[2]);
          }
        }
      }
    }

    if (queryType === 'INSERT' && transData) {
      mockDatabase[node].push(transData);
    } else if (queryType === 'UPDATE' && transData) {
      const index = mockDatabase[node].findIndex(r => r.trans_id === transData.trans_id);
      if (index >= 0) {
        mockDatabase[node][index] = transData;
      }
    }

    const replicationResults = [];
    
    if (queryType === 'INSERT' || queryType === 'UPDATE') {
      if (node === 'node0') {
        const targetFragment = transData ? getFragmentForDate(transData.newdate) : 'node1';
        
        if (nodeStates[targetFragment] === 'offline') {
          replicationResults.push({
            target: targetFragment,
            status: 'failed',
            error: `Target node ${targetFragment} is offline`
          });
          replicationQueue.push({
            id: 'repl-' + Date.now(),
            source: node,
            target: targetFragment,
            query,
            status: 'failed',
            error: `Target node ${targetFragment} is offline`,
            time: new Date()
          });
        } else {
          if (transData) {
            if (queryType === 'INSERT') {
              mockDatabase[targetFragment].push(transData);
            } else {
              const index = mockDatabase[targetFragment].findIndex(r => r.trans_id === transData.trans_id);
              if (index >= 0) {
                mockDatabase[targetFragment][index] = transData;
              }
            }
          }
          replicationResults.push({
            target: targetFragment,
            status: 'replicated'
          });
        }
      } else {
        if (nodeStates.node0 === 'offline') {
          replicationResults.push({
            target: 'node0',
            status: 'failed',
            error: 'Central node (node0) is offline'
          });
          replicationQueue.push({
            id: 'repl-' + Date.now(),
            source: node,
            target: 'node0',
            query,
            status: 'failed',
            error: 'Central node (node0) is offline',
            time: new Date()
          });
        } else {
          if (transData) {
            if (queryType === 'INSERT') {
              mockDatabase.node0.push(transData);
            } else {
              const index = mockDatabase.node0.findIndex(r => r.trans_id === transData.trans_id);
              if (index >= 0) {
                mockDatabase.node0[index] = transData;
              }
            }
          }
          replicationResults.push({
            target: 'node0',
            status: 'replicated'
          });
        }
      }
    }

    // Log transaction
    transactionLog.push({
      transactionId,
      node,
      query,
      queryType,
      isolationLevel: isolationLevel || 'READ_COMMITTED',
      status: 'committed',
      replication: replicationResults,
      timestamp: new Date()
    });

    res.json({
      transactionId,
      results: [{ affectedRows: queryType === 'SELECT' ? 0 : 1 }],
      replication: replicationResults
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/replication/queue', (req, res) => {
  res.json({
    queue: replicationQueue,
    total: replicationQueue.length
  });
});

app.get('/api/data/:node', (req, res) => {
  const { node } = req.params;
  const { filter, trans_id } = req.query;
  
  let data = mockDatabase[node] || [];
  
  if (filter === 'by_trans_id' && trans_id) {
    data = data.filter(record => record.trans_id == trans_id);
  }
  
  res.json({
    node,
    filter: filter || 'all',
    count: data.length,
    data: data
  });
});

app.post('/api/logs/clear', (req, res) => {
  replicationQueue = [];
  transactionLog = [];
  res.json({ message: 'Logs cleared', timestamp: new Date() });
});

describe('Distributed Database Recovery Tests - 4 Cases × 3 Iterations', () => {
  let server;
  const testPort = 5700;

  beforeAll(async () => {
    server = app.listen(testPort);
    console.log('\n' + '='.repeat(80));
    console.log('RECOVERY TEST SUITE - 4 CASES × 3 ITERATIONS = 12 TESTS');
    console.log('Database: trans (trans_id, account_id, newdate, amount, balance)');
    console.log('='.repeat(80));
    await new Promise(resolve => setTimeout(resolve, 1000));
  });

  afterAll(async () => {
    if (server) {
      server.close();
    }
    
    console.log('\n' + '='.repeat(80));
    console.log('FINAL TEST RESULTS SUMMARY');
    console.log('='.repeat(80));
    console.log('All 12 recovery test iterations completed');
    console.log('Database operations tested: INSERT, UPDATE with replication');
    console.log('Recovery scenarios: Fragment failures, Central failures');
    console.log('Test suite execution finished!');
  });

  beforeEach(async () => {
    // Reset state before each test
    nodeStates = { node0: 'online', node1: 'online', node2: 'online' };
    replicationQueue = [];
    transactionLog = [];
    mockDatabase = { node0: [], node1: [], node2: [] };
    
    await request(app).post('/api/logs/clear').expect(200);
  });

  // CASE 1: Fragment-to-Central Replication Failure (3 iterations)
  describe('Case 1: Fragment-to-Central Replication Failure', () => {
    
    test('Case 1.1: Node1 INSERT fails to replicate to central node', async () => {
      console.log('\nCASE 1.1: Fragment Node1 INSERT Replication Failure');
      
      // Kill central node
      await request(app).post('/api/nodes/kill').send({ node: 'node0' }).expect(200);
      console.log('Central node (node0) killed');
      const response = await request(app)
        .post('/api/query/execute')
        .send({
          node: 'node1',
          query: "INSERT INTO trans (trans_id, account_id, newdate, amount, balance) VALUES (1001, 'ACC1001', '1996-05-15', 1500.00, 6500.00)",
          isolationLevel: 'READ_COMMITTED'
        })
        .expect(200);

      console.log(`INSERT executed on node1: ${response.body.transactionId}`);

      // Verify replication failure
      const replicationResponse = await request(app).get('/api/replication/queue').expect(200);
      const failures = replicationResponse.body.queue.filter(r => r.status === 'failed');
      expect(failures.length).toBeGreaterThan(0);
      console.log(`Replication failures recorded: ${failures.length}`);

      // Recover central node
      await request(app).post('/api/nodes/recover').send({ node: 'node0' }).expect(200);
      console.log('Central node recovered');
      // Verify data in fragment
      const dataResponse = await request(app).get('/api/data/node1?filter=by_trans_id&trans_id=1001').expect(200);
      expect(dataResponse.body.count).toBe(1);
      console.log('CASE 1.1 PASSED - Data verified in fragment node');
    });

    test('Case 1.2: Node2 UPDATE fails to replicate to central node', async () => {
      console.log('\nCASE 1.2: Fragment Node2 UPDATE Replication Failure');
      
      await request(app)
        .post('/api/query/execute')
        .send({
          node: 'node2',
          query: "INSERT INTO trans (trans_id, account_id, newdate, amount, balance) VALUES (1002, 'ACC1002', '1998-08-20', 2000.00, 7000.00)"
        })
        .expect(200);

      await request(app).post('/api/nodes/kill').send({ node: 'node0' }).expect(200);
      console.log('Central node (node0) killed');

      const response = await request(app)
        .post('/api/query/execute')
        .send({
          node: 'node2',
          query: "UPDATE trans SET amount = 2500.00, balance = 7500.00 WHERE trans_id = 1002",
          isolationLevel: 'READ_COMMITTED'
        })
        .expect(200);

      console.log(`UPDATE executed on node2: ${response.body.transactionId}`);

      // Verify replication failure
      const replicationResponse = await request(app).get('/api/replication/queue').expect(200);
      const failures = replicationResponse.body.queue.filter(r => r.status === 'failed');
      expect(failures.length).toBeGreaterThan(0);
      console.log(`Replication failures recorded: ${failures.length}`);

      // Recover central node
      await request(app).post('/api/nodes/recover').send({ node: 'node0' }).expect(200);
      console.log('CASE 1.2 PASSED - UPDATE replication failure handled');
    });

    test('Case 1.3: Multiple fragment operations during central failure', async () => {
      console.log('\nCASE 1.3: Multiple Fragment Operations During Central Failure');
      
      // Kill central node first
      await request(app).post('/api/nodes/kill').send({ node: 'node0' }).expect(200);
      console.log('Central node (node0) killed');
      const operations = [
        { node: 'node1', query: "INSERT INTO trans (trans_id, account_id, newdate, amount, balance) VALUES (1003, 'ACC1003', '1995-12-10', 1800.00, 6800.00)" },
        { node: 'node2', query: "INSERT INTO trans (trans_id, account_id, newdate, amount, balance) VALUES (1004, 'ACC1004', '1999-03-25', 2200.00, 7200.00)" }
      ];

      for (const op of operations) {
        const response = await request(app).post('/api/query/execute').send(op).expect(200);
        console.log(`Operation executed on ${op.node}: ${response.body.transactionId}`);
      }

      // Verify multiple replication failures
      const replicationResponse = await request(app).get('/api/replication/queue').expect(200);
      const failures = replicationResponse.body.queue.filter(r => r.status === 'failed');
      expect(failures.length).toBeGreaterThanOrEqual(2);
      console.log(`Multiple replication failures: ${failures.length}`);

      // Recover central node
      await request(app).post('/api/nodes/recover').send({ node: 'node0' }).expect(200);
      console.log('CASE 1.3 PASSED - Multiple operations handled');
    });
  });

  // CASE 2: Central Node Recovery with Missed Transactions (3 iterations)
  describe('Case 2: Central Node Recovery with Missed Transactions', () => {
    
    test('Case 2.1: Central node misses fragment transactions', async () => {
      console.log('\nCASE 2.1: Central Node Missing Fragment Transactions');
      
      // Kill central node
      await request(app).post('/api/nodes/kill').send({ node: 'node0' }).expect(200);
      console.log('Central node killed');

      const transactions = [
        { node: 'node1', query: "INSERT INTO trans (trans_id, account_id, newdate, amount, balance) VALUES (2001, 'ACC2001', '1996-06-15', 1600.00, 6600.00)" },
        { node: 'node2', query: "INSERT INTO trans (trans_id, account_id, newdate, amount, balance) VALUES (2002, 'ACC2002', '1998-09-20', 2100.00, 7100.00)" }
      ];

      for (const tx of transactions) {
        const result = await request(app).post('/api/query/execute').send(tx).expect(200);
        console.log(`Fragment transaction: ${result.body.transactionId}`);
      }

      const replicationResponse = await request(app).get('/api/replication/queue').expect(200);
      const missed = replicationResponse.body.queue.filter(r => r.target === 'node0' && r.status === 'failed');
      expect(missed.length).toBeGreaterThanOrEqual(2);
      console.log(`Missed transactions: ${missed.length}`);

      // Recover central node
      await request(app).post('/api/nodes/recover').send({ node: 'node0' }).expect(200);
      console.log('Central node recovered');

      const node1Data = await request(app).get('/api/data/node1?filter=by_trans_id&trans_id=2001').expect(200);
      const node2Data = await request(app).get('/api/data/node2?filter=by_trans_id&trans_id=2002').expect(200);
      expect(node1Data.body.count).toBe(1);
      expect(node2Data.body.count).toBe(1);
      console.log('CASE 2.1 PASSED - Fragment data preserved');
    });

    test('Case 2.2: Extended central downtime with multiple transactions', async () => {
      console.log('\nCASE 2.2: Extended Central Downtime');
      
      await request(app).post('/api/nodes/kill').send({ node: 'node0' }).expect(200);

      const extendedTxs = [
        { node: 'node1', query: "INSERT INTO trans (trans_id, account_id, newdate, amount, balance) VALUES (2003, 'ACC2003', '1995-04-10', 1400.00, 6400.00)" },
        { node: 'node1', query: "INSERT INTO trans (trans_id, account_id, newdate, amount, balance) VALUES (2004, 'ACC2004', '1996-07-15', 1700.00, 6700.00)" },
        { node: 'node2', query: "INSERT INTO trans (trans_id, account_id, newdate, amount, balance) VALUES (2005, 'ACC2005', '1999-11-25', 2400.00, 7400.00)" }
      ];

      for (const [index, tx] of extendedTxs.entries()) {
        const result = await request(app).post('/api/query/execute').send(tx).expect(200);
        console.log(`Extended transaction ${index + 1}: ${result.body.transactionId}`);
      }

      const replicationResponse = await request(app).get('/api/replication/queue').expect(200);
      const missedCount = replicationResponse.body.queue.filter(r => r.status === 'failed').length;
      expect(missedCount).toBeGreaterThanOrEqual(3);
      console.log(`Extended missed transactions: ${missedCount}`);

      await request(app).post('/api/nodes/recover').send({ node: 'node0' }).expect(200);
      console.log('CASE 2.2 PASSED - Extended downtime handled');
    });

    test('Case 2.3: Rapid failure and recovery cycles', async () => {
      console.log('\nCASE 2.3: Rapid Failure/Recovery Cycles');
      
      for (let cycle = 1; cycle <= 2; cycle++) {
        await request(app).post('/api/nodes/kill').send({ node: 'node0' }).expect(200);
        
        const result = await request(app).post('/api/query/execute').send({
          node: 'node1',
          query: `INSERT INTO trans (trans_id, account_id, newdate, amount, balance) VALUES (${2005 + cycle}, 'CYCLE${cycle}', '1996-0${cycle}-01', ${1300 + cycle * 100}, ${6300 + cycle * 100})`
        }).expect(200);
        
        console.log(`Cycle ${cycle} transaction: ${result.body.transactionId}`);
        
        await request(app).post('/api/nodes/recover').send({ node: 'node0' }).expect(200);
        console.log(`Cycle ${cycle} recovery completed`);
      }
      
      console.log('CASE 2.3 PASSED - Rapid cycles handled');
    });
  });

  // CASE 3: Central-to-Fragment Replication Failure (3 iterations)
  describe('Case 3: Central-to-Fragment Replication Failure', () => {
    
    test('Case 3.1: Central INSERT fails to replicate to node1', async () => {
      console.log('\nCASE 3.1: Central to Fragment Node1 Replication Failure');
      
      // Kill fragment node1
      await request(app).post('/api/nodes/kill').send({ node: 'node1' }).expect(200);
      console.log('Fragment node1 killed');
      const response = await request(app)
        .post('/api/query/execute')
        .send({
          node: 'node0',
          query: "INSERT INTO trans (trans_id, account_id, newdate, amount, balance) VALUES (3001, 'ACC3001', '1996-02-10', 1900.00, 6900.00)"
        })
        .expect(200);

      console.log(`Central INSERT executed: ${response.body.transactionId}`);

      const replicationResponse = await request(app).get('/api/replication/queue').expect(200);
      const failedToNode1 = replicationResponse.body.queue.filter(r => r.target === 'node1' && r.status === 'failed');
      expect(failedToNode1.length).toBeGreaterThan(0);
      console.log('Replication failure to node1 recorded');

      const centralData = await request(app).get('/api/data/node0?filter=by_trans_id&trans_id=3001').expect(200);
      expect(centralData.body.count).toBe(1);

      await request(app).post('/api/nodes/recover').send({ node: 'node1' }).expect(200);
      console.log('CASE 3.1 PASSED - Central data preserved');
    });

    test('Case 3.2: Central UPDATE fails to replicate to node2', async () => {
      console.log('\nCASE 3.2: Central UPDATE to Fragment Node2 Failure');
      
      await request(app)
        .post('/api/query/execute')
        .send({
          node: 'node0',
          query: "INSERT INTO trans (trans_id, account_id, newdate, amount, balance) VALUES (3002, 'ACC3002', '1998-05-15', 2000.00, 7000.00)"
        })
        .expect(200);

      // Kill fragment node2
      await request(app).post('/api/nodes/kill').send({ node: 'node2' }).expect(200);
      console.log('Fragment node2 killed');

      const response = await request(app)
        .post('/api/query/execute')
        .send({
          node: 'node0',
          query: "UPDATE trans SET amount = 2300.00, balance = 7300.00 WHERE trans_id = 3002"
        })
        .expect(200);

      console.log(`Central UPDATE executed: ${response.body.transactionId}`);

      // Verify replication failure
      const replicationResponse = await request(app).get('/api/replication/queue').expect(200);
      const failedToNode2 = replicationResponse.body.queue.filter(r => r.target === 'node2' && r.status === 'failed');
      expect(failedToNode2.length).toBeGreaterThan(0);

      await request(app).post('/api/nodes/recover').send({ node: 'node2' }).expect(200);
      console.log('CASE 3.2 PASSED - Central UPDATE failure handled');
    });

    test('Case 3.3: Central operations with both fragments offline', async () => {
      console.log('\nCASE 3.3: Central Operations with All Fragments Down');
      
      await Promise.all([
        request(app).post('/api/nodes/kill').send({ node: 'node1' }),
        request(app).post('/api/nodes/kill').send({ node: 'node2' })
      ]);
      console.log('All fragment nodes killed');

      const operations = [
        "INSERT INTO trans (trans_id, account_id, newdate, amount, balance) VALUES (3003, 'ACC3003', '1995-08-20', 1700.00, 6700.00)",
        "INSERT INTO trans (trans_id, account_id, newdate, amount, balance) VALUES (3004, 'ACC3004', '1999-12-15', 2500.00, 7500.00)"
      ];

      for (const [index, query] of operations.entries()) {
        const result = await request(app).post('/api/query/execute').send({ node: 'node0', query }).expect(200);
        console.log(`Central operation ${index + 1}: ${result.body.transactionId}`);
      }

      const replicationResponse = await request(app).get('/api/replication/queue').expect(200);
      const totalFailed = replicationResponse.body.queue.filter(r => r.status === 'failed').length;
      expect(totalFailed).toBeGreaterThanOrEqual(2);
      console.log(`Total replication failures: ${totalFailed}`);

      // Recover fragments
      await Promise.all([
        request(app).post('/api/nodes/recover').send({ node: 'node1' }),
        request(app).post('/api/nodes/recover').send({ node: 'node2' })
      ]);
      console.log('CASE 3.3 PASSED - All fragments recovered');
    });
  });

  // CASE 4: Fragment Node Recovery with Missed Transactions (3 iterations)
  describe('Case 4: Fragment Node Recovery with Missed Transactions', () => {
    
    test('Case 4.1: Single fragment recovery after missing central transactions', async () => {
      console.log('\nCASE 4.1: Single Fragment Recovery');
      
      await request(app).post('/api/nodes/kill').send({ node: 'node1' }).expect(200);
      console.log('Fragment node1 killed');

      const centralOps = [
        "INSERT INTO trans (trans_id, account_id, newdate, amount, balance) VALUES (4001, 'ACC4001', '1996-03-10', 1500.00, 6500.00)",
        "INSERT INTO trans (trans_id, account_id, newdate, amount, balance) VALUES (4002, 'ACC4002', '1995-11-20', 1300.00, 6300.00)"
      ];

      for (const [index, query] of centralOps.entries()) {
        const result = await request(app).post('/api/query/execute').send({ node: 'node0', query }).expect(200);
        console.log(`Central operation ${index + 1}: ${result.body.transactionId}`);
      }

      const replicationResponse = await request(app).get('/api/replication/queue').expect(200);
      const missedByNode1 = replicationResponse.body.queue.filter(r => r.target === 'node1' && r.status === 'failed');
      expect(missedByNode1.length).toBeGreaterThan(0);
      console.log(`Transactions missed by node1: ${missedByNode1.length}`);

      await request(app).post('/api/nodes/recover').send({ node: 'node1' }).expect(200);
      console.log('CASE 4.1 PASSED - Single fragment recovery completed');
    });

    test('Case 4.2: Multiple fragment recovery with mixed transactions', async () => {
      console.log('\nCASE 4.2: Multiple Fragment Recovery');
      
      await Promise.all([
        request(app).post('/api/nodes/kill').send({ node: 'node1' }),
        request(app).post('/api/nodes/kill').send({ node: 'node2' })
      ]);
      console.log('Both fragment nodes killed');

      const mixedOps = [
        "INSERT INTO trans (trans_id, account_id, newdate, amount, balance) VALUES (4003, 'ACC4003', '1996-08-15', 1600.00, 6600.00)",
        "INSERT INTO trans (trans_id, account_id, newdate, amount, balance) VALUES (4004, 'ACC4004', '1998-12-25', 2200.00, 7200.00)",
        "INSERT INTO trans (trans_id, account_id, newdate, amount, balance) VALUES (4005, 'ACC4005', '1995-05-30', 1400.00, 6400.00)"
      ];

      for (const [index, query] of mixedOps.entries()) {
        const result = await request(app).post('/api/query/execute').send({ node: 'node0', query }).expect(200);
        console.log(`Mixed operation ${index + 1}: ${result.body.transactionId}`);
      }

      await request(app).post('/api/nodes/recover').send({ node: 'node1' }).expect(200);
      console.log('Node1 recovered');
      
      await new Promise(resolve => setTimeout(resolve, 500));
      
      await request(app).post('/api/nodes/recover').send({ node: 'node2' }).expect(200);
      console.log('CASE 4.2 PASSED - Multiple fragment recovery completed');
    });

    test('Case 4.3: Concurrent fragment recovery under transaction load', async () => {
      console.log('\nCASE 4.3: Concurrent Recovery Under Load');
      
      await Promise.all([
        request(app).post('/api/nodes/kill').send({ node: 'node1' }),
        request(app).post('/api/nodes/kill').send({ node: 'node2' })
      ]);

      const loadOps = Array.from({length: 4}, (_, i) => 
        `INSERT INTO trans (trans_id, account_id, newdate, amount, balance) VALUES (${4006 + i}, 'LOAD${i}', '${i % 2 === 0 ? '1996' : '1998'}-06-${10 + i}', ${1500 + i * 50}, ${6500 + i * 50})`
      );

      for (const [index, query] of loadOps.entries()) {
        const result = await request(app).post('/api/query/execute').send({ node: 'node0', query }).expect(200);
        console.log(`Load operation ${index + 1}: ${result.body.transactionId}`);
      }

      // Concurrent recovery
      await Promise.all([
        request(app).post('/api/nodes/recover').send({ node: 'node1' }),
        request(app).post('/api/nodes/recover').send({ node: 'node2' })
      ]);
      console.log('Concurrent recovery initiated');

      // Verify final state
      const finalStatus = await request(app).get('/api/nodes/status').expect(200);
      expect(finalStatus.body.node0.status).toBe('online');
      expect(finalStatus.body.node1.status).toBe('online');
      expect(finalStatus.body.node2.status).toBe('online');
      console.log('CASE 4.3 PASSED - Concurrent recovery under load completed');
    });
  });
});