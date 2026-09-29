'use strict';

const $ = (id) => document.getElementById(id);

// ---------- 設定の保存（使えない環境では何もしない） ----------
const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem('yomiage.' + key);
      return v === null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('yomiage.' + key, JSON.stringify(value)); } catch { /* 無視 */ }
  },
};

// ---------- 1. 取り込み ----------
const source = document.createElement('canvas'); // 元画像（原寸）
const preview = $('preview');                    // 表示用
let contentRevision = 0;
function invalidateOcr() {
  contentRevision++;
  if (ocrBusy) showStatus('内容が変更されたため、処理中の読み取り結果は反映しません。', 0);
}
let selection = null;                            // 元画像座標での囲み {x, y, w, h}

const canCapture = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
if (!canCapture) {
  $('btnCapture').hidden = true;
  $('captureHint').textContent =
    'この端末では画面を直接取り込めません。スクリーンショットを撮ってから「画像・スクショを選ぶ」を押してください。' +
    '（iPhone/iPad: サイドボタン＋音量上げボタン）';
}

$('btnCapture').addEventListener('click', async () => {
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  } catch {
    return; // キャンセルされた
  }
  try {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await video.play();
    // 最初のフレームが描画されるまで少し待つ
    await new Promise((r) => setTimeout(r, 300));
    loadImage(video, video.videoWidth, video.videoHeight);
  } finally {
    stream.getTracks().forEach((t) => t.stop());
  }
});

$('btnFile').addEventListener('click', () => $('fileInput').click());

$('fileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (file) await loadImageFile(file);
});

$('btnPaste').addEventListener('click', async () => {
  // 画像があれば画像、なければ文字を貼り付ける
  try {
    if (navigator.clipboard && navigator.clipboard.read) {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const type = item.types.find((t) => t.startsWith('image/'));
        if (type) { await loadImageFile(await item.getType(type)); return; }
      }
    }
    const text = await navigator.clipboard.readText();
    if (text) setText(text);
  } catch {
    alert('貼り付けできませんでした。文章欄を長押し（または Ctrl+V / ⌘+V）で貼り付けてください。');
  }
});

// Ctrl+V / ⌘+V で画像を貼り付けたとき
document.addEventListener('paste', async (e) => {
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
  if (item) {
    e.preventDefault();
    await loadImageFile(item.getAsFile());
  }
});

async function loadImageFile(blob) {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    loadImage(img, img.naturalWidth, img.naturalHeight);
  } catch {
    alert('画像を開けませんでした。');
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImage(el, w, h) {
  invalidateOcr();
  source.width = w;
  source.height = h;
  source.getContext('2d').drawImage(el, 0, 0, w, h);
  selection = null;
  $('previewWrap').hidden = false;
  drawPreview();
  $('previewWrap').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function drawPreview() {
  // 表示用は幅1200pxまでに縮小
  const scale = Math.min(1, 1200 / source.width);
  preview.width = Math.round(source.width * scale);
  preview.height = Math.round(source.height * scale);
  const ctx = preview.getContext('2d');
  ctx.drawImage(source, 0, 0, preview.width, preview.height);
  if (selection) {
    const s = scale;
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.beginPath();
    ctx.rect(0, 0, preview.width, preview.height);
    ctx.rect(selection.x * s, selection.y * s, selection.w * s, selection.h * s);
    ctx.fill('evenodd');
    ctx.strokeStyle = '#ffcc00';
    ctx.lineWidth = 3;
    ctx.strokeRect(selection.x * s, selection.y * s, selection.w * s, selection.h * s);
  }
}

// 指やマウスで範囲を囲む
let dragStart = null;
function toSource(e) {
  const r = preview.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(source.width, (e.clientX - r.left) / r.width * source.width)),
    y: Math.max(0, Math.min(source.height, (e.clientY - r.top) / r.height * source.height)),
  };
}
preview.addEventListener('pointerdown', (e) => {
  dragStart = toSource(e);
  preview.setPointerCapture(e.pointerId);
});
preview.addEventListener('pointermove', (e) => {
  if (!dragStart) return;
  const p = toSource(e);
  selection = {
    x: Math.min(dragStart.x, p.x), y: Math.min(dragStart.y, p.y),
    w: Math.abs(p.x - dragStart.x), h: Math.abs(p.y - dragStart.y),
  };
  drawPreview();
});
preview.addEventListener('pointerup', () => {
  dragStart = null;
  // 小さすぎる囲みはタップとみなして解除
  if (selection && (selection.w < 20 || selection.h < 20)) selection = null;
  drawPreview();
});
$('btnClearSel').addEventListener('click', () => { selection = null; drawPreview(); });

