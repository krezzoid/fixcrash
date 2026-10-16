export interface Profile {
  id: string;
  name: string;
  avatarUrl: string;
}

interface ProfileResponse {
  id: string;
  name: string;
  avatar: { url: string };
}

export function parseProfile(json: string): Profile {
  const raw = JSON.parse(json) as ProfileResponse;
  return { id: raw.id, name: raw.name, avatarUrl: raw.avatar.url };
}
