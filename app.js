const builtInSongs = [
  { title: "Karaoke Star Demo - Root", lead: "../0 Lead Vocals.mp3", instrumental: "../1 Instrumental.mp3" },
  { title: "Pour It Out - Sample", lead: "../pour-it-out/0 Lead Vocals_01.mp3", instrumental: "../pour-it-out/1 Instrumental_01.mp3" },
];

const appRoot = document.getElementById("appRoot");
const accessGate = document.getElementById("accessGate");
const accessCodeInput = document.getElementById("accessCodeInput");
const unlockBtn = document.getElementById("unlockBtn");
const gateStatus = document.getElementById("gateStatus");

const songSelect = document.getElementById("songSelect");
const loadSongBtn = document.getElementById("loadSongBtn");
const leadUpload = document.getElementById("leadUpload");
const instUpload = document.getElementById("instUpload");
const loadCustomBtn = document.getElementById("loadCustomBtn");

const bgFx = document.getElementById("bgFx");
const bgPresetSelect = document.getElementById("bgPresetSelect");
const applyBgBtn = document.getElementById("applyBgBtn");
const bgUpload = document.getElementById("bgUpload");
const applyCustomBgBtn = document.getElementById("applyCustomBgBtn");

const micBtn = document.getElementById("micBtn");
const playBtn = document.getElementById("playBtn");
const pauseBtn = document.getElementById("pauseBtn");
const stopBtn = document.getElementById("stopBtn");
const modeSelect = document.getElementById("modeSelect");

const eqLow = document.getElementById("eqLow");
const eqMid = document.getElementById("eqMid");
const eqHigh = document.getElementById("eqHigh");
const autoTune = document.getElementById("autoTune");
const eqReadout = document.getElementById("eqReadout");

const recordGain = document.getElementById("recordGain");
const recordGainValue = document.getElementById("recordGainValue");
const recordBtn = document.getElementById("recordBtn");
const stopRecordBtn = document.getElementById("stopRecordBtn");
const replayBtn = document.getElementById("replayBtn");
const downloadWavBtn = document.getElementById("downloadWavBtn");

const micMeter = document.getElementById("micMeter");
const micValue = document.getElementById("micValue");
const leadMeter = document.getElementById("leadMeter");
const leadValue = document.getElementById("leadValue");
const scoreMeter = document.getElementById("scoreMeter");
const scoreValue = document.getElementById("scoreValue");
const scoreDigits = document.getElementById("scoreDigits");
const statusEl = document.getElementById("status");

const backingAudio = new Audio();
const leadAudio = new Audio();
backingAudio.crossOrigin = "anonymous";
leadAudio.crossOrigin = "anonymous";
backingAudio.preload = "auto";
leadAudio.preload = "auto";

let micCtx;
let micStream;
let micAnalyser;
let micData;
let meterLoop;
let currentSong;
let sessionScore = 0;
let isPaused = false;

let recCtx;
let recDestination;
let recMicGain;
let recLeadGain;
let recMicLow;
let recMicMid;
let recMicHigh;
let recMicComp;
let recMicShape;

let mediaRecorder;
let recordedChunks = [];
let recordingBlob = null;
let recordingUrl = "";
let customBgUrl = "";

function setStatus(msg) { statusEl.textContent = msg; }
function formatDb(v) { return `${Number(v) >= 0 ? "+" : ""}${Number(v)} dB`; }
function dbToGain(db) { return 10 ** (db / 20); }
function sanitizeForFilename(text) { return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "side-chain"; }

function lockApp() {
  document.body.classList.add("locked");
  appRoot.setAttribute("aria-hidden", "true");
  accessGate.style.display = "grid";
}

function unlockApp(tier) {
  document.body.classList.remove("locked");
  appRoot.setAttribute("aria-hidden", "false");
  accessGate.style.display = "none";
  setStatus(`Access granted (${tier}). Ready to sing.`);
}

