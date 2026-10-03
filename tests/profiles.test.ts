import { describe, expect, it } from 'vitest';
import { ProfileDirectory } from '../src/profiles.js';
import { USER_A, deferred } from './helpers.js';

describe('profile erasure', () => {
  it('evicts cached names and does not repopulate them from an in-flight request', async () => {
    const response = deferred<unknown>();
    let calls = 0;
    const profiles = new ProfileDirectory({
      get: async () => {
        calls++;
        return calls === 1 ? response.promise : { id: USER_A, username: 'New name', global_name: null, avatar: null };
      },
    });
    const pending = profiles.get(USER_A);
    profiles.forget(USER_A);
    response.resolve({ id: USER_A, username: 'Old name', global_name: null, avatar: null });
    expect((await pending).name).toBe('A generous donor');
    expect((await profiles.get(USER_A)).name).toBe('New name');
    expect(calls).toBe(2);
    await profiles.get(USER_A);
    expect(calls).toBe(2);
    profiles.forget(USER_A);
    await profiles.get(USER_A);
    expect(calls).toBe(3);
  });
});
