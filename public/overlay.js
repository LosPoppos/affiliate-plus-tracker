(() => {
  'use strict';

  const id = location.pathname.match(/\/o\/([^/?#]+)/)?.[1] || '';

  function apply(data) {
    if (!data) return;

    const title = document.getElementById('title');
    const label = document.getElementById('label');
    const value = document.getElementById('value');
    const fill = document.getElementById('fill');
    const icon = document.getElementById('icon');

    if (title) title.textContent = data.title ?? '';
    if (label) label.textContent = data.label ?? '';
    if (value) value.textContent = `${data.points ?? 0}/${data.target ?? 100}`;

    if (fill) {
      const target = Number(data.target) || 100;
      const points = Number(data.points) || 0;
      const percent = Math.min(100, Math.max(0, (points / target) * 100));
      fill.style.width = `${percent}%`;
    }

    if (icon) {
      icon.textContent = '';
      icon.className = 'widget-icon';

      if (data.iconUrl) {
        const img = document.createElement('img');
        img.className = 'widget-icon image-icon';
        img.alt = '';
        img.referrerPolicy = 'no-referrer';
        img.src = data.iconUrl;

        img.onerror = () => {
          icon.className = 'widget-icon star-icon';
          icon.textContent = '★';
        };

        icon.appendChild(img);
      } else {
        icon.className = 'widget-icon star-icon';
        icon.textContent = '★';
      }
    }
  }

  async function refresh() {
    if (!id) return;

    try {
      const response = await fetch(
        `/api/overlay/${encodeURIComponent(id)}?t=${Date.now()}`,
        {
          cache: 'no-store',
          credentials: 'same-origin'
        }
      );

      if (!response.ok) {
        console.error('Overlay API:', response.status);
        return;
      }

      const data = await response.json();
      apply(data);
    } catch (error) {
      console.error('Overlay update failed:', error);
    }
  }

  refresh();
  setInterval(refresh, 5000);
})();