// ---------- 文字認識（OCR） ----------
// 横書き用と縦書き用で読み取りデータが違うので、別々に用意する
const LANGS = { h: 'jpn+eng', v: 'jpn_vert' };
const workers = {};
let ocrBusy = false;
let ocrRevision = 0;
function getWorker(dir) {
  if (!workers[dir]) {
    const dataLabel = dir === 'v' ? '縦書き用データを読み込み中…' : '日本語データを読み込み中…';
    workers[dir] = Tesseract.createWorker(LANGS[dir], 1, {
      logger: (m) => {
        const labels = {
          'loading tesseract core': '準備中…',
          'loading language traineddata': dataLabel + '（初回のみ時間がかかります）',
          'initializing api': '準備中…',
          'recognizing text': dir === 'v' ? '縦書きとして読み取り中…' : '文字を読み取り中…',
        };
        if (ocrBusy && ocrRevision === contentRevision) showStatus(labels[m.status] || '処理中…', m.progress);
      },
    }).then(async (w) => {
      // ページ全体のレイアウトを自動で解析する（縦書きの列を見つけるのに必要）
      await w.setParameters({ tessedit_pageseg_mode: Tesseract.PSM.AUTO });
      return w;
    }).catch((err) => { delete workers[dir]; throw err; });
  }
  return workers[dir];
}

async function recognize(dir, image) {
  const worker = await getWorker(dir);
  const { data } = await worker.recognize(image);
  return data;
}

// 自動のときは横書きで読み、自信が低ければ縦書きでも読んで良いほうを使う
async function recognizeAuto(image) {
  const mode = $('direction').value;
  if (mode !== 'auto') return recognize(mode, image);
  const h = await recognize('h', image);
  if (h.confidence >= 80) return h;
  try {
    const v = await recognize('v', image);
    return v.confidence > h.confidence ? v : h;
  } catch (err) {
    if (!h.text.trim()) throw err;
    return { ...h, warning: '縦書きの確認ができなかったため、横書きの結果を表示しています。' };
  }
}

function showStatus(label, progress) {
  $('ocrStatus').hidden = false;
  $('ocrLabel').textContent = label;
  $('ocrProgress').value = progress || 0;
}

$('btnOcr').addEventListener('click', async () => {
  if (ocrBusy) return;
  const revision = contentRevision;
  ocrRevision = revision;
  const btn = $('btnOcr');
  btn.disabled = true;
  ocrBusy = true;
  stop();
  try {
    showStatus('準備中…', 0);
    const data = await recognizeAuto(cropForOcr());
    ocrBusy = false;
    if (revision !== contentRevision) return;
    const text = cleanOcrText(data.text);
    if (!text) {
      showStatus('文字が見つかりませんでした。範囲を囲み直すか、画像を拡大して試してください。', 0);
      return;
    }
    setText(text);
    if (data.warning) showStatus(data.warning, 1);
    else $('ocrStatus').hidden = true;
    if ($('autoPlay').checked) play();
  } catch (err) {
    if (revision !== contentRevision) return;
    console.error(err);
    showStatus('読み取りに失敗しました。通信状態を確認して、もう一度お試しください。', 0);
  } finally {
    ocrBusy = false;
    btn.disabled = false;
  }
});

