(() => {
  let stored = null;
  try { stored = localStorage.getItem('manasplit-theme'); } catch {}
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = stored || (systemDark ? 'dark' : 'light');
})();
