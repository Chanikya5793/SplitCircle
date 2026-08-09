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

export const friendlyAuthError = (error: unknown, provider?: 'google' | 'apple'): string => {
  const code =
    (error as { code?: string })?.code ??
    // Firebase JS SDK messages embed the code: "Firebase: Error (auth/...)."
    (typeof (error as Error)?.message === 'string'
      ? /\((auth\/[a-z-]+)\)/.exec((error as Error).message)?.[1]
      : undefined);

  // auth/invalid-credential is the code Firebase's OAuth (Google/Apple) token
  // exchange throws too — MESSAGES' "Incorrect email or password" is actively
  // wrong there, since neither flow involves typing either.
  if (provider && code === 'auth/invalid-credential') {
    return provider === 'apple'
      ? "We couldn't verify your Apple sign-in. Please try again."
      : "We couldn't verify your Google sign-in. Please try again.";
  }

  if (code && MESSAGES[code]) return MESSAGES[code];

  // Anything reaching here is an auth failure we have no copy for, and the
  // fallback tells the user — and whoever they report it to — nothing at all.
  // console.error, not console.warn or debugLog: a Release bundle's warn never
  // reaches the device log, so this is the only level that stays diagnosable in
  // the builds where it actually matters (see CLAUDE.md).
  console.error(
    `[auth] unmapped failure — code=${code ?? 'none'} message=${
      (error as Error)?.message ?? String(error)
    }`,
  );
  return 'Something went wrong. Please try again.';
};
