'use strict';

(() => {
  if (window.__ympLoaded) return;
  window.__ympLoaded = true;

  const LOG = '[YMP:content]';
  const log = (...a) => console.log(LOG, ...a);
  const warn = (...a) => console.warn(LOG, ...a);

  // ---------- селекторы ----------
  const SEL = {
    composeButton: [
      'a[href*="compose"]',
      'button[data-testid="compose-button"]',
      '[role="button"][aria-label*="Написать" i]',
      '[role="button"][title*="Написать" i]',
      '.ns-view-compose-button a',
    ],
    toField: [
      'div[contenteditable="true"][id^="compose-field-"][aria-label*="Кому" i]',
      'div[contenteditable="true"][data-name="to"]',
      'div[contenteditable="true"][aria-label*="Кому" i]',
      'input[name="to"]',
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

  // ---------- утилиты ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function qs(selectors, root = document) {
    for (const sel of selectors) {
      try { const el = root.querySelector(sel); if (el) return el; } catch (_) {}
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
  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    let n = el;
    while (n && n !== document.body) {
      const s = window.getComputedStyle(n);
      if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
      n = n.parentElement;
    }
    return true;
  }
  function waitFor(getter, timeout = 10000, errorMsg = 'Timeout') {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const tick = () => {
        let el = null;
        try { el = getter(); } catch (_) {}
        if (el) return resolve(el);
        if (Date.now() - start > timeout) return reject(new Error(errorMsg));
        setTimeout(tick, 200);
      };
      tick();
    });
  }
  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // ---------- overlay ----------
  function ensureOverlay() {
    let el = document.getElementById('ymp-overlay');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'ymp-overlay';
    Object.assign(el.style, {
      position: 'fixed', bottom: '24px', right: '24px', zIndex: '2147483647',
      padding: '12px 16px', borderRadius: '8px', maxWidth: '440px',
      fontFamily: 'Arial, sans-serif', fontSize: '14px', lineHeight: '1.4',
      boxShadow: '0 6px 20px rgba(0,0,0,0.18)', border: '1px solid #ccc',
      background: '#fff', color: '#000',
    });
    document.body.appendChild(el);
    return el;
  }
  function showHint(text)  { const el = ensureOverlay(); el.style.borderColor = '#f0c419'; el.style.background = '#fffbe6'; el.textContent = '⏳ ' + text; }
  function showReady(text) { const el = ensureOverlay(); el.style.borderColor = '#4caf50'; el.style.background = '#e8f5e9'; el.textContent = '✅ ' + text; }
  function showError(text) { const el = ensureOverlay(); el.style.borderColor = '#f44336'; el.style.background = '#ffebee'; el.textContent = '❌ ' + text; }
  function hideOverlay() { const el = document.getElementById('ymp-overlay'); if (el) el.remove(); }

  function reportPhase(phase, error = '') {
    try { chrome.runtime.sendMessage({ type: 'PHASE', phase, error }); }
    catch (e) { warn('reportPhase:', e); }
  }

  // ---------- compose ----------
  async function ensureComposeOpen() {
    const existing = qs(SEL.toField);
    if (existing && isVisible(existing)) return;
    const btn = qs(SEL.composeButton);
    if (!btn) throw new Error('Не найдена кнопка «Написать». Откройте главную страницу Яндекс.Почты.');
    btn.click();
    await waitFor(() => {
      const el = qs(SEL.toField);
      return el && isVisible(el) ? el : null;
    }, 15000, 'Не удалось открыть форму письма');
  }

  // ---------- клавиатура ----------
  function makeKeyEvent(type, key, code, keyCode) {
    const ev = new KeyboardEvent(type, { key, code, bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'keyCode', { get: () => keyCode });
    Object.defineProperty(ev, 'which', { get: () => keyCode });
    return ev;
  }
  function dispatchEnter(t) {
    t.dispatchEvent(makeKeyEvent('keydown', 'Enter', 'Enter', 13));
    t.dispatchEvent(makeKeyEvent('keypress', 'Enter', 'Enter', 13));
    t.dispatchEvent(makeKeyEvent('keyup', 'Enter', 'Enter', 13));
  }
  function dispatchTab(t) {
    t.dispatchEvent(makeKeyEvent('keydown', 'Tab', 'Tab', 9));
    t.dispatchEvent(makeKeyEvent('keyup', 'Tab', 'Tab', 9));
  }
  function dispatchComma(t) {
    t.dispatchEvent(makeKeyEvent('keydown', ',', 'Comma', 188));
    t.dispatchEvent(makeKeyEvent('keypress', ',', 'Comma', 188));
    t.dispatchEvent(makeKeyEvent('keyup', ',', 'Comma', 188));
  }

  // ---------- работа с полями получателей ----------
  function findInnerInput(field) {
    if (!field) return null;
    if (field.tagName === 'INPUT' || field.tagName === 'TEXTAREA') return field;
    return field.querySelector('input[type="text"], input:not([type]), textarea');
  }
  function setNativeValue(input, value) {
    const proto = input.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, value);
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

  /**
   * Адрес присутствует в поле именно как отдельный токен (не склеен).
   * Проверяем textContent с границами и наличие листового элемента с текстом = email.
   */
  function emailAppearsSeparated(field, email) {
    if (!field) return false;
    const lower = email.toLowerCase().trim();
    const text = (field.innerText || field.textContent || '').toLowerCase();
    const re = new RegExp(`(^|[\\s,;])${escapeRegex(lower)}([\\s,;]|$)`);
    if (re.test(text)) return true;
    for (const le of field.querySelectorAll('*')) {
      if (le.children.length === 0 && (le.textContent || '').trim().toLowerCase() === lower) {
        return true;
      }
    }
    return false;
  }

  /** Адрес именно как отдельный «чип» (элемент-обёртка с текстом = email). */
  function isChip(field, email) {
    if (!field) return false;
    const lower = email.toLowerCase().trim();
    for (const c of field.querySelectorAll('*')) {
      if (c === field) continue;
      if (c.tagName === 'INPUT' || c.tagName === 'TEXTAREA') continue;
      if (c.childElementCount > 3) continue;
      const txt = (c.textContent || '').trim().toLowerCase();
      // допускаем чип с «×» рядом: убираем не-буквенные хвостики
      if (txt === lower || txt === lower + '×' || txt === lower + 'x') return true;
    }
    return false;
  }

  async function clearField(el) {
    el.focus();
    await sleep(80);
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      setNativeValue(el, '');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    if (el.isContentEditable) {
      try {
        const r = document.createRange();
        r.selectNodeContents(el);
        const s = window.getSelection();
        s.removeAllRanges();
        s.addRange(r);
        document.execCommand('delete', false);
      } catch (_) {}
      // добить оставшиеся чипы-элементы
      const input = findInnerInput(el);
      Array.from(el.children).forEach((c) => {
        if (c !== input && c.getAttribute('contenteditable') !== 'true') c.remove();
      });
    }
    const inp = findInnerInput(el);
    if (inp && inp !== el) {
      setNativeValue(inp, '');
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    }
    await sleep(80);
  }

  function findSuggestion(email) {
    const lower = email.toLowerCase();
    const sels = [
      '[role="listbox"] [role="option"]',
      '[role="option"]',
      '[class*="suggest"] [class*="item"]',
      '[class*="autocomplete"] [class*="item"]',
      'li[class*="suggest"]',
    ];
    for (const sel of sels) {
      let items; try { items = document.querySelectorAll(sel); } catch (_) { continue; }
      for (const item of items) {
        if (!isVisible(item)) continue;
        if ((item.textContent || '').toLowerCase().includes(lower)) return item;
      }
    }
    return null;
  }

  /**
   * Вставить ровно ОДИН адрес и попытаться закоммитить его как чип.
   * Ключевое отличие: перед вставкой проверяем, что предыдущее содержимое
   * уже оканчивается разделителем, и при необходимости добавляем его —
   * так исключается склейка.
   */
  async function insertOneRecipient(el, email) {
    const input = findInnerInput(el);
    const target = input || el;
    target.focus();
    await sleep(80);

    // === Способ 1: синтетический paste одного адреса ===
    try {
      const dt = new DataTransfer();
      dt.setData('text/plain', email);
      target.dispatchEvent(new ClipboardEvent('paste', {
        bubbles: true, cancelable: true, clipboardData: dt,
      }));
      await sleep(400);
    } catch (e) { warn('paste-one failed:', e); }

    if (isChip(el, email) || emailAppearsSeparated(el, email)) {
      return true;
    }

    // === Способ 2: вставка текста вручную ===
    if (input) {
      const cur = input.value || '';
      const sep = (cur && !/[\s,;]$/.test(cur)) ? ', ' : '';
      setNativeValue(input, cur + sep + email);
      input.dispatchEvent(new InputEvent('input', {
        bubbles: true, cancelable: true, inputType: 'insertText', data: email,
      }));
    } else if (el.isContentEditable) {
      // перед вставкой добить разделитель, если он отсутствует
      const txt = (el.textContent || '').replace(/\s+$/, '');
      if (txt && !/[\s,;]$/.test(txt)) {
        placeCursorAtEnd(el);
        document.execCommand('insertText', false, ', ');
        await sleep(80);
      }
      placeCursorAtEnd(el);
      document.execCommand('insertText', false, email);
    } else {
      return false;
    }
    await sleep(350);

    // клик по подсказке
    const sugg = findSuggestion(email);
    if (sugg) { sugg.click(); await sleep(300); if (isChip(el, email)) return true; }

    // Enter / Tab / Comma / blur — по очереди
    dispatchEnter(target); await sleep(300); if (isChip(el, email)) return true;
    dispatchTab(target);   await sleep(300); if (isChip(el, email)) return true;
    dispatchComma(target); await sleep(300); if (isChip(el, email)) return true;
    target.blur(); await sleep(250);
    if (isChip(el, email)) return true;
    target.focus(); await sleep(150);

    return isChip(el, email) || emailAppearsSeparated(el, email);
  }

  /** Поставить `, ` после последнего вставленного текста, если разделителя нет. */
  async function ensureSeparatorAfter(el) {
    const input = findInnerInput(el);
    if (input) {
      const v = input.value || '';
      if (v && !/[\s,;]$/.test(v)) {
        setNativeValue(input, v + ', ');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await sleep(80);
      }
      return;
    }
    if (el.isContentEditable) {
      // ищем последний содержательный текстовый узел
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let last = null, n;
      while ((n = walker.nextNode())) {
        if (n.nodeValue && n.nodeValue.trim()) last = n;
      }
      if (!last) return; // всё — чипы, разделитель не нужен
      if (/[\s,;]$/.test(last.nodeValue)) return;
      try {
        placeCursorAtEnd(el);
        document.execCommand('insertText', false, ', ');
        await sleep(80);
      } catch (e) { warn('ensureSeparatorAfter:', e); }
    }
  }

  /** Диагностика склейки: ищем пары email1+email2 без разделителя. */
  function detectGlue(el, emails) {
    const text = (el.innerText || el.textContent || el.value || '').toLowerCase();
    const glued = [];
    for (let i = 0; i < emails.length; i++) {
      for (let j = 0; j < emails.length; j++) {
        if (i === j) continue;
        if (text.includes(emails[i].toLowerCase() + emails[j].toLowerCase())) {
          glued.push(`${emails[i]} + ${emails[j]}`);
        }
      }
    }
    return glued;
  }

  async function fillRecipientField(el, emails) {
    if (!el || emails.length === 0) return;
    if (!isVisible(el)) throw new Error('Целевое поле не отображается на странице');

    const input = findInnerInput(el);
    const target = input || el;

    // === Стратегия A: единый paste всех адресов (Yandex создаёт чипы) ===
    await clearField(el);
    await sleep(150);
    target.focus();
    await sleep(100);

    try {
      const dt = new DataTransfer();
      dt.setData('text/plain', emails.join(', '));
      target.dispatchEvent(new ClipboardEvent('paste', {
        bubbles: true, cancelable: true, clipboardData: dt,
      }));
    } catch (e) { warn('paste-all:', e); }
    await sleep(600);

    const allPresentA = emails.every((e) => isChip(el, e) || emailAppearsSeparated(el, e));
    const allChipsA   = emails.every((e) => isChip(el, e));
    if (allPresentA) {
      log(`recipients filled via paste-all (chips=${allChipsA}, n=${emails.length})`);
      el.dispatchEvent(new Event('blur', { bubbles: true }));
      await sleep(200);
      return;
    }

    // === Стратегия B: по одному, с гарантированными разделителями ===
    log('paste-all incomplete, switching to per-email');
    await clearField(el);
    await sleep(150);

    for (let i = 0; i < emails.length; i++) {
      const isLast = i === emails.length - 1;
      const ok = await insertOneRecipient(el, emails[i]);
      if (!ok) {
        const cur = (el.innerText || el.textContent || el.value || '').trim();
        throw new Error(
          `Не удалось добавить адрес «${emails[i]}» (${i + 1}/${emails.length}). ` +
          `Текущее содержимое поля: "${cur.slice(0, 100)}". Проверьте вручную.`
        );
      }
      // ставим разделитель после КАЖДОГО, кроме последнего, если адрес не стал чипом
      if (!isLast && !isChip(el, emails[i])) {
        await ensureSeparatorAfter(el);
      }
    }

    // === финальная проверка ===
    await sleep(250);
    const missing = emails.filter((e) => !isChip(el, e) && !emailAppearsSeparated(el, e));
    const glued = detectGlue(el, emails);
    if (missing.length || glued.length) {
      const parts = [];
      if (missing.length) parts.push(`не попали: ${missing.join(', ')}`);
      if (glued.length) parts.push(`склеены: ${glued.join('; ')}`);
      throw new Error(
        `Ошибка заполнения поля: ${parts.join('. ')}. ` +
        `Проверьте поле вручную перед отправкой.`
      );
    }

    el.dispatchEvent(new Event('blur', { bubbles: true }));
    await sleep(200);
    log(`recipients filled via per-email (n=${emails.length})`);
  }

  // ---------- открытие BCC ----------
  function findBccToggle() {
    return qsa(['button', '[role="button"]', 'a', 'span']).find((el) => {
      if (!isVisible(el)) return false;
      const t = (el.textContent || '').trim().toLowerCase();
      return t === 'скрытая копия' || t === 'скрыть' || (t.includes('скрыт') && t.includes('копи'));
    }) || null;
  }
  function findCcToggle() {
    return qsa(['button', '[role="button"]', 'a', 'span']).find((el) => {
      if (!isVisible(el)) return false;
      const t = (el.textContent || '').trim().toLowerCase();
      return t === 'копия' || t === 'добавить копию';
    }) || null;
  }
  async function ensureBccOpen() {
    let bcc = qs(SEL.bccField);
    if (bcc && isVisible(bcc)) return bcc;

    let toggle = findBccToggle();
    if (toggle) {
      toggle.click();
      await sleep(500);
      bcc = qs(SEL.bccField);
      if (bcc && isVisible(bcc)) return bcc;
    }
    const ccToggle = findCcToggle();
    if (ccToggle) {
      ccToggle.click();
      await sleep(400);
      toggle = findBccToggle();
      if (toggle) {
        toggle.click();
        await sleep(500);
        bcc = qs(SEL.bccField);
        if (bcc && isVisible(bcc)) return bcc;
      }
    }
    await sleep(1000);
    bcc = qs(SEL.bccField);
    return bcc && isVisible(bcc) ? bcc : null;
  }

  // ---------- тема / тело ----------
  function getSubjectEl() { return qs(SEL.subject); }
  function getBodyEl()    { return qs(SEL.body); }

  function waitForTemplate(timeout = 120000) {
    return new Promise((resolve) => {
      const start = Date.now();
      const check = () => {
        if (Date.now() - start > timeout) {
          return resolve({ ok: false, error: 'Истекло время ожидания выбора шаблона. Выберите шаблон и повторите.' });
        }
        const s = getSubjectEl(), b = getBodyEl();
        const sv = s ? (s.value || '').trim() : '';
        const bv = b ? (b.innerText || '').trim() : '';
        if (sv && bv) return resolve({ ok: true, subject: sv, bodyText: bv });
        setTimeout(check, 300);
      };
      check();
    });
  }

  function replaceInTextNodes(root, search, replacement) {
    let count = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !node.nodeValue.includes(search)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes = [];
    let n; while ((n = walker.nextNode())) nodes.push(n);
    for (const node of nodes) {
      const before = node.nodeValue;
      node.nodeValue = before.split(search).join(replacement);
      if (node.nodeValue !== before) count++;
    }
    return count;
  }

  // ---------- основной сценарий ----------
  async function doFillGroup(group) {
    log('doFillGroup', group);
    await ensureComposeOpen();

    // 1. Кому
    const toField = await waitFor(() => {
      const el = qs(SEL.toField); return el && isVisible(el) ? el : null;
    }, 10000, 'Поле «Кому» не найдено');
    await fillRecipientField(toField, [group.emails[0]]);

    // 2. Скрытая копия
    if (group.emails.length > 1) {
      let bcc = qs(SEL.bccField);
      if (!bcc || !isVisible(bcc)) bcc = await ensureBccOpen();
      if (!bcc) {
        bcc = await waitFor(() => {
          const el = qs(SEL.bccField); return el && isVisible(el) ? el : null;
        }, 8000, 'Поле «Скрытая копия» не удалось открыть');
      }
      await fillRecipientField(bcc, group.emails.slice(1));
    }

    // 3. Подсказка
    showHint(`Письмо для «${group.name}». Выберите шаблон вручную в форме письма.`);
    reportPhase('waiting_template');

    // 4. Ждём шаблон
    const tmpl = await waitForTemplate(120000);
    if (!tmpl.ok) throw new Error(tmpl.error);
    if (!tmpl.subject) throw new Error('Тема письма пуста после выбора шаблона.');

    // 5. Плейсхолдер
    const body = getBodyEl();
    if (!body) throw new Error('Тело письма не найдено.');
    if (!body.innerText.includes('{Имя}') && !body.innerHTML.includes('{Имя}')) {
      throw new Error('В теле письма нет плейсхолдера {Имя}. Проверьте шаблон.');
    }

    // 6. Замена
    const replaced = replaceInTextNodes(body, '{Имя}', group.name);
    log('replaced text-nodes:', replaced);
    if (replaced === 0 && body.innerHTML.includes('{Имя}')) {
      body.innerHTML = body.innerHTML.split('{Имя}').join(group.name);
    }

    // 7. Финальная верификация получателей
    await sleep(300);
    const toNow = qs(SEL.toField);
    if (!toNow || (!isChip(toNow, group.emails[0]) && !emailAppearsSeparated(toNow, group.emails[0]))) {
      if (toNow) await fillRecipientField(toNow, [group.emails[0]]);
    }
    if (group.emails.length > 1) {
      const bccNow = qs(SEL.bccField);
      const bccEmails = group.emails.slice(1);
      const stillMissing = bccEmails.filter((e) =>
        !bccNow || (!isChip(bccNow, e) && !emailAppearsSeparated(bccNow, e))
      );
      if (stillMissing.length) {
        if (bccNow) await fillRecipientField(bccNow, bccEmails);
        const bccAfter = qs(SEL.bccField);
        const glued = bccAfter ? detectGlue(bccAfter, bccEmails) : [];
        const remainMissing = bccEmails.filter((e) =>
          !bccAfter || (!isChip(bccAfter, e) && !emailAppearsSeparated(bccAfter, e))
        );
        if (remainMissing.length || glued.length) {
          const parts = [];
          if (remainMissing.length) parts.push(`не попали: ${remainMissing.join(', ')}`);
          if (glued.length) parts.push(`склеены: ${glued.join('; ')}`);
          throw new Error(`«Скрытая копия» заполнена не полностью — ${parts.join('. ')}. Добавьте адреса вручную.`);
        }
      }
    }

    showReady('Письмо готово. Проверьте и нажмите «Отправить» в Яндекс.Почте, затем в расширении — «Далее».');
    reportPhase('ready');
  }

  // ---------- сообщения ----------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return false;
    if (msg.type === 'PING') { sendResponse({ ok: true }); return false; }
    if (msg.type === 'FILL_GROUP') {
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

  log('content script loaded (v3 — no-glue recipient filler)');
})();