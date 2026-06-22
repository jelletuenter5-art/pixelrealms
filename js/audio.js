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

  // Chill ambient chord progression — Am · F · C · G
  const CHORDS = [
    [110, 165, 220, 261.63],       // Am (bass + triad)
    [87.31, 130.81, 174.61, 220],  // F
    [65.41, 130.81, 164.81, 196],  // C
    [98, 147, 196, 246.94],        // G
  ];

  const CHORD_DURATION = 9;   // seconds per chord
  const CHORD_OVERLAP  = 2.5; // crossfade seconds
  const LOOKAHEAD      = 20;  // schedule this many seconds ahead

  function init() {
    if (ctx) return;
    ctx = new (window.AudioContext || window.webkitAudioContext)();

    masterGain = ctx.createGain();
    masterGain.gain.value = muted ? 0 : 1;
    masterGain.connect(ctx.destination);

    musicGain = ctx.createGain();
    musicGain.gain.value = 0.38;
    musicGain.connect(masterGain);

    sfxGain = ctx.createGain();
    sfxGain.gain.value = 0.7;
    sfxGain.connect(masterGain);
  }

  // Simple convolution reverb from noise impulse
  function makeReverb(duration = 1.8, decay = 2.5) {
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

  function playChord(freqs, startTime) {
    const dur = CHORD_DURATION + CHORD_OVERLAP;
    const reverb = makeReverb();
    const revGain = ctx.createGain();
    revGain.gain.value = 0.35;
    reverb.connect(revGain);
    revGain.connect(musicGain);

    freqs.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const g   = ctx.createGain();
      // Alternate sine/triangle for warmth
      osc.type = i === 0 ? 'sine' : (i === 1 ? 'triangle' : 'sine');
      osc.frequency.value = freq;
      // Slight detune for richness
      osc.detune.value = (i % 2 === 0 ? 1 : -1) * (i * 2);

      const vol = i === 0 ? 0.055 : 0.04;
      g.gain.setValueAtTime(0, startTime);
      g.gain.linearRampToValueAtTime(vol, startTime + 2.5);
      g.gain.setValueAtTime(vol, startTime + dur - CHORD_OVERLAP);
      g.gain.linearRampToValueAtTime(0, startTime + dur);

      osc.connect(g);
      g.connect(musicGain);
      g.connect(reverb);
      osc.start(startTime);
      osc.stop(startTime + dur + 0.1);
    });

    // Soft high shimmer on top
    const shimFreq = freqs[freqs.length - 1] * 2;
    const shimOsc  = ctx.createOscillator();
    const shimGain = ctx.createGain();
    shimOsc.type = 'sine';
    shimOsc.frequency.value = shimFreq;
    shimOsc.detune.value = 5;
    shimGain.gain.setValueAtTime(0, startTime);
    shimGain.gain.linearRampToValueAtTime(0.018, startTime + 3);
    shimGain.gain.setValueAtTime(0.018, startTime + dur - CHORD_OVERLAP);
    shimGain.gain.linearRampToValueAtTime(0, startTime + dur);
    shimOsc.connect(shimGain);
    shimGain.connect(musicGain);
    shimGain.connect(reverb);
    shimOsc.start(startTime);
    shimOsc.stop(startTime + dur + 0.1);
  }

  function scheduleChords() {
    if (!ctx || !musicRunning) return;
    const now = ctx.currentTime;
    while (nextChordTime < now + LOOKAHEAD) {
      playChord(CHORDS[chordIndex % CHORDS.length], Math.max(nextChordTime, now + 0.05));
      chordIndex++;
      nextChordTime += CHORD_DURATION;
    }
  }

  function startMusic() {
    if (musicRunning) return;
    musicRunning = true;
    nextChordTime = ctx.currentTime + 0.2;
    scheduleChords();
    schedulerTimer = setInterval(scheduleChords, 3000);
  }

  // ── Sound Effects ──────────────────────────────────────────

  function playExpand() {
    if (!ctx || muted) return;
    // Soft ascending chime — three quick notes
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

    // Woody thunk
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

    // Follow-up chime
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

    // Low noise thud
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

    // Pitch drop
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
    if (masterGain) masterGain.gain.setTargetAtTime(muted ? 0 : 1, ctx.currentTime, 0.15);
    return muted;
  }

  function isMuted() { return muted; }

  // Call on first user interaction to unlock audio context
  function unlock() {
    init();
    if (ctx.state === 'suspended') ctx.resume();
    if (!musicRunning) startMusic();
  }

  return { unlock, toggleMute, isMuted, playExpand, playBuild, playAttack };
})();
