import {
  getDatabase,
  onValue,
  ref,
  remove,
  set,
  update,
} from 'firebase/database';

export type FriendSource = 'group' | 'debt' | 'manual';

export interface Friend {
  /** The other user's userId. Mirrors the RTDB key. */
  userId: string;
  /** Strongest of the materialization sources. `manual` > `debt` > `group`. */
  source: FriendSource;
  /** When this friendship was first created (ms epoch). */
  since: number;
  /** Last interaction timestamp — used to sort the Friends list. */
  lastInteractionAt?: number;
  /** User-pinned to top of the list. */
  isPinned?: boolean;
  /** Soft-hide from the list without deleting (so debt-derived re-creation
   *  doesn't resurface them). */
  hidden?: boolean;
}

const FRIENDS_PATH = 'friends';

const sanitizeFriend = (key: string, raw: unknown): Friend | null => {
  if (!raw || typeof raw !== 'object') return null;
  const data = raw as Record<string, unknown>;
  const source = data.source;
  const since = data.since;
  if (source !== 'group' && source !== 'debt' && source !== 'manual') return null;
  if (typeof since !== 'number') return null;
  return {
    userId: key,
    source,
    since,
    lastInteractionAt: typeof data.lastInteractionAt === 'number' ? data.lastInteractionAt : undefined,
    isPinned: data.isPinned === true,
    hidden: data.hidden === true,
  };
};

/**
 * Live-subscribe to the signed-in user's friends list. Returns an unsubscribe.
 * The callback fires once on initial load and again on every server change.
 */
export const subscribeToFriends = (
  ownerUid: string,
  callback: (friends: Friend[]) => void,
): (() => void) => {
  if (!ownerUid) {
    callback([]);
    return () => undefined;
  }

  const friendsRef = ref(getDatabase(), `${FRIENDS_PATH}/${ownerUid}`);
  return onValue(friendsRef, (snapshot) => {
    const value = snapshot.val();
    if (!value || typeof value !== 'object') {
      callback([]);
      return;
    }
    const friends: Friend[] = [];
    for (const key of Object.keys(value)) {
      const friend = sanitizeFriend(key, (value as Record<string, unknown>)[key]);
      if (friend) friends.push(friend);
    }
    callback(friends);
  }, (error) => {
    console.warn('subscribeToFriends failed', error);
    callback([]);
  });
};

/**
 * Manually add another user to your friends list. RTDB rules permit writes
 * only to your own `/friends/{ownerUid}/...`, so this does NOT mirror to the
 * other user's list — that's by design (privacy: friending is one-sided
 * unless promoted via mutual group/debt by a server trigger).
 */
export const addFriendManually = async (
  ownerUid: string,
  friendUid: string,
): Promise<void> => {
  if (!ownerUid || !friendUid || ownerUid === friendUid) return;
  const friendRef = ref(getDatabase(), `${FRIENDS_PATH}/${ownerUid}/${friendUid}`);
  const now = Date.now();
  await set(friendRef, {
    source: 'manual',
    since: now,
    lastInteractionAt: now,
  });
};

export const removeFriend = async (
  ownerUid: string,
  friendUid: string,
): Promise<void> => {
  if (!ownerUid || !friendUid) return;
  await remove(ref(getDatabase(), `${FRIENDS_PATH}/${ownerUid}/${friendUid}`));
};

export const setFriendPinned = async (
  ownerUid: string,
  friendUid: string,
  isPinned: boolean,
): Promise<void> => {
  await update(ref(getDatabase(), `${FRIENDS_PATH}/${ownerUid}/${friendUid}`), {
    isPinned: isPinned ? true : null,
  });
};

export const setFriendHidden = async (
  ownerUid: string,
  friendUid: string,
  hidden: boolean,
): Promise<void> => {
  await update(ref(getDatabase(), `${FRIENDS_PATH}/${ownerUid}/${friendUid}`), {
    hidden: hidden ? true : null,
  });
};
