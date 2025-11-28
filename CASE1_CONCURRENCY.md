# Case 1: Concurrent Reads (Simple Guide)

- Goal: Run two or more transactions concurrently on two or more nodes that READ the same data item. Since these are reads only, the database remains consistent.
- How it works: We trigger multiple SELECT queries at the same time targeting the same `id` (or key) on different nodes. Results should match per node’s data and no locks or conflicts occur.

Steps (using the app):
- Open the dashboard and click “Case 1: Concurrent Reads”.
- In the modal, choose nodes (e.g., Node 0 and Node 1) and set the record `ID` to read.
- Click “Run Concurrent Reads”. The app fires SELECT queries simultaneously and shows the small summary.

Notes:
- This case only performs READs, so no updates happen.
- If a node is offline, its request will fail, but other nodes still succeed — consistency is preserved.
