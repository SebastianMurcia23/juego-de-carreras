(function () {
  'use strict';
  const KEY = 'rr_profile_id';
  let profileId = localStorage.getItem(KEY);
  let catalog = null;
  let profile = null;

  function makeId() {
    return window.crypto && crypto.randomUUID
      ? crypto.randomUUID()
      : 'pilot-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  }

  async function ensureProfile() {
    profileId = profileId || makeId();
    const response = await fetch('/api/product/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: profileId, name: localStorage.getItem('rr_pilot_name') || 'Piloto' }),
    });
    if (!response.ok) throw new Error('No se pudo cargar el perfil');
    profile = await response.json();
    profileId = profile.id;
    localStorage.setItem(KEY, profileId);
    return profile;
  }

  async function loadCatalog() {
    const response = await fetch('/api/product/catalog');
    if (!response.ok) throw new Error('No se pudo cargar la tienda');
    catalog = await response.json();
    return catalog;
  }

  function render(profileData) {
    profile = profileData;
    const root = document.getElementById('product-hub');
    if (!root) return;
    const nextLevel = profile.level * 500;
    const progress = Math.min(100, Math.round((profile.xp % 500) / 5));
    root.innerHTML = `<button class="pilot-chip" id="product-open" type="button">
      <span class="pilot-avatar">P${profile.level}</span>
      <span class="pilot-copy"><strong>${escapeHtml(profile.name)}</strong><small>NIVEL ${profile.level} · ${profile.xp} XP</small>
      <i><b style="width:${progress}%"></b></i></span>
      <span class="pilot-coins">🪙 ${profile.coins}</span>
    </button>`;
    root.querySelector('#product-open').addEventListener('click', openHub);
  }

  async function openHub() {
    if (!catalog) await loadCatalog();
    const modal = document.createElement('div');
    modal.className = 'product-modal';
    modal.innerHTML = `<section class="product-window" role="dialog" aria-label="Garaje del piloto">
      <button class="product-close" type="button" aria-label="Cerrar">×</button>
      <header class="product-window-head"><div><small>ROAD RUMBLE // PILOT HQ</small><h2>GARAJE <em>${escapeHtml(profile.name)}</em></h2></div>
        <div class="garage-stats"><b>LVL ${profile.level}</b><span>🪙 ${profile.coins}</span></div></header>
      <nav class="product-tabs"><button class="active" data-tab="garage">GARAGE</button><button data-tab="season">TEMPORADA</button><button data-tab="rank">RANKING</button></nav>
      <div class="product-content" id="product-content"></div>
    </section>`;
    document.body.appendChild(modal);
    modal.querySelector('.product-close').onclick = () => modal.remove();
    modal.addEventListener('click', event => { if (event.target === modal) modal.remove(); });
    modal.querySelectorAll('[data-tab]').forEach(button => button.onclick = () => {
      modal.querySelectorAll('[data-tab]').forEach(item => item.classList.toggle('active', item === button));
      renderTab(modal.querySelector('#product-content'), button.dataset.tab);
    });
    renderTab(modal.querySelector('#product-content'), 'garage');
  }

  function renderTab(target, tab) {
    if (tab === 'garage') {
      target.innerHTML = `<div class="garage-hero"><div class="garage-car-art">🏎️</div><div><span class="eyebrow">TU VEHÍCULO // CONFIGURACIÓN</span><h3>CONSTRUYE TU LEYENDA</h3><p>Desbloquea estilos únicos y presume tu identidad en cada carrera.</p><button class="neon-action" type="button" data-coming>PERSONALIZAR VEHÍCULO</button></div></div>
        <h3 class="section-title">TIENDA DE COSMÉTICOS <span>SOLO ESTÉTICA · JUEGO JUSTO</span></h3><div class="cosmetic-grid">${catalog.cosmetics.map(itemCard).join('')}</div>
        <h3 class="section-title">DESAFÍOS ACTIVOS</h3><div class="mission-grid">${catalog.missions.map(m => `<article class="mission-card"><b>${escapeHtml(m.name)}</b><p>${escapeHtml(m.description)}</p><span>+${m.rewardXp} XP · 🪙 ${m.rewardCoins}</span></article>`).join('')}</div>`;
      target.querySelectorAll('[data-buy]').forEach(button => button.onclick = () => buy(button.dataset.buy));
      target.querySelectorAll('[data-coming]').forEach(button => button.onclick = () => alert('El editor 3D llegará en la próxima actualización.'));
    } else if (tab === 'season') {
      target.innerHTML = `<div class="season-banner"><span class="eyebrow">SEASON 01 // LANZAMIENTO</span><h3>${escapeHtml(catalog.season.name)}</h3><p>Corre, gana XP y desbloquea recompensas exclusivas.</p><div class="season-track">${catalog.season.rewards.map(reward => `<div><b>NIVEL ${reward.level}</b><span>🎁 ${reward.free.type === 'cosmetic' ? reward.free.id : reward.free.amount + ' monedas'}</span><strong>PREMIUM · ${reward.premium.type === 'cosmetic' ? reward.premium.id : reward.premium.amount + ' monedas'}</strong></div>`).join('')}</div></div>`;
    } else {
      fetch('/api/product/leaderboard').then(response => response.json()).then(data => {
        target.innerHTML = `<div class="leaderboard-list">${data.entries.length ? data.entries.map(entry => `<div class="leader-row"><b>#${entry.rank}</b><span>${escapeHtml(entry.name)}<small>Nivel ${entry.level}</small></span><strong>${entry.xp} XP</strong><em>${entry.wins} victorias</em></div>`).join('') : '<p class="empty-state">Corre tu primera carrera para entrar al ranking.</p>'}</div>`;
      }).catch(() => { target.innerHTML = '<p class="empty-state">Ranking no disponible.</p>'; });
    }
  }

  function itemCard(item) {
    const owned = profile.inventory.includes(item.id);
    return `<article class="cosmetic-card rarity-${item.rarity}"><div class="cosmetic-preview" style="--item-color:${item.color}">🏎</div><div><b>${escapeHtml(item.name)}</b><small>${item.rarity.toUpperCase()} · ${item.type}</small></div>${owned ? '<button class="owned" disabled>ADQUIRIDO</button>' : `<button data-buy="${item.id}">🪙 ${item.price}</button>`}</article>`;
  }

  async function buy(id) {
    const response = await fetch('/api/product/purchase', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profileId, cosmeticId: id }) });
    const result = await response.json();
    if (!response.ok) return alert(result.error === 'INSUFFICIENT_FUNDS' ? 'Necesitas más monedas.' : 'No se pudo completar la compra.');
    profile = result;
    render(profile);
    document.querySelector('.product-modal')?.remove();
    openHub();
  }

  function escapeHtml(value) {
    return String(value || '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  }

  window.ROAD_RUMBLE_PRODUCT = { profileId: () => profileId, refresh: ensureProfile };
  document.addEventListener('DOMContentLoaded', () => {
    ensureProfile().then(render).catch(error => console.warn('[product] unavailable:', error.message));
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/service-worker.js').catch(() => {});
  });
}());
