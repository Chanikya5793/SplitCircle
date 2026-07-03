// Maps Firebase Auth error codes to friendly copy. Screens must never show
// raw SDK strings like "Firebase: Error (auth/invalid-credential)." —
// pass every caught auth error through here.

const MESSAGES: Record<string, string> = {
  'auth/invalid-credential': 'Incorrect email or password.',
  'auth/wrong-password': 'Incorrect email or password.',
  'auth/user-not-found': 'No account found with this email.',
  'auth/invalid-email': "That email address doesn't look right.",
  'auth/email-already-in-use': 'An account with this email already exists — try signing in instead.',
  'auth/weak-password': 'Password must be at least 6 characters.',
  'auth/too-many-requests': 'Too many attempts. Please wait a moment and try again.',
  'auth/network-request-failed': "You're offline. Connect to the internet and try again.",
  'auth/user-disabled': 'This account has been disabled.',
  'auth/expired-action-code': 'That link has expired. Request a new one.',
  'auth/missing-email': 'Enter your email address first.',
};

export const friendlyAuthError = (error: unknown): string => {
  const code =
    (error as { code?: string })?.code ??
    // Firebase JS SDK messages embed the code: "Firebase: Error (auth/...)."
    (typeof (error as Error)?.message === 'string'
      ? /\((auth\/[a-z-]+)\)/.exec((error as Error).message)?.[1]
      : undefined);

  if (code && MESSAGES[code]) return MESSAGES[code];
  return 'Something went wrong. Please try again.';
};
