'use strict';

const $ = (id) => document.getElementById(id);

let state = {};

// ---------- загрузка состояния ----------
async function loadState() {
  state = await chrome.storage.local.get([
    'groups', 'currentIndex', 'sentCount',
    'fileStats', 'phase', 'lastError',
  ]);
  render();
}

// ---------- рендер ----------
function render() {
  const groups = state.groups || [];
  const idx = state.currentIndex || 0;
  const sent = state.sentCount || 0;
  const stats = state.fileStats;
  const phase = state.phase || 'idle';

  // файл
  if (stats) {
    $('file-name').textContent = stats.filename;
    $('file-stats').textContent =
      `Строк: ${stats.totalLines} · уникальных имён (групп): ${stats.totalGroups}`;
  } else {
    $('file-name').textContent = 'Выберите .txt файл';
    $('file-stats').textContent = '';
  }

  // прогресс
  if (groups.length > 0) {
    $('progress-section').hidden = false;
    $('prepared-count').textContent = Math.min(idx, groups.length);
    $('total-count').textContent = groups.length;
    $('sent-count').textContent = sent;
    const pct = groups.length ? Math.min(100, (idx / groups.length) * 100) : 0;
    $('progress-fill').style.width = pct + '%';
  } else {
    $('progress-section').hidden = true;
  }

  // статус
  const statusEl = $('status');
  statusEl.className = 'status status-' + phase;

  let statusText = '';
  if (groups.length === 0) {
    statusText = 'Загрузите .txt файл для начала';
  } else if (idx >= groups.length) {
    statusText = `Готово. Все ${groups.length} писем подготовлены.`;
  } else {
    const names = {
      idle: `Готово к запуску. Писем: ${groups.length}.`,
      filling: 'Заполнение полей письма…',
      waiting_template: 'Выберите шаблон вручную в открытом окне письма Яндекс.Почты.',
      ready: 'Письмо готово. Проверьте, отправьте вручную, затем нажмите «Далее».',
      error: 'Ошибка: ' + (state.lastError || 'неизвестно'),
    };
    statusText = names[phase] || '';
  }
  statusEl.textContent = statusText;

  // ошибка
  if (phase === 'error' && state.lastError) {
    $('error').hidden = false;
    $('error').textContent = state.lastError;
  } else {
    $('error').hidden = true;
    $('error').textContent = '';
  }

  // кнопки
  const startBtn = $('start-btn');
  const nextBtn = $('next-btn');

  if (groups.length === 0) {
    startBtn.hidden = false; startBtn.disabled = true;
    startBtn.textContent = 'Начать';
    nextBtn.hidden = true;
  } else if (idx >= groups.length) {
    startBtn.hidden = true;
    nextBtn.hidden = true;
  } else if (phase === 'ready') {
    startBtn.hidden = true;
    nextBtn.hidden = false;
    nextBtn.disabled = false;
    nextBtn.textContent = (idx === groups.length - 1) ? 'Завершить' : 'Далее';
  } else {
    startBtn.hidden = false;
    nextBtn.hidden = true;
    startBtn.disabled = (phase === 'filling' || phase === 'waiting_template');
    if (phase === 'error') startBtn.textContent = 'Повторить';
    else if (idx === 0) startBtn.textContent = 'Начать';
    else startBtn.textContent = 'Продолжить';
  }
}

// ---------- парсинг и валидация файла ----------
function parseFile(text) {
  const lines = text.split(/\r?\n/);
  const groups = [];
  let current = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) continue;

    const sep = line.indexOf(';');
    if (sep === -1) {
      throw new Error(`Строка ${i + 1}: отсутствует разделитель ";"`);
    }
    const name = line.slice(0, sep).trim();
    const email = line.slice(sep + 1).trim();

    if (!name) {
      throw new Error(`Строка ${i + 1}: пустое имя`);
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error(`Строка ${i + 1}: некорректный email "${email}"`);
    }

    if (current && current.name === name) {
      current.emails.push(email);
    } else {
      current = { name, emails: [email] };
      groups.push(current);
    }
  }

  if (groups.length === 0) {
    throw new Error('Файл не содержит валидных строк');
  }
  return groups;
}

async function handleFile(file) {
  try {
    const text = await file.text();
    const groups = parseFile(text);
    const totalLines = groups.reduce((s, g) => s + g.emails.length, 0);

    await chrome.storage.local.set({
      groups,
      currentIndex: 0,
      sentCount: 0,
      fileStats: {
        filename: file.name,
        totalLines,
        totalGroups: groups.length,
      },
      phase: 'idle',
      lastError: '',
    });
    await loadState();
  } catch (e) {
    $('error').hidden = false;
    $('error').textContent = e.message;
  }
}

// ---------- сообщения в background ----------
function sendMessage(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(res || { ok: false, error: 'Нет ответа от background' });
      }
    });
  });
}

// ---------- события ----------
$('file-input').addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  if (file) handleFile(file);
});

$('start-btn').addEventListener('click', async () => {
  $('start-btn').disabled = true;
  const res = await sendMessage({ type: 'START' });
  if (!res.ok) {
    $('error').hidden = false;
    $('error').textContent = res.error || 'Ошибка запуска';
  }
  await loadState();
});

$('next-btn').addEventListener('click', async () => {
  $('next-btn').disabled = true;
  const res = await sendMessage({ type: 'NEXT' });
  if (!res.ok && res.error) {
    $('error').hidden = false;
    $('error').textContent = res.error;
  }
  await loadState();
});

// реакция на изменения хранилища (background/контент-скрипт пишут фазу)
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') loadState();
});

// инициализация
loadState();