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
    
    showSuccessMessage('Query executed successfully');
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
      logElement.innerHTML = `
        <strong>${log.transactionId.substring(0, 8)}</strong> | 
        ${log.node} | 
        ${log.status} | 
        Level: ${log.isolationLevel}
      `;
      logsContainer.appendChild(logElement);
    });
  }
}

function updateReplicationQueueUI() {
  const queueContainer = document.getElementById('replication-queue');
  
  if (queueContainer) {
    queueContainer.innerHTML = '';
    
    state.replicationQueue.forEach(item => {
      const queueElement = document.createElement('div');
      queueElement.className = 'queue-entry';
      queueElement.textContent = `Pending: ${item.operation} on ${item.node}`;
      queueContainer.appendChild(queueElement);
    });
    
    if (state.replicationQueue.length === 0) {
      queueContainer.innerHTML = '<div class="queue-entry">Queue is empty</div>';
    }
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
