import { ROUTES } from '@/constants/routes';

export type AppSearchScope = 'expenses' | 'chat' | 'calls' | 'settings' | 'all';

type Listener = (scope: AppSearchScope) => void;

const listeners = new Set<Listener>();
let lastScope: AppSearchScope = 'expenses';

export const scopeForRoute = (routeName?: string): AppSearchScope | null => {
  switch (routeName) {
    case ROUTES.APP.GROUPS_TAB:
    case ROUTES.APP.GROUPS:
      return 'expenses';
    case ROUTES.APP.CHAT_TAB:
      return 'chat';
    case ROUTES.APP.CALLS_TAB:
      return 'calls';
    case ROUTES.APP.SETTINGS:
      return 'settings';
    default:
      return null;
  }
};

export const getLastSearchScope = (): AppSearchScope => lastScope;

export const setLastSearchScopeForRoute = (routeName?: string) => {
  const next = scopeForRoute(routeName);
  if (!next || next === lastScope) return;
  lastScope = next;
  listeners.forEach((listener) => listener(lastScope));
};

export const subscribeSearchScope = (listener: Listener): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

