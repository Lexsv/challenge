import { randomUUID } from 'node:crypto';

const strategies = new Set(['full', 'sliding', 'sticky', 'key-value']);
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(value);

/** Persistent snapshots are scoped by session and strategy; branch writes use optimistic revisions. */
export function createContextWorkspaceStore(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS context_branches (
    sessionId TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    strategy TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL CHECK(json_valid(state)),
    PRIMARY KEY(sessionId, strategy, id)
  );
  CREATE TABLE IF NOT EXISTS context_checkpoints (
    sessionId TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    strategy TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL,
    sourceBranchId TEXT NOT NULL, state TEXT NOT NULL CHECK(json_valid(state)),
    PRIMARY KEY(sessionId, strategy, id)
  );`);
  const branch = db.prepare('SELECT id, name, revision, state FROM context_branches WHERE sessionId=? AND strategy=? AND id=?');
  const checkpoint = db.prepare('SELECT id, name, sourceBranchId, state FROM context_checkpoints WHERE sessionId=? AND strategy=? AND id=?');
  const insertBranch = db.prepare('INSERT INTO context_branches (sessionId,strategy,id,name,state) VALUES (?,?,?,?,?)');
  const insertCheckpoint = db.prepare('INSERT INTO context_checkpoints (sessionId,strategy,id,name,sourceBranchId,state) VALUES (?,?,?,?,?,?)');
  const updateBranch = db.prepare('UPDATE context_branches SET state=?, revision=revision+1 WHERE sessionId=? AND strategy=? AND id=? AND revision=?');
  const checkScope = (sessionId, strategy) => {
    if (!identifier(sessionId) || !strategies.has(strategy)) throw new Error('Invalid workspace scope.');
  };
  const decode = row => row && ({ ...row, state: JSON.parse(row.state) });
  const encode = state => {
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('Invalid workspace state.');
    const data = JSON.stringify(state);
    if (Buffer.byteLength(data) > 5_000_000) throw new Error('Workspace state is too large.');
    return data;
  };
  const nameOf = name => {
    if (typeof name !== 'string' || !name.trim() || name.length > 200) throw new Error('Invalid workspace name.');
    return name.trim();
  };
  return {
    checkpoints(sessionId, strategy) {
      checkScope(sessionId, strategy);
      return db.prepare('SELECT id, name, sourceBranchId FROM context_checkpoints WHERE sessionId=? AND strategy=? ORDER BY rowid DESC').all(sessionId, strategy);
    },
    create(sessionId, strategy, name, state) {
      checkScope(sessionId, strategy);
      const id = randomUUID();
      insertBranch.run(sessionId, strategy, id, nameOf(name), encode(state));
      return decode(branch.get(sessionId, strategy, id));
    },
    get(sessionId, strategy, id) {
      checkScope(sessionId, strategy);
      if (!identifier(id)) throw new Error('Invalid branch ID.');
      return decode(branch.get(sessionId, strategy, id));
    },
    save(sessionId, strategy, id, revision, state) {
      checkScope(sessionId, strategy);
      if (!identifier(id) || !Number.isSafeInteger(revision) || revision < 0) throw new Error('Invalid branch revision.');
      if (!updateBranch.run(encode(state), sessionId, strategy, id, revision).changes) throw new Error('Branch changed or is unavailable.');
      return decode(branch.get(sessionId, strategy, id));
    },
    checkpoint(sessionId, strategy, branchId, name) {
      checkScope(sessionId, strategy);
      if (!identifier(branchId)) throw new Error('Invalid branch ID.');
      const source = branch.get(sessionId, strategy, branchId);
      if (!source) throw new Error('Branch not found.');
      const id = randomUUID();
      insertCheckpoint.run(sessionId, strategy, id, nameOf(name), branchId, source.state);
      return decode(checkpoint.get(sessionId, strategy, id));
    },
    branchFrom(sessionId, strategy, checkpointId, name) {
      checkScope(sessionId, strategy);
      if (!identifier(checkpointId)) throw new Error('Invalid checkpoint ID.');
      const source = checkpoint.get(sessionId, strategy, checkpointId);
      if (!source) throw new Error('Checkpoint not found.');
      const id = randomUUID();
      insertBranch.run(sessionId, strategy, id, nameOf(name), source.state);
      return decode(branch.get(sessionId, strategy, id));
    },
  };
}
