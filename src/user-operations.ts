/** A request-scoped guard: forgetting invalidates pending work, not already dispatched I/O. */
export interface UserOperation {
  /** False after forgetting; check after awaits and before user-linked writes. */
  isCurrent(): boolean;
  /** Release the in-memory request identity in a finally block. */
  finish(): void;
}

/** Single-process lifetime owner for user-linked work that can overlap /donor-forget. */
export class UserOperations {
  private readonly pending = new Map<string, Set<{ current: boolean }>>();

  /** Track one request. There are no durable user tombstones or completed-request history. */
  begin(userId: string): UserOperation {
    const operation = { current: true };
    const group = this.pending.get(userId) ?? new Set();
    group.add(operation);
    this.pending.set(userId, group);
    return {
      isCurrent: () => operation.current,
      finish: () => {
        group.delete(operation);
        if (group.size === 0 && this.pending.get(userId) === group) this.pending.delete(userId);
      },
    };
  }

  /** Invalidate and release all pending requests for this user without retaining their ID. */
  forget(userId: string): void {
    for (const operation of this.pending.get(userId) ?? []) operation.current = false;
    this.pending.delete(userId);
  }
}
