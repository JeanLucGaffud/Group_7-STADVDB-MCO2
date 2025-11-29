# Concurrency & Consistency Test Cases

This document consolidates the scenarios implemented in the app for exploring isolation, replication, and conflict behavior across nodes.

## Case 1: Concurrent Reads
- Goal: Run two or more transactions concurrently on two or more nodes that READ the same data item. Reads do not modify data, so the database remains consistent.
- How it works: The app fires multiple `SELECT * FROM trans WHERE trans_id = <ID>` simultaneously on chosen nodes.
- Expected: Results per node should match the node’s current data. No locks or conflicts.
- Steps:
  1. Open dashboard → “Case 1: Concurrent Reads”.
  2. Choose Node A, Node B, and set `Record ID`.
  3. Choose Isolation Level (Read Uncommitted/Committed/Repeatable Read/Serializable).
  4. Click “Run Concurrent Reads” and review rows, raw data, and equality indicator.

## Case 2: Write + Concurrent Reads
- Goal: Perform one update, then read concurrently from writer and two other nodes to observe replication and consistency.
- How it works: Issue `UPDATE trans SET amount = <value> WHERE trans_id = <ID>` on Writer node, then run three parallel reads (Writer, Reader A, Reader B).
- Replication: The backend eagerly forwards writes according to fragmentation rules:
  - Node 0 (master) → replicate to correct fragment by `newdate` (< 1997 to Node1, ≥ 1997 to Node2).
  - Fragment → replicate back to Node 0; block if the fragment rule is violated.
- Output: Shows write status, node data arrays, comparisons (MATCH/DIFF), and detailed replication entries.
- Steps:
  1. Open dashboard → “Case 2: Write + Reads”.
  2. Choose Writer, Reader A, Reader B, `Record ID`, `New Amount`, Isolation.
  3. Run and review consistency and replication details.

## Case 3: Concurrent Writes (Same Record)
- Goal: Trigger two updates to the same `trans_id` from two nodes concurrently to observe conflicts (lost update, last-writer-wins) and divergence.
- How it works: Two parallel `UPDATE` queries on Node A and Node B with different amounts, followed by final reads from Node A, Node B, and Node 0.
- Locking: The backend enforces an in-memory per-record distributed lock:
  - Before any write, the server acquires a lock for `trans_id` keyed by owner node.
  - If another node holds the lock, the write fails with HTTP 423 and error “Record <id> locked by <node>”.
  - Lock is released after commit (and replication attempt) or on error.
- Output: Shows write statuses (including 423 lock failures), replication results, write ordering, conflict classification, divergence flag, and final rows.
- Steps:
  1. Open dashboard → “Case 3: Concurrent Writes”.
  2. Choose Node A, Node B, `Record ID`, `Amount A`, `Amount B`, Isolation levels.
  3. Run and inspect lock enforcement, conflict type, and final convergence.

## Fragmentation Rules
- Node 0 (master): all rows.
- Node 1: rows with `newdate < 1997-01-01`.
- Node 2: rows with `newdate ≥ 1997-01-01`.
- Writes are routed by `newdate` and violations are recorded in replication entries.

## Replication Behavior & Retries (Concept)
- Eager forwarding on writes; details shown in Case 2 and Case 3.
- Retries (conceptual): transient failures (deadlocks, timeouts) should be retried with backoff.
- Non-retriable: fragment rule violations or hard constraints.
- Future work: add a retry worker and reconciliation to heal divergence.

## Notes
- Isolation level values are normalized internally (e.g., `READ_COMMITTED` → `READ COMMITTED`).
- For demo purposes, the lock manager is in-memory (single backend instance). A production-ready version would use a shared store (e.g., Redis) or DB advisory locks.
- The UI surfaces errors and lock messages clearly for transparency.
