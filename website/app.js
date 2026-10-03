const header = document.querySelector('.site-header');

const navLinks = document.querySelector('.nav-links');
const themeButton = document.createElement('button');
themeButton.className = 'theme-toggle';
themeButton.type = 'button';
themeButton.innerHTML = `
  <svg class="sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="3.5"/><path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.66 6.34l1.41-1.41"/></svg>
  <svg class="moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M20.2 15.5A8.5 8.5 0 0 1 8.5 3.8 8.5 8.5 0 1 0 20.2 15.5Z"/></svg>`;

const syncThemeButton = () => {
  const dark = document.documentElement.dataset.theme === 'dark';
  themeButton.setAttribute('aria-pressed', dark.toString());
  themeButton.setAttribute('aria-label', `Switch to ${dark ? 'light' : 'dark'} mode`);
  themeButton.title = `Switch to ${dark ? 'light' : 'dark'} mode`;
};

if (navLinks) {
  navLinks.insertBefore(themeButton, navLinks.querySelector('.button'));
  syncThemeButton();
  themeButton.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('manasplit-theme', next); } catch {}
    syncThemeButton();
  });
}

const updateHeader = () => {
  header?.classList.toggle('scrolled', window.scrollY > 18);
};

updateHeader();
window.addEventListener('scroll', updateHeader, { passive: true });

document.querySelectorAll('[data-year]').forEach((node) => {
  node.textContent = new Date().getFullYear().toString();
});

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const spatialStage = document.querySelector('[data-spatial-stage]');

if (spatialStage && !reducedMotion.matches) {
  spatialStage.addEventListener('pointermove', (event) => {
    const rect = spatialStage.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width - 0.5;
    const y = (event.clientY - rect.top) / rect.height - 0.5;
    spatialStage.style.setProperty('--stage-x', `${y * -7}deg`);
    spatialStage.style.setProperty('--stage-y', `${x * 8}deg`);
  });
  spatialStage.addEventListener('pointerleave', () => {
    spatialStage.style.setProperty('--stage-x', '0deg');
    spatialStage.style.setProperty('--stage-y', '0deg');
  });
}

const orbitLabels = [...document.querySelectorAll('[data-orbit-label]')];
let orbitFrame = 0;
let orbitVisible = true;

const positionOrbitLabels = (time, staticPosition = false) => {
  if (!spatialStage || !orbitLabels.length) return;
  const rect = spatialStage.getBoundingClientRect();
  const radiusX = Math.min(rect.width * (window.innerWidth < 600 ? 0.34 : 0.41), 286);
  const radiusY = Math.min(rect.height * 0.265, 172);
  const travel = staticPosition ? 0 : (time / 10500) * Math.PI * 2;

  orbitLabels.forEach((label) => {
    const phase = Number(label.dataset.phase || 0);
    const angle = travel + phase;
    const depth = Math.sin(angle);
    const x = Math.cos(angle) * radiusX;
    const y = Math.sin(angle) * radiusY;
    const scale = staticPosition ? 1 : 0.78 + ((depth + 1) / 2) * 0.28;
    label.style.setProperty('--orbit-x', `${x.toFixed(1)}px`);
    label.style.setProperty('--orbit-y', `${y.toFixed(1)}px`);
    label.style.setProperty('--orbit-scale', scale.toFixed(3));
    label.style.opacity = staticPosition ? '1' : (0.48 + ((depth + 1) / 2) * 0.52).toFixed(3);
    label.style.zIndex = staticPosition || depth > 0 ? '7' : '2';
    label.style.filter = !staticPosition && depth < -0.45 ? 'blur(.35px)' : 'none';
  });
};

const animateOrbit = (time) => {
  positionOrbitLabels(time);
  if (orbitVisible && !document.hidden) orbitFrame = requestAnimationFrame(animateOrbit);
};

