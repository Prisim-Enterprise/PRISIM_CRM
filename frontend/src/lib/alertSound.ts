// A short chime for alerts that need someone to act: new leads, untouched leads, overdue follow-ups.
// Made with the Web Audio API, so there is no sound file to load.
// Browsers only allow sound after the person has clicked or typed on the page once; until then it is silent.

const KEY = 'prisim-alert-sound';

/** Alert types that chime. Everything else only shows in the bell and as a desktop notification. */
export const LOUD_TYPES = new Set([
  'lead.new', 'lead.imported', 'lead.assigned', 'lead.stale', 'lead.escalated', 'lead.resubmitted',
  'followup.reminder', 'followup.overdue', 'followup.escalated', 'task.overdue',
]);

export const soundEnabled = () => {
  try { return localStorage.getItem(KEY) !== 'off'; } catch { return true; }
};
export const setSoundEnabled = (on: boolean) => {
  try { localStorage.setItem(KEY, on ? 'on' : 'off'); } catch { /* private mode: stays on for this visit */ }
};

let ctx: AudioContext | null = null;
const audio = () => {
  if (!ctx) {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  return ctx;
};

/** Call once at start-up: the first click or key press unlocks sound for the rest of the visit. */
export function unlockSoundOnFirstGesture() {
  const unlock = () => {
    void audio()?.resume();
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('keydown', unlock);
  };
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);
}

let lastPlayed = 0;

/** Two soft rising notes. At most once every 3 seconds, so a batch of alerts is one chime. */
export function playAlertSound(force = false) {
  if (!force && !soundEnabled()) return;
  const now = Date.now();
  if (now - lastPlayed < 3000) return;
  const c = audio();
  if (!c || c.state !== 'running') return;
  lastPlayed = now;
  const start = c.currentTime;
  [[880, 0], [1320, 0.16]].forEach(([freq, at]) => {
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, start + at);
    gain.gain.exponentialRampToValueAtTime(0.25, start + at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + at + 0.35);
    osc.connect(gain).connect(c.destination);
    osc.start(start + at);
    osc.stop(start + at + 0.4);
  });
}