async function verifySession() {
  try {
    const resp = await fetch("/api/access/verify", { credentials: "include" });
    if (!resp.ok) {
      lockApp();
      return;
    }
    const data = await resp.json();
    unlockApp(data.tier || "member");
  } catch {
    lockApp();
  }
}

async function unlockWithCode() {
  const code = accessCodeInput.value.trim();
  if (!code) {
    gateStatus.textContent = "Enter an access code first.";
    return;
  }

  gateStatus.textContent = "Verifying code...";
  unlockBtn.disabled = true;

  try {
    const resp = await fetch("/api/access/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ code }),
    });

    const data = await resp.json();
    if (!resp.ok) {
      gateStatus.textContent = data.error || "Access denied.";
      unlockBtn.disabled = false;
      return;
    }

    gateStatus.textContent = `Access granted for ${data.tier}.`;
    unlockApp(data.tier);
  } catch (err) {
    console.error(err);
    gateStatus.textContent = "Server unavailable. Start side-chain/access-gateway.js";
    unlockBtn.disabled = false;
  }
}

function hydrateSongMenu() {
  songSelect.innerHTML = "";
  builtInSongs.forEach((song, idx) => {
    const option = document.createElement("option");
    option.value = String(idx);
    option.textContent = song.title;
    songSelect.appendChild(option);
  });
}

function getMicLevel() {
  if (!micAnalyser) return 0;
  micAnalyser.getByteTimeDomainData(micData);
  let sumSquares = 0;
  for (let i = 0; i < micData.length; i += 1) {
    const centered = (micData[i] - 128) / 128;
    sumSquares += centered * centered;
  }
  return Math.min(1, Math.sqrt(sumSquares / micData.length) * 4.2);
}

function computeLeadVolume(mode, micLevel) {
  const modeBase = { practice: 1.0, light: 0.8, medium: 0.6, ghost: 0.2, solo: 0.0 };
  const base = modeBase[mode] ?? 1.0;
  if (mode === "practice" || mode === "solo") return base;
  return Math.max(0, base - micLevel * 0.5);
}

function makeDriveCurve(amount = 0) {
  const n = 1024;
  const curve = new Float32Array(n);
  const k = 1 + (amount / 100) * 20;
  for (let i = 0; i < n; i += 1) {
    const x = (i * 2) / n - 1;
    curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
  }
  return curve;
}

function updateMicToneChain() {
  if (!recMicLow) {
    eqReadout.textContent = `Low ${eqLow.value} dB • Mid ${eqMid.value} dB • High ${eqHigh.value} dB • Auto Tune Assist ${autoTune.value}%`;
    return;
  }

  recMicLow.gain.value = Number(eqLow.value);
  recMicMid.gain.value = Number(eqMid.value);
  recMicHigh.gain.value = Number(eqHigh.value);

  const tuneAmt = Number(autoTune.value);
  recMicComp.threshold.value = -30 - tuneAmt * 0.2;
  recMicComp.ratio.value = 2 + tuneAmt * 0.1;
  recMicComp.attack.value = 0.003 + (100 - tuneAmt) * 0.0002;
  recMicComp.release.value = 0.08 + tuneAmt * 0.003;
  recMicShape.curve = makeDriveCurve(tuneAmt);

  eqReadout.textContent = `Low ${eqLow.value} dB • Mid ${eqMid.value} dB • High ${eqHigh.value} dB • Auto Tune Assist ${autoTune.value}%`;
}

function setBackgroundPreset(preset) {
  document.body.style.backgroundImage = "";
  document.body.classList.remove("bg-electric-grid", "bg-rain-fern", "bg-starfield", "bg-light-phenomena");
  const fxMap = {
    electric: ["bg-electric-grid", "fx-electric"],
    rain: ["bg-rain-fern", "fx-rain"],
    starfield: ["bg-starfield", "fx-starfield"],
    lights: ["bg-light-phenomena", "fx-lights"],
  };
  const [bodyClass, fxClass] = fxMap[preset] || fxMap.electric;
  document.body.classList.add(bodyClass);
  bgFx.className = `bg-fx ${fxClass}`;
}

