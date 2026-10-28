(function () {
  'use strict';

  let currentUser = '';
  let senderToken = '';
  let latestMessageId = 0;
  let isPolling = false;
  let knownMessageIds = new Set();

  const chatArea = document.getElementById('chatArea');
  const messagesList = document.getElementById('messagesList');
  const chatForm = document.getElementById('chatForm');
  const messageInput = document.getElementById('messageInput');
  const sendBtn = document.getElementById('sendBtn');
  const botTrap = document.getElementById('botTrap');

  const currentUserName = document.getElementById('currentUserName');
  const changeUserBtn = document.getElementById('changeUserBtn');
  const userModal = document.getElementById('userModal');
  const userForm = document.getElementById('userForm');
  const userInput = document.getElementById('userInput');
  const userError = document.getElementById('userError');

  const sitesDropdown = document.getElementById('sitesDropdown');
  const sitesBtn = document.getElementById('sitesBtn');

  const SVG_TRASH = `<svg class="icon icon-xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>`;

  function getSenderToken() {
    let t = sessionStorage.getItem('c3b_token');
    if (!t) {
      const arr = new Uint8Array(16);
      crypto.getRandomValues(arr);
      t = Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
      sessionStorage.setItem('c3b_token', t);
    }
    return t;
  }

  function formatTime(str) {
    try {
      const d = new Date(str);
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    } catch {
      return '';
    }
  }

  function appendMessage(msg, isInitial) {
    if (knownMessageIds.has(msg.id)) return;
    knownMessageIds.add(msg.id);

    if (msg.id > latestMessageId) {
      latestMessageId = msg.id;
    }

    const row = document.createElement('div');
    row.id = `msg-${msg.id}`;
    row.className = 'msg-row ' + (msg.is_mine ? 'mine' : 'other');

    if (!msg.is_mine) {
      const author = document.createElement('div');
      author.className = 'msg-author';
      author.textContent = msg.username;
      row.appendChild(author);
    }

    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';

    const textEl = document.createElement('div');
    textEl.textContent = msg.message;
    bubble.appendChild(textEl);

    const meta = document.createElement('div');
    meta.className = 'msg-meta';

    const time = document.createElement('span');
    time.className = 'msg-time';
    time.textContent = formatTime(msg.created_at);
    meta.appendChild(time);

    if (msg.is_mine) {
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'btn-del';
      delBtn.title = 'Elimina';
      delBtn.innerHTML = SVG_TRASH;
      delBtn.onclick = () => deleteMessage(msg.id);
      meta.appendChild(delBtn);
    }

    bubble.appendChild(meta);
    row.appendChild(bubble);
    messagesList.appendChild(row);

    chatArea.scrollTop = chatArea.scrollHeight;
  }

  async function fetchMessages(isInitial = false) {
    if (isPolling) return;
    isPolling = true;

    try {
      let url = '/api/messages';
      if (latestMessageId > 0 && !isInitial) {
        url += `?since_id=${latestMessageId}`;
      } else {
        url += '?limit=50';
      }

      const res = await fetch(url, {
        headers: { 'X-Sender-Token': senderToken }
      });

      if (!res.ok) return;
      const data = await res.json();
      if (data && Array.isArray(data.messages)) {
        data.messages.forEach(m => appendMessage(m, isInitial));
      }
    } catch {
      // Ignore network errors in polling
    } finally {
      isPolling = false;
    }
  }

  async function sendMessage(text) {
    if (!currentUser) {
      openModal();
      return;
    }

    sendBtn.disabled = true;
    try {
      const res = await fetch('/api/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Sender-Token': senderToken
        },
        body: JSON.stringify({
          username: currentUser,
          message: text,
          sender_token: senderToken,
          honeypot: botTrap.value
        })
      });

      const data = await res.json();
      if (res.ok && data.success) {
        messageInput.value = '';
        appendMessage(data.message, false);
      } else {
        alert(data.error || 'Errore durante l invio.');
      }
    } catch {
      alert('Errore di connessione.');
    } finally {
      sendBtn.disabled = false;
      messageInput.focus();
    }
  }

  async function deleteMessage(id) {
    if (!confirm('Eliminare questo messaggio?')) return;
    try {
      const res = await fetch(`/api/messages?id=${id}`, {
        method: 'DELETE',
        headers: { 'X-Sender-Token': senderToken }
      });
      if (res.ok) {
        const el = document.getElementById(`msg-${id}`);
        if (el) el.remove();
      }
    } catch {
      // Ignore
    }
  }

  chatForm.onsubmit = (e) => {
    e.preventDefault();
    const val = messageInput.value.trim();
    if (val) sendMessage(val);
  };

  function openModal() {
    userInput.value = currentUser || localStorage.getItem('c3b_user') || '';
    userError.classList.add('hide');
    userModal.classList.remove('hide');
    setTimeout(() => userInput.focus(), 60);
  }

  function closeModal() {
    userModal.classList.add('hide');
  }

  userForm.onsubmit = (e) => {
    e.preventDefault();
    const val = userInput.value.trim();
    if (val.length < 2 || val.length > 24) {
      userError.textContent = 'Inserisci da 2 a 24 caratteri.';
      userError.classList.remove('hide');
      return;
    }

    currentUser = val;
    sessionStorage.setItem('c3b_active_user', currentUser);
    localStorage.setItem('c3b_user', currentUser);
    currentUserName.textContent = currentUser;
    closeModal();
    messageInput.focus();
  };

  changeUserBtn.onclick = openModal;

  // Dropdown Siti
  sitesBtn.onclick = (e) => {
    e.stopPropagation();
    sitesDropdown.classList.toggle('open');
  };

  document.onclick = (e) => {
    if (!sitesDropdown.contains(e.target)) {
      sitesDropdown.classList.remove('open');
    }
  };

  // Init
  senderToken = getSenderToken();
  const saved = sessionStorage.getItem('c3b_active_user');
  if (saved) {
    currentUser = saved;
    currentUserName.textContent = currentUser;
    closeModal();
  } else {
    openModal();
  }

  fetchMessages(true);
  setInterval(() => fetchMessages(false), 2500);

})();
