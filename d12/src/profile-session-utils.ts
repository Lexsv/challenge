import type { SessionMetadata } from './week3-session-api';
import type { ContextProfile } from './users-page';

export function sessionCounts(sessions:readonly SessionMetadata[]):Record<string,number> | null {
  if(sessions.some(session=>typeof session.profileId!=='string' || !session.profileId)) return null;
  const counts:Record<string,number>=Object.create(null);
  for(const session of sessions) counts[session.profileId!] = (counts[session.profileId!] ?? 0)+1;
  return counts;
}

export function profileName(profileId:string | undefined, profiles:readonly ContextProfile[]):string {
  return profiles.find(profile=>profile.id===profileId)?.name ?? 'Unknown profile';
}
