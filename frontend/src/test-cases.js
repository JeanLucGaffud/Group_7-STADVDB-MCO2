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

// Case 2: one write then concurrent reads from writer + 2 readers
export async function case2WritePlusReads(writerNode, readerA, readerB, recordId, newValue, isolationLevel) {
  const id = Number(recordId);
  const val = Number(newValue);
  const iso = isolationLevel || 'READ_COMMITTED';
  const updateQuery = `UPDATE trans SET amount = ${val} WHERE trans_id = ${id}`;
  const selectQuery = `SELECT * FROM trans WHERE trans_id = ${id}`;
  let writeResult;
  try {
    writeResult = await apiClient.post('/query/execute', { node: writerNode, query: updateQuery, isolationLevel: iso });
  } catch (e) {
    writeResult = { status: 'failed', error: e.message };
  }
  // Concurrent reads
  const readPromises = [
    apiClient.post('/query/execute', { node: writerNode, query: selectQuery, isolationLevel: iso }),
    apiClient.post('/query/execute', { node: readerA, query: selectQuery, isolationLevel: iso }),
    apiClient.post('/query/execute', { node: readerB, query: selectQuery, isolationLevel: iso })
  ];
  const [wRead, aRead, bRead] = await Promise.allSettled(readPromises);
  const unwrap = r => r.status === 'fulfilled' ? (r.value.data.results || []) : [];
  const replication = writeResult?.data?.replication || [];

  return {
    isolation: iso,
    write: {
      status: writeResult?.data?.logEntry?.status || writeResult.status || 'unknown',
      error: writeResult.error,
      query: updateQuery,
      replication
    },
    reads: {
      writer: unwrap(wRead),
      readerA: unwrap(aRead),
      readerB: unwrap(bRead)
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
