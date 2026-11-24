/* ============================================================
   TROTUAR AI 2.0 — логика приложения.
   Сохраняет поведение 1.x (история в localStorage, сайдбар,
   аватар, мобильное меню) и добавляет: стриминг Ollama, Markdown,
   подсветку кода, действия над сообщениями, режимы Чат/Изображение/
   Редактор, настройки, голос, файлы, горячие клавиши.
   ============================================================ */
(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  // ---------- Ключи хранилища ----------
  const STORAGE_KEY = 'trotuar_ai_chats_v3';
  const LEGACY_KEY = 'trotuar_ai_chats_v2';
  const ACTIVE_KEY = 'trotuar_ai_active_chat';
  const UI_KEY = 'trotuar_ai_ui_v3';
  const GALLERY_KEY = 'trotuar_ai_gallery_v3';
  const EDITOR_KEY = 'trotuar_ai_editor_v3';

  // ---------- Ссылки на DOM ----------
  const promptInput = $('#prompt');
  const messagesEl = $('#messages');
  const sendButton = $('.send');
  const chatList = $('#chat-list');
  const welcome = $('.welcome');
  const searchInput = $('#history-search');
  const attachChipRow = $('#attach-chip-row');
  const modeControls = $('#mode-controls');
  const fileInput = $('#file-input');

  // ---------- Состояние ----------
  let chats = [];
  let activeId = null;
  let isSending = false;
  let abortController = null;
  let currentMode = 'chat';
  let pendingTextFiles = [];   // [{name, text}]
  let pendingImages = [];      // [{name, dataUrl}]
  let gallery = [];            // [{id, prompt, style, size, seed, url, createdAt, status}]
  let editorState = null;      // {name, mime, dataUrl}
  let ui = { theme: 'dark', username: 'TROTUAR_USER', mode: 'chat' };
  let health = null;
  let speaking = null;

  const makeId = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2));

  // ---------- localStorage: загрузка и сохранение ----------
  function loadChats() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) { const parsed = JSON.parse(raw); if (Array.isArray(parsed)) return parsed; }
      const legacy = localStorage.getItem(LEGACY_KEY);
      if (legacy) {
        const parsed = JSON.parse(legacy);
        if (Array.isArray(parsed)) return parsed.map((c) => ({ ...c, messages: (c.messages || []).map((m) => ({ id: makeId(), ...m })) }));
      }
    } catch {}
    return [];
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(chats.slice(0, 100)));
      localStorage.setItem(ACTIVE_KEY, activeId || '');
    } catch (error) {
      // Переполнение localStorage: убираем изображения из самых старых чатов и пробуем снова
      try {
        const pruned = chats.map((chat, index) => index < 3 ? chat : {
          ...chat,
          messages: chat.messages.map((m) => ({ ...m, images: undefined }))
        });
        localStorage.setItem(STORAGE_KEY, JSON.stringify(pruned.slice(0, 100)));
      } catch {
        toast('Не удалось сохранить историю: хранилище браузера переполнено.', 'error');
      }
    }
  }

  function loadJson(key, fallback) {
    try { const v = JSON.parse(localStorage.getItem(key) || 'null'); return v == null ? fallback : v; }
    catch { return fallback; }
  }

  function saveUi() {
    localStorage.setItem(UI_KEY, JSON.stringify(ui));
  }

  function saveGallery() {
    try { localStorage.setItem(GALLERY_KEY, JSON.stringify(gallery.slice(0, 60))); } catch {}
  }

  // ---------- Тосты ----------
  function toast(message, kind = 'info', ms = 3800) {
    const zone = $('#toast-zone');
    const el = document.createElement('div');
    el.className = 'toast' + (kind === 'success' ? ' success' : kind === 'error' ? ' error' : '');
    el.textContent = message;
    zone.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 320); }, ms);
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); toast('Скопировано в буфер обмена', 'success', 1800); }
    catch {
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); ta.remove();
      toast('Скопировано', 'success', 1800);
    }
  }

  function download(href, filename) {
    const a = document.createElement('a');
    a.href = href; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
  }

  // ---------- Markdown ----------
  if (window.marked) marked.setOptions({ gfm: true, breaks: true, async: false });
  function renderMarkdown(text) {
    if (!window.marked || !window.DOMPurify) return escapeHtml(text);
    const dirty = marked.parse(String(text || ''));
    return DOMPurify.sanitize(dirty, { ADD_ATTR: ['target'] });
  }
  function escapeHtml(v) {
    return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function enhanceCodeBlocks(container) {
    container.querySelectorAll('pre code').forEach((block) => {
      if (block.dataset.enhanced) return;
      block.dataset.enhanced = '1';
      try { if (window.hljs) hljs.highlightElement(block); } catch {}
      const pre = block.parentElement;
      const wrap = document.createElement('div');
      wrap.className = 'code-block';
      const head = document.createElement('div');
      head.className = 'code-block-head';
      const lang = (block.className.match(/language-([\w-]+)/) || [])[1] || 'код';
      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.textContent = 'Копировать';
      copyBtn.addEventListener('click', () => copyText(block.textContent));
      head.append(Object.assign(document.createElement('span'), { textContent: lang }), copyBtn);
      pre.replaceWith(wrap);
      wrap.append(head, pre);
    });
    container.querySelectorAll('a[href]').forEach((a) => { a.target = '_blank'; a.rel = 'noopener noreferrer'; });
  }

  // ---------- История чатов ----------
  const activeChat = () => chats.find((c) => c.id === activeId);
  function titleFrom(text) {
    const clean = String(text).replace(/\s+/g, ' ').trim();
    return clean.length > 34 ? clean.slice(0, 33) + '…' : clean || 'Новый чат';
  }

  function createChat(silent = false) {
    const chat = { id: makeId(), title: 'Новый чат', createdAt: Date.now(), updatedAt: Date.now(), messages: [], pinned: false };
    chats.unshift(chat);
    activeId = chat.id;
    save(); renderAll();
    promptInput.focus();
    closeSidebarOnMobile();
    if (!silent) toast('Новый чат создан', 'success', 1500);
    return chat;
  }

  function dateLabel(ts) {
    const d = new Date(ts);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const diff = Math.floor((today - new Date(new Date(ts).setHours(0, 0, 0, 0))) / 86400000);
    if (diff === 0) return 'СЕГОДНЯ';
    if (diff === 1) return 'ВЧЕРА';
    if (diff < 7) return 'ПОСЛЕДНИЕ 7 ДНЕЙ';
    return d.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' }).toUpperCase();
  }

  function renderSidebar(filter = '') {
    const query = filter.trim().toLowerCase();
    chatList.replaceChildren();

    const sorted = [...chats].sort((a, b) => {
      if (!!b.pinned !== !!a.pinned) return b.pinned ? 1 : -1;
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });
    const filtered = query
      ? sorted.filter((c) =>
          c.title.toLowerCase().includes(query) ||
          (c.messages || []).some((m) => (m.text || '').toLowerCase().includes(query)))
      : sorted;

    if (!filtered.length) {
      const empty = document.createElement('div');
      empty.className = 'history-empty';
      empty.textContent = query ? 'Ничего не найдено' : 'Здесь появятся ваши диалоги';
      chatList.appendChild(empty);
      return;
    }

    let lastGroup = null;
    filtered.forEach((chat) => {
      const group = chat.pinned ? 'ЗАКРЕПЛЁННЫЕ' : dateLabel(chat.updatedAt || chat.createdAt);
      if (group !== lastGroup) {
        const g = document.createElement('div');
        g.className = 'date-group';
        g.textContent = group;
        chatList.appendChild(g);
        lastGroup = group;
      }
      const row = document.createElement('div');
      row.className = 'chat-row' + (chat.id === activeId ? ' active' : '') + (chat.pinned ? ' pinned' : '');
      const open = document.createElement('button');
      open.className = 'chat-open';
      open.type = 'button';
      open.innerHTML = '<span class="chat-row-icon">◷</span><span class="chat-title"></span>' + (chat.pinned ? '<span class="pin-dot" title="Закреплённый чат"></span>' : '');
      open.querySelector('.chat-title').textContent = chat.title;
      open.addEventListener('click', () => { activeId = chat.id; save(); renderAll(); closeSidebarOnMobile(); });
      const more = document.createElement('button');
      more.className = 'chat-more';
      more.type = 'button';
      more.textContent = '•••';
      more.setAttribute('aria-label', 'Действия с чатом');
      more.addEventListener('click', (event) => { event.stopPropagation(); openChatMenu(chat, event.currentTarget); });
      row.append(open, more);
      chatList.appendChild(row);
    });
  }

  // ---------- Контекстное меню чата ----------
  const ctxMenu = $('#chat-ctx-menu');
  let ctxChat = null;
  function openChatMenu(chat, anchor) {
    ctxChat = chat;
    $('#ctx-pin-label').textContent = chat.pinned ? 'Открепить' : 'Закрепить';
    ctxMenu.classList.add('open');
    const rect = anchor.getBoundingClientRect();
    const menuH = ctxMenu.offsetHeight || 160;
    ctxMenu.style.left = Math.min(rect.left, window.innerWidth - 210) + 'px';
    ctxMenu.style.top = (rect.bottom + 6 + menuH > window.innerHeight ? rect.top - menuH - 6 : rect.bottom + 6) + 'px';
  }
  function closeCtxMenu() { ctxMenu.classList.remove('open'); }
  document.addEventListener('click', (e) => { if (!ctxMenu.contains(e.target)) closeCtxMenu(); });
  ctxMenu.addEventListener('click', (event) => {
    const action = event.target.closest('[data-ctx]')?.dataset.ctx;
    if (!action || !ctxChat) return;
    closeCtxMenu();
    const chat = ctxChat;
    if (action === 'rename') {
      const next = prompt('Новое название чата', chat.title);
      if (next && next.trim()) { chat.title = next.trim().slice(0, 60); save(); renderSidebar(searchInput.value); }
    } else if (action === 'pin') {
      chat.pinned = !chat.pinned;
      save(); renderSidebar(searchInput.value);
      toast(chat.pinned ? 'Чат закреплён' : 'Чат откреплён', 'success', 1500);
    } else if (action === 'delete') {
      if (confirm('Удалить эту переписку?')) {
        chats = chats.filter((item) => item.id !== chat.id);
        if (activeId === chat.id) activeId = chats[0]?.id || null;
        if (!activeId) createChat(true); else { save(); renderAll(); }
        toast('Переписка удалена', 'success', 1500);
      }
    } else if (action === 'export') {
      const blob = new Blob([JSON.stringify(chat, null, 2)], { type: 'application/json' });
      download(URL.createObjectURL(blob), `trotuar-chat-${chat.id.slice(0, 8)}.json`);
    }
  });

  // ---------- Рендер сообщений ----------
  const ICONS = {
    copy: '<svg viewBox="0 0 24 24" fill="none"><rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" stroke-width="1.8"/><path d="M5 15V5a2 2 0 0 1 2-2h10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    regen: '<svg viewBox="0 0 24 24" fill="none"><path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v4h-4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    edit: '<svg viewBox="0 0 24 24" fill="none"><path d="m14 5 5 5M4 20l4.2-.9L20 7.3 16.7 4 4.9 15.8 4 20Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
    speak: '<svg viewBox="0 0 24 24" fill="none"><rect x="9" y="2" width="6" height="13" rx="3" stroke="currentColor" stroke-width="1.8"/><path d="M5 11a7 7 0 0 0 14 0M12 18v4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    stopSpeak: '<svg viewBox="0 0 24 24" fill="none"><rect x="9" y="2" width="6" height="13" rx="3" stroke="currentColor" stroke-width="1.8"/><path d="M5 11a7 7 0 0 0 14 0M12 18v4M8 4l8 16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>'
  };

  function buildActions(message, index, isLastUser, isLastAssistant) {
    const actions = document.createElement('div');
    actions.className = 'msg-actions';
    const mkBtn = (label, icon, handler) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.innerHTML = icon + '<span>' + label + '</span>';
      b.addEventListener('click', handler);
      actions.appendChild(b);
      return b;
    };
    mkBtn('Копировать', ICONS.copy, () => copyText(message.text || ''));
    if (message.role === 'assistant') {
      const speakBtn = mkBtn(speaking === index ? 'Стоп' : 'Озвучить', speaking === index ? ICONS.stopSpeak : ICONS.speak, () => toggleSpeak(message, index, speakBtn));
      if (isLastAssistant) mkBtn('Заново', ICONS.regen, regenerateLast);
    }
    if (message.role === 'user' && isLastUser) mkBtn('Изменить', ICONS.edit, () => editUserMessage(index));
    return actions;
  }

  function messageBubble(message, index, opts = {}) {
    const bubble = document.createElement('div');
    bubble.className = 'message ' + (message.role === 'user' ? 'user' : 'ai') + (message.error ? ' error' : '');
    bubble.dataset.index = String(index);

    if (message.role === 'assistant' && !opts.plain) {
      const md = document.createElement('div');
      md.className = 'md';
      md.innerHTML = renderMarkdown(message.text || '');
      bubble.appendChild(md);
      enhanceCodeBlocks(md);
    } else {
      bubble.textContent = message.text || '';
    }

    if (Array.isArray(message.images) && message.images.length) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin-top:8px';
      message.images.forEach((img) => {
        const image = document.createElement('img');
        image.src = img.dataUrl || img;
        image.alt = img.name || 'вложение';
        image.style.cssText = 'max-width:160px;max-height:160px;border-radius:12px;border:1px solid rgba(255,255,255,.2);cursor:pointer';
        image.addEventListener('click', () => openLightbox(image.src, null, null));
        row.appendChild(image);
      });
      bubble.appendChild(row);
    }

    if (message.streaming) {
      bubble.querySelector('.md')?.insertAdjacentHTML('beforeend', '<span class="stream-cursor"></span>');
    }
    if (!message.streaming) bubble.appendChild(buildActions(message, index, opts.isLastUser, opts.isLastAssistant));
    return bubble;
  }

  function renderMessages() {
    messagesEl.replaceChildren();
    const chat = activeChat();
    const hasMessages = !!chat?.messages?.length;
    welcome.classList.toggle('has-messages', hasMessages);
    if (hasStudioVisible()) welcome.classList.add('has-messages');
    if (!hasMessages) return;
    const lastUserIdx = (() => { for (let i = chat.messages.length - 1; i >= 0; i--) if (chat.messages[i].role === 'user') return i; return -1; })();
    const lastAssistantIdx = (() => { for (let i = chat.messages.length - 1; i >= 0; i--) if (chat.messages[i].role === 'assistant') return i; return -1; })();
    chat.messages.forEach((message, index) => {
      messagesEl.appendChild(messageBubble(message, index, {
        isLastUser: index === lastUserIdx,
        isLastAssistant: index === lastAssistantIdx
      }));
    });
    requestAnimationFrame(() => messagesEl.scrollIntoView({ behavior: 'smooth', block: 'end' }));
  }

  function renderAll() {
    renderSidebar(searchInput.value);
    renderMessages();
  }

  // ---------- Озвучивание (TTS) ----------
  function toggleSpeak(message, index, btn) {
    if (!('speechSynthesis' in window)) { toast('Озвучивание не поддерживается этим браузером.', 'error'); return; }
    if (speaking === index) { speechSynthesis.cancel(); speaking = null; renderMessages(); return; }
    speechSynthesis.cancel();
    const plain = String(message.text || '').replace(/```[\s\S]*?```/g, ' блок кода ').replace(/[#*_`>\-]+/g, ' ').slice(0, 4000);
    const utterance = new SpeechSynthesisUtterance(plain);
    utterance.lang = 'ru-RU';
    utterance.rate = 1.02;
    utterance.onend = () => { speaking = null; renderMessages(); };
    utterance.onerror = () => { speaking = null; renderMessages(); };
    speaking = index;
    speechSynthesis.speak(utterance);
    renderMessages();
  }

  // ---------- Действия: повторная генерация и редактирование ----------
  function regenerateLast() {
    if (isSending) return;
    const chat = activeChat();
    if (!chat) return;
    for (let i = chat.messages.length - 1; i >= 0; i--) {
      if (chat.messages[i].role === 'assistant') { chat.messages.splice(i, 1); break; }
    }
    save(); renderAll();
    streamAssistantReply();
  }

  function editUserMessage(index) {
    const chat = activeChat();
    if (!chat || isSending) return;
    const message = chat.messages[index];
    if (!message) return;
    chat.messages = chat.messages.slice(0, index);
    save(); renderAll();
    promptInput.value = message.text || '';
    autoGrow();
    promptInput.focus();
  }

  // ---------- Отправка и стриминг ----------
  function chatPayload() {
    const chat = activeChat();
    if (!chat) return [];
    return chat.messages
      .filter((m) => !m.error)
      .slice(-30)
      .map((m) => ({
        role: m.role,
        content: m.text || '',
        ...(Array.isArray(m.images) && m.images.length ? { images: m.images.map((i) => i.dataUrl || i) } : {})
      }));
  }

  function streamAssistantReply() {
    const chat = activeChat();
    if (!chat) return;
    isSending = true;
    sendButton.disabled = false; // активна как кнопка "Стоп"
    sendButton.classList.add('stop', 'sending');
    sendButton.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>';
    promptInput.disabled = true;

    const reply = { id: makeId(), role: 'assistant', text: '', streaming: true };
    chat.messages.push(reply);
    chat.updatedAt = Date.now();
    renderMessages();

    let pendingRender = false;
    const replyEl = () => messagesEl.querySelector(`[data-index="${chat.messages.length - 1}"] .md`);
    const scheduleRender = () => {
      if (pendingRender) return;
      pendingRender = true;
      requestAnimationFrame(() => {
        pendingRender = false;
        const el = replyEl();
        if (el) { el.innerHTML = renderMarkdown(reply.text); enhanceCodeBlocks(el); el.insertAdjacentHTML('beforeend', '<span class="stream-cursor"></span>'); }
        const lastMsg = messagesEl.lastElementChild;
        if (lastMsg) lastMsg.scrollIntoView({ block: 'end' });
      });
    };

    abortController = new AbortController();
    const finish = (errorText, isError) => {
      reply.streaming = false;
      if (errorText && !reply.text) reply.text = errorText;
      if (errorText && reply.text) reply.text += (isError ? '\n\n' + errorText : '');
      reply.error = Boolean(isError && errorText);
      isSending = false;
      abortController = null;
      sendButton.classList.remove('stop', 'sending');
      sendButton.innerHTML = '<svg viewBox="0 0 24 24" fill="none"><path d="M5 12h13m-6-6 6 6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      promptInput.disabled = false;
      save(); renderAll();
      promptInput.focus();
    };

    fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: chatPayload() }),
      signal: abortController.signal
    }).then(async (response) => {
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `Ошибка сервера (${response.status})`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep;
        while ((sep = buffer.indexOf('\n\n')) >= 0) {
          const rawEvent = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          for (const line of rawEvent.split('\n')) {
            if (!line.startsWith('data:')) continue;
            let event;
            try { event = JSON.parse(line.slice(5).trim()); } catch { continue; }
            if (event.type === 'token') { reply.text += event.text || ''; scheduleRender(); }
            else if (event.type === 'done') { finish(); return; }
            else if (event.type === 'aborted') { finish(null); return; }
            else if (event.type === 'error') { finish('Ошибка: ' + (event.message || 'неизвестная ошибка'), true); return; }
          }
        }
      }
      finish();
    }).catch((error) => {
      if (error.name === 'AbortError') { finish(null); return; }
      finish('Не удалось связаться с сервером: ' + error.message + '\n\nПроверьте, что TROTUAR AI сервер запущен и Ollama доступна (см. настройки).', true);
    });
  }

  function stopGeneration() {
    if (abortController) abortController.abort();
  }

  async function sendChatMessage() {
    const value = promptInput.value.trim();
    if (!value && !pendingImages.length && !pendingTextFiles.length) { promptInput.focus(); return; }
    if (isSending) return;
    if (!activeChat()) createChat(true);

    let content = value;
    for (const file of pendingTextFiles) {
      const block = `\n\n---\nФайл «${file.name}»:\n${file.text.slice(0, 30000)}`;
      content += block;
    }
    const images = pendingImages.map((img) => ({ name: img.name, dataUrl: img.dataUrl }));

    addMessage('user', content.trim() || '(вложение)', images.length ? { images } : {});
    promptInput.value = ''; autoGrow();
    pendingTextFiles = []; pendingImages = []; renderAttachChips();
    streamAssistantReply();
  }

  function addMessage(role, text, extra = {}) {
    const chat = activeChat();
    if (!chat) return;
    chat.messages.push({ id: makeId(), role, text, ...extra });
    chat.updatedAt = Date.now();
    if (role === 'user' && chat.messages.filter((m) => m.role === 'user').length === 1 && chat.title === 'Новый чат') {
      chat.title = titleFrom(text);
    }
    save(); renderAll();
  }

  // ---------- Вложения ----------
  async function handleFiles(fileList) {
    const files = Array.from(fileList || []);
    for (const file of files) {
      if (file.size > 15 * 1024 * 1024) { toast(`«${file.name}» больше 15 МБ — файл пропущен.`, 'error'); continue; }
      const chip = addProgressChip(file.name);
      try {
        const formData = new FormData();
        formData.append('file', file);
        const response = await fetch('/api/upload', { method: 'POST', body: formData });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || 'Ошибка загрузки');
        if (data.kind === 'image') pendingImages.push({ name: data.name, dataUrl: data.dataUrl });
        else pendingTextFiles.push({ name: data.name, text: data.text || '' });
        chip.remove();
        renderAttachChips();
      } catch (error) {
        chip.remove();
        toast(`«${file.name}»: ${error.message}`, 'error');
      }
    }
  }

  function addProgressChip(name) {
    attachChipRow.classList.remove('hidden');
    const chip = document.createElement('div');
    chip.className = 'attach-chip';
    chip.innerHTML = '<span class="chip-icon">…</span><span class="chip-name"></span>';
    chip.querySelector('.chip-name').textContent = name + ' — загрузка';
    attachChipRow.appendChild(chip);
    return chip;
  }

  function renderAttachChips() {
    attachChipRow.replaceChildren();
    let hasAny = false;
    const mk = (label, icon, onRemove) => {
      hasAny = true;
      const chip = document.createElement('div');
      chip.className = 'attach-chip';
      chip.innerHTML = `<span class="chip-icon">${icon}</span><span class="chip-name"></span><button type="button" aria-label="Убрать файл">×</button>`;
      chip.querySelector('.chip-name').textContent = label;
      chip.querySelector('button').addEventListener('click', onRemove);
      attachChipRow.appendChild(chip);
    };
    pendingTextFiles.forEach((f, i) => mk(f.name, '📄', () => { pendingTextFiles.splice(i, 1); renderAttachChips(); }));
    pendingImages.forEach((f, i) => mk(f.name, '🖼', () => { pendingImages.splice(i, 1); renderAttachChips(); }));
    attachChipRow.classList.toggle('hidden', !hasAny);
  }

  // ---------- Режимы ----------
  function hasStudioVisible() {
    return $('#image-studio').classList.contains('visible') || $('#editor-studio').classList.contains('visible');
  }

  function setMode(mode) {
    currentMode = mode;
    ui.mode = mode; saveUi();
    $$('#mode-switch .mode-chip').forEach((chip) => {
      const active = chip.dataset.mode === mode;
      chip.classList.toggle('active', active);
      chip.setAttribute('aria-selected', String(active));
    });
    // Контролы режимов
    let anyControl = false;
    modeControls.querySelectorAll('[data-mode]').forEach((control) => {
      const show = control.dataset.mode === mode;
      control.style.display = show ? '' : 'none';
      if (show) anyControl = true;
    });
    modeControls.classList.toggle('hidden', !anyControl);

    // Секции студий
    $('#image-studio').classList.toggle('visible', mode === 'image');
    $('#editor-studio').classList.toggle('visible', mode === 'edit');
    welcome.classList.toggle('has-studio', mode !== 'chat');

    // Плейсхолдер
    promptInput.placeholder = mode === 'chat' ? 'Спроси TROTUAR AI'
      : mode === 'image' ? 'Опишите изображение: что нарисовать, атмосфера, детали…'
      : 'Что изменить на фото? Например: замени фон на вечерний город';
    if (mode !== 'chat') {
      welcome.classList.add('has-messages');
      if (mode === 'image') renderGallery();
      if (mode === 'edit') renderEditorState();
    }
    renderAll();
    promptInput.focus();
  }

  // ---------- Галерея изображений ----------
  function renderGallery() {
    const galleryEl = $('#gallery');
    galleryEl.replaceChildren();
    if (!gallery.length) {
      const empty = document.createElement('div');
      empty.className = 'gallery-empty';
      empty.textContent = 'Здесь появится история ваших генераций. Опишите изображение в поле ниже и нажмите отправить.';
      galleryEl.appendChild(empty);
      return;
    }
    gallery.forEach((item) => {
      const card = document.createElement('div');
      card.className = 'gen-card';
      if (item.status === 'pending') {
        card.innerHTML = '<div class="gen-spin"><div class="spin-orb"></div><span>Создаём изображение…</span></div>';
        const meta = document.createElement('div');
        meta.className = 'gen-meta';
        meta.textContent = item.prompt;
        card.appendChild(meta);
      } else if (item.status === 'error') {
        card.innerHTML = '<div class="gen-spin"><span>Не удалось создать изображение</span></div>';
      } else {
        const img = document.createElement('img');
        img.src = item.url; img.alt = item.prompt; img.loading = 'lazy';
        img.addEventListener('click', () => openLightbox(item.url, item.prompt, item));
        const meta = document.createElement('div');
        meta.className = 'gen-meta';
        meta.textContent = item.prompt;
        card.append(img, meta);
      }
      galleryEl.appendChild(card);
    });
  }

  async function generateImageFlow() {
    const prompt = promptInput.value.trim();
    if (!prompt) { promptInput.focus(); return; }
    promptInput.value = ''; autoGrow();

    const style = $('#style-select').value;
    const size = $('#size-select').value;
    const item = { id: makeId(), prompt, style, size, seed: null, url: null, createdAt: Date.now(), status: 'pending' };
    gallery.unshift(item);
    if (currentMode !== 'image') setMode('image');
    renderGallery();

    try {
      const response = await fetch('/api/image/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, style, size })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `Ошибка сервера (${response.status})`);
      item.url = data.url; item.seed = data.seed; item.status = 'done';
      toast('Изображение готово', 'success', 1800);
    } catch (error) {
      item.status = 'error';
      toast(error.message, 'error', 6000);
    }
    saveGallery();
    renderGallery();
  }

  // ---------- Лайтбокс ----------
  function openLightbox(src, promptText, item) {
    $('#lightbox-img').src = src;
    const dl = $('#lightbox-download');
    dl.href = src;
    dl.download = promptText ? 'trotuar-' + promptText.slice(0, 24).replace(/[^\wа-яё]+/gi, '-') + '.jpg' : 'trotuar-image.jpg';
    const regenBtn = $('#lightbox-regen');
    regenBtn.style.display = item ? '' : 'none';
    regenBtn.onclick = () => {
      $('#img-lightbox').classList.remove('open');
      promptInput.value = item.prompt;
      generateImageFlow();
    };
    $('#img-lightbox').classList.add('open');
  }
  $('#lightbox-close').addEventListener('click', () => $('#img-lightbox').classList.remove('open'));
  $('#img-lightbox').addEventListener('click', (e) => { if (e.target.id === 'img-lightbox') $('#img-lightbox').classList.remove('open'); });

  // ---------- Редактор фото ----------
  function renderEditorState() {
    const state = $('#editor-state');
    state.replaceChildren();
    if (!editorState) return;
    const result = document.createElement('div');
    result.className = 'editor-result';
    if (editorState.busy) {
      result.innerHTML = '<div class="editor-busy"><div class="spin-orb"></div><span>Обрабатываем фото — это может занять до минуты…</span></div>';
    } else if (editorState.resultUrl) {
      const compare = document.createElement('div');
      compare.className = 'editor-compare';
      const before = document.createElement('figure');
      before.innerHTML = `<img src="${editorState.dataUrl}" alt="Оригинал"><figcaption>Оригинал</figcaption>`;
      const after = document.createElement('figure');
      after.innerHTML = `<img src="${editorState.resultUrl}" alt="Результат"><figcaption>Результат</figcaption>`;
      after.querySelector('img').addEventListener('click', () => openLightbox(editorState.resultUrl, null, null));
      compare.append(before, after);
      const actions = document.createElement('div');
      actions.className = 'field-row';
      actions.style.marginTop = '12px';
      const dl = document.createElement('button');
      dl.className = 'btn-ghost';
      dl.style.flex = '1';
      dl.textContent = 'Скачать результат';
      dl.addEventListener('click', () => download(editorState.resultUrl, 'trotuar-edited.png'));
      const again = document.createElement('button');
      again.className = 'btn-ghost';
      again.style.flex = '1';
      again.textContent = 'Редактировать ещё';
      again.addEventListener('click', () => { editorState.dataUrl = editorState.resultUrl; editorState.resultUrl = null; renderEditorState(); });
      actions.append(dl, again);
      result.append(compare, actions);
    } else if (editorState.dataUrl) {
      const compare = document.createElement('div');
      compare.className = 'editor-compare';
      compare.style.gridTemplateColumns = '1fr';
      const fig = document.createElement('figure');
      fig.innerHTML = `<img src="${editorState.dataUrl}" alt="Загруженное фото"><figcaption>${escapeHtml(editorState.name || 'фото')} — опишите изменение ниже и нажмите отправить</figcaption>`;
      compare.appendChild(fig);
      result.appendChild(compare);
    }
    state.appendChild(result);
  }

  function setEditorFile(file) {
    if (!file) return;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) { toast('Поддерживаются только PNG, JPG и WebP.', 'error'); return; }
    if (file.size > 10 * 1024 * 1024) { toast('Файл больше 10 МБ.', 'error'); return; }
    const reader = new FileReader();
    reader.onload = () => {
      editorState = { name: file.name, mime: file.type, dataUrl: reader.result, resultUrl: null, busy: false };
      $('#editor-warning').classList.add('visible');
      renderEditorState();
      promptInput.focus();
    };
    reader.readAsDataURL(file);
  }

  async function runEditFlow() {
    if (!editorState) { toast('Сначала загрузите фотографию.', 'error'); return; }
    const instruction = promptInput.value.trim();
    if (!instruction) { promptInput.focus(); return; }
    promptInput.value = ''; autoGrow();
    editorState.busy = true; editorState.resultUrl = null;
    renderEditorState();
    try {
      const response = await fetch('/api/image/edit', {
        method: 'POST',
        body: (() => { const fd = new FormData(); fd.append('image', dataUrlToFile(editorState.dataUrl, editorState.name || 'photo.png')); fd.append('prompt', instruction); fd.append('size', $('#edit-size-select').value === 'auto' ? '1024x1024' : $('#edit-size-select').value); return fd; })()
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `Ошибка сервера (${response.status})`);
      editorState.resultUrl = data.dataUrl;
      editorState.busy = false;
      toast('Готово! Результат справа/ниже.', 'success');
    } catch (error) {
      editorState.busy = false;
      toast(error.message, 'error', 8000);
    }
    renderEditorState();
  }

  function dataUrlToFile(dataUrl, filename) {
    const [meta, b64] = dataUrl.split(',');
    const mime = (meta.match(/data:([^;]+)/) || [])[1] || 'image/png';
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new File([bytes], filename, { type: mime });
  }

  // ---------- Композер ----------
  function autoGrow() {
    promptInput.style.height = 'auto';
    const scrollH = promptInput.scrollHeight;
    promptInput.style.height = Math.min(Math.max(scrollH, 46), 160) + 'px';
  }

  $('#prompt-form').addEventListener('submit', (event) => {
    event.preventDefault();
    if (isSending) { stopGeneration(); return; }
    if (sendButton.classList.contains('stop')) { stopGeneration(); return; }
    if (currentMode === 'chat') sendChatMessage();
    else if (currentMode === 'image') generateImageFlow();
    else if (currentMode === 'edit') runEditFlow();
  });

  promptInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      $('#prompt-form').requestSubmit();
    }
  });
  promptInput.addEventListener('input', autoGrow);

  // Быстрые действия
  document.querySelectorAll('[data-prompt]').forEach((button) => button.addEventListener('click', () => {
    promptInput.value = button.dataset.prompt;
    autoGrow();
    promptInput.focus();
  }));
  document.querySelectorAll('.quick[data-mode]').forEach((button) => button.addEventListener('click', () => setMode(button.dataset.mode)));

  // Переключатель режимов
  $$('#mode-switch .mode-chip').forEach((chip) => chip.addEventListener('click', () => setMode(chip.dataset.mode)));

  // Плюс: показать/скрыть подсказки (как в 1.x)
  $('#plus-button').addEventListener('click', () => {
    const suggestions = document.querySelector('.quick-actions');
    suggestions.classList.toggle('suggestions-hidden');
    if (!suggestions.classList.contains('suggestions-hidden')) suggestions.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });

  // ---------- Файлы ----------
  $('#attach-button').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { handleFiles(fileInput.files); fileInput.value = ''; });
  const inputShell = $('.input-shell');
  ['dragover', 'dragenter'].forEach((evt) => inputShell.addEventListener(evt, (e) => { e.preventDefault(); inputShell.classList.add('dragging'); }));
  ['dragleave', 'drop'].forEach((evt) => inputShell.addEventListener(evt, (e) => { e.preventDefault(); inputShell.classList.remove('dragging'); }));
  inputShell.addEventListener('drop', (e) => { if (e.dataTransfer?.files?.length) handleFiles(e.dataTransfer.files); });

  // ---------- Редактор: загрузка фото ----------
  const editorDrop = $('#editor-drop');
  const editorFileInput = $('#editor-file-input');
  editorDrop.addEventListener('click', () => editorFileInput.click());
  editorDrop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') editorFileInput.click(); });
  editorFileInput.addEventListener('change', () => { setEditorFile(editorFileInput.files[0]); editorFileInput.value = ''; });
  ['dragover', 'dragenter'].forEach((evt) => editorDrop.addEventListener(evt, (e) => { e.preventDefault(); editorDrop.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach((evt) => editorDrop.addEventListener(evt, (e) => { e.preventDefault(); editorDrop.classList.remove('dragover'); }));
  editorDrop.addEventListener('drop', (e) => { const f = e.dataTransfer?.files?.[0]; if (f) setEditorFile(f); });

  // ---------- Сайдбар ----------
  $('#new-chat').addEventListener('click', () => createChat());
  searchInput.addEventListener('input', (event) => renderSidebar(event.target.value));
  $('#menu-button').addEventListener('click', () => {
    $('#sidebar').classList.toggle('sidebar-open');
    $('#app-backdrop').classList.toggle('visible', $('#sidebar').classList.contains('sidebar-open'));
  });
  $('#app-backdrop').addEventListener('click', closeSidebarOnMobile);
  function closeSidebarOnMobile() {
    $('#sidebar').classList.remove('sidebar-open');
    $('#app-backdrop').classList.remove('visible');
  }

  // ---------- Модалки ----------
  function openModal(el) {
    el.classList.add('open');
    el.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
  }
  function closeModal(el) {
    el.classList.remove('open');
    el.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
  }
  $('#settings-button').addEventListener('click', () => { fillSettingsForm(); openModal($('#settings-modal')); });
  $('#close-settings').addEventListener('click', () => closeModal($('#settings-modal')));
  $('#settings-modal').addEventListener('click', (e) => { if (e.target.id === 'settings-modal') closeModal($('#settings-modal')); });
  $('#profile-menu').addEventListener('click', () => openModal($('#settings-modal')));
  $('#connect-button').addEventListener('click', () => openModal($('#auth-modal')));
  $('#login-button').addEventListener('click', () => openModal($('#auth-modal')));

  // Авторизация (демо, как в 1.x)
  const authModal = $('#auth-modal');
  const authForm = $('#auth-form');
  const switchMode = $('#switch-mode');
  let authMode = 'login';
  function renderAuthMode() {
    const login = authMode === 'login';
    $('#modal-title').textContent = login ? 'Войти в TROTUAR AI' : 'Создать аккаунт';
    $('#modal-description').textContent = login ? 'Продолжай общение со своим ИИ-помощником.' : 'Зарегистрируйся и начни создавать вместе с TROTUAR AI.';
    $('#auth-submit').textContent = login ? 'Войти' : 'Зарегистрироваться';
    switchMode.textContent = login ? 'Зарегистрироваться' : 'Войти';
    $('.switch').firstChild.textContent = login ? 'Нет аккаунта? ' : 'Уже есть аккаунт? ';
    $('#password').autocomplete = login ? 'current-password' : 'new-password';
  }
  function closeAuth() { closeModal(authModal); }
  $('#close-modal').addEventListener('click', closeAuth);
  authModal.addEventListener('click', (e) => { if (e.target === authModal) closeAuth(); });
  switchMode.addEventListener('click', () => { authMode = authMode === 'login' ? 'register' : 'login'; renderAuthMode(); });
  authForm.addEventListener('submit', (e) => {
    e.preventDefault();
    toast('Демо-режим: авторизация пока не подключена. Все функции доступны локально.');
    closeAuth();
  });

  // ---------- Настройки ----------
  const settingsModal = $('#settings-modal');
  function applyTheme(theme) {
    document.body.dataset.theme = theme === 'light' ? 'light' : '';
    if (theme !== 'light') delete document.body.dataset.theme;
  }

  function fillSettingsForm() {
    fetch('/api/settings').then((r) => r.json()).then(({ settings }) => {
      $('#provider-select').value = settings.provider;
      $('#ollama-url').value = settings.ollama.url;
      $('#ollama-model').value = settings.ollama.model;
      $('#ollama-key').placeholder = settings.ollama.apiKeyConfigured ? `Сохранён ключ ${settings.ollama.apiKeyMasked} (введите новый для замены)` : 'Оставьте пустым для локального сервера';
      $('#system-prompt').value = settings.ollama.systemPrompt || '';
      $('#temperature').value = settings.ollama.temperature;
      $('#temperature-out').textContent = settings.ollama.temperature;
      $('#top-p').value = settings.ollama.topP;
      $('#top-p-out').textContent = settings.ollama.topP;
      $('#max-tokens').value = settings.ollama.maxTokens;
      $('#max-tokens-out').textContent = settings.ollama.maxTokens;
      $('#gemini-model').value = settings.gemini.model;
      $('#gemini-key').placeholder = settings.gemini.apiKeyConfigured ? `Сохранён ключ ${settings.gemini.apiKeyMasked}` : 'Ключ Google AI Studio';
      $('#pollinations-key').placeholder = settings.image.apiKeyConfigured ? `Сохранён ключ ${settings.image.apiKeyMasked}` : 'enter.pollinations.ai — необязательно для генерации';
      $('#edit-model-input').value = settings.image.editModel || '';
      toggleProviderFields();
    }).catch(() => toast('Не удалось загрузить настройки с сервера.', 'error'));
    $('#theme-select').value = ui.theme;
    $('#username-input').value = ui.username;
    $('#test-status').textContent = '';
    fetch('/api/models').then((r) => r.json()).then((data) => {
      if (data.ok) {
        $('#models-datalist').replaceChildren(...data.models.map((m) => Object.assign(document.createElement('option'), { value: m.name, label: m.parameterSize || '' })));
      }
    }).catch(() => {});
  }

  function toggleProviderFields() {
    const provider = $('#provider-select').value;
    $('#ollama-fields').style.display = provider === 'ollama' ? '' : 'none';
    $('#gemini-fields').style.display = provider === 'gemini' ? '' : 'none';
  }
  $('#provider-select').addEventListener('change', toggleProviderFields);
  [['temperature', 'temperature-out'], ['top-p', 'top-p-out'], ['max-tokens', 'max-tokens-out']].forEach(([input, out]) => {
    $('#' + input).addEventListener('input', (e) => { $('#' + out).textContent = e.target.value; });
  });

  $('#test-connection').addEventListener('click', async () => {
    const status = $('#test-status');
    status.className = 'test-status';
    status.textContent = 'Проверяем подключение…';
    try {
      const response = await fetch('/api/settings/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: $('#ollama-url').value.trim(), apiKey: $('#ollama-key').value.trim() || undefined })
      });
      const data = await response.json();
      status.className = 'test-status ' + (data.ok ? 'ok' : 'fail');
      status.textContent = data.message;
      if (data.ok && Array.isArray(data.models)) {
        $('#models-datalist').replaceChildren(...data.models.map((m) => Object.assign(document.createElement('option'), { value: m })));
      }
    } catch (error) {
      status.className = 'test-status fail';
      status.textContent = 'Сервер TROTUAR AI недоступен: ' + error.message;
    }
  });

  $('#refresh-models').addEventListener('click', async () => {
    const status = $('#test-status');
    status.className = 'test-status';
    status.textContent = 'Получаем список моделей…';
    try {
      const response = await fetch('/api/models');
      const data = await response.json();
      if (!data.ok) throw new Error(data.error || 'Ошибка');
      $('#models-datalist').replaceChildren(...data.models.map((m) => Object.assign(document.createElement('option'), { value: m.name, label: m.parameterSize || '' })));
      status.className = 'test-status ok';
      status.textContent = `Найдено моделей: ${data.models.length}. Список доступен в подсказках поля модели.`;
    } catch (error) {
      status.className = 'test-status fail';
      status.textContent = error.message;
    }
  });

  $('#save-settings').addEventListener('click', async () => {
    const payload = {
      provider: $('#provider-select').value,
      ollama: {
        url: $('#ollama-url').value.trim(),
        model: $('#ollama-model').value.trim(),
        systemPrompt: $('#system-prompt').value,
        temperature: Number($('#temperature').value),
        topP: Number($('#top-p').value),
        maxTokens: Number($('#max-tokens').value)
      },
      gemini: { model: $('#gemini-model').value.trim() },
      image: { editModel: $('#edit-model-input').value.trim() }
    };
    if ($('#ollama-key').value.trim()) payload.ollama.apiKey = $('#ollama-key').value.trim();
    if ($('#gemini-key').value.trim()) payload.gemini.apiKey = $('#gemini-key').value.trim();
    if ($('#pollinations-key').value.trim()) payload.image.pollinationsApiKey = $('#pollinations-key').value.trim();

    try {
      const response = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Ошибка сохранения');
      ui.theme = $('#theme-select').value;
      ui.username = $('#username-input').value.trim() || 'TROTUAR_USER';
      saveUi();
      applyTheme(ui.theme);
      $('#profile-name').textContent = ui.username;
      closeModal(settingsModal);
      toast('Настройки сохранены', 'success');
      checkHealth();
    } catch (error) {
      toast(error.message, 'error');
    }
  });

  // Экспорт / импорт / очистка истории
  $('#export-chats').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ app: 'TROTUAR AI', version: 3, chats, gallery }, null, 2)], { type: 'application/json' });
    download(URL.createObjectURL(blob), 'trotuar-ai-history.json');
  });
  $('#import-chats').addEventListener('click', () => $('#import-file-input').click());
  $('#import-file-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!Array.isArray(data.chats)) throw new Error('нет массива chats');
        const existing = new Set(chats.map((c) => c.id));
        let added = 0;
        for (const chat of data.chats) {
          if (!chat.id || existing.has(chat.id)) continue;
          chats.push({ ...chat, messages: (chat.messages || []).map((m) => ({ id: makeId(), ...m })) });
          added++;
        }
        if (Array.isArray(data.gallery)) {
          const ids = new Set(gallery.map((g) => g.id));
          data.gallery.forEach((g) => { if (g.id && !ids.has(g.id)) gallery.push(g); });
          saveGallery(); renderGallery();
        }
        save(); renderAll();
        toast(`Импортировано чатов: ${added}`, 'success');
      } catch (error) {
        toast('Не удалось импортировать: ' + error.message, 'error');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  });
  $('#clear-chats').addEventListener('click', () => {
    if (!confirm('Удалить все переписки и историю генераций?')) return;
    chats = []; gallery = [];
    activeId = null;
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(ACTIVE_KEY);
    localStorage.removeItem(GALLERY_KEY);
    saveGallery();
    createChat(true);
    toast('История очищена', 'success');
    closeModal(settingsModal);
  });

  // ---------- Голосовой ввод ----------
  $('#voice-button').addEventListener('click', () => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) { toast('Голосовой ввод не поддерживается этим браузером.', 'error'); return; }
    const recognition = new SpeechRecognition();
    recognition.lang = 'ru-RU';
    recognition.interimResults = false;
    recognition.onresult = (event) => {
      promptInput.value = (promptInput.value ? promptInput.value + ' ' : '') + event.results[0][0].transcript;
      autoGrow();
      promptInput.focus();
    };
    recognition.onerror = () => toast('Не удалось распознать речь. Разрешите доступ к микрофону.', 'error');
    recognition.start();
  });

  // ---------- Горячие клавиши ----------
  document.addEventListener('keydown', (event) => {
    const meta = event.ctrlKey || event.metaKey;
    if (event.key === 'Escape') {
      closeCtxMenu();
      closeModal(settingsModal); closeAuth();
      $('#img-lightbox').classList.remove('open');
      closeSidebarOnMobile();
    } else if (meta && event.key.toLowerCase() === 'n') {
      event.preventDefault(); createChat();
    } else if (meta && event.key.toLowerCase() === 'k') {
      event.preventDefault(); searchInput.focus(); searchInput.select();
    } else if (meta && event.key.toLowerCase() === 'b') {
      event.preventDefault(); $('#menu-button').click();
    }
  });

  // ---------- Проверка здоровья сервера ----------
  async function checkHealth() {
    try {
      const response = await fetch('/api/health');
      health = await response.json();
      const dot = $('#conn-dot');
      const label = $('#conn-label');
      if (health.provider === 'ollama') {
        if (health.ollamaOnline) {
          dot.style.background = '#5ee09b'; dot.style.boxShadow = '0 0 9px #5ee09b';
          label.textContent = health.ollama.model + ' · онлайн';
        } else {
          dot.style.background = '#ff9d9d'; dot.style.boxShadow = '0 0 9px #ff9d9d';
          label.textContent = 'Ollama недоступна';
        }
      } else {
        dot.style.background = health.gemini.apiKeyConfigured ? '#5ee09b' : '#ffb46b';
        dot.style.boxShadow = 'none';
        label.textContent = health.provider === 'gemini' ? 'Gemini ' + health.gemini.model : 'Готово';
      }
    } catch {
      const dot = $('#conn-dot');
      const label = $('#conn-label');
      dot.style.background = '#ff9d9d';
      label.textContent = 'Сервер отключён';
    }
  }

  // ---------- Инициализация ----------
  chats = loadChats();
  ui = Object.assign(ui, loadJson(UI_KEY, {}));
  gallery = loadJson(GALLERY_KEY, []).filter((g) => g.status !== 'pending');
  applyTheme(ui.theme);
  $('#profile-name').textContent = ui.username;

  if (chats.length) {
    const requested = localStorage.getItem(ACTIVE_KEY);
    activeId = chats.some((chat) => chat.id === requested) ? requested : chats[0].id;
  } else {
    const chat = { id: makeId(), title: 'Новый чат', createdAt: Date.now(), updatedAt: Date.now(), messages: [], pinned: false };
    chats.push(chat);
    activeId = chat.id;
  }
  save();
  setMode(ui.mode === 'image' || ui.mode === 'edit' ? ui.mode : 'chat');
  autoGrow();
  checkHealth();
})();
