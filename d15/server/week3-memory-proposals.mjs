// These functions run on the same SQLite connection and transaction as the
// Week 3 transcript and memory snapshot. Receipts contain no provider output.
export function initializeProposalReceipts(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS week3_proposal_receipts (
    session_id TEXT NOT NULL REFERENCES week3_sessions(id) ON DELETE CASCADE,
    turn_id TEXT NOT NULL, fingerprint TEXT NOT NULL, redacted INTEGER NOT NULL,
    PRIMARY KEY(session_id, turn_id)
  )`);
}
export function proposalReceipt(db, sessionId, turnId) {
  return db
    .prepare(
      "SELECT fingerprint, redacted FROM week3_proposal_receipts WHERE session_id=? AND turn_id=?",
    )
    .get(sessionId, turnId);
}
export function commitProposalReceipt(db, sessionId, input, redacted) {
  db.prepare(
    "INSERT INTO week3_proposal_receipts(session_id,turn_id,fingerprint,redacted) VALUES(?,?,?,?)",
  ).run(sessionId, input.turnId, input.fingerprint, Number(redacted));
}
