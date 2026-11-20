/** Resolve one coherent session/profile snapshot without caching or writing. */
export function resolveSessionPersonalization(db, sessionId) {
  try {
    const row=db.prepare(`SELECT s.id AS sessionId, s.profile_id AS profileId,
      p.id AS resolvedId, p.revision AS profileRevision, p.habits, p.is_system AS isSystem
      FROM week3_sessions s LEFT JOIN context_profiles p ON p.id=s.profile_id WHERE s.id=?`).get(sessionId);
    if (!row) return {ok:false,error:'session_not_found'};
    if (typeof row.sessionId!=='string' || row.sessionId!==sessionId || typeof row.profileId!=='string' || !row.profileId.trim() || row.profileId!==row.profileId.trim()) return {ok:false,error:'invalid_association'};
    if (row.resolvedId===null) return {ok:false,error:'profile_not_found'};
    if (row.resolvedId!==row.profileId || !Number.isSafeInteger(row.profileRevision) || row.profileRevision<1 || typeof row.habits!=='string' || ![0,1].includes(row.isSystem) || (row.profileId==='general' ? row.isSystem!==1 || row.habits!=='' : row.isSystem!==0)) return {ok:false,error:'invalid_association'};
    return {ok:true,data:Object.freeze({sessionId:row.sessionId,profileId:row.profileId,profileRevision:row.profileRevision,habits:row.habits})};
  } catch {
    return {ok:false,error:'database_error'};
  }
}