function applyBgPreset() {
  if (customBgUrl) {
    URL.revokeObjectURL(customBgUrl);
    customBgUrl = "";
  }
  setBackgroundPreset(bgPresetSelect.value);
}

function applyCustomBackground() {
  const file = bgUpload.files?.[0];
  if (!file) {
    setStatus("Choose an image or GIF for custom background.");
    return;
  }

  if (customBgUrl) URL.revokeObjectURL(customBgUrl);
  customBgUrl = URL.createObjectURL(file);
  document.body.classList.remove("bg-electric-grid", "bg-rain-fern", "bg-starfield", "bg-light-phenomena");
  bgFx.className = "bg-fx";
  document.body.style.backgroundImage = `linear-gradient(rgba(6, 8, 14, 0.42), rgba(6, 8, 14, 0.42)), url('${customBgUrl}')`;
  document.body.style.backgroundSize = "cover";
  document.body.style.backgroundPosition = "center";
  setStatus(`Applied custom background: ${file.name}`);
}

function updateRecordingMixGains() {
  if (!recLeadGain || !recMicGain) return;
  recLeadGain.gain.value = computeLeadVolume(modeSelect.value, getMicLevel());
  recMicGain.gain.value = dbToGain(Number(recordGain.value));
}

function tickMeters() {
  const micLevel = getMicLevel();
  const leadLevel = computeLeadVolume(modeSelect.value, micLevel);
  leadAudio.volume = leadLevel;
  updateRecordingMixGains();

  const micPct = Math.round(micLevel * 100);
  const leadPct = Math.round(leadLevel * 100);
  sessionScore += micPct * 0.035;
  const score = Math.round(sessionScore);

  micMeter.style.width = `${micPct}%`;
  micValue.textContent = String(micPct);
  leadMeter.style.width = `${leadPct}%`;
  leadValue.textContent = String(leadPct);

  scoreMeter.style.width = `${Math.min(100, Math.round(score / 10))}%`;
  scoreValue.textContent = String(score);
  scoreDigits.textContent = String(score).padStart(6, "0");

  meterLoop = requestAnimationFrame(tickMeters);
}

function applyMicGain() {
  recordGainValue.textContent = formatDb(recordGain.value);
  if (recMicGain) recMicGain.gain.value = dbToGain(Number(recordGain.value));
}

async function setupRecordingBus() {
  if (!micStream || recDestination) return;
  recCtx = new (window.AudioContext || window.webkitAudioContext)();
  recDestination = recCtx.createMediaStreamDestination();

  const recLeadSource = recCtx.createMediaStreamSource(leadAudio.captureStream());
  const recInstSource = recCtx.createMediaStreamSource(backingAudio.captureStream());
  const recMicSource = recCtx.createMediaStreamSource(micStream);

  recLeadGain = recCtx.createGain();
  const recInstGain = recCtx.createGain();
  recMicGain = recCtx.createGain();

  recMicLow = recCtx.createBiquadFilter();
  recMicLow.type = "lowshelf";
  recMicLow.frequency.value = 180;
  recMicMid = recCtx.createBiquadFilter();
  recMicMid.type = "peaking";
  recMicMid.frequency.value = 1800;
  recMicMid.Q.value = 1.0;
  recMicHigh = recCtx.createBiquadFilter();
  recMicHigh.type = "highshelf";
  recMicHigh.frequency.value = 5200;
  recMicComp = recCtx.createDynamicsCompressor();
  recMicShape = recCtx.createWaveShaper();

  recLeadSource.connect(recLeadGain).connect(recDestination);
  recInstSource.connect(recInstGain).connect(recDestination);
  recMicSource.connect(recMicLow).connect(recMicMid).connect(recMicHigh).connect(recMicComp).connect(recMicShape).connect(recMicGain).connect(recDestination);

  updateMicToneChain();
  applyMicGain();
}

