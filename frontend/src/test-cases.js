import { runConcurrentReads, showErrorMessage, showSuccessMessage } from './app.js';
import { apiClient } from './api.js';

// Minimal Test Cases module (we will add Case2/Case3 later)
export async function case1ConcurrentReads(nodeA, nodeB, recordId, isolationLevel) {
  try {
    const { ra, rb, query } = await runConcurrentReads(nodeA, nodeB, recordId, isolationLevel);
    const okA = ra.status === 'fulfilled' ? 'OK' : 'FAIL';
    const okB = rb.status === 'fulfilled' ? 'OK' : 'FAIL';
    const dataA = ra.status === 'fulfilled' ? (ra.value.data.results || []) : [];
    const dataB = rb.status === 'fulfilled' ? (rb.value.data.results || []) : [];
    const rowsA = dataA.length;
    const rowsB = dataB.length;
    const same = ra.status === 'fulfilled' && rb.status === 'fulfilled'
      ? JSON.stringify(dataA) === JSON.stringify(dataB)
      : false;
    return {
      nodeA, nodeB, recordId, query,
      results: {
        nodeA: okA,
        nodeB: okB,
        rowsA,
        rowsB,
        same,
        dataA,
        dataB
      }
    };
  } catch (e) {
    showErrorMessage(e.message);
    return { error: e.message };
  }
}

// Case 2: Write + concurrent reads
export async function case2WritePlusReads(writerNode, readerA, readerB, recordId, newValue, isolationLevel) {
  const id = Number(recordId);
  const val = Number(newValue);
  const iso = isolationLevel || 'READ_COMMITTED';
  const updateQuery = `UPDATE trans SET amount = ${val} WHERE trans_id = ${id}`;
  const selectQuery = `SELECT * FROM trans WHERE trans_id = ${id}`;
  
  // CRITICAL FIX: Execute write and reads in PARALLEL using Promise.all
  // This ensures reads happen DURING the write, not after it completes
  // This is the ONLY way to see dirty reads with READ_UNCOMMITTED
  
  console.log(`[CASE 2] Starting concurrent write + reads with ${iso}...`);
  
  const [writeResult, wRead, aRead, bRead] = await Promise.all([
    apiClient.post('/query/execute', { node: writerNode, query: updateQuery, isolationLevel: iso }),
    apiClient.post('/query/execute', { node: writerNode, query: selectQuery, isolationLevel: iso }),
    apiClient.post('/query/execute', { node: readerA, query: selectQuery, isolationLevel: iso }),
    apiClient.post('/query/execute', { node: readerB, query: selectQuery, isolationLevel: iso })
  ]);
  
  console.log(`[CASE 2] All operations completed`);
  
  const unwrap = r => r.data.results || [];
  const unwrapWrite = r => {
    return {
      status: r.data?.logEntry?.status || 'unknown',
      replication: r.data?.replication || []
    };
  };

  const write = unwrapWrite(writeResult);
  const writerData = unwrap(wRead);
  const readerAData = unwrap(aRead);
  const readerBData = unwrap(bRead);

  // Check if readers saw different values (expected for READ_UNCOMMITTED - dirty reads)
  const values = [
    writerData[0]?.amount,
    readerAData[0]?.amount,
    readerBData[0]?.amount
  ].filter(v => v !== undefined);
  
  const uniqueValues = [...new Set(values)];
  const sawDifferentValues = uniqueValues.length > 1;

  if (sawDifferentValues) {
    console.log(`[CASE 2] DIRTY READS DETECTED: Read values varied: [${uniqueValues.join(', ')}]`);
    console.log(`[CASE 2] This is ${iso === 'READ_UNCOMMITTED' ? 'EXPECTED' : 'UNEXPECTED'} for ${iso}`);
  } else {
    console.log(`[CASE 2] All reads consistent: ${values.length > 0 ? values[0] : 'N/A'}`);
  }

  return {
    isolation: iso,
    write: {
      status: write.status,
      error: write.error,
      query: updateQuery,
      replication: write.replication
    },
    reads: {
      writer: writerData,
      readerA: readerAData,
      readerB: readerBData
    },
    concurrency: {
      sawDifferentValues,
      uniqueValues,
      expected: iso === 'READ_UNCOMMITTED'
        ? 'May see different values (dirty reads allowed across all nodes)'
        : 'Should see consistent values (reads wait for write to commit)'
    }
  };
}

