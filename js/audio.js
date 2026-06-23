// PixelRealms — audio.js
// MP3 soundtrack + Web Audio API sound effects

const AudioEngine = (() => {
  let ctx = null;
  let sfxGain = null;
  let muted = localStorage.getItem('pr_muted') === 'true';

  const music = new Audio('../assets/soundtrack.mp3');
  music.loop = true;
  music.volume = muted ? 0 : 0.5;

  // Restore playback position so music feels continuous across page navigations
  const DURATION_KEY = 'pr_music_duration';
  const POS_KEY      = 'pr_music_pos';
  const TS_KEY       = 'pr_music_ts';

  music.addEventListener('loadedmetadata', () => {
    const savedDuration = parseFloat(localStorage.getItem(DURATION_KEY) || '0');
    const savedPos      = parseFloat(localStorage.getItem(POS_KEY) || '0');
    const savedTs       = parseFloat(localStorage.getItem(TS_KEY) || '0');
    const duration      = music.duration;
    if (savedPos > 0 && duration > 0) {
      const elapsed = savedTs > 0 ? (Date.now() - savedTs) / 1000 : 0;
      music.currentTime = (savedPos + elapsed) % duration;
    }
    localStorage.setItem(DURATION_KEY, String(duration));
  });

  // Save position before leaving the page
  window.addEventListener('beforeunload', () => {
    if (!music.paused) {
      localStorage.setItem(POS_KEY, String(music.currentTime));
      localStorage.setItem(TS_KEY, String(Date.now()));
    }
  });

  // Try to autoplay immediately (works if user already interacted on a previous page)
  music.play().catch(() => {});

  function init() {
    if (ctx) return;
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    sfxGain = ctx.createGain();
    sfxGain.gain.value = muted ? 0 : 0.65;
    sfxGain.connect(ctx.destination);
  }

  async function unlock() {
    init();
    if (ctx.state === 'suspended') await ctx.resume();
    if (music.paused) music.play().catch(() => {});
  }

  function toggleMute() {
    muted = !muted;
    localStorage.setItem('pr_muted', muted);
    music.volume = muted ? 0 : 0.5;
    if (sfxGain) sfxGain.gain.setTargetAtTime(muted ? 0 : 0.65, ctx.currentTime, 0.1);
    return muted;
  }

  function isMuted() { return muted; }

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

  return { unlock, toggleMute, isMuted, playExpand, playBuild, playAttack };
})();
