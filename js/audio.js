// PixelRealms — audio.js
// Procedural ambient music + sound effects via Web Audio API. No files needed.

const AudioEngine = (() => {
  let ctx = null;
  let masterGain = null;
  let musicGain = null;
  let sfxGain = null;
  let muted = localStorage.getItem('pr_muted') === 'true';
  let musicRunning = false;
  let schedulerTimer = null;
  let nextChordTime = 0;
  let chordIndex = 0;

  // Am · F · C · G · Dm · F — slightly extended for more variety
  const CHORDS = [
    [110,   220,   261.63, 329.63],  // Am
    [174.61,220,   261.63, 349.23],  // F
    [130.81,196,   261.63, 329.63],  // C
    [196,   246.94,293.66, 392],     // G
    [146.83,220,   293.66, 349.23],  // Dm
    [174.61,220,   261.63, 329.63],  // F
  ];

  const CHORD_DURATION = 6;
  const CHORD_OVERLAP  = 2;
  const LOOKAHEAD      = 18;

  function init() {
    if (ctx) return;
    ctx = new (window.AudioContext || window.webkitAudioContext)();

    masterGain = ctx.createGain();
    masterGain.gain.value = muted ? 0 : 1;
    masterGain.connect(ctx.destination);

    musicGain = ctx.createGain();
    musicGain.gain.value = 0.18; // quieter overall
    musicGain.connect(masterGain);

    sfxGain = ctx.createGain();
    sfxGain.gain.value = 0.65;
    sfxGain.connect(masterGain);
  }

  function makeReverb(duration = 2.2, decay = 3) {
    const len = Math.floor(ctx.sampleRate * duration);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    const conv = ctx.createConvolver();
    conv.buffer = buf;
    return conv;
  }

  function playPad(freqs, startTime) {
    const dur = CHORD_DURATION + CHORD_OVERLAP;
    const reverb  = makeReverb();
    const revGain = ctx.createGain();
    revGain.gain.value = 0.4;
    reverb.connect(revGain);
    revGain.connect(musicGain);

    freqs.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const g   = ctx.createGain();
      osc.type = i === 0 ? 'sine' : 'triangle';
      osc.frequency.value = freq;
      osc.detune.value = (i % 2 === 0 ? 1 : -1) * (i * 3);

      const vol = i === 0 ? 0.06 : 0.045;
      g.gain.setValueAtTime(0, startTime);
      g.gain.linearRampToValueAtTime(vol, startTime + 1.8);
      g.gain.setValueAtTime(vol, startTime + dur - CHORD_OVERLAP);
      g.gain.linearRampToValueAtTime(0, startTime + dur);

      osc.connect(g);
      g.connect(musicGain);
      g.connect(reverb);
      osc.start(startTime);
      osc.stop(startTime + dur + 0.1);
    });
  }

  // Gentle arpeggio — plays chord notes one by one, high octave, soft
  function playArpeggio(freqs, startTime) {
    const dur    = CHORD_DURATION + CHORD_OVERLAP;
    const step   = CHORD_DURATION / (freqs.length * 2);
    const reverb = makeReverb(1.2, 4);
    const revG   = ctx.createGain();
    revG.gain.value = 0.25;
    reverb.connect(revG);
    revG.connect(musicGain);

    freqs.forEach((freq, i) => {
      // Play each note twice — once ascending, once descending
      [i, freqs.length - 1 - i].forEach((idx, pass) => {
        const t   = startTime + (i + pass * freqs.length) * step;
        const osc = ctx.createOscillator();
        const g   = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freqs[idx] * 2; // upper octave
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(0.018, t + 0.04);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.55);
        osc.connect(g);
        g.connect(musicGain);
        g.connect(reverb);
        osc.start(t);
        osc.stop(t + 0.6);
      });
    });
  }

  // Slow walking melody — picks a note from the chord and wanders slightly
  const MELODY_OFFSETS = [0, 2, 1, 3, 1, 0, 2, 3]; // index into chord freqs
  let melodyStep = 0;
  function playMelodyNote(freqs, startTime) {
    const idx  = MELODY_OFFSETS[melodyStep % MELODY_OFFSETS.length] % freqs.length;
    melodyStep++;
    const freq = freqs[idx] * 4; // two octaves up
    const t    = startTime + Math.random() * 1.5; // slight timing drift for humanity
    const osc  = ctx.createOscillator();
    const g    = ctx.createGain();
    const reverb = makeReverb(1.5, 4);
    const revG   = ctx.createGain();
    revG.gain.value = 0.3;
    reverb.connect(revG);
    revG.connect(musicGain);

    osc.type = 'sine';
    osc.frequency.value = freq;
    osc.detune.value = (Math.random() - 0.5) * 8; // tiny human pitch wobble
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.012, t + 0.08);
    g.gain.exponentialRampToValueAtTime(0.001, t + 1.2);
    osc.connect(g);
    g.connect(musicGain);
    osc.connect(reverb);
    osc.start(t);
    osc.stop(t + 1.4);
  }

  function scheduleChords() {
    if (!ctx || !musicRunning) return;
    const now = ctx.currentTime;
    while (nextChordTime < now + LOOKAHEAD) {
      const t     = Math.max(nextChordTime, now + 0.05);
      const chord = CHORDS[chordIndex % CHORDS.length];
      playPad(chord, t);
      playArpeggio(chord, t);
      playMelodyNote(chord, t);
      chordIndex++;
      nextChordTime += CHORD_DURATION;
    }
  }

  async function startMusic() {
    if (musicRunning) return;
    musicRunning = true;
    nextChordTime = ctx.currentTime + 0.3;
    scheduleChords();
    schedulerTimer = setInterval(scheduleChords, 2500);
  }

  // ── Sound Effects ──────────────────────────────────────────

  function playExpand() {
    if (!ctx || muted) return;
    [523.25, 659.25, 783.99].forEach((freq, i) => {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      const t    = ctx.currentTime + i * 0.09;
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.18, t + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
      osc.connect(gain);
      gain.connect(sfxGain);
      osc.start(t);
      osc.stop(t + 0.5);
    });
  }

  function playBuild() {
    if (!ctx || muted) return;
    const t = ctx.currentTime;
    const osc1  = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.type = 'triangle';
    osc1.frequency.setValueAtTime(380, t);
    osc1.frequency.exponentialRampToValueAtTime(180, t + 0.12);
    gain1.gain.setValueAtTime(0.28, t);
    gain1.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
    osc1.connect(gain1);
    gain1.connect(sfxGain);
    osc1.start(t);
    osc1.stop(t + 0.3);

    const osc2  = ctx.createOscillator();
    const gain2 = ctx.createGain();
    const t2    = t + 0.1;
    osc2.type = 'sine';
    osc2.frequency.value = 1046.5;
    gain2.gain.setValueAtTime(0, t2);
    gain2.gain.linearRampToValueAtTime(0.12, t2 + 0.02);
    gain2.gain.exponentialRampToValueAtTime(0.001, t2 + 0.6);
    osc2.connect(gain2);
    gain2.connect(sfxGain);
    osc2.start(t2);
    osc2.stop(t2 + 0.65);
  }

  function playAttack() {
    if (!ctx || muted) return;
    const t = ctx.currentTime;
    const bufLen = Math.floor(ctx.sampleRate * 0.3);
    const buf    = ctx.createBuffer(1, bufLen, ctx.sampleRate);
    const data   = buf.getChannelData(0);
    for (let i = 0; i < bufLen; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / bufLen, 3);
    const noise  = ctx.createBufferSource();
    noise.buffer = buf;
    const lpf    = ctx.createBiquadFilter();
    lpf.type = 'lowpass';
    lpf.frequency.value = 180;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.45, t);
    ng.gain.exponentialRampToValueAtTime(0.001, t + 0.28);
    noise.connect(lpf);
    lpf.connect(ng);
    ng.connect(sfxGain);
    noise.start(t);
    noise.stop(t + 0.35);

    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(140, t);
    osc.frequency.exponentialRampToValueAtTime(38, t + 0.22);
    gain.gain.setValueAtTime(0.32, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.28);
    osc.connect(gain);
    gain.connect(sfxGain);
    osc.start(t);
    osc.stop(t + 0.35);
  }

  // ── Controls ───────────────────────────────────────────────

  function toggleMute() {
    muted = !muted;
    localStorage.setItem('pr_muted', muted);
    if (masterGain) masterGain.gain.setTargetAtTime(muted ? 0 : 1, ctx.currentTime, 0.2);
    return muted;
  }

  function isMuted() { return muted; }

  // Call on any user interaction — safe to call multiple times
  async function unlock() {
    init();
    if (ctx.state === 'suspended') await ctx.resume();
    if (!musicRunning) startMusic();
  }

  return { unlock, toggleMute, isMuted, playExpand, playBuild, playAttack };
})();
