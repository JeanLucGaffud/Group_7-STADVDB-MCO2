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
  console.log('[INIT] Initializing Distributed DB Simulator...');
  
  try {
    // Check backend health
    const healthResponse = await healthCheck();
    console.log('[OK] Backend connected:', healthResponse.data);
    
    // Initial load
    await refreshNodeStatus();
    await refreshTransactionLogs();
    await refreshReplicationQueue();
    
    // Start auto-refresh if enabled
    if (state.autoRefresh) {
      startAutoRefresh();
    }
    
    console.log('[OK] Application initialized successfully');
  } catch (error) {
    console.error('[ERROR] Error initializing app:', error);
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
  
  console.log('[REFRESH] Auto-refresh started');
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
    console.log(`[WARNING] Node ${node} killed`);
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
    console.log(`[OK] Node ${node} recovery initiated`);
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
    console.log(`[QUERY] Executing query on ${state.selectedNode} with isolation level ${state.selectedIsolationLevel}`);
    
    const response = await executeQuery(
      state.selectedNode,
      query,
      state.selectedIsolationLevel
    );
    
    console.log('[OK] Query executed:', response.data);
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
    console.log(`[DATA] Fetching data from ${node}...`);
    
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
      console.log('[CLEAR] Logs cleared');
      updateUI();
    } catch (error) {
      console.error('Error clearing logs:', error);
      showErrorMessage('Failed to clear logs');
    }
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
          affectedInfo = ` | <span class="affected-rows warning">WARNING: 0 rows affected</span>`;
        } else {
          affectedInfo = ` | <span class="affected-rows success">${affectedRows} row(s) affected</span>`;
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

// ===== NEW CRUD OPERATIONS =====

// Tab switching
window.showOperationTab = function(tabName) {
  // Hide all panels
  document.querySelectorAll('.operation-panel').forEach(panel => {
    panel.classList.remove('active');
  });
  
  // Remove active from all tabs
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.remove('active');
  });
  
  // Show selected panel and activate tab
  document.getElementById(`${tabName}Operation`).classList.add('active');
  document.getElementById(`${tabName}Tab`).classList.add('active');
};

// INSERT Operation
window.executeInsert = async function() {
  const transId = document.getElementById('insertTransId').value;
  const accountId = document.getElementById('insertAccountId').value;
  const date = document.getElementById('insertDate').value;
  const amount = document.getElementById('insertAmount').value;
  const balance = document.getElementById('insertBalance').value;
  
  if (!transId || !accountId || !date || !amount || !balance) {
    showErrorMessage('Please fill in all required fields');
    return;
  }
  
  const query = `INSERT INTO trans (trans_id, account_id, newdate, amount, balance) VALUES (${transId}, ${accountId}, '${date}', ${amount}, ${balance})`;
  
  try {
    const response = await executeQuery('node0', query, 'READ_COMMITTED');
    document.getElementById('insertResult').innerHTML = `
      <div class="success-box">
        <strong>Insert Successful</strong><br>
        Inserted to Node 0 (Master) and replicated to ${date < '1997-01-01' ? 'Node 1 (Pre-1997)' : 'Node 2 (1997+)'}<br>
        Trans ID: ${transId}, Account: ${accountId}, Date: ${date}, Amount: ${amount}, Balance: ${balance}
      </div>
    `;
    
    // Clear form
    document.getElementById('insertTransId').value = '';
    document.getElementById('insertAccountId').value = '';
    document.getElementById('insertDate').value = '';
    document.getElementById('insertAmount').value = '';
    document.getElementById('insertBalance').value = '';
    
    await refreshTransactionLogs();
  } catch (error) {
    document.getElementById('insertResult').innerHTML = `
      <div class="error-box">Insert Failed: ${error.message}</div>
    `;
  }
};

// UPDATE Operation - Load current record
window.loadRecordForUpdate = async function() {
  const transId = document.getElementById('updateTransId').value;
  
  if (!transId) {
    showErrorMessage('Please enter a Transaction ID');
    return;
  }
  
  const query = `SELECT * FROM trans WHERE trans_id = ${transId}`;
  
  try {
    const response = await executeQuery('node0', query, 'READ_COMMITTED');
    if (response.data.results && response.data.results.length > 0) {
      const record = response.data.results[0];
      document.getElementById('currentRecordDisplay').style.display = 'block';
      document.getElementById('currentRecordDetails').innerHTML = `
        <strong>Trans ID:</strong> ${record.trans_id}<br>
        <strong>Account ID:</strong> ${record.account_id}<br>
        <strong>Date:</strong> ${record.trans_date}<br>
        <strong>Current Amount:</strong> ${record.amount}<br>
        <strong>Current Balance:</strong> ${record.balance}
      `;
      
      // Pre-fill all update fields
      document.getElementById('updateAccountId').value = record.account_id;
      document.getElementById('updateDate').value = record.trans_date;
      document.getElementById('updateAmount').value = record.amount;
      document.getElementById('updateBalance').value = record.balance;
    } else {
      showErrorMessage('Record not found');
    }
  } catch (error) {
    showErrorMessage('Error loading record: ' + error.message);
  }
};

