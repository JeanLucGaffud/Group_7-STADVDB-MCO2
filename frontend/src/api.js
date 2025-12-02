import axios from 'axios';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001/api';

export const apiClient = axios.create({
  baseURL: API_URL,
  headers: {
    'Content-Type': 'application/json'
  }
});

// Node Management
export const getNodeStatus = () => apiClient.get('/nodes/status');
export const killNode = (node) => apiClient.post('/nodes/kill', { node });
export const recoverNode = (node) => apiClient.post('/nodes/recover', { node });

// Query Execution
export const executeQuery = (node, query, isolationLevel) =>
  apiClient.post('/query/execute', { node, query, isolationLevel });

// Auto Query Execution (automatic node selection with failover)
export const autoExecuteQuery = (query, isolationLevel) =>
  apiClient.post('/query/auto-execute', { query, isolationLevel });

// Data Retrieval
export const getNodeData = (node, table = 'trans', filter = 'all', additionalParams = {}) =>
  apiClient.get(`/data/${node}`, { 
    params: { 
      table, 
      filter,
      ...additionalParams 
    } 
  });

// Logs
export const getTransactionLogs = () => apiClient.get('/logs/transactions');
export const clearLogs = () => apiClient.post('/logs/clear');

// Replication
export const getReplicationQueue = () => apiClient.get('/replication/queue');

// Database Initialization
export const initDatabase = () => apiClient.post('/db/init');

// Health Check
export const healthCheck = () => apiClient.get('/health');
