/** Soft two-tone chime for high-intent alerts — WebAudio, no assets. */

let ctx: AudioContext | null = null;

function ensureCtx(): AudioContext | null {
  try {
    if (!ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      ctx = new Ctor();
    }
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

export function chime(kind: "alert" | "info" = "alert"): void {
  const audio = ensureCtx();
  if (!audio) return;
  try {
    const now = audio.currentTime;
    const notes = kind === "alert" ? [880, 659.25] : [523.25];
    notes.forEach((freq, i) => {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const t0 = now + i * 0.13;
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(0.035, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.24);
      osc.connect(gain);
      gain.connect(audio.destination);
      osc.start(t0);
      osc.stop(t0 + 0.26);
    });
  } catch {
    /* autoplay restrictions — silent degradation */
  }
}