async function enableMic() {
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    micCtx = micCtx || new (window.AudioContext || window.webkitAudioContext)();
    const micSource = micCtx.createMediaStreamSource(micStream);
    micAnalyser = micCtx.createAnalyser();
    micAnalyser.fftSize = 1024;
    micData = new Uint8Array(micAnalyser.fftSize);
    micSource.connect(micAnalyser);

    await setupRecordingBus();

    micBtn.disabled = true;
    playBtn.disabled = false;
    recordBtn.disabled = false;
    setStatus("Mic enabled. Ready to sing.");
  } catch (err) {
    setStatus("Mic access failed. Check browser permissions.");
    console.error(err);
  }
}

function resetMeters() {
  micMeter.style.width = "0%";
  micValue.textContent = "0";
  leadMeter.style.width = "0%";
  leadValue.textContent = "0";
}

function loadSong(song) {
  currentSong = song;
  leadAudio.src = song.lead;
  backingAudio.src = song.instrumental;
  leadAudio.load();
  backingAudio.load();

  sessionScore = 0;
  scoreMeter.style.width = "0%";
  scoreValue.textContent = "0";
  scoreDigits.textContent = "000000";
  resetMeters();

  playBtn.disabled = !micStream;
  pauseBtn.disabled = true;
  stopBtn.disabled = true;
  recordBtn.disabled = !micStream;
  setStatus(`Loaded: ${song.title}`);
}

function play() {
  if (!currentSong) return setStatus("Pick a song first.");
  Promise.all([leadAudio.play(), backingAudio.play()])
    .then(() => {
      if (!meterLoop) tickMeters();
      isPaused = false;
      pauseBtn.textContent = "Pause";
      pauseBtn.disabled = false;
      stopBtn.disabled = false;
      setStatus(`Playing: ${currentSong.title}`);
    })
    .catch((err) => {
      setStatus("Playback failed. Reload song and try again.");
      console.error(err);
    });
}

function pause() {
  if (!currentSong) return;
  if (!isPaused) {
    leadAudio.pause();
    backingAudio.pause();
    isPaused = true;
    pauseBtn.textContent = "Resume";
    setStatus("Paused.");
  } else {
    play();
  }
}

function stop() {
  leadAudio.pause();
  backingAudio.pause();
  leadAudio.currentTime = 0;
  backingAudio.currentTime = 0;
  isPaused = false;
  pauseBtn.textContent = "Pause";
  pauseBtn.disabled = true;
  stopBtn.disabled = true;
  if (meterLoop) {
    cancelAnimationFrame(meterLoop);
    meterLoop = null;
  }
  resetMeters();
  setStatus("Stopped.");
}

function startRecording() {
  if (!recDestination) return setStatus("Enable mic first before recording.");
  if (typeof MediaRecorder === "undefined") return setStatus("Recording not supported in this browser.");
  if (mediaRecorder?.state === "recording") return;

  recordedChunks = [];
  recordingBlob = null;
  replayBtn.disabled = true;
  downloadWavBtn.disabled = true;

  const options = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
    ? { mimeType: "audio/webm;codecs=opus" }
    : MediaRecorder.isTypeSupported("audio/webm")
      ? { mimeType: "audio/webm" }
      : undefined;

  mediaRecorder = new MediaRecorder(recDestination.stream, options);
  mediaRecorder.ondataavailable = (e) => { if (e.data?.size > 0) recordedChunks.push(e.data); };
  mediaRecorder.onstop = () => {
    recordingBlob = new Blob(recordedChunks, { type: mediaRecorder.mimeType || "audio/webm" });
    if (recordingUrl) URL.revokeObjectURL(recordingUrl);
    recordingUrl = URL.createObjectURL(recordingBlob);
    replayBtn.disabled = false;
    downloadWavBtn.disabled = false;
    setStatus("Recording complete. Replay or download WAV.");
  };

  mediaRecorder.start();
  recordBtn.disabled = true;
  stopRecordBtn.disabled = false;
  setStatus("Recording started.");
}

