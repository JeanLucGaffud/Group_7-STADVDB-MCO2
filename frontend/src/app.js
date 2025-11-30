import { 
  getNodeStatus, 
  killNode, 
  recoverNode, 
  executeQuery, 
  getNodeData,
  getTransactionLogs,
  getReplicationQueue,
  clearLogs,
  healthCheck
} from './api.js';

// Global state
let state = {
  nodeStatus: {},
  transactionLogs: [],
  replicationQueue: [],
  selectedNode: 'node0',
  selectedIsolationLevel: 'READ_COMMITTED',
  autoRefresh: true,
  autoRefreshInterval: 3000
};

let refreshInterval = null;

// Initialize Application
export async function initializeApp() {
  console.log('🚀 Initializing Distributed DB Simulator...');
  
  try {
    // Check backend health
    const healthResponse = await healthCheck();
    console.log('✅ Backend connected:', healthResponse.data);
    
    // Initial load
    await refreshNodeStatus();
    await refreshTransactionLogs();
    await refreshReplicationQueue();
    
    // Start auto-refresh if enabled
    if (state.autoRefresh) {
      startAutoRefresh();
    }
    
    console.log('✅ Application initialized successfully');
  } catch (error) {
    console.error('❌ Error initializing app:', error);
    showErrorMessage('Failed to connect to backend. Please check your server.');
  }
}

// Auto-refresh mechanism
export function startAutoRefresh() {
  if (refreshInterval) clearInterval(refreshInterval);
  
  refreshInterval = setInterval(async () => {
    await refreshNodeStatus();
    await refreshTransactionLogs();
    await refreshReplicationQueue();
    updateUI();
  }, state.autoRefreshInterval);
  
  console.log('🔄 Auto-refresh started');
}

export function stopAutoRefresh() {
  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
    console.log('⏹️ Auto-refresh stopped');
  }
}

// Refresh Functions
async function refreshNodeStatus() {
  try {
    const response = await getNodeStatus();
    state.nodeStatus = response.data;
  } catch (error) {
    console.error('Error refreshing node status:', error);
  }
}

async function refreshTransactionLogs() {
  try {
    const response = await getTransactionLogs();
    state.transactionLogs = response.data.logs || [];
  } catch (error) {
    console.error('Error refreshing logs:', error);
  }
}

async function refreshReplicationQueue() {
  try {
    const response = await getReplicationQueue();
    state.replicationQueue = response.data.queue || [];
  } catch (error) {
    console.error('Error refreshing replication queue:', error);
  }
}

// Node Management Actions
export async function killNodeAction(node) {
  try {
    await killNode(node);
    console.log(`⚠️ Node ${node} killed`);
    await refreshNodeStatus();
    updateUI();
  } catch (error) {
    console.error(`Error killing node ${node}:`, error);
    showErrorMessage(`Failed to kill ${node}`);
  }
}

export async function recoverNodeAction(node) {
  try {
    await recoverNode(node);
    console.log(`✅ Node ${node} recovery initiated`);
    await refreshNodeStatus();
    updateUI();
  } catch (error) {
    console.error(`Error recovering node ${node}:`, error);
    showErrorMessage(`Failed to recover ${node}`);
  }
}

// Query Execution
export async function executeQueryAction(query) {
  if (!query.trim()) {
    showErrorMessage('Query cannot be empty');
    return;
  }
  
  try {
    console.log(`📝 Executing query on ${state.selectedNode} with isolation level ${state.selectedIsolationLevel}`);
    
    const response = await executeQuery(
      state.selectedNode,
      query,
      state.selectedIsolationLevel
    );
    
    console.log('✅ Query executed:', response.data);
    await refreshTransactionLogs();
    updateUI();
    
    // Check if it's a write operation and show detailed results
    const isWrite = /^\s*(UPDATE|INSERT|DELETE)/i.test(query);
    
    if (isWrite && response.data && response.data.results && typeof response.data.results.affectedRows !== 'undefined') {
      const affectedRows = response.data.results.affectedRows;
      if (affectedRows === 0) {
        showErrorMessage(`Query executed but no rows were affected (0 rows matched the WHERE condition)`);
      } else {
        showSuccessMessage(`Query executed successfully (${affectedRows} row(s) affected)`);
      }
    } else {
      showSuccessMessage('Query executed successfully');
    }
  } catch (error) {
    console.error('Error executing query:', error);
    showErrorMessage('Query execution failed: ' + error.response?.data?.error || error.message);
  }
}

