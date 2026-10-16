import type { SpeakerEvent } from './forth-boot';

// How far ahead of the emulation speaker changes are scheduled. A frame runs at most 100 ms of game time, so its
// events still lie in the future when they are scheduled.
const LATENCY_SECONDS = 0.12;
const VOLUME = 0.08;
// The speaker cone's rise time, short enough to keep notes crisp without clicking on every change.
const RAMP_SECONDS = 0.002;

// The PC speaker as a Web Audio square wave: the runner reports tone changes in emulated milliseconds, and each
// animation frame schedules the ones it ran, relative to the game time it reached.
export class SpeakerAudio {
  private context?: AudioContext;
  private oscillator?: OscillatorNode;
  private gain?: GainNode;
  // After silence(), the speaker may still be sounding in the game; the next play() restores its tone.
  private needsSync = true;

  // Create or resume the audio context. Browsers only allow this from a user gesture such as a click or key press.
  resume(): void {
    if (!this.context) {
      const context = new AudioContext();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = 'square';
      gain.gain.value = 0;
      oscillator.connect(gain).connect(context.destination);
      oscillator.start();
      this.context = context;
      this.oscillator = oscillator;
      this.gain = gain;
    }
    if (this.context.state === 'suspended') void this.context.resume();
  }

  // Schedule `events`, which happened up to the emulated time `nowMilliseconds`; `tone` is the speaker's tone now.
  play(events: readonly SpeakerEvent[], nowMilliseconds: number, tone: number): void {
    const context = this.context;
    if (!context || context.state !== 'running') return;
    const base = context.currentTime + LATENCY_SECONDS;
    if (events.length === 0 && this.needsSync) this.set(tone, base);
    for (const event of events) {
      this.set(event.frequency, Math.max(context.currentTime, base - (nowMilliseconds - event.milliseconds) / 1000));
    }
    this.needsSync = false;
  }

  // Stop any sound at once, e.g. while the game is paused, hidden or skipping ahead.
  silence(): void {
    this.needsSync = true;
    if (!this.context || !this.gain) return;
    const now = this.context.currentTime;
    this.gain.gain.cancelScheduledValues(now);
    this.gain.gain.setTargetAtTime(0, now, RAMP_SECONDS);
  }

  private set(frequency: number, time: number): void {
    if (!this.oscillator || !this.gain) return;
    if (frequency > 0) this.oscillator.frequency.setValueAtTime(Math.min(frequency, 20000), time);
    this.gain.gain.setTargetAtTime(frequency > 0 ? VOLUME : 0, time, RAMP_SECONDS);
  }
}