function cropForOcr() {
  const s = selection || { x: 0, y: 0, w: source.width, h: source.height };
  // 小さい文字は2倍に拡大すると認識しやすい
  const zoom = Math.max(s.w, s.h) < 1000 ? 2 : 1;
  const c = document.createElement('canvas');
  c.width = Math.round(s.w * zoom);
  c.height = Math.round(s.h * zoom);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, s.x, s.y, s.w, s.h, 0, 0, c.width, c.height);
  return c;
}

// 日本語OCRの結果に入る余分な空白・改行を取り除く
const JA = '　-〿぀-ヿ㐀-鿿豈-﫿＀-￯';
function cleanOcrText(raw) {
  return raw
    .replace(new RegExp(`([${JA}])[ \\t]+(?=[${JA}])`, 'g'), '$1')
    .replace(new RegExp(`([${JA}])\\n(?=[${JA}])`, 'g'), '$1')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------- 2. 文章 ----------
function setText(text) {
  invalidateOcr();
  stop();
  $('text').value = text;
  store.set('text', text);
}
$('text').value = store.get('text', '');
$('text').addEventListener('input', () => {
  invalidateOcr();
  store.set('text', $('text').value);
});

// ---------- 3. 読み上げ ----------
const synth = window.speechSynthesis;
let voices = [];
let chunks = [];     // [{text, start, end}]
let index = 0;       // 次に読む塊
let playing = false;
let paused = false;
let generation = 0;  // 停止・再開のたびに増やし、古い発話のイベントを無視する

function loadVoices() {
  voices = synth.getVoices().filter((v) => v.localService === true);
  const select = $('voice');
  const saved = store.get('voice', '');
  const ja = voices.filter((v) => v.lang.toLowerCase().startsWith('ja'));
  const others = voices.filter((v) => !v.lang.toLowerCase().startsWith('ja'));
  select.innerHTML = '';
  const addGroup = (label, list) => {
    if (!list.length) return;
    const g = document.createElement('optgroup');
    g.label = label;
    list.forEach((v) => {
      const o = document.createElement('option');
      o.value = v.voiceURI;
      o.textContent = `${v.name}（${v.lang}）`;
      g.appendChild(o);
    });
    select.appendChild(g);
  };
  addGroup('日本語', ja);
  addGroup('その他の言語', others);
  if (voices.some((v) => v.voiceURI === saved)) select.value = saved;
  else if (ja.length) select.value = (ja.find((v) => v.default) || ja[0]).voiceURI;
  else if (voices.length) select.value = voices[0].voiceURI;
  $('voiceStatus').textContent = voices.length ? '端末内の音声のみ使用します。' : '端末内の音声が見つかりません。端末の音声設定で音声を追加してから、ページを開き直してください。';
  updateButtons();
}
if (synth) {
  loadVoices();
  synth.addEventListener?.('voiceschanged', loadVoices);
} else {
  $('btnPlay').disabled = true;
  $('voice').innerHTML = '<option>このブラウザは音声読み上げに対応していません</option>';
}

$('voice').addEventListener('change', () => { store.set('voice', $('voice').value); restartIfPlaying(); });
for (const id of ['rate', 'pitch']) {
  const input = $(id);
  input.value = store.get(id, input.value);
  $(id + 'Out').textContent = Number(input.value).toFixed(1);
  input.addEventListener('input', () => { $(id + 'Out').textContent = Number(input.value).toFixed(1); });
  input.addEventListener('change', () => { store.set(id, input.value); restartIfPlaying(); });
}
$('autoPlay').checked = store.get('autoPlay', true);
$('direction').value = store.get('direction', 'auto');
$('direction').addEventListener('change', () => store.set('direction', $('direction').value));
$('autoPlay').addEventListener('change', () => store.set('autoPlay', $('autoPlay').checked));

// 文ごとに区切る（長すぎる文は読点でさらに分ける）
function splitText(text) {
  const result = [];
  const re = /[^。．！？!?\n]*[。．！？!?]+[」』）)]*|[^\n]+/g;
  let m;
  while ((m = re.exec(text))) {
    let start = m.index;
    let part = m[0];
    while (part.length > 120) {
      let cut = part.lastIndexOf('、', 120);
      if (cut < 40) cut = 120; else cut += 1;
      result.push({ start, end: start + cut });
      start += cut;
      part = part.slice(cut);
    }
    result.push({ start, end: start + part.length });
  }
  return result
    .map((c) => ({ ...c, text: text.slice(c.start, c.end) }))
    .filter((c) => c.text.trim());
}

