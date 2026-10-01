(() => {
  const id = location.pathname.split('/').filter(Boolean).pop();

  function setIcon(el, url) {
    el.textContent = '';
    el.className = 'widget-icon';
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

  async function refresh() {
    if (!id) return;
    try {
      const r = await fetch(`/api/overlay/${encodeURIComponent(id)}`, {cache:'no-store'});
      if (!r.ok) return;
      const data = await r.json();
      document.title = data.title || 'Plus Points Overlay';
      document.getElementById('title').textContent = data.title || '';
      document.getElementById('label').textContent = data.label || '';
      document.getElementById('value').textContent = `${data.points}/${data.target}`;
      document.getElementById('fill').style.width = `${Math.min(100, Math.max(0, (data.points / data.target) * 100))}%`;
      setIcon(document.getElementById('icon'), data.iconUrl || '');
    } catch {}
  }

  refresh();
  setInterval(refresh, 5000);
})();
