import { createContextProfileRepository } from './context-profile-repository.mjs';

// SQLite folds ASCII letters when comparing identifiers; non-ASCII stays distinct.
const identifierKey = value => value.replace(/[A-Z]/g, letter => letter.toLowerCase());

// All related rows are staged and restored in one transaction while foreign keys
// remain enabled: SQLite cannot add a populated NOT NULL REFERENCES column with
// a non-NULL default to a nonempty table.
export function initializeWeek3ProfileReference(db) {
  if (db.prepare('PRAGMA foreign_keys').get().foreign_keys !== 1) throw new Error('Week 3 profile migration requires foreign keys.');
  db.exec('SAVEPOINT week3_profile_migration');
  try {
    createContextProfileRepository(db);
    const columns = db.prepare('PRAGMA table_info(week3_sessions)').all();
    if (!columns.some(column => identifierKey(column.name) === 'profile_id')) {
      const order = ['week3_sessions', 'week3_history_events', 'week3_session_memory', 'week3_topics', 'week3_topic_changes', 'week3_topic_evidence', 'week3_topic_segments'];
      const existing = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(row => identifierKey(row.name)));
      const tables = order.filter(name => existing.has(name));
      const stagedTables = new Set(tables);
      // Unknown relationships or triggers may have side effects when rows are staged.
      for (const { name } of db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) {
        const refs = db.prepare(`PRAGMA foreign_key_list(${JSON.stringify(name)})`).all();
        if (refs.some(ref => stagedTables.has(identifierKey(ref.table))) && !stagedTables.has(identifierKey(name))) throw new Error('Unsupported dependent table in Week 3 profile migration.');
      }
      const triggers = db.prepare("SELECT tbl_name FROM sqlite_schema WHERE type='trigger'").all();
      if (triggers.some(trigger => stagedTables.has(identifierKey(trigger.tbl_name)))) throw new Error('Unsupported trigger in Week 3 profile migration.');
      if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Existing database has foreign key violations.');
      for (const name of tables) db.exec(`CREATE TEMP TABLE migration_${name} AS SELECT rowid AS migration_rowid, * FROM ${name}`);
      for (const name of [...tables].reverse()) db.exec(`DELETE FROM ${name}`);
      db.exec("ALTER TABLE week3_sessions ADD COLUMN profile_id TEXT NOT NULL DEFAULT 'general' REFERENCES context_profiles(id)");
      for (const name of tables) {
        const names = db.prepare(`PRAGMA table_info(${name})`).all().map(column => column.name).filter(column => identifierKey(column) !== 'profile_id');
        const list = names.map(name => `\"${name.replaceAll('"', '""')}\"`).join(',');
        db.exec(`INSERT INTO ${name}(rowid,${list}) SELECT migration_rowid,${list} FROM migration_${name}`);
        db.exec(`DROP TABLE migration_${name}`);
      }
    }
    const profileColumn = db.prepare('PRAGMA table_info(week3_sessions)').all().find(column => identifierKey(column.name) === 'profile_id');
    const profileReference = db.prepare('PRAGMA foreign_key_list(week3_sessions)').all().some(key => identifierKey(key.from) === 'profile_id' && identifierKey(key.table) === 'context_profiles' && key.to !== null && identifierKey(key.to) === 'id');
    if (!profileColumn?.notnull || profileColumn.dflt_value !== "'general'" || !profileReference) throw new Error('Invalid Week 3 profile schema.');
    db.exec(`CREATE INDEX IF NOT EXISTS week3_sessions_profile_id ON week3_sessions(profile_id);
      CREATE TRIGGER IF NOT EXISTS week3_sessions_profile_immutable BEFORE UPDATE OF profile_id ON week3_sessions
      WHEN NEW.profile_id IS NOT OLD.profile_id BEGIN SELECT RAISE(ABORT, 'Session profile is immutable.'); END;
      CREATE TRIGGER IF NOT EXISTS week3_sessions_profile_immutable_replace BEFORE INSERT ON week3_sessions
      WHEN EXISTS (SELECT 1 FROM week3_sessions WHERE id=NEW.id AND profile_id IS NOT NEW.profile_id)
      BEGIN SELECT RAISE(ABORT, 'Session profile is immutable.'); END;`);
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Week 3 profile migration failed foreign key validation.');
    db.exec('RELEASE week3_profile_migration');
  } catch (error) {
    db.exec('ROLLBACK TO week3_profile_migration');
    db.exec('RELEASE week3_profile_migration');
    throw error;
  }
}
