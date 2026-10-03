import { Routes, type APIUser, type REST } from 'discord.js';
import { UserOperations } from './user-operations.js';

export interface Profile {
  name: string;
  avatarUrl: string;
}

const TTL_MS = 6 * 60 * 60 * 1000;

function isProfileUser(value: unknown): value is Pick<APIUser, 'id' | 'username' | 'global_name' | 'avatar'> {
  return typeof value === 'object' && value !== null &&
    'id' in value && typeof value.id === 'string' &&
    'username' in value && typeof value.username === 'string' &&
    'global_name' in value && (value.global_name === null || typeof value.global_name === 'string') &&
    'avatar' in value && (value.avatar === null || typeof value.avatar === 'string');
}

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

  private readonly operations = new UserOperations();

  constructor(private readonly rest: Pick<REST, 'get'>) {}

  /** Read a profile; late responses after forgetting cannot repopulate the cache. */
  async get(discordUserId: string): Promise<Profile> {
    const cached = this.cache.get(discordUserId);
    if (cached && Date.now() - cached.at < TTL_MS) return cached.value;
    const fallback = { name: 'A generous donor', avatarUrl: defaultAvatarUrl(discordUserId) };
    const operation = this.operations.begin(discordUserId);
    try {
      const user = await this.rest.get(Routes.user(discordUserId));
      if (!operation.isCurrent()) return fallback;
      if (!isProfileUser(user) || user.id !== discordUserId) return fallback;
      const value = { name: user.global_name || user.username, avatarUrl: avatarUrl(user) };
      this.cache.set(discordUserId, { at: Date.now(), value });
      return value;
    } catch {
      return operation.isCurrent() ? cached?.value ?? fallback : fallback;
    } finally {
      operation.finish();
    }
  }

  /** Evict this user and invalidate all currently pending lookups without a retained user tombstone. */
  forget(discordUserId: string): void {
    this.operations.forget(discordUserId);
    this.cache.delete(discordUserId);
  }

  /** Resolve the bounded donor-wall batch, deduplicating user IDs. */
  async getMany(discordUserIds: string[]): Promise<Map<string, Profile>> {
    const unique = [...new Set(discordUserIds)];
    const results = await Promise.all(unique.map(async (id) => [id, await this.get(id)] as const));
    return new Map(results);
  }
}
