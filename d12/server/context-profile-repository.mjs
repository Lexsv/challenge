import { randomUUID } from 'node:crypto';

export const GENERAL_PROFILE_ID = 'general';

/** Session-independent repository over the application's existing SQLite connection. */
export function createContextProfileRepository(db) {
  db.exec('SAVEPOINT context_profile_init');
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS context_profiles (
      id TEXT PRIMARY KEY NOT NULL CHECK(length(trim(id)) > 0),
      name TEXT NOT NULL CHECK(length(trim(name)) > 0),
      habits TEXT NOT NULL DEFAULT '',
      is_system INTEGER NOT NULL DEFAULT 0 CHECK(is_system IN (0, 1)),
      revision INTEGER NOT NULL DEFAULT 1 CHECK(typeof(revision) = 'integer' AND revision >= 1),
      CHECK((id = 'general' AND name = 'General' AND habits = '' AND is_system = 1 AND revision = 1)
         OR (id <> 'general' AND is_system = 0 AND lower(trim(name)) <> 'general'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS context_profiles_one_system ON context_profiles(is_system) WHERE is_system = 1;
    CREATE TRIGGER IF NOT EXISTS context_profiles_protect_general_update BEFORE UPDATE ON context_profiles
      WHEN OLD.is_system = 1 BEGIN SELECT RAISE(ABORT, 'System profile is immutable.'); END;
    CREATE TRIGGER IF NOT EXISTS context_profiles_protect_general_delete BEFORE DELETE ON context_profiles
      WHEN OLD.is_system = 1 BEGIN SELECT RAISE(ABORT, 'System profile cannot be deleted.'); END;
    INSERT INTO context_profiles(id, name, habits, is_system, revision)
      VALUES ('general', 'General', '', 1, 1) ON CONFLICT(id) DO NOTHING;`);
    const general = db.prepare('SELECT id, name, habits, is_system, revision FROM context_profiles WHERE id = ?').get(GENERAL_PROFILE_ID);
    if (!general || general.name !== 'General' || general.habits !== '' || general.is_system !== 1 || general.revision !== 1) throw new Error('Invalid system profile.');
    db.exec('RELEASE context_profile_init');
  } catch (error) { db.exec('ROLLBACK TO context_profile_init'); db.exec('RELEASE context_profile_init'); throw error; }

  const get = db.prepare('SELECT id, name, habits, is_system, revision FROM context_profiles WHERE id = ?');
  const list = db.prepare('SELECT id, name, habits, is_system, revision FROM context_profiles ORDER BY is_system DESC, name COLLATE NOCASE, id');
  const insert = db.prepare('INSERT INTO context_profiles(id, name, habits, is_system, revision) VALUES (?, ?, ?, 0, 1)');
  const update = db.prepare('UPDATE context_profiles SET name = ?, habits = ?, revision = revision + 1 WHERE id = ? AND is_system = 0 AND revision = ?');
  const remove = db.prepare('DELETE FROM context_profiles WHERE id = ? AND is_system = 0');
  const validate = (name, habits) => {
    if (typeof name !== 'string' || !name.trim() || name.trim().toLowerCase() === 'general' || typeof habits !== 'string') throw new Error('Invalid profile.');
  };
  return {
    list: () => list.all(),
    get: id => get.get(id) ?? null,
    create(name, habits = '') { validate(name, habits); const id = randomUUID(); insert.run(id, name.trim(), habits); return get.get(id); },
    update(id, name, habits, expectedRevision) {
      validate(name, habits);
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error('Invalid profile revision.');
      if (id === GENERAL_PROFILE_ID) throw new Error('System profile is immutable.');
      if (update.run(name.trim(), habits, id, expectedRevision).changes !== 1) throw new Error('Profile missing or revision conflict.');
      return get.get(id);
    },
    delete(id) {
      if (id === GENERAL_PROFILE_ID) throw new Error('System profile cannot be deleted.');
      return remove.run(id).changes === 1;
    },
  };
}
