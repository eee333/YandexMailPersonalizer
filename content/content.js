'use strict';

(() => {
  if (window.__ympLoaded) return;
  window.__ympLoaded = true;

  const LOG = '[YMP:content]';
  const log = (...a) => console.log(LOG, ...a);
  const warn = (...a) => console.warn(LOG, ...a);

  // ---------- селекторы (несколько стратегий для устойчивости) ----------
  const SEL = {
    composeButton: [
      'a[href*="compose"]',
      'button[data-testid="compose-button"]',
      '[role="button"][aria-label*="Написать" i]',
      '[role="button"][title*="Написать" i]',
      '.ns-view-compose-button a',
      'a.control.link_theme_normal[href*="compose"]',
    ],
    toField: [
      'div[contenteditable="true"][id^="compose-field-"][aria-label*="Кому" i]',
      'div[contenteditable="true"][data-name="to"]',
      'div[contenteditable="true"][aria-label*="Кому" i]',
      'input[name="to"]',
    ],
    ccField: [
      'div[contenteditable="true"][id^="compose-field-"][aria-label*="Копия" i]:not([aria-label*="Скрыт" i])',
      'div[contenteditable="true"][data-name="cc"]',
    ],
    bccField: [
      'div[contenteditable="true"][id^="compose-field-"][aria-label*="Скрыт" i]',
      'div[contenteditable="true"][data-name="bcc"]',
    ],
    subject: [
      'input[name="subject"]',
      'input[aria-label*="Тема" i]',
      'input[placeholder*="Тема" i]',
    ],
    body: [
      'div[contenteditable="true"][aria-label*="Текст" i]',
      'div[contenteditable="true"][role="textbox"]:not([id^="compose-field-"])',
      '.compose-editor [contenteditable="true"]',
      '[data-name="body"] [contenteditable="true"]',
    ],
  };

  // ---------- утилиты DOM ----------
  function qs(selectors, root = document) {
    for (const sel of selectors) {
      try {
        const el = root.querySelector(sel);
        if (el) return el;
      } catch (_) { /* ignore bad selector */ }
    }
    return null;
  }

  function qsa(selectors, root = document) {
    const out = [];
    for (const sel of selectors) {
      try { out.push(...root.querySelectorAll(sel)); } catch (_) {}
    }
    return out;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function waitFor(getter, timeout = 10000, errorMsg = 'Timeout') {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const tick = () => {
        const el = getter();
        if (el) return resolve(el);
        if (Date.now() - start > timeout) return reject(new Error(errorMsg));
        setTimeout(tick, 200);
      };
      tick();
    });
  }

  // ---------- overlay ----------
  function ensureOverlay() {
    let el = document.getElementById('ymp-overlay');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'ymp-overlay';
    Object.assign(el.style, {
      position: 'fixed', bottom: '24px', right: '24px', zIndex: '2147483647',
      padding: '12px 16px', borderRadius: '8px', maxWidth: '420px',
      fontFamily: 'Arial, sans-serif', fontSize: '14px', lineHeight: '1.4',
      boxShadow: '0 6px 20px rgba(0,0,0,0.18)', border: '1px solid #ccc',
      background: '#fff', color: '#000',
    });
    document.body.appendChild(el);
    return el;
  }
  function showHint(text) {
    const el = ensureOverlay();
    el.style.borderColor = '#f0c419';
    el.style.background = '#fffbe6';
    el.textContent = '⏳ ' + text;
  }
  function showReady(text) {
    const el = ensureOverlay();
    el.style.borderColor = '#4caf50';
    el.style.background = '#e8f5e9';
    el.textContent = '✅ ' + text;
  }
  function showError(text) {
    const el = ensureOverlay();
    el.style.borderColor = '#f44336';
    el.style.background = '#ffebee';
    el.textContent = '❌ ' + text;
  }
  function hideOverlay() {
    const el = document.getElementById('ymp-overlay');
    if (el) el.remove();
  }

  // ---------- отчёт о фазах ----------
  function reportPhase(phase, error = '') {
    try {
      chrome.runtime.sendMessage({ type: 'PHASE', phase, error });
    } catch (e) { warn('reportPhase failed', e); }
  }

  // ---------- compose ----------
  async function ensureComposeOpen() {
    const existing = qs(SEL.toField);
    if (existing) {
      log('compose already open');
      return;
    }
    const btn = qs(SEL.composeButton);
    if (!btn) {
      throw new Error('Не найдена кнопка «Написать». Откройте главную страницу Яндекс.Почты.');
    }
    log('clicking compose button');
    btn.click();
    await waitFor(() => qs(SEL.toField), 15000, 'Не удалось открыть форму письма');
  }

  function placeCursorAtEnd(el) {
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function simulateEnter(el) {
    const ev = new KeyboardEvent('keydown', {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
      bubbles: true, cancelable: true,
    });
    el.dispatchEvent(ev);
    el.dispatchEvent(new KeyboardEvent('keyup', {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
      bubbles: true, cancelable: true,
    }));
  }

  /**
   * Заполняет chip-поле получателей (Кому / Копия / Скрытая копия).
   * Вводит каждый адрес по одному и подтверждает Enter-ом,
   * чтобы фреймворк превратил его в «чип».
   */
  async function fillRecipientField(el, emails) {
    if (!el) return;
    el.focus();
    await sleep(100);

    // очистить существующее содержимое
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      placeCursorAtEnd(el);
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('delete', false);
    }
    await sleep(100);

    for (const email of emails) {
      placeCursorAtEnd(el);
      document.execCommand('insertText', false, email);
      await sleep(120);
      simulateEnter(el);
      await sleep(180);
    }

    el.dispatchEvent(new Event('blur', { bubbles: true }));
    await sleep(200);
  }

  async function ensureBccOpen() {
    let bcc = qs(SEL.bccField);
    if (bcc) return bcc;

    // ищем кнопку-переключатель «Копия / Скрытая копия»
    const candidates = qsa(['button', '[role="button"]', 'a', 'span']);
    const toggle = candidates.find((el) => {
      const t = (el.textContent || '').trim().toLowerCase();
      return t === 'скрытая копия' ||
             t === 'копия' ||
             (t.includes('скрыт') && t.includes('копи'));
    });
    if (toggle) {
      toggle.click();
      await sleep(600);
      bcc = qs(SEL.bccField);
    }
    return bcc;
  }

  function getSubjectEl() { return qs(SEL.subject); }
  function getBodyEl() { return qs(SEL.body); }

  // ---------- ожидание применения шаблона ----------
  function waitForTemplate(timeout = 120000) {
    return new Promise((resolve) => {
      const start = Date.now();
      const check = () => {
        if (Date.now() - start > timeout) {
          return resolve({ ok: false, error: 'Истекло время ожидания выбора шаблона. Выберите шаблон и повторите.' });
        }
        const subj = getSubjectEl();
        const body = getBodyEl();
        const subjVal = subj ? (subj.value || '').trim() : '';
        const bodyText = body ? (body.innerText || '').trim() : '';
        if (subjVal && bodyText) {
          return resolve({ ok: true, subject: subjVal, bodyText });
        }
        setTimeout(check, 300);
      };
      check();
    });
  }

  // ---------- замена {Имя} без разрушения форматирования ----------
  function replaceInTextNodes(root, search, replacement) {
    let count = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !node.nodeValue.includes(search)) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes = [];
    let n;
    while ((n = walker.nextNode())) nodes.push(n);

    for (const node of nodes) {
      const before = node.nodeValue;
      node.nodeValue = before.split(search).join(replacement);
      if (node.nodeValue !== before) count++;
    }
    return count;
  }

  // ---------- основная логика ----------
  async function doFillGroup(group) {
    log('doFillGroup', group);

    await ensureComposeOpen();

    // 1. Кому
    const toField = await waitFor(() => qs(SEL.toField), 10000, 'Поле «Кому» не найдено');
    await fillRecipientField(toField, [group.emails[0]]);

    // 2. Скрытая копия
    if (group.emails.length > 1) {
      let bccField = qs(SEL.bccField);
      if (!bccField) bccField = await ensureBccOpen();
      if (!bccField) {
        bccField = await waitFor(() => qs(SEL.bccField), 5000, 'Поле «Скрытая копия» не найдено');
      }
      await fillRecipientField(bccField, group.emails.slice(1));
    }

    // 3. Подсказка пользователю
    showHint(`Письмо для «${group.name}». Выберите шаблон вручную в форме письма.`);
    reportPhase('waiting_template');

    // 4. Ждём вставки шаблона
    const tmpl = await waitForTemplate(120000);
    if (!tmpl.ok) throw new Error(tmpl.error);

    // 5. Проверка темы
    if (!tmpl.subject) throw new Error('Тема письма пуста после выбора шаблона.');

    // 6. Проверка плейсхолдера
    const body = getBodyEl();
    if (!body) throw new Error('Тело письма не найдено.');
    if (!body.innerText.includes('{Имя}') && !body.innerHTML.includes('{Имя}')) {
      throw new Error('В теле письма нет плейсхолдера {Имя}. Проверьте шаблон.');
    }

    // 7. Замена
    const replaced = replaceInTextNodes(body, '{Имя}', group.name);
    log('replaced text-nodes:', replaced);
    if (replaced === 0 && body.innerHTML.includes('{Имя}')) {
      // fallback: аккуратная замена в HTML (редкий случай)
      body.innerHTML = body.innerHTML.split('{Имя}').join(group.name);
    }

    // 8. Повторная проверка получателей
    await sleep(300);
    const toNow = qs(SEL.toField);
    if (toNow) {
      const txt = (toNow.innerText || toNow.value || '').trim();
      if (!txt.includes(group.emails[0])) {
        await fillRecipientField(toNow, [group.emails[0]]);
      }
    }
    if (group.emails.length > 1) {
      const bccNow = qs(SEL.bccField);
      if (bccNow) {
        const txt = (bccNow.innerText || bccNow.value || '').trim();
        const missing = group.emails.slice(1).some((e) => !txt.includes(e));
        if (missing) {
          await fillRecipientField(bccNow, group.emails.slice(1));
        }
      }
    }

    // 9. Готово
    showReady('Письмо готово. Проверьте и нажмите «Отправить» в Яндекс.Почте, затем в расширении — «Далее».');
    reportPhase('ready');
  }

  // ---------- обработка сообщений ----------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return false;

    if (msg.type === 'PING') {
      sendResponse({ ok: true });
      return false;
    }

    if (msg.type === 'FILL_GROUP') {
      // Отвечаем сразу — работа идёт асинхронно, фазы приходят через PHASE
      sendResponse({ ok: true, accepted: true });
      hideOverlay();
      doFillGroup(msg.group).catch((e) => {
        warn('fill error', e);
        showError(e.message || 'Неизвестная ошибка');
        reportPhase('error', e.message || 'Неизвестная ошибка');
      });
      return false;
    }

    return false;
  });

  log('content script loaded');
})();