// View Data
export async function viewNodeData(node) {
  try {
    console.log(`📊 Fetching data from ${node}...`);
    
    const response = await getNodeData(node);
    
    return response.data;
  } catch (error) {
    console.error(`Error fetching data from ${node}:`, error);
    showErrorMessage(`Failed to fetch data from ${node}`);
    return null;
  }
}

// Clear Logs
export async function clearLogsAction() {
  if (confirm('Are you sure you want to clear all logs?')) {
    try {
      await clearLogs();
      state.transactionLogs = [];
      state.replicationQueue = [];
      console.log('🗑️ Logs cleared');
      updateUI();
    } catch (error) {
      console.error('Error clearing logs:', error);
      showErrorMessage('Failed to clear logs');
    }
  }
}

// Replay Failed Replications
export async function replayFailedReplications() {
  try {
    console.log('🔄 Manually triggering replication replay...');
    
    const response = await fetch(`${window.location.origin.replace('3000', '5000')}/api/replication/replay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    const result = await response.json();
    
    console.log('✅ Replay completed:', result);
    
    // Refresh UI
    await refreshReplicationQueue();
    await refreshTransactionLogs();
    updateUI();
    
    if (result.results && Object.values(result.results).some(r => r.replayed > 0)) {
      const totalReplayed = Object.values(result.results).reduce((sum, r) => sum + r.replayed, 0);
      showSuccessMessage(`Successfully replayed ${totalReplayed} missed transactions`);
    } else {
      showSuccessMessage('No transactions needed replay');
    }
    
  } catch (error) {
    console.error('❌ Error during replay:', error);
    showErrorMessage('Failed to replay transactions: ' + error.message);
  }
}

// State Management
export function setState(updates) {
  state = { ...state, ...updates };
  updateUI();
}

export function getState() {
  return state;
}

// UI Update Function
function updateUI() {
  // Update node status indicators
  updateNodeStatusUI();
  
  // Update transaction logs
  updateTransactionLogsUI();
  
  // Update replication queue
  updateReplicationQueueUI();
}

function updateNodeStatusUI() {
  const nodes = ['node0', 'node1', 'node2'];
  
  nodes.forEach(node => {
    const statusElement = document.getElementById(`status-${node}`);
    const nodeInfo = state.nodeStatus[node] || { status: 'unknown' };
    
    if (statusElement) {
      const statusClass = nodeInfo.status === 'online' ? 'online' : 'offline';
      statusElement.className = `node-status ${statusClass}`;
      statusElement.textContent = `${node.toUpperCase()}: ${nodeInfo.status}`;
    }
  });
}

function updateTransactionLogsUI() {
  const logsContainer = document.getElementById('transaction-logs');
  
  if (logsContainer) {
    logsContainer.innerHTML = '';
    
    const recentLogs = state.transactionLogs.slice(-10).reverse();
    
    recentLogs.forEach(log => {
      const logElement = document.createElement('div');
      logElement.className = `log-entry ${log.status}`;
      
      // Check if it's a write operation and show affected rows
      let affectedInfo = '';
      if (log.results && typeof log.results.affectedRows !== 'undefined') {
        const affectedRows = log.results.affectedRows;
        if (affectedRows === 0) {
          affectedInfo = ` | <span class="affected-rows warning">⚠️ 0 rows affected</span>`;
        } else {
          affectedInfo = ` | <span class="affected-rows success">✓ ${affectedRows} row(s) affected</span>`;
        }
      }
      
      logElement.innerHTML = `
        <strong>${log.transactionId.substring(0, 8)}</strong> | 
        ${log.node} | 
        ${log.status} | 
        Level: ${log.isolationLevel}${affectedInfo}
      `;
      logsContainer.appendChild(logElement);
    });
  }
}

function updateReplicationQueueUI() {
  const queueContainer = document.getElementById('replication-queue');
  
  if (queueContainer) {
    queueContainer.innerHTML = '';
    
    if (state.replicationQueue.length === 0) {
      queueContainer.innerHTML = '<div class="queue-entry">Queue is empty</div>';
      return;
    }
    
    // Show most recent entries first
    const recentQueue = state.replicationQueue.slice(-10).reverse();
    
    recentQueue.forEach(item => {
      const queueElement = document.createElement('div');
      
      // Determine status class for styling
      let statusClass = '';
      let statusText = item.status || 'pending';
      
      switch (statusText) {
        case 'replicated':
          statusClass = 'success';
          break;
        case 'replayed':
          statusClass = 'success';
          statusText = 'REPLAYED';
          break;
        case 'failed':
          statusClass = 'error';
          break;
        default:
          statusClass = 'pending';
      }
      
      queueElement.className = `queue-entry ${statusClass}`;
      
      // Format the display text
      const sourceNode = item.source || 'unknown';
      const targetNode = item.target || 'unknown';
      const operation = item.query ? item.query.split(' ')[0] : 'QUERY';
      const time = item.time ? new Date(item.time).toLocaleTimeString() : '';
      
      queueElement.innerHTML = `
        <div class="queue-status">${statusText.toUpperCase()}</div>
        <div class="queue-details">${sourceNode} → ${targetNode} | ${operation}</div>
        ${item.error ? `<div class="queue-error">Error: ${item.error}</div>` : ''}
        <div class="queue-time">${time}</div>
      `;
      
      queueContainer.appendChild(queueElement);
    });
  }
}

// Notification Functions
function showErrorMessage(message) {
  const notificationElement = document.getElementById('notification');
  if (notificationElement) {
    notificationElement.className = 'notification error';
    notificationElement.textContent = message;
    notificationElement.style.display = 'block';
    
    setTimeout(() => {
      notificationElement.style.display = 'none';
    }, 4000);
  }
}

function showSuccessMessage(message) {
  const notificationElement = document.getElementById('notification');
  if (notificationElement) {
    notificationElement.className = 'notification success';
    notificationElement.textContent = message;
    notificationElement.style.display = 'block';
    
    setTimeout(() => {
      notificationElement.style.display = 'none';
    }, 3000);
  }
}

export { showErrorMessage, showSuccessMessage };

// --- Simple Case 1 helpers (concurrent reads) ---
export async function runConcurrentReads(nodeA, nodeB, recordId, isolationLevel) {
  const id = Number(recordId);
  const query = `SELECT * FROM trans WHERE trans_id = ${id}`;
  const level = isolationLevel || 'READ_COMMITTED';
  const a = executeQuery(nodeA, query, level);
  const b = executeQuery(nodeB, query, level);
  const [ra, rb] = await Promise.allSettled([a, b]);
  return { ra, rb, query, isolationLevel: level };
}

// ============================================
// CRUD OPERATIONS
// ============================================

// Operation Tab Management
window.showOperationTab = function(tabName) {
  ['read', 'write', 'delete'].forEach(op => {
    const panel = document.getElementById(`${op}Operation`);
    const tab = document.getElementById(`${op}OpTab`);
    if (panel && tab) {
      panel.classList.toggle('active', op === tabName);
      tab.classList.toggle('active', op === tabName);
    }
  });
};

// READ Operation
window.executeReadOperation = async function() {
  const node = document.getElementById('readNodeSelect').value;
  const transId = document.getElementById('readTransId').value;
  const isolation = document.getElementById('readIsolation').value;
  const resultDiv = document.getElementById('readOperationResult');

  if (!transId) {
    resultDiv.innerHTML = '<div class="error">❌ Transaction ID is required</div>';
    return;
  }

  const query = `SELECT * FROM trans WHERE trans_id = ${transId}`;
  resultDiv.innerHTML = '<div class="loading">Reading transaction...</div>';

  try {
    const response = await executeQuery(node, query, isolation);
    const results = response.data.results || [];
    
    if (results.length === 0) {
      resultDiv.innerHTML = `<div class="error">No transaction found with trans_id = ${transId} on ${node}</div>`;
      return;
    }

    const row = results[0];
    resultDiv.innerHTML = `
      <div class="success">
        <h4>Read Successful</h4>
        <p><strong>Node:</strong> ${node} | <strong>Isolation:</strong> ${isolation}</p>
        <div class="record-display">
          <div class="record-field">
            <span class="field-label">trans_id:</span>
            <span class="field-value">${row.trans_id}</span>
          </div>
          <div class="record-field">
            <span class="field-label">account_id:</span>
            <span class="field-value">${row.account_id}</span>
          </div>
          <div class="record-field">
            <span class="field-label">newdate:</span>
            <span class="field-value">${new Date(row.newdate).toLocaleDateString()}</span>
          </div>
          <div class="record-field">
            <span class="field-label">amount:</span>
            <span class="field-value">${row.amount}</span>
          </div>
          <div class="record-field">
            <span class="field-label">balance:</span>
            <span class="field-value">${row.balance}</span>
          </div>
        </div>
      </div>
    `;
    
    await refreshTransactionLogs();
  } catch (error) {
    resultDiv.innerHTML = `<div class="error">Read failed: ${error.response?.data?.error || error.message}</div>`;
  }
};

// WRITE Operation
window.executeWriteOperation = async function() {
  const accountId = document.getElementById('writeAccountId').value;
  const date = document.getElementById('writeDate').value;
  const amount = document.getElementById('writeAmount').value;
  const balance = document.getElementById('writeBalance').value;
  const isolation = document.getElementById('writeIsolation').value;
  const resultDiv = document.getElementById('writeOperationResult');

  // Validation
  if (!accountId || !date || !amount || !balance) {
    resultDiv.innerHTML = '<div class="error">All fields are required</div>';
    return;
  }

  const query = `INSERT INTO trans (account_id, newdate, amount, balance) 
                 VALUES (${accountId}, '${date}', ${amount}, ${balance})`;

  resultDiv.innerHTML = '<div class="loading">Writing transaction to master...</div>';

  try {
    const response = await executeQuery('node0', query, isolation);
    const replication = response.data.replication || [];
    const insertId = response.data.results.insertId;

    // Determine which slave received the data
    const targetSlave = new Date(date) < new Date('1997-01-01') ? 'Node 1 (Pre-1997)' : 'Node 2 (1997+)';

    resultDiv.innerHTML = `
      <div class="success">
        <h4>Write Successful</h4>
        <p><strong>New trans_id:</strong> ${insertId || 'Auto-generated'}</p>
        <p><strong>Executed on:</strong> Node 0 (Master)</p>
        <p><strong>Target Slave:</strong> ${targetSlave}</p>
        <h5>Replication Status:</h5>
        <ul>
          ${replication.map(r => `
            <li class="${r.status === 'replicated' ? 'success' : 'error'}">
              <strong>${r.target}:</strong> ${r.status}
              ${r.error ? `<br><small>Error: ${r.error}</small>` : ''}
            </li>
          `).join('')}
        </ul>
        <p><em>Record written to master and replicated to ${targetSlave}</em></p>
      </div>
    `;

    // Clear form
    document.getElementById('writeAccountId').value = '';
    document.getElementById('writeDate').value = '';
    document.getElementById('writeAmount').value = '';
    document.getElementById('writeBalance').value = '';

    await refreshTransactionLogs();
    await refreshReplicationQueue();
  } catch (error) {
    resultDiv.innerHTML = `<div class="error">Write failed: ${error.response?.data?.error || error.message}</div>`;
  }
};

// DELETE Operation
window.executeDeleteOperation = async function() {
  const transId = document.getElementById('deleteTransId').value;
  const isolation = document.getElementById('deleteIsolation').value;
  const confirm = document.getElementById('deleteConfirm').checked;
  const resultDiv = document.getElementById('deleteOperationResult');

  if (!transId) {
    resultDiv.innerHTML = '<div class="error">Transaction ID is required</div>';
    return;
  }

  if (!confirm) {
    resultDiv.innerHTML = '<div class="error">Please confirm deletion</div>';
    return;
  }

  const query = `DELETE FROM trans WHERE trans_id = ${transId}`;

  resultDiv.innerHTML = '<div class="loading">Deleting transaction from master...</div>';

  try {
    const response = await executeQuery('node0', query, isolation);
    const replication = response.data.replication || [];
    const affectedRows = response.data.results.affectedRows;

    if (affectedRows === 0) {
      resultDiv.innerHTML = `<div class="error">No transaction found with trans_id = ${transId}</div>`;
      return;
    }

    resultDiv.innerHTML = `
      <div class="success">
        <h4>Delete Successful</h4>
        <p><strong>Deleted trans_id:</strong> ${transId}</p>
        <h5>Replication Status:</h5>
        <ul>
          ${replication.map(r => `
            <li class="${r.status === 'replicated' ? 'success' : 'error'}">
              <strong>${r.target}:</strong> ${r.status}
              ${r.error ? `<br><small>Error: ${r.error}</small>` : ''}
            </li>
          `).join('')}
        </ul>
        <p><em>Record deleted from master and replicated to appropriate slave</em></p>
      </div>
    `;

    // Clear form
    document.getElementById('deleteTransId').value = '';
    document.getElementById('deleteConfirm').checked = false;

    await refreshTransactionLogs();
    await refreshReplicationQueue();
  } catch (error) {
    resultDiv.innerHTML = `<div class="error">Delete failed: ${error.response?.data?.error || error.message}</div>`;
  }
};