// Case 3: concurrent writes on same record from two nodes
export async function case3ConcurrentWrites(nodeA, nodeB, recordId, valueA, valueB, isoA, isoB) {
  const id = Number(recordId);
  const valA = Number(valueA);
  const valB = Number(valueB);
  const isolationA = isoA || 'READ_COMMITTED';
  const isolationB = isoB || isolationA;
  const updateA = `UPDATE trans SET amount = ${valA} WHERE trans_id = ${id}`;
  const updateB = `UPDATE trans SET amount = ${valB} WHERE trans_id = ${id}`;
  const select = `SELECT * FROM trans WHERE trans_id = ${id}`;

  // Fire both writes concurrently
  const writePromises = [
    apiClient.post('/query/execute', { node: nodeA, query: updateA, isolationLevel: isolationA }),
    apiClient.post('/query/execute', { node: nodeB, query: updateB, isolationLevel: isolationB })
  ];
  const [wA, wB] = await Promise.allSettled(writePromises);

  const unwrapWrite = (res, node, valSet) => {
    if (res.status === 'fulfilled') {
      return {
        node,
        status: res.value.data?.logEntry?.status || 'unknown',
        transactionId: res.value.data?.transactionId,
        replication: res.value.data?.replication || [],
        query: res.value.data?.logEntry?.query,
        valueSet: valSet
      };
    }
    // Rejection case: extract HTTP status and backend error if available
    const httpStatus = res.reason?.response?.status;
    const backendError = res.reason?.response?.data?.error;
    const message = backendError || res.reason?.message || String(res.reason || 'Error');
    return { node, status: 'failed', code: httpStatus, error: message, valueSet: valSet };
  };

  const writeA = unwrapWrite(wA, nodeA, valA);
  const writeB = unwrapWrite(wB, nodeB, valB);

  // Collect completion ordering (approx by presence of logEntry endTime if available)
  const order = [];
  if (wA.status === 'fulfilled') order.push({ node: nodeA, endTime: wA.value.data?.logEntry?.endTime });
  if (wB.status === 'fulfilled') order.push({ node: nodeB, endTime: wB.value.data?.logEntry?.endTime });
  order.sort((a,b) => new Date(a.endTime || 0) - new Date(b.endTime || 0));

  // Final reads from each node (include master always)
  const readNodes = Array.from(new Set([nodeA, nodeB, 'node0']));
  const finalReadsPromises = readNodes.map(n => apiClient.post('/query/execute', { node: n, query: select, isolationLevel: 'READ_COMMITTED' }));
  const settledFinal = await Promise.allSettled(finalReadsPromises);
  const finalReads = {};
  settledFinal.forEach((r, idx) => {
    const n = readNodes[idx];
    finalReads[n] = r.status === 'fulfilled' ? (r.value.data.results || []) : [];
  });

  // Determine final amount (prefer master if available else any)
  const masterRow = finalReads['node0'] && finalReads['node0'][0];
  const finalAmount = masterRow ? masterRow.amount : (finalReads[nodeA][0]?.amount ?? finalReads[nodeB][0]?.amount);

  let conflictType = 'none';
  if (writeA.status === 'committed' && writeB.status === 'committed') {
    if (finalAmount === valA && valA !== valB) conflictType = nodeA === order.slice(-1)[0]?.node ? 'last-write-wins (A)' : 'lost-update (B over A then reverted)';
    if (finalAmount === valB && valA !== valB) conflictType = nodeB === order.slice(-1)[0]?.node ? 'last-write-wins (B)' : 'lost-update (A over B then reverted)';
    if (finalAmount !== valA && finalAmount !== valB) conflictType = 'anomalous (unexpected final value)';
  }

  // Divergence check (amount differs across nodes)
  const amounts = readNodes.map(n => finalReads[n][0]?.amount).filter(a => a !== undefined);
  const divergence = amounts.length > 1 && amounts.some(a => a !== amounts[0]);

  return {
    recordId: id,
    isolation: { nodeA: isolationA, nodeB: isolationB },
    writes: [writeA, writeB],
    order,
    finalReads,
    finalAmount,
    divergence,
    conflictType
  };
}
