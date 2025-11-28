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

export async function retryReplication() {
  // placeholder for future phases
  showSuccessMessage('Retry triggered (to be implemented)');
}
