export const formatRelativeTime = (timestamp: number): string => {
  const deltaMs = Date.now() - timestamp;
  const deltaMinutes = Math.floor(deltaMs / 60000);
  if (deltaMinutes < 1) return 'just now';
  if (deltaMinutes < 60) return `${deltaMinutes}m ago`;
  const deltaHours = Math.floor(deltaMinutes / 60);
  if (deltaHours < 24) return `${deltaHours}h ago`;
  const deltaDays = Math.floor(deltaHours / 24);
  return `${deltaDays}d ago`;
};

export const formatDate = (timestamp: number): string =>
  new Date(timestamp).toLocaleDateString();