if (spatialStage && orbitLabels.length) {
  if (reducedMotion.matches) {
    positionOrbitLabels(0, true);
  } else {
    const orbitObserver = new IntersectionObserver(([entry]) => {
      orbitVisible = entry.isIntersecting;
      cancelAnimationFrame(orbitFrame);
      if (orbitVisible) orbitFrame = requestAnimationFrame(animateOrbit);
    }, { threshold: 0.01 });
    orbitObserver.observe(spatialStage);
    orbitFrame = requestAnimationFrame(animateOrbit);
    document.addEventListener('visibilitychange', () => {
      cancelAnimationFrame(orbitFrame);
      if (!document.hidden && orbitVisible) orbitFrame = requestAnimationFrame(animateOrbit);
    });
  }
}

const storySteps = [...document.querySelectorAll('[data-story]')];
const storyScenes = [...document.querySelectorAll('[data-scene]')];

const activateStory = (name) => {
  storySteps.forEach((step) => step.classList.toggle('is-active', step.dataset.story === name));
  storyScenes.forEach((scene) => scene.classList.toggle('is-active', scene.dataset.scene === name));
};

if ('IntersectionObserver' in window && storySteps.length) {
  const storyObserver = new IntersectionObserver((entries) => {
    const visible = entries
      .filter((entry) => entry.isIntersecting)
      .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
    if (visible?.target.dataset.story) activateStory(visible.target.dataset.story);
  }, { rootMargin: '-28% 0px -36%', threshold: [0.1, 0.35, 0.6] });
  storySteps.forEach((step) => storyObserver.observe(step));
}

const revealNodes = document.querySelectorAll('[data-reveal]');
if ('IntersectionObserver' in window && !reducedMotion.matches) {
  const revealObserver = new IntersectionObserver((entries, observer) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add('in-view');
      observer.unobserve(entry.target);
    });
  }, { rootMargin: '0px 0px -12%' });
  revealNodes.forEach((node) => revealObserver.observe(node));
} else {
  revealNodes.forEach((node) => node.classList.add('in-view'));
}

const lowerJourney = document.querySelector('[data-lower-journey]');
let journeyTicking = false;

const updateLowerJourney = () => {
  journeyTicking = false;
  if (!lowerJourney || reducedMotion.matches) return;
  const rect = lowerJourney.getBoundingClientRect();
  const travel = Math.max(rect.height - window.innerHeight * 0.35, 1);
  const progress = Math.min(1, Math.max(0, (window.innerHeight * 0.72 - rect.top) / travel));
  lowerJourney.style.setProperty('--journey-progress', progress.toFixed(4));
};

const requestJourneyUpdate = () => {
  if (journeyTicking) return;
  journeyTicking = true;
  requestAnimationFrame(updateLowerJourney);
};

if (lowerJourney) {
  if (reducedMotion.matches) {
    lowerJourney.style.setProperty('--journey-progress', '1');
  } else {
    updateLowerJourney();
    window.addEventListener('scroll', requestJourneyUpdate, { passive: true });
    window.addEventListener('resize', requestJourneyUpdate, { passive: true });
  }
}

const attachSpatialTilt = (node, xProperty, yProperty, strength = 5) => {
  if (!node || reducedMotion.matches) return;
  node.addEventListener('pointermove', (event) => {
    const rect = node.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width - 0.5;
    const y = (event.clientY - rect.top) / rect.height - 0.5;
    node.style.setProperty(xProperty, `${(-y * strength).toFixed(2)}deg`);
    node.style.setProperty(yProperty, `${(x * strength).toFixed(2)}deg`);
  });
  node.addEventListener('pointerleave', () => {
    node.style.setProperty(xProperty, '0deg');
    node.style.setProperty(yProperty, '0deg');
  });
};

attachSpatialTilt(document.querySelector('.privacy-panel'), '--model-x', '--model-y', 9);
attachSpatialTilt(document.querySelector('[data-depth-stack]'), '--stack-x', '--stack-y', 5);