function stopRecording() {
  if (!mediaRecorder || mediaRecorder.state !== "recording") return;
  mediaRecorder.stop();
  stopRecordBtn.disabled = true;
  recordBtn.disabled = false;
}

function replayRecording() {
  if (!recordingUrl) return setStatus("No recording available yet.");
  const audio = new Audio(recordingUrl);
  audio.play().catch((err) => {
    setStatus("Replay failed.");
    console.error(err);
  });
}

function audioBufferToWavBlob(buffer) {
  const channels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const length = buffer.length * channels * 2;
  const wav = new ArrayBuffer(44 + length);
  const view = new DataView(wav);

  function writeString(offset, string) {
    for (let i = 0; i < string.length; i += 1) view.setUint8(offset + i, string.charCodeAt(i));
  }

  writeString(0, "RIFF");
  view.setUint32(4, 36 + length, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, length, true);

  const interleaved = new Float32Array(buffer.length * channels);
  for (let ch = 0; ch < channels; ch += 1) {
    const channelData = buffer.getChannelData(ch);
    for (let i = 0; i < buffer.length; i += 1) interleaved[i * channels + ch] = channelData[i];
  }

  let offset = 44;
  for (let i = 0; i < interleaved.length; i += 1) {
    const s = Math.max(-1, Math.min(1, interleaved[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }

  return new Blob([wav], { type: "audio/wav" });
}

async function downloadWav() {
  if (!recordingBlob) return setStatus("No recording available for download.");

  try {
    const audioBuffer = await new (window.AudioContext || window.webkitAudioContext)().decodeAudioData(await recordingBlob.arrayBuffer());
    const wavBlob = audioBufferToWavBlob(audioBuffer);
    const filename = `${sanitizeForFilename(currentSong?.title || "side-chain-session")}_score-${String(Math.round(sessionScore)).padStart(3, "0")}.wav`;

    const url = URL.createObjectURL(wavBlob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);

    setStatus(`Downloaded WAV: ${filename}`);
  } catch (err) {
    console.error(err);
    setStatus("WAV conversion failed in this browser. Try Chrome/Edge.");
  }
}

function loadCustomFiles() {
  const leadFile = leadUpload.files?.[0];
  const instFile = instUpload.files?.[0];
  if (!leadFile || !instFile) return setStatus("Choose both lead and instrument files.");
  loadSong({
    title: `Custom: ${leadFile.name}`,
    lead: URL.createObjectURL(leadFile),
    instrumental: URL.createObjectURL(instFile),
  });
}

loadSongBtn.addEventListener("click", () => loadSong(builtInSongs[Number(songSelect.value)]));
loadCustomBtn.addEventListener("click", loadCustomFiles);
applyBgBtn.addEventListener("click", applyBgPreset);
applyCustomBgBtn.addEventListener("click", applyCustomBackground);
micBtn.addEventListener("click", enableMic);
playBtn.addEventListener("click", play);
pauseBtn.addEventListener("click", pause);
stopBtn.addEventListener("click", stop);
recordBtn.addEventListener("click", startRecording);
stopRecordBtn.addEventListener("click", stopRecording);
replayBtn.addEventListener("click", replayRecording);
downloadWavBtn.addEventListener("click", downloadWav);
recordGain.addEventListener("input", applyMicGain);
eqLow.addEventListener("input", updateMicToneChain);
eqMid.addEventListener("input", updateMicToneChain);
eqHigh.addEventListener("input", updateMicToneChain);
autoTune.addEventListener("input", updateMicToneChain);
unlockBtn.addEventListener("click", unlockWithCode);
accessCodeInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") unlockWithCode();
});

setBackgroundPreset("electric");
applyMicGain();
updateMicToneChain();
scoreDigits.textContent = "000000";
hydrateSongMenu();
loadSong(builtInSongs[0]);
verifySession();
