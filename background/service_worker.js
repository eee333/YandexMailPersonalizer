'use strict';

const MAIL_URLS = [
  'https://mail.yandex.ru/*',
  'https://mail.yandex.com/*',
  'https://mail.yandex.by/*',
  'https://mail.yandex.kz/*',
  'https://mail.yandex.ua/*',
];

const DEFAULT_MAIL_URL = 'https://mail.yandex.ru/';

// ---------- storage helpers ----------
async function getState() {
  return await chrome.storage.local.get([
    'groups', 'currentIndex', 'sentCount',
    'fileStats', 'phase', 'lastError',
  ]);
}

async function setState(partial) {
  await chrome.storage.local.set(partial);
}

// ---------- tab helpers ----------
async function findMailTab() {
  const tabs = await chrome.tabs.query({ url: MAIL_URLS });
  return tabs[0] || null;
}

async function waitForTabComplete(tabId, timeout = 20000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const listener = (updatedTabId, info) => {
      if (updatedTabId === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(true);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    const interval = setInterval(async () => {
      if (Date.now() - start > timeout) {
        clearInterval(interval);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(false);
      }
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.status === 'complete') {
          clearInterval(interval);
          chrome.tabs.onUpdated.removeListener(listener);
          resolve(true);
        }
      } catch (_) { /* tab may be gone */ }
    }, 500);
  });
}

async function ensureMailTab() {
  let tab = await findMailTab();
  if (tab) {
    await chrome.tabs.update(tab.id, { active: true });
    try { await chrome.windows.update(tab.windowId, { focused: true }); } catch (_) {}
    return tab;
  }
  tab = await chrome.tabs.create({ url: DEFAULT_MAIL_URL, active: true });
  await waitForTabComplete(tab.id);
  return tab;
}

async function waitForContentReady(tabId, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const res = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
      if (res && res.ok) return true;
    } catch (_) { /* not ready yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// ---------- core flow ----------
async function startFill(index) {
  const state = await getState();
  const groups = state.groups || [];
  const group = groups[index];

  if (!group) {
    await setState({ phase: 'idle', lastError: '' });
    return { ok: false, error: 'Все группы уже обработаны' };
  }

  await setState({ phase: 'filling', lastError: '' });

  const tab = await ensureMailTab();
  const ready = await waitForContentReady(tab.id);

  if (!ready) {
    await setState({
      phase: 'error',
      lastError: 'Контент-скрипт не отвечает. Откройте Яндекс.Почту и обновите страницу.',
    });
    return { ok: false, error: 'content script not ready' };
  }

  // Fire-and-forget: content script отчитается через PHASE
  chrome.tabs
    .sendMessage(tab.id, { type: 'FILL_GROUP', group, index })
    .catch((e) => {
      console.warn('[YMP:bg] sendMessage error', e);
      setState({ phase: 'error', lastError: e.message || 'Ошибка связи с вкладкой' });
    });

  return { ok: true };
}

// ---------- message router ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return false;

  if (msg.type === 'START') {
    (async () => {
      const state = await getState();
      const idx = state.currentIndex || 0;
      const res = await startFill(idx);
      sendResponse(res);
    })();
    return true;
  }

  if (msg.type === 'NEXT') {
    (async () => {
      const state = await getState();
      const groups = state.groups || [];
      const nextIdx = (state.currentIndex || 0) + 1;
      const sentCount = (state.sentCount || 0) + 1;

      if (nextIdx >= groups.length) {
        await setState({
          currentIndex: nextIdx,
          sentCount,
          phase: 'idle',
          lastError: '',
        });
        sendResponse({ ok: true, done: true });
        return;
      }

      await setState({ currentIndex: nextIdx, sentCount, phase: 'filling' });
      const res = await startFill(nextIdx);
      sendResponse(res);
    })();
    return true;
  }

  if (msg.type === 'PHASE') {
    setState({ phase: msg.phase, lastError: msg.error || '' });
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'PING_BG') {
    sendResponse({ ok: true });
    return false;
  }

  return false;
});