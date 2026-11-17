const validId = id => id === 'general' || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
const validName = name => typeof name === 'string' && name.trim().length > 0 && name.trim().length <= 200 && name.trim().toLowerCase() !== 'general';
const validHabits = habits => typeof habits === 'string' && habits.length <= 50000;

/** HTTP boundary only; profile mutations and system protection belong to the repository. */
export function createContextProfileRoutes(profiles) {
  return async (req, path, reply) => {
    if (path !== '/api/users' && !path.startsWith('/api/users/')) return false;
    const id = path === '/api/users' ? null : path.slice('/api/users/'.length);
    if (id !== null && !validId(id)) { reply(400,{error:'Invalid profile ID.'}); return true; }
    if (req.method === 'GET') {
      if (id === null) reply(200,profiles.list());
      else { const profile=profiles.get(id); reply(profile ? 200 : 404,profile ?? {error:'Profile not found.'}); }
      return true;
    }
    if (req.method === 'DELETE' && id !== null) {
      if (id === 'general') { reply(403,{error:'General cannot be deleted.'}); return true; }
      if (!profiles.delete(id)) reply(404,{error:'Profile not found.'});
      else reply(200,{id,deleted:true});
      return true;
    }
    if ((req.method !== 'POST' || id !== null) && (req.method !== 'PATCH' || id === null)) { reply(405,{error:'Method not allowed.'}); return true; }
    if (id === 'general') { reply(403,{error:'General cannot be modified.'}); return true; }
    let body='';
    for await (const chunk of req) { body+=chunk; if (Buffer.byteLength(body)>1048576) { reply(413,{error:'Request too large.'}); return true; } }
    let value; try { value=JSON.parse(body); } catch { reply(400,{error:'Invalid JSON.'}); return true; }
    const allowed = id === null ? ['name','habits'] : ['name','habits','expectedRevision'];
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key=>!allowed.includes(key)) || !validName(value.name) || !validHabits(value.habits === undefined && id === null ? '' : value.habits) || (id !== null && (!Number.isSafeInteger(value.expectedRevision) || value.expectedRevision<1))) {
      reply(400,{error:'Invalid profile input.'}); return true;
    }
    if (id === null) { reply(201,profiles.create(value.name,value.habits ?? '')); return true; }
    const current=profiles.get(id);
    if (!current) { reply(404,{error:'Profile not found.'}); return true; }
    if (current.revision !== value.expectedRevision) { reply(409,{error:'Profile revision conflict.'}); return true; }
    try { reply(200,profiles.update(id,value.name,value.habits,value.expectedRevision)); }
    catch (error) {
      const latest=profiles.get(id);
      if (!latest) reply(404,{error:'Profile not found.'});
      else if (latest.revision !== value.expectedRevision) reply(409,{error:'Profile revision conflict.'});
      else throw error;
    }
    return true;
  };
}
