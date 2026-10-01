(() => {
  const $ = id => document.getElementById(id);

  async function getMe() {
    const r = await fetch('/api/me', { cache: 'no-store' });
    if (!r.ok) return null;
    return await r.json();
  }

  function iconMode() {
    return document.querySelector('input[name="iconType"]:checked')?.value || 'star';
  }

  function resolveIconUrl() {
    const type = iconMode();
    if (type === 'emote') {
      const id = $('emoteId').value.trim();
      return id ? `https://static-cdn.jtvnw.net/emoticons/v2/${encodeURIComponent(id)}/default/dark/3.0` : '';
    }
    if (type === 'image') return $('imageUrl').value.trim();
    return '';
  }

  function setIconPreview(el, url) {
    el.textContent = '';
    el.classList.remove('star-icon');
    if (!url) {
      el.classList.add('star-icon');
      el.textContent = '★';
      return;
    }
    const img = document.createElement('img');
    img.className = 'widget-icon image-icon';
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    img.src = url;
    img.onerror = () => {
      el.className = 'widget-icon star-icon';
      el.textContent = '★';
    };
    el.appendChild(img);
  }

  function renderPreview() {
    const title = $('title').value || 'AFFILIATE PLUS erreichen!';
    const label = $('label').value || 'Neue Abo-Punkte';
    const points = Math.max(0, Number($('points').value) || 0);
    const target = Math.max(1, Number($('target').value) || 100);
    $('previewTitle').textContent = title;
    $('previewLabel').textContent = label;
    $('previewValue').textContent = `${points}/${target}`;
    $('previewFill').style.width = `${Math.min(100, (points / target) * 100)}%`;
    setIconPreview($('previewIcon'), resolveIconUrl());
  }

  function toggleIconInputs() {
    const mode = iconMode();
    $('emoteField').classList.toggle('hidden', mode !== 'emote');
    $('imageField').classList.toggle('hidden', mode !== 'image');
    renderPreview();
  }

  async function saveConfig() {
    setStatus('Speichere …');
    const payload = {
      title: $('title').value.trim() || 'AFFILIATE PLUS erreichen!',
      label: $('label').value.trim() || 'Neue Abo-Punkte',
      target: Math.max(1, Math.min(9999, Number($('target').value) || 100)),
      initialPoints: Math.max(0, Math.min(9999, Number($('points').value) || 0)),
      iconUrl: resolveIconUrl()
    };

    try {
      const r = await fetch('/api/config', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(payload)
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.message || 'Speichern fehlgeschlagen.');
      $('obsUrl').value = body.overlayUrl;
      $('result').classList.remove('hidden');
      setStatus('Gespeichert.', false, true);
    } catch (e) {
      setStatus(e.message || 'Fehler.', true);
    }
  }

  function setStatus(msg, error=false, ok=false) {
    const el = $('status');
    el.textContent = msg || '';
    el.className = `status ${error ? 'error' : ok ? 'ok' : ''}`;
  }

  async function boot() {
    const params = new URLSearchParams(location.search);
    if (params.get('error')) {
      $('landing').classList.add('hidden');
      $('error').classList.remove('hidden');
      $('errorMessage').textContent = params.get('error_description') || params.get('error');
      return;
    }

    const me = await getMe();
    if (!me) {
      $('landing').classList.remove('hidden');
      $('setup').classList.add('hidden');
      return;
    }

    $('landing').classList.add('hidden');
    $('setup').classList.remove('hidden');
    $('accountBox').textContent = `Verbunden als @${me.login} (${me.displayName})`;

    if (me.config) {
      $('title').value = me.config.title || $('title').value;
      $('label').value = me.config.label || $('label').value;
      $('target').value = me.config.target || 100;
      $('points').value = me.config.points ?? 0;

      if (me.config.iconUrl) {
        if (/static-cdn\.jtvnw\.net\/emoticons\/v2\//.test(me.config.iconUrl)) {
          const match = me.config.iconUrl.match(/emoticons\/v2\/([^/]+)/);
          if (match) {
            document.querySelector('input[value="emote"]').checked = true;
            $('emoteId').value = decodeURIComponent(match[1]);
          }
        } else {
          document.querySelector('input[value="image"]').checked = true;
          $('imageUrl').value = me.config.iconUrl;
        }
      }
    }

    toggleIconInputs();
    renderPreview();
  }

  document.querySelectorAll('input[name="iconType"]').forEach(x => x.addEventListener('change', toggleIconInputs));
  ['title','label','target','points','emoteId','imageUrl'].forEach(id => $(id).addEventListener('input', renderPreview));

  $('saveBtn').addEventListener('click', saveConfig);

  $('copyBtn').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('obsUrl').value);
      $('copyBtn').textContent = 'Kopiert';
      setTimeout(() => $('copyBtn').textContent = 'Kopieren', 1200);
    } catch {
      $('obsUrl').select();
      document.execCommand('copy');
    }
  });

  $('logoutBtn').addEventListener('click', async () => {
    await fetch('/api/logout', {method: 'POST'});
    location.href = '/';
  });

  boot();
})();