function renderReader(text) {
  const reader = $('reader');
  reader.innerHTML = '';
  let pos = 0;
  chunks.forEach((c, i) => {
    if (c.start > pos) reader.append(text.slice(pos, c.start));
    const span = document.createElement('span');
    span.textContent = c.text;
    span.dataset.i = i;
    span.tabIndex = 0;
    span.setAttribute('role', 'button');
    span.setAttribute('aria-label', 'ここから読み上げる：' + c.text);
    reader.append(span);
    pos = c.end;
  });
  if (pos < text.length) reader.append(text.slice(pos));
}

// 文をタップするとそこから読む
$('reader').addEventListener('click', (e) => {
  const i = e.target.dataset?.i;
  if (i === undefined) return;
  index = Number(i);
  paused = false;
  speakFrom(index);
});

$('reader').addEventListener('keydown', (e) => {
  if (e.target.dataset?.i !== undefined && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    e.target.click();
  }
});

function highlight(i) {
  $('reader').querySelectorAll('.now').forEach((el) => el.classList.remove('now'));
  const el = $('reader').querySelector(`[data-i="${i}"]`);
  if (el) {
    el.classList.add('now');
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

function play() {
  if (!synth) return;
  if (paused) { paused = false; speakFrom(index); return; }
  const text = $('text').value;
  chunks = splitText(text);
  if (!chunks.length) { $('text').focus(); return; }
  renderReader(text);
  $('text').hidden = true;
  $('reader').hidden = false;
  index = 0;
  speakFrom(0);
}

function speakFrom(i) {
  const voice = voices.find((v) => v.voiceURI === $('voice').value && v.localService === true);
  if (!synth || !voice) {
    stop();
    $('speechStatus').textContent = '端末内の音声を選択してから、もう一度読み上げてください。';
    return;
  }
  $('speechStatus').textContent = '';
  const gen = ++generation;
  synth.cancel();
  playing = true;
  updateButtons();
  const next = (n) => {
    if (gen !== generation) return;
    if (n >= chunks.length) { finish(); return; }
    index = n;
    highlight(n);
    const u = new SpeechSynthesisUtterance(chunks[n].text);
    u.voice = voice;
    u.lang = voice.lang;
    u.rate = Number($('rate').value);
    u.pitch = Number($('pitch').value);
    u.onend = () => next(n + 1);
    const fail = () => {
      if (gen !== generation) return;
      generation++;
      synth.cancel();
      playing = false;
      paused = true;
      $('speechStatus').textContent = '読み上げに失敗しました。音声や端末の設定を確認し、「続きから」で再試行してください。';
      updateButtons();
    };
    u.onerror = fail;
    try { synth.speak(u); } catch { fail(); }
  };
  next(i);
}

function pause() {
  generation++;
  synth.cancel();
  playing = false;
  paused = true;
  updateButtons();
}

function stop() {
  generation++;
  if (synth) synth.cancel();
  finish();
}

function finish() {
  playing = false;
  paused = false;
  index = 0;
  $('reader').hidden = true;
  $('text').hidden = false;
  updateButtons();
}

function restartIfPlaying() {
  if (playing) speakFrom(index);
}

function updateButtons() {
  $('btnPlay').textContent = paused ? '▶ 続きから' : '▶ 読み上げ';
  $('btnPlay').disabled = playing || !synth || !voices.length;
  $('btnPause').disabled = !playing;
  $('btnStop').disabled = !playing && !paused;
}

$('btnPlay').addEventListener('click', play);
$('btnPause').addEventListener('click', pause);
$('btnStop').addEventListener('click', stop);

// ---------- オフライン対応 ----------
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
