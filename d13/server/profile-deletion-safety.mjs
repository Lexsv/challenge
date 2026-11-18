// SQLite identifier comparisons fold ASCII letters, not arbitrary Unicode.
const identifier = value => value.replace(/[A-Z]/g, letter => letter.toLowerCase());
const signature = (parent, onDelete, columns) => `${parent}|${onDelete}|no action|${columns}`;
const expected = {
  context_profiles: [],
  week3_sessions: [signature('context_profiles','no action','profile_id:id')],
  week3_history_events: [signature('week3_sessions','no action','sessionid:id')],
  week3_session_memory: [signature('week3_sessions','no action','sessionid:id')],
  week3_topics: [signature('week3_sessions','cascade','session_id:id')],
  week3_topic_changes: [signature('week3_topics','cascade','session_id:session_id,topic_key:topic_key')],
  week3_topic_evidence: [signature('week3_topic_changes','cascade','session_id:session_id,topic_key:topic_key,ordinal:ordinal')],
  week3_topic_segments: [signature('week3_sessions','cascade','session_id:id')],
};
const normalizeSql = sql => sql.replace(/\s+/g,' ').trim().toLowerCase();
const knownTriggers = new Map([
  ['context_profiles_protect_general_update', "CREATE TRIGGER context_profiles_protect_general_update BEFORE UPDATE ON context_profiles WHEN OLD.is_system = 1 BEGIN SELECT RAISE(ABORT, 'System profile is immutable.'); END"],
  ['context_profiles_protect_general_delete', "CREATE TRIGGER context_profiles_protect_general_delete BEFORE DELETE ON context_profiles WHEN OLD.is_system = 1 BEGIN SELECT RAISE(ABORT, 'System profile cannot be deleted.'); END"],
  ['week3_sessions_profile_immutable', "CREATE TRIGGER week3_sessions_profile_immutable BEFORE UPDATE OF profile_id ON week3_sessions WHEN NEW.profile_id IS NOT OLD.profile_id BEGIN SELECT RAISE(ABORT, 'Session profile is immutable.'); END"],
  ['week3_sessions_profile_immutable_replace', "CREATE TRIGGER week3_sessions_profile_immutable_replace BEFORE INSERT ON week3_sessions WHEN EXISTS (SELECT 1 FROM week3_sessions WHERE id=NEW.id AND profile_id IS NOT NEW.profile_id) BEGIN SELECT RAISE(ABORT, 'Session profile is immutable.'); END"],
].map(([name,sql]) => [name, normalizeSql(sql)]));

// Fail closed on unknown dependent tables, relationships, or triggers before any DELETE.
export function validateProfileDeletionSchema(db) {
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
  const protectedTables = new Set(Object.keys(expected));
  const present = new Set(tables.map(row => identifier(row.name)));
  if ([...protectedTables].some(name => !present.has(name))) throw new Error('Unsupported profile deletion schema.');
  for (const {name} of tables) {
    const key=identifier(name), groups=new Map();
    for (const fk of db.prepare('SELECT * FROM pragma_foreign_key_list(?)').all(name)) {
      const rows=groups.get(fk.id) ?? []; rows.push(fk); groups.set(fk.id,rows);
    }
    const actual=[];
    for (const group of groups.values()) {
      group.sort((a,b)=>a.seq-b.seq);
      const first=group[0], parent=identifier(first.table);
      if (!protectedTables.has(key)) {
        if (protectedTables.has(parent)) throw new Error('Unsupported profile deletion dependency.');
        continue;
      }
      if (group.some(fk=>fk.to===null || identifier(fk.table)!==parent || fk.on_delete!==first.on_delete || fk.on_update!==first.on_update || fk.match!=='NONE')) throw new Error('Unsupported profile deletion dependency.');
      actual.push(`${parent}|${first.on_delete.toLowerCase()}|${first.on_update.toLowerCase()}|${group.map(fk=>`${identifier(fk.from)}:${identifier(fk.to)}`).join(',')}`);
    }
    if (protectedTables.has(key) && JSON.stringify(actual.sort())!==JSON.stringify([...expected[key]].sort())) throw new Error('Unsupported profile deletion dependency.');
  }
  const triggers=db.prepare("SELECT name,tbl_name,sql,0 AS temporary FROM sqlite_schema WHERE type='trigger' UNION ALL SELECT name,tbl_name,sql,1 AS temporary FROM sqlite_temp_schema WHERE type='trigger'").all();
  for (const trigger of triggers) {
    if (protectedTables.has(identifier(trigger.tbl_name)) && (trigger.temporary || !knownTriggers.has(identifier(trigger.name)) || !trigger.sql || knownTriggers.get(identifier(trigger.name))!==normalizeSql(trigger.sql))) throw new Error('Unsupported profile deletion trigger.');
  }
}
