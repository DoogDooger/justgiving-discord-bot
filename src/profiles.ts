import { Routes, type APIUser, type REST } from 'discord.js';

export interface Profile {
  name: string;
  avatarUrl: string;
}

const TTL_MS = 6 * 60 * 60 * 1000;

/** Discord's default avatar for users without a custom one. */
export function defaultAvatarUrl(discordUserId: string): string {
  const index = Number((BigInt(discordUserId) >> 22n) % 6n);
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

export function avatarUrl(user: Pick<APIUser, 'id' | 'avatar'>, size = 96): string {
  if (!user.avatar) return defaultAvatarUrl(user.id);
  const ext = user.avatar.startsWith('a_') ? 'gif' : 'png';
  return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${ext}?size=${size}`;
}

/**
 * Looks up Discord display names and avatars for the donor wall, by user ID over
 * REST (no intents needed). Kept in memory only, refreshed every few hours.
 */
export class ProfileDirectory {
  private readonly cache = new Map<string, { at: number; value: Profile }>();

  constructor(private readonly rest: Pick<REST, 'get'>) {}

  async get(discordUserId: string): Promise<Profile> {
    const cached = this.cache.get(discordUserId);
    if (cached && Date.now() - cached.at < TTL_MS) return cached.value;
    try {
      const user = (await this.rest.get(Routes.user(discordUserId))) as APIUser;
      const value = { name: user.global_name || user.username, avatarUrl: avatarUrl(user) };
      this.cache.set(discordUserId, { at: Date.now(), value });
      return value;
    } catch {
      return cached?.value ?? { name: 'A generous donor', avatarUrl: defaultAvatarUrl(discordUserId) };
    }
  }

  async getMany(discordUserIds: string[]): Promise<Map<string, Profile>> {
    const unique = [...new Set(discordUserIds)];
    const results = await Promise.all(unique.map(async (id) => [id, await this.get(id)] as const));
    return new Map(results);
  }
}