// UPDATE Operation - Execute
window.executeUpdate = async function() {
  const transId = document.getElementById('updateTransId').value;
  const accountId = document.getElementById('updateAccountId').value;
  const date = document.getElementById('updateDate').value;
  const amount = document.getElementById('updateAmount').value;
  const balance = document.getElementById('updateBalance').value;
  
  if (!transId) {
    showErrorMessage('Please enter a Transaction ID');
    return;
  }
  
  if (!accountId && !date && !amount && !balance) {
    showErrorMessage('Please provide at least one field to update');
    return;
  }
  
  let updates = [];
  if (accountId) updates.push(`account_id = ${accountId}`);
  if (date) updates.push(`newdate = '${date}'`);
  if (amount) updates.push(`amount = ${amount}`);
  if (balance) updates.push(`balance = ${balance}`);
  
  const query = `UPDATE trans SET ${updates.join(', ')} WHERE trans_id = ${transId}`;
  
  try {
    const response = await executeQuery('node0', query, 'READ_COMMITTED');
    
    let fragmentNote = '';
    if (date) {
      fragmentNote = date < '1997-01-01' ? 
        '<br><strong>Note:</strong> Record moved to Node 1 fragment (Pre-1997)' : 
        '<br><strong>Note:</strong> Record moved to Node 2 fragment (1997+)';
    }
    
    document.getElementById('updateResult').innerHTML = `
      <div class="success-box">
        <strong>Update Successful</strong><br>
        Updated Trans ID: ${transId}<br>
        ${accountId ? `New Account ID: ${accountId}<br>` : ''}
        ${date ? `New Date: ${date}<br>` : ''}
        ${amount ? `New Amount: ${amount}<br>` : ''}
        ${balance ? `New Balance: ${balance}<br>` : ''}
        Changes replicated to appropriate fragment node.${fragmentNote}
      </div>
    `;
    
    // Clear the form fields
    document.getElementById('updateAccountId').value = '';
    document.getElementById('updateDate').value = '';
    document.getElementById('updateAmount').value = '';
    document.getElementById('updateBalance').value = '';
    document.getElementById('currentRecordDisplay').style.display = 'none';
    
    await refreshTransactionLogs();
  } catch (error) {
    document.getElementById('updateResult').innerHTML = `
      <div class="error-box">Update Failed: ${error.message}</div>
    `;
  }
};

// DELETE Operation - Load record for preview
window.loadRecordForDelete = async function() {
  const transId = document.getElementById('deleteTransId').value;
  
  if (!transId) {
    showErrorMessage('Please enter a Transaction ID');
    return;
  }
  
  const query = `SELECT * FROM trans WHERE trans_id = ${transId}`;
  
  try {
    const response = await executeQuery('node0', query, 'READ_COMMITTED');
    if (response.data.results && response.data.results.length > 0) {
      const record = response.data.results[0];
      document.getElementById('deleteRecordDisplay').style.display = 'block';
      document.getElementById('deleteRecordDetails').innerHTML = `
        <strong>Trans ID:</strong> ${record.trans_id}<br>
        <strong>Account ID:</strong> ${record.account_id}<br>
        <strong>Date:</strong> ${record.newdate}<br>
        <strong>Amount:</strong> $${record.amount}<br>
        <strong>Balance:</strong> $${record.balance}
      `;
    } else {
      showErrorMessage('Record not found');
      document.getElementById('deleteRecordDisplay').style.display = 'none';
    }
  } catch (error) {
    showErrorMessage('Error loading record: ' + error.message);
  }
};

// DELETE Operation - Execute
window.executeDelete = async function() {
  const transId = document.getElementById('deleteTransId').value;
  const confirmed = document.getElementById('deleteConfirm').checked;
  
  if (!transId) {
    showErrorMessage('Please enter a Transaction ID');
    return;
  }
  
  if (!confirmed) {
    showErrorMessage('Please confirm deletion by checking the checkbox');
    return;
  }
  
  const query = `DELETE FROM trans WHERE trans_id = ${transId}`;
  
  try {
    const response = await executeQuery('node0', query, 'READ_COMMITTED');
    document.getElementById('deleteResult').innerHTML = `
      <div class="success-box">
        <strong>Delete Successful</strong><br>
        Deleted Trans ID: ${transId} from Node 0 (Master)<br>
        Changes replicated to appropriate fragment node.
      </div>
    `;
    
    // Clear form
    document.getElementById('deleteTransId').value = '';
    document.getElementById('deleteConfirm').checked = false;
    document.getElementById('deleteRecordDisplay').style.display = 'none';
    
    await refreshTransactionLogs();
  } catch (error) {
    document.getElementById('deleteResult').innerHTML = `
      <div class="error-box">Delete Failed: ${error.message}</div>
    `;
  }
};

// REPORTS Operation - Generate
window.generateReport = async function() {
  const output = document.getElementById('reportOutput');
  let reportText = '';
  
  try {
    const pre1997Query = `
      SELECT 
        COUNT(*) as transaction_count,
        SUM(amount) as total_amount
      FROM trans
      WHERE newdate < '1997-01-01'
    `;
    
    const post1997Query = `
      SELECT 
        COUNT(*) as transaction_count,
        SUM(amount) as total_amount
      FROM trans
      WHERE newdate >= '1997-01-01'
    `;
    
    const pre1997Resp = await executeQuery('node0', pre1997Query, 'READ_COMMITTED');
    const post1997Resp = await executeQuery('node0', post1997Query, 'READ_COMMITTED');
    
    const pre1997 = pre1997Resp.data.results[0];
    const post1997 = post1997Resp.data.results[0];
    
    reportText = `
==========================================
  TRANSACTION AMOUNT REPORT
==========================================
Generated: ${new Date().toLocaleString()}
==========================================

Transactions < 1997
  Count: ${pre1997.transaction_count}
  Total: $${parseFloat(pre1997.total_amount || 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}

Transactions >= 1997
  Count: ${post1997.transaction_count}
  Total: $${parseFloat(post1997.total_amount || 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}

==========================================
`;
    
    output.textContent = reportText;
    output.style.display = 'block';
  } catch (error) {
    showErrorMessage('Report Generation Failed: ' + error.message);
  }
};

// ===== END NEW CRUD OPERATIONS =====

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
