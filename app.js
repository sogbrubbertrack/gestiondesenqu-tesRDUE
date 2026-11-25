const recordsBody = document.querySelector('#recordsBody');
const emptyState = document.querySelector('#emptyState');
const dialog = document.querySelector('#uploadDialog');
const form = document.querySelector('#uploadForm');
const toast = document.querySelector('#toast');
let appState = { records: [], agents: [], zones: [], zoneAgents: [], archiveDirectory: '' };
let supabaseConfig = null;
let supabaseSession = null;
let currentProfile = null;
let accountCache = [];
let producersPage = 1;
let producersSearchTimer = null;
const SESSION_KEY = 'rubberway.supabase.session';
const zoneKey = (value) => String(value || '').trim().toLocaleLowerCase('fr');
const normalizeSearch = (value) => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLocaleLowerCase('fr');

function saveSession(session) {
  supabaseSession = session;
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}
function agentDisplayName(user) {
  return user?.user_metadata?.full_name || user?.user_metadata?.name || user?.email || 'Agent connecté';
}
async function readResponse(response) {
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.msg || result.message || result.error_description || result.error || `Erreur ${response.status}`);
  return result;
}
async function refreshSession() {
  if (!supabaseSession?.refresh_token) throw new Error('Votre session a expiré. Reconnectez-vous.');
  const response = await fetch(`${supabaseConfig.supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST', headers: { apikey: supabaseConfig.supabaseAnonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: supabaseSession.refresh_token }),
  });
  const session = await readResponse(response);
  session.expires_at = Math.floor(Date.now() / 1000) + (session.expires_in || 3600);
  saveSession(session);
  return session;
}
async function supabaseFetch(path, options = {}) {
  if (!supabaseSession) throw new Error('Connectez-vous pour accéder aux enquêtes.');
  if (supabaseSession.expires_at && supabaseSession.expires_at < Math.floor(Date.now() / 1000) + 30) await refreshSession();
  const response = await fetch(`${supabaseConfig.supabaseUrl}/rest/v1/${path}`, {
    ...options,
    headers: { apikey: supabaseConfig.supabaseAnonKey, Authorization: `Bearer ${supabaseSession.access_token}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  return readResponse(response);
}
async function supabaseFetchAll(path, pageSize = 1000) {
  const rows = [];
  let offset = 0;
  while (true) {
    const separator = path.includes('?') ? '&' : '?';
    const page = await supabaseFetch(`${path}${separator}limit=${pageSize}&offset=${offset}`);
    if (!Array.isArray(page)) throw new Error('Réponse Supabase invalide.');
    rows.push(...page);
    if (page.length < pageSize) return rows;
    offset += pageSize;
  }
}
function showApplication() {
  document.querySelector('#loginView').hidden = true;
  document.querySelector('#appShell').hidden = false;
  document.querySelector('#connectedAgent').textContent = currentProfile?.display_name || agentDisplayName(supabaseSession?.user);
  document.querySelector('#connectedRole').textContent = currentProfile?.role === 'supervisor' ? 'Superviseur ·' : `${currentProfile?.title || 'Assistant'} ·`;
  configureNavigation();
}

function hasModule(moduleName) {
  return currentProfile?.role === 'supervisor' || (currentProfile?.permissions || []).includes(moduleName);
}

function configureNavigation() {
  const tabs = [...document.querySelectorAll('.app-tab')];
  for (const tab of tabs) {
    const visible = tab.dataset.module === 'settings'
      ? currentProfile?.role === 'supervisor'
      : tab.dataset.module === 'producers'
        ? currentProfile?.role === 'supervisor'
      : hasModule(tab.dataset.module);
    tab.hidden = !visible;
  }
  const firstTab = tabs.find((tab) => !tab.hidden);
  tabs.forEach((tab) => setMainTabState(tab, tab === firstTab));
  document.querySelectorAll('.app-view').forEach((view) => { view.hidden = !firstTab || view.id !== firstTab.dataset.view; });
  document.querySelector('#restrictedView').hidden = Boolean(firstTab);
  document.querySelector('#chooseFolder').hidden = currentProfile?.role !== 'supervisor' || Boolean(supabaseConfig?.cloudStorage);
  document.querySelector('#openUpload').hidden = currentProfile?.role !== 'supervisor';
}

async function loadUserProfile() {
  const response = await fetch('/api/profile', {
    headers: { Authorization: `Bearer ${supabaseSession.access_token}` },
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || 'Impossible de vérifier les droits du compte.');
  currentProfile = result.profile;
}

async function adminRequest(method = 'GET', body, endpoint = '/api/admin/users') {
  if (supabaseSession.expires_at && supabaseSession.expires_at < Math.floor(Date.now() / 1000) + 30) await refreshSession();
  const response = await fetch(endpoint, {
    method,
    headers: {
      Authorization: `Bearer ${supabaseSession.access_token}`,
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result.error || 'Opération sur les comptes impossible.');
    error.code = result.code;
    throw error;
  }
  return result;
}

const moduleNames = { dashboard: 'Tableau de bord', archives: 'Enquêtes par agent', summary: 'Résumé des enquêtes', reports: 'Rapports' };

function zoneCheckboxes(zones, selected, name) {
  const selectedZones = new Set(selected || []);
  return zones.length ? zones.map((zone) => `<label><input type="checkbox" name="${name}" value="${escapeHtml(zone)}" ${selectedZones.has(zone) ? 'checked' : ''}> ${escapeHtml(zone)}</label>`).join('') : '<span class="muted">Aucune zone disponible. Choisissez d’abord le dossier d’enquêtes.</span>';
}

function renderCreateAccountZones() {
  const target = document.querySelector('#createAccountZones');
  if (target) target.innerHTML = zoneCheckboxes(appState.zones || [], [], 'zones');
}

async function loadManagedAccounts() {
  const list = document.querySelector('#accountsList');
  const notice = document.querySelector('#accountSettingsNotice');
  list.innerHTML = '<p class="muted">Chargement des comptes...</p>';
  notice.textContent = '';
  try {
    const result = await adminRequest();
    accountCache = (result.accounts || []).filter((account) => ['supervisor', 'responsable'].includes(account.role));
    list.innerHTML = accountCache.length ? accountCache.map((account) => `
      <details class="account-card" data-account="${escapeHtml(account.user_id)}">
        <summary class="account-card-summary"><span class="account-card-identity"><strong>${escapeHtml(account.display_name || account.email)}</strong><span>${escapeHtml(account.email)}</span></span><span class="account-role">${account.role === 'supervisor' ? 'Superviseur' : escapeHtml(account.title || 'Assistant')}</span><span class="account-expand-icon" aria-hidden="true">⌄</span></summary>
        <div class="account-card-body">
        ${account.role === 'supervisor' ? '' : `<label class="account-title-label">Nom et titre<div class="account-profile-fields"><input name="account-name" value="${escapeHtml(account.display_name || '')}" aria-label="Nom du responsable"><select name="account-title"><option value="Chef de secteur" ${account.title === 'Chef de secteur' ? 'selected' : ''}>Chef de secteur</option><option value="Chef de département" ${account.title === 'Chef de département' ? 'selected' : ''}>Chef de département</option><option value="Assistant" ${(account.title || 'Assistant') === 'Assistant' ? 'selected' : ''}>Assistant</option></select></div></label>`}
        <div class="account-modules">${Object.entries(moduleNames).map(([key, label]) => `<label><input type="checkbox" value="${key}" ${account.role === 'supervisor' || (account.permissions || []).includes(key) ? 'checked' : ''} ${account.role === 'supervisor' ? 'disabled' : ''}> ${label}</label>`).join('')}</div>
        ${account.role === 'supervisor' ? '' : `<fieldset class="module-access zone-access"><legend>Zones autorisées</legend><div class="zone-checkboxes">${zoneCheckboxes(appState.zones || [], account.zones || [], 'account-zones')}</div></fieldset>`}
        ${account.role === 'supervisor' ? '' : '<button type="button" class="secondary" data-save-access>Enregistrer le profil et les accès</button><div class="account-password-reset"><input type="password" name="account-password" minlength="8" autocomplete="new-password" placeholder="Nouveau mot de passe provisoire"><button type="button" class="secondary" data-reset-password>Réinitialiser le mot de passe</button></div><button type="button" class="secondary danger-button" data-dismiss>Retirer ses fonctions et ses accès</button>'}
        </div>
      </details>`).join('') : '<p class="empty visible">Aucun compte trouvé.</p>';
  } catch (error) {
    list.innerHTML = '';
    notice.textContent = error.message;
  }
}

let fieldAgentVillages = [];
const fieldAgentVillageSelections = new Map();
let activeVillagePickerUserId = null;
let fieldAgentCache = [];

function renderFieldAgentDetail(agent) {
  const detail = document.querySelector('#fieldAgentDetail');
  if (!agent || !agent.exists) {
    detail.innerHTML = '<div class="agent-detail-empty"><strong>Aucun compte agent trouvé</strong><span>Créez d’abord les comptes manquants ou choisissez un agent déjà créé.</span></div>';
    return;
  }
  fieldAgentVillageSelections.set(agent.user_id, [...(agent.villages || [])]);
  detail.innerHTML = `
    <article class="agent-detail-card" data-user-id="${escapeHtml(agent.user_id)}">
      <div class="agent-detail-heading"><div class="agent-avatar">${escapeHtml((agent.name || '?').trim().slice(0, 1).toLocaleUpperCase('fr'))}</div><div><span class="eyebrow">FICHE AGENT DE TERRAIN</span><h3>${escapeHtml(agent.name)}</h3><p>${escapeHtml(agent.source_name || agent.name)} · compte mobile</p></div><span class="field-agent-status is-created">Compte actif</span></div>
      <section class="agent-edit-section"><div class="agent-section-heading"><div><h4>Profil et accès mobile</h4><p>Modifiez le nom affiché, l’identifiant de connexion ou le mot de passe.</p></div></div>
        <div class="agent-profile-fields">
          <label>Nom de l’agent<input data-agent-name value="${escapeHtml(agent.name || '')}" autocomplete="off"></label>
          <label>Identifiant de connexion<input data-agent-identifier value="${escapeHtml(agent.login_identifier || '')}" autocomplete="off"></label>
          <label>Nouveau mot de passe<input data-agent-password type="password" minlength="6" autocomplete="new-password" placeholder="Laisser vide pour conserver l’actuel"></label>
        </div>
        <div class="agent-save-row"><button type="button" class="secondary" data-save-agent-profile>Enregistrer le profil</button><span class="section-save-status" data-profile-status role="status" aria-live="polite"></span></div>
      </section>
      <section class="agent-edit-section"><div class="agent-section-heading"><div><h4>Section et villages attribués</h4><p>Les planteurs visibles sur le téléphone de l’agent proviennent de ces villages.</p></div></div>
        <div class="field-agent-section">
          <label>Nom de la section<input data-section-name value="${escapeHtml(agent.section_name || '')}" placeholder="Ex. Section Méagui Nord"></label>
          <div class="field-agent-villages"><span class="field-agent-label">Villages de la section</span><div class="selected-villages" data-village-list></div><button type="button" class="secondary add-village-button" data-add-village>＋ Ajouter un village</button></div>
          <div class="section-save-area"><button type="button" class="primary save-section-button" data-save-agent-section>Enregistrer les villages</button><span class="section-save-status" data-section-status role="status" aria-live="polite"></span></div>
        </div>
      </section>
      <div class="agent-save-row">
        <button type="button" class="secondary" data-sync-agent-producers>Synchroniser les planteurs avec l’application mobile</button>
        <span class="section-save-status" data-producer-sync-status role="status"></span>
      </div>
    </article>`;
  renderFieldAgentVillages(detail.querySelector('.agent-detail-card'));
}

function renderFieldAgentVillages(card) {
  const userId = card.dataset.userId;
  const selected = fieldAgentVillageSelections.get(userId) || [];
  const container = card.querySelector('[data-village-list]');
  container.innerHTML = selected.length
    ? selected.map((village, index) => `<span class="selected-village-chip">${escapeHtml(village)}<button type="button" data-remove-village="${index}" aria-label="Retirer ${escapeHtml(village)}">×</button></span>`).join('')
    : '<span class="muted">Aucun village ajouté.</span>';
}

function renderVillagePickerResults() {
  const results = document.querySelector('#villagePickerResults');
  const normalizeVillageSearch = (value) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('fr');
  const query = normalizeVillageSearch(document.querySelector('#villagePickerSearch').value.trim());
  const assigned = new Set(fieldAgentVillageSelections.get(activeVillagePickerUserId) || []);
  const matches = fieldAgentVillages.filter((village) => normalizeVillageSearch(village).includes(query));
  results.innerHTML = !fieldAgentVillages.length
    ? "<p class=\"muted village-picker-empty\">Aucun village disponible dans l’onglet Producteurs.</p>"
    : matches.length ? matches.map((village) => `
    <button type="button" class="village-picker-option ${assigned.has(village) ? 'is-added' : ''}" data-pick-village="${escapeHtml(village)}" ${assigned.has(village) ? 'disabled' : ''}>
      <span>${escapeHtml(village)}</span><strong>${assigned.has(village) ? 'Ajouté' : 'Ajouter'}</strong>
    </button>`).join('') : '<p class="muted village-picker-empty">Aucun village correspondant.</p>';
}

async function loadVillagesFromProducersTab() {
  const firstPage = await adminRequest('GET', undefined, '/api/producers?page=1&pageSize=1000');
  const pageSize = firstPage.pageSize || 100;
  const pageCount = Math.ceil((firstPage.total || 0) / pageSize);
  const rows = [...(firstPage.items || [])];
  for (let start = 2; start <= pageCount; start += 12) {
    const pages = Array.from({ length: Math.min(12, pageCount - start + 1) }, (_, index) => start + index);
    const batches = await Promise.all(pages.map((page) => adminRequest('GET', undefined, `/api/producers?page=${page}&pageSize=${pageSize}`)));
    for (const batch of batches) rows.push(...(batch.items || []));
  }
  const villages = new Map();
  for (const producer of rows) {
    const village = String(producer.village || '').trim();
    const key = village.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('fr');
    if (key && !villages.has(key)) villages.set(key, village);
  }
  return [...villages.values()].sort((a, b) => a.localeCompare(b, 'fr'));
}

async function loadFieldAgentAccounts() {
  const list = document.querySelector('#fieldAgentsList');
  const notice = document.querySelector('#fieldAgentsNotice');
  const createButton = document.querySelector('#createFieldAgentAccounts');
  if (!list || !notice) return;
  detailStatus('Chargement des comptes agents...');
  notice.textContent = '';
  try {
    const result = await adminRequest('GET', undefined, '/api/admin/field-agents');
    const agents = result.agents || [];
    fieldAgentCache = agents;
    fieldAgentVillages = result.villages || [];
    if (!fieldAgentVillages.length) fieldAgentVillages = await loadVillagesFromProducersTab();
    fieldAgentVillageSelections.clear();
    const datalist = document.querySelector('#fieldAgentOptions');
    datalist.innerHTML = agents.map((agent) => `<option value="${escapeHtml(agent.name)}"></option>`).join('');
    createButton.disabled = agents.length === 0 || agents.every((agent) => agent.exists);
    const search = document.querySelector('#fieldAgentSearch');
    const selected = agents.find((agent) => agent.exists && [agent.name, agent.login_identifier].some((value) => normalizeSearch(value) === normalizeSearch(search.value)));
    if (selected) renderFieldAgentDetail(selected);
    else detailStatus(agents.length ? 'Recherchez puis sélectionnez un agent pour ouvrir sa fiche.' : 'Aucun agent détecté dans le dossier sélectionné.');
  } catch (error) {
    fieldAgentCache = [];
    document.querySelector('#fieldAgentOptions').replaceChildren();
    detailStatus('Impossible de charger les comptes agents. Cliquez sur Actualiser pour réessayer.');
    const message = error.message || '';
    notice.textContent = error.code === 'SECTIONS_SCHEMA_MISSING'
      ? `Exécutez sections-migration.sql dans l’éditeur SQL de Supabase, puis actualisez les agents. Détail Supabase : ${message}`
      : message;
    createButton.disabled = true;
  }
}

function detailStatus(message) {
  const detail = document.querySelector('#fieldAgentDetail');
  if (detail) detail.innerHTML = `<div class="agent-detail-empty"><strong>${escapeHtml(message)}</strong></div>`;
}

function selectFieldAgentFromSearch() {
  const query = normalizeSearch(document.querySelector('#fieldAgentSearch').value);
  if (!query) {
    detailStatus('Recherchez puis sélectionnez un agent pour ouvrir sa fiche.');
    return;
  }
  const selected = fieldAgentCache.find((agent) => agent.exists && [agent.name, agent.source_name, agent.login_identifier].some((value) => normalizeSearch(value) === query));
  if (selected) renderFieldAgentDetail(selected);
}

document.querySelector('#createFieldAgentAccounts').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  const notice = document.querySelector('#fieldAgentsNotice');
  button.disabled = true;
  button.textContent = 'Création des comptes...';
  notice.textContent = '';
  try {
    const result = await adminRequest('POST', {}, '/api/admin/field-agents');
    const messages = [`${result.created.length} compte(s) créé(s)`, `${result.already_exists.length} déjà existant(s)`, `mot de passe provisoire : ${result.default_password}`];
    if (result.errors.length) messages.push(`${result.errors.length} erreur(s) : ${result.errors.map((item) => `${item.login_identifier} — ${item.error}`).join(' ; ')}`);
    notice.textContent = messages.join(' · ');
  } catch (error) {
    notice.textContent = error.message;
  } finally {
    button.textContent = 'Créer les comptes manquants';
    await loadFieldAgentAccounts();
  }
});
document.querySelector('#reloadFieldAgents').addEventListener('click', loadFieldAgentAccounts);

async function syncAgentProducers(card) {
  const button = card.querySelector('[data-sync-agent-producers]');
  const saveButton = card.querySelector('[data-save-agent-section]');
  const saveWasDisabled = saveButton.disabled;
  const status = card.querySelector('[data-producer-sync-status]');
  button.disabled = true;
  saveButton.disabled = true;
  status.className = 'section-save-status is-pending';
  status.textContent = 'Envoi des producteurs vers Supabase…';
  try {
    const result = await adminRequest('POST', { user_id: card.dataset.userId }, '/api/admin/sync-producers');
    if (!Number.isInteger(result.assigned_villages)) {
      throw new Error('Relancez le serveur de la plateforme pour activer la synchronisation par agent.');
    }
    status.className = result.synchronized ? 'section-save-status is-success' : 'section-save-status is-error';
    if (result.synchronized) {
      status.textContent = `${result.synchronized.toLocaleString('fr-FR')} producteurs envoyés à Supabase. L’agent peut actualiser sa liste sur le téléphone avec Internet.`;
    } else if (result.assigned_villages) {
      status.textContent = 'Le fichier Producteurs ne contient aucun planteur pour les villages enregistrés de cet agent.';
    } else {
      status.textContent = 'Enregistrez au moins un village pour cet agent avant de synchroniser.';
    }
  } catch (error) {
    status.className = 'section-save-status is-error';
    status.textContent = error.message;
  } finally {
    saveButton.disabled = saveWasDisabled;
    button.disabled = false;
  }
}

document.querySelector('#fieldAgentDetail').addEventListener('click', async (event) => {
  const syncButton = event.target.closest('[data-sync-agent-producers]');
  if (syncButton) {
    await syncAgentProducers(syncButton.closest('.agent-detail-card'));
    return;
  }
  const addButton = event.target.closest('[data-add-village]');
  if (addButton) {
    const card = addButton.closest('.agent-detail-card');
    activeVillagePickerUserId = card.dataset.userId;
    document.querySelector('#villagePickerSearch').value = '';
    renderVillagePickerResults();
    document.querySelector('#villagePickerDialog').showModal();
    document.querySelector('#villagePickerSearch').focus();
    return;
  }
  const removeButton = event.target.closest('[data-remove-village]');
  if (removeButton) {
    const card = removeButton.closest('.agent-detail-card');
    const selected = fieldAgentVillageSelections.get(card.dataset.userId) || [];
    selected.splice(Number(removeButton.dataset.removeVillage), 1);
    fieldAgentVillageSelections.set(card.dataset.userId, selected);
    renderFieldAgentVillages(card);
    return;
  }
  const profileButton = event.target.closest('[data-save-agent-profile]');
  if (profileButton) {
    const card = profileButton.closest('.agent-detail-card');
    const status = card.querySelector('[data-profile-status]');
    profileButton.disabled = true;
    profileButton.textContent = 'Enregistrement...';
    status.className = 'section-save-status is-pending';
    status.textContent = 'Mise à jour du compte mobile...';
    try {
      const result = await adminRequest('PATCH', {
        user_id: card.dataset.userId,
        display_name: card.querySelector('[data-agent-name]').value,
        login_identifier: card.querySelector('[data-agent-identifier]').value,
        password: card.querySelector('[data-agent-password]').value,
      }, '/api/admin/field-agents');
      card.querySelector('[data-agent-password]').value = '';
      status.className = 'section-save-status is-success';
      status.textContent = 'Profil et accès mobile enregistrés.';
      document.querySelector('#fieldAgentSearch').value = result.display_name;
      await loadFieldAgentAccounts();
      const updated = fieldAgentCache.find((agent) => agent.user_id === result.user_id);
      if (updated) renderFieldAgentDetail(updated);
      showToast("Profil et accès mobile de l'agent enregistrés.");
    } catch (error) {
      status.className = 'section-save-status is-error';
      status.textContent = error.message || 'Échec de la mise à jour du compte.';
    } finally {
      profileButton.disabled = false;
      profileButton.textContent = 'Enregistrer le profil';
    }
    return;
  }
  const button = event.target.closest('[data-save-agent-section]');
  if (!button) return;
  const card = button.closest('.agent-detail-card');
  const notice = document.querySelector('#fieldAgentsNotice');
  const status = card.querySelector('[data-section-status]');
  const originalLabel = button.textContent;
  const syncButtonForCard = card.querySelector('[data-sync-agent-producers]');
  button.disabled = true;
  syncButtonForCard.disabled = true;
  button.textContent = 'Enregistrement...';
  status.className = 'section-save-status is-pending';
  status.textContent = 'Enregistrement de la section dans Supabase...';
  notice.textContent = '';
  try {
    const result = await adminRequest('PATCH', {
      user_id: card.dataset.userId,
      section_name: card.querySelector('[data-section-name]').value,
      villages: fieldAgentVillageSelections.get(card.dataset.userId) || [],
    }, '/api/admin/field-agents');
    fieldAgentVillageSelections.set(card.dataset.userId, result.villages || []);
    const cachedAgent = fieldAgentCache.find((agent) => agent.user_id === card.dataset.userId);
    if (cachedAgent) {
      cachedAgent.section_name = result.section_name;
      cachedAgent.villages = result.villages || [];
    }
    renderFieldAgentVillages(card);
    status.className = 'section-save-status is-success';
    status.textContent = `Section enregistrée (${result.villages.length} village(s)).`;
    if (result.villages.length) {
      await syncAgentProducers(card);
    } else {
      card.querySelector('[data-producer-sync-status]').textContent = '';
    }
  } catch (error) {
    const raw = error.message || '';
    status.className = 'section-save-status is-error';
    status.textContent = /section_name|villages|agent_source_name|42703|does not exist|n'existe pas/i.test(raw)
      ? 'Les colonnes de section manquent dans Supabase. Exécutez sections-migration.sql dans SQL Editor.'
      : /opération sur les comptes impossible|operation on accounts|not found/i.test(raw)
        ? 'Le serveur n’a pas encore chargé cette fonction. Fermez sa fenêtre puis relancez DEMARRER.bat.'
        : raw || 'Échec de l’enregistrement. Vérifiez la connexion et réessayez.';
  } finally {
    button.disabled = false;
    syncButtonForCard.disabled = false;
    button.textContent = originalLabel;
  }
});

document.querySelector('#villagePickerResults').addEventListener('click', (event) => {
  const option = event.target.closest('[data-pick-village]');
  if (!option) return;
  const selected = fieldAgentVillageSelections.get(activeVillagePickerUserId) || [];
  selected.push(option.dataset.pickVillage);
  fieldAgentVillageSelections.set(activeVillagePickerUserId, selected);
  const card = document.querySelector(`.agent-detail-card[data-user-id="${CSS.escape(activeVillagePickerUserId)}"]`);
  if (card) renderFieldAgentVillages(card);
  renderVillagePickerResults();
});

document.querySelector('#fieldAgentSearch').addEventListener('change', selectFieldAgentFromSearch);
document.querySelector('#fieldAgentSearch').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    selectFieldAgentFromSearch();
  }
});

document.querySelector('#villagePickerSearch').addEventListener('input', renderVillagePickerResults);
document.querySelector('#closeVillagePicker').addEventListener('click', () => document.querySelector('#villagePickerDialog').close());
document.querySelector('#doneVillagePicker').addEventListener('click', () => document.querySelector('#villagePickerDialog').close());

document.querySelector('#createAccountForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const errorBox = document.querySelector('#accountFormError');
  const button = document.querySelector('#createAccountButton');
  const permissions = [...form.querySelectorAll('input[name="permissions"]:checked')].map((input) => input.value);
  const zones = [...form.querySelectorAll('input[name="zones"]:checked')].map((input) => input.value);
  if (!permissions.length || !zones.length) {
    errorBox.textContent = !permissions.length ? 'Sélectionnez au moins un module pour ce responsable.' : 'Sélectionnez au moins une zone pour ce responsable.';
    return;
  }
  button.disabled = true;
  errorBox.textContent = '';
  try {
    await adminRequest('POST', {
      display_name: form.elements.display_name.value.trim(),
      title: form.elements.title.value,
      email: form.elements.email.value.trim(),
      password: form.elements.password.value,
      permissions,
      zones,
    });
    form.reset();
    form.hidden = true;
    const toggle = document.querySelector('#toggleCreateAccount');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.textContent = '+ Ajouter un nouveau compte';
    showToast('Compte responsable créé avec ses accès.');
    await loadManagedAccounts();
  } catch (error) {
    errorBox.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

document.querySelector('#toggleCreateAccount').addEventListener('click', (event) => {
  const button = event.currentTarget;
  const form = document.querySelector('#createAccountForm');
  const expanded = form.hidden;
  form.hidden = !expanded;
  button.setAttribute('aria-expanded', String(expanded));
  button.textContent = expanded ? 'Fermer le formulaire' : '+ Ajouter un nouveau compte';
  if (expanded) form.querySelector('input[name="display_name"]').focus();
});

document.querySelector('#accountsList').addEventListener('click', async (event) => {
  const card = event.target.closest('[data-account]');
  if (!card) return;
  const resetButton = event.target.closest('[data-reset-password]');
  if (resetButton) {
    const passwordInput = card.querySelector('input[name="account-password"]');
    const password = passwordInput.value;
    if (password.length < 8) { showToast('Le nouveau mot de passe doit contenir au moins 8 caractères.'); return; }
    resetButton.disabled = true;
    try {
      await adminRequest('PATCH', { user_id: card.dataset.account, password });
      passwordInput.value = '';
      showToast('Mot de passe réinitialisé. Transmettez le mot de passe provisoire au responsable.');
    } catch (error) { showToast(error.message); }
    finally { resetButton.disabled = false; }
    return;
  }
  const dismissButton = event.target.closest('[data-dismiss]');
  if (dismissButton) {
    if (!window.confirm('Retirer tous les modules et toutes les zones autorisés à ce responsable ?')) return;
    dismissButton.disabled = true;
    try {
      await adminRequest('PATCH', { user_id: card.dataset.account, permissions: [], zones: [] });
      showToast('Fonctions et accès retirés. Le compte pourra être réactivé depuis ses paramètres.');
      await loadManagedAccounts();
    } catch (error) { showToast(error.message); dismissButton.disabled = false; }
    return;
  }
  const button = event.target.closest('[data-save-access]');
  if (!button) return;
  const permissions = [...card.querySelectorAll('.account-modules input:checked')].map((input) => input.value);
  const zones = [...card.querySelectorAll('input[name="account-zones"]:checked')].map((input) => input.value);
  const title = card.querySelector('select[name="account-title"]')?.value || 'Assistant';
  const displayName = card.querySelector('input[name="account-name"]')?.value.trim() || '';
  if (permissions.length && !zones.length) { showToast('Attribuez au moins une zone aux modules autorisés.'); return; }
  if (displayName.length < 2) { showToast('Le nom du responsable doit contenir au moins 2 caractères.'); return; }
  button.disabled = true;
  try {
    await adminRequest('PATCH', { user_id: card.dataset.account, permissions, zones, title, display_name: displayName });
    showToast('Profil et accès du responsable mis à jour.');
    await loadManagedAccounts();
  } catch (error) {
    showToast(error.message);
    button.disabled = false;
  }
});
document.querySelector('#reloadAccounts').addEventListener('click', loadManagedAccounts);
async function startLogin(email, password) {
  if (!supabaseConfig?.supabaseUrl || !supabaseConfig?.supabaseAnonKey) {
    throw new Error('Configuration Supabase manquante : renseignez SUPABASE_URL et SUPABASE_ANON_KEY dans le fichier .env.');
  }
  let session;
  try {
    const response = await fetch(`${supabaseConfig.supabaseUrl}/auth/v1/token?grant_type=password`, {
      method: 'POST', headers: { apikey: supabaseConfig.supabaseAnonKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
    });
    session = await readResponse(response);
  } catch (error) {
    throw new Error(`Connexion Supabase impossible : ${error.message}`);
  }
  session.expires_at = Math.floor(Date.now() / 1000) + (session.expires_in || 3600);
  saveSession(session);
  try {
    await loadUserProfile();
  } catch (error) {
    throw new Error(`Authentification réussie, mais vérification du profil impossible : ${error.message}`);
  }
  showApplication();
  try {
    await loadState();
  } catch (error) {
    document.querySelector('#loadingMessage').hidden = true;
    showToast(`Connecté, mais chargement des données impossible : ${error.message}`);
  }
}
document.querySelector('#loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = document.querySelector('#loginButton');
  const error = document.querySelector('#loginError');
  error.textContent = '';
  button.disabled = true;
  button.textContent = 'Connexion…';
  try { await startLogin(form.elements.email.value.trim(), form.elements.password.value); }
  catch (err) {
    document.querySelector('#appShell').hidden = true;
    document.querySelector('#loginView').hidden = false;
    error.textContent = err.message || 'Connexion impossible.';
    localStorage.removeItem(SESSION_KEY);
    supabaseSession = null;
  }
  finally { button.disabled = false; button.textContent = 'Se connecter'; }
});
document.querySelector('#logoutButton').addEventListener('click', () => {
  localStorage.removeItem(SESSION_KEY);
  supabaseSession = null;
  currentProfile = null;
  document.querySelector('#appShell').hidden = true;
  document.querySelector('#loginView').hidden = false;
  document.querySelector('#loginForm').reset();
});

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function formatDate(value) {
  if (!value) return '—';
  const [year, month, day] = value.split('-').map(Number);
  return new Intl.DateTimeFormat('fr-FR').format(new Date(year, month - 1, day));
}

function formatSize(bytes = 0) {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} Ko` : `${(bytes / 1024 / 1024).toFixed(1)} Mo`;
}

function buildStatisticsSnapshot(records, sourceId) {
  const totals = new Map();
  for (const record of records) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(record.date || '') || !record.agent) continue;
    for (const answer of record.answers || []) {
      const response = String(answer.response || '').trim();
      if (!response) continue;
      const row = {
        source_id: sourceId,
        date_enquete: record.date,
        zone: record.zone || '',
        agent: record.agent,
        question_ref: String(answer.ref || ''),
        question: String(answer.question || ''),
        reponse: response,
      };
      const key = [row.source_id, row.date_enquete, row.zone, row.agent, row.question_ref, row.reponse].join('\u0000');
      const stored = totals.get(key) || { ...row, nombre: 0 };
      stored.nombre += 1;
      totals.set(key, stored);
    }
  }
  return [...totals.values()];
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 3400);
}

async function loadState() {
  const loadingMessage = document.querySelector('#loadingMessage');
  loadingMessage.textContent = 'Lecture des enquêtes du dossier…';
  loadingMessage.hidden = false;
  let localState;
  try {
    const response = await fetch('/api/state', { headers: { Authorization: `Bearer ${supabaseSession.access_token}` } });
    if (!response.ok) throw new Error('Impossible de lire le dossier local.');
    localState = await response.json();
  } catch {
    // Une autre instance peut consulter les données Supabase sans accéder au PC source.
    localState = {
      records: [], agents: [], zones: [], zoneAgents: [], archiveDirectory: 'Dossier local indisponible',
      sourceDirectoryFound: false, statisticsSourceId: '',
    };
  }
  if (currentProfile?.role !== 'supervisor') {
    const allowedZones = new Set((currentProfile?.zones || []).map(zoneKey));
    localState.records = (localState.records || []).filter((record) => allowedZones.has(zoneKey(record.zone)));
    localState.zones = (localState.zones || []).filter((zone) => allowedZones.has(zoneKey(zone)));
    localState.agents = [...new Set(localState.records.map((record) => record.agent).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'fr'));
    localState.zoneAgents = (localState.zoneAgents || []).filter((item) => allowedZones.has(zoneKey(item.zone)));
  }
  appState = localState;
  renderCreateAccountZones();
  updateSettingsFolderPath(appState.archiveDirectory);
  render();
  loadingMessage.textContent = 'Synchronisation des informations…';
  if (!['dashboard', 'archives', 'summary', 'reports'].some(hasModule)) {
    appState = { ...localState, records: [], agents: [], zones: [], zoneAgents: [], statisticsRows: [], statisticsSourceId: '' };
    render();
    loadingMessage.hidden = true;
    return;
  }
  const localById = new Map(localState.records.map((record) => [record.id, record]));
  let statisticsSyncError = '';
  let duplicateCheckSchemaMissing = false;
  let remoteStatistics = [];
  if (currentProfile?.role === 'supervisor' && localState.records.length) {
    const payload = localState.records
      .filter((record) => ['Conforme', 'Non conforme'].includes(record.status))
      .map((record) => ({
      // Identifiant du fichier local uniquement : le PDF n'est jamais envoye a Supabase.
      pdf_key: record.id,
      zone: record.zone || '',
      agent: record.agent || '',
      code_phi: record.code || '',
      nom_planteur: record.producer || '',
      village: record.village || '',
      date_enquete: /^\d{4}-\d{2}-\d{2}$/.test(record.date || '') ? record.date : null,
      statut: record.status,
      }));
    if (payload.length) {
      try {
        await supabaseFetch('enquetes?on_conflict=pdf_key', {
          method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(payload),
        });
      } catch (error) {
        if (!/date_enquete|village|42703|PGRST204/i.test(error.message || '')) throw error;
        duplicateCheckSchemaMissing = true;
        const legacyPayload = payload.map(({ date_enquete, village, ...row }) => row);
        await supabaseFetch('enquetes?on_conflict=pdf_key', {
          method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(legacyPayload),
        });
      }
    }
    if (localState.sourceDirectoryFound && localState.statisticsSourceId) {
      try {
        const summaryRows = buildStatisticsSnapshot(localState.records, localState.statisticsSourceId);
        await supabaseFetch('rpc/replace_archive_statistics', {
          method: 'POST', body: JSON.stringify({ p_source_id: localState.statisticsSourceId, p_rows: summaryRows }),
        });
      } catch (error) {
        statisticsSyncError = error.message || 'Synchronisation des résumés impossible.';
      }
    }
  }
  const remoteRows = await supabaseFetchAll('enquetes?select=*&order=zone.asc,agent.asc,code_phi.asc');
  if (remoteRows.length && remoteRows.some((row) => !Object.hasOwn(row, 'date_enquete'))) {
    duplicateCheckSchemaMissing = true;
  }
  try {
    if (hasModule('summary') || hasModule('reports')) remoteStatistics = await supabaseFetchAll('statistiques_reponses?select=source_id,date_enquete,zone,agent,question_ref,question,reponse,nombre&order=agent.asc,question_ref.asc');
  } catch (error) {
    statisticsSyncError = statisticsSyncError || error.message || 'Lecture des résumés Supabase impossible.';
  }
  let remoteAnnotations = [];
  try {
    if (hasModule('archives')) remoteAnnotations = await supabaseFetchAll('annotations_enquetes?select=pdf_key,zone,annotation,reprise_requise,annotateur,updated_at');
  } catch (error) {
    showToast(`Annotations en ligne indisponibles : ${error.message || 'table absente'}`);
  }
  const annotationsByPdf = new Map(remoteAnnotations.map((annotation) => [annotation.pdf_key, annotation]));
  const recordsByKey = new Map(remoteRows.map((row) => {
    const local = localById.get(row.pdf_key);
    return [row.pdf_key, {
      id: row.pdf_key, date: local?.date || row.date_enquete || '', zone: row.zone || '', agent: row.agent || '',
      code: row.code_phi || '', producer: row.nom_planteur || '', village: row.village || '',
      status: row.statut || 'À vérifier', criteria: row.criteres || '',
      answers: local?.answers || (Array.isArray(row.reponses) ? row.reponses : []),
      originalName: local?.originalName || row.nom_fichier || '', size: local?.size || row.taille_pdf || 0, pdfAvailable: Boolean(local || row.pdf_path),
      ...annotationFields(annotationsByPdf.get(row.pdf_key)),
    }];
  }));
  // Affiche aussi les PDF du dossier dont le statut n'a pas pu être lu; ils ne sont pas synchronisés.
  for (const local of localState.records) {
    if (!recordsByKey.has(local.id)) recordsByKey.set(local.id, {
      ...local, pdfAvailable: true, ...annotationFields(annotationsByPdf.get(local.id)),
    });
  }
  const records = [...recordsByKey.values()];
  markSurveyDuplicates(records);
  const agents = [...new Set([...localState.agents, ...records.map((record) => record.agent).filter(Boolean)])].sort((a, b) => a.localeCompare(b, 'fr'));
  const zones = [...new Set([...localState.zones, ...records.map((record) => record.zone).filter(Boolean)])].sort((a, b) => a.localeCompare(b, 'fr'));
  const zoneAgents = [...localState.zoneAgents, ...records.filter((record) => record.zone && record.agent).map(({ zone, agent }) => ({ zone, agent }))];
  appState = { ...localState, records, agents, zones, zoneAgents, statisticsRows: remoteStatistics, statisticsSyncError, duplicateCheckSchemaMissing };
  updateSettingsFolderPath(appState.archiveDirectory);
  render();
  loadingMessage.hidden = true;
  if (statisticsSyncError) showToast(`Résumés en ligne indisponibles : ${statisticsSyncError}`);
}

function updateSettingsFolderPath(folderPath) {
  const element = document.querySelector('#settingsArchivePath');
  if (element) element.textContent = supabaseConfig?.cloudStorage ? 'PDF stockés de façon sécurisée dans Supabase Storage.' : (folderPath || 'Aucun dossier sélectionné');
}

function currentFilters() {
  return {
    search: document.querySelector('#searchInput').value.trim().toLocaleLowerCase('fr'),
    zone: document.querySelector('#zoneFilter').value,
    agent: document.querySelector('#agentFilter').value,
    status: document.querySelector('#statusFilter').value,
    from: document.querySelector('#fromFilter').value,
    to: document.querySelector('#toFilter').value,
  };
}

function annotationFields(annotation) {
  return {
    annotation: annotation?.annotation || '',
    repriseRequired: Boolean(annotation?.reprise_requise),
    annotatedBy: annotation?.annotateur || '',
    annotatedAt: annotation?.updated_at || '',
  };
}

function markSurveyDuplicates(records) {
  const groups = new Map();
  for (const record of records) {
    record.isDuplicate = false;
    record.duplicateType = '';
    record.duplicateYear = '';
    record.duplicateDetails = '';
    const year = String(record.date || '').slice(0, 4);
    if (!/^\d{4}$/.test(year)) continue;

    const normalizedCode = normalizeSearch(record.code).replace(/[^a-z0-9]/g, '');
    const hasUsableCode = normalizedCode && !['phi', 'codenontrouve', 'inconnu', 'sanscode'].includes(normalizedCode);
    const normalizedName = normalizeSearch(record.producer).replace(/[^a-z0-9]/g, '');
    const identity = hasUsableCode
      ? { value: `code:${normalizedCode}`, type: 'confirmed' }
      : normalizedName.length >= 6
        ? { value: `name:${normalizedName}`, type: 'possible' }
        : null;
    if (!identity) continue;

    const key = `${year}:${identity.value}`;
    const group = groups.get(key) || { records: [], type: identity.type, year };
    group.records.push(record);
    groups.set(key, group);
  }

  for (const group of groups.values()) {
    if (group.records.length < 2) continue;
    const otherSurveys = group.records.map((record) =>
      `${record.agent || 'Agent inconnu'}${record.zone ? ` (${record.zone})` : ''}`,
    );
    const details = `${group.records.length} enquêtes repérées en ${group.year} : ${otherSurveys.join(', ')}`;
    for (const record of group.records) {
      record.isDuplicate = true;
      record.duplicateType = group.type;
      record.duplicateYear = group.year;
      record.duplicateDetails = details;
    }
  }
}

function render() {
  const { records, agents, zones, zoneAgents = [] } = appState;
  const zoneFilter = document.querySelector('#zoneFilter');
  const selectedZone = zoneFilter.value;
  zoneFilter.innerHTML = '<option value="">Toutes les zones</option>' + zones.map((zone) => `<option value="${escapeHtml(zone)}">${escapeHtml(zone)}</option>`).join('');
  if (zones.includes(selectedZone)) zoneFilter.value = selectedZone;

  const agentFilter = document.querySelector('#agentFilter');
  const selectedAgent = agentFilter.value;
  const availableAgents = selectedZone
    ? [...new Set(zoneAgents.filter((entry) => zoneKey(entry.zone) === zoneKey(selectedZone)).map((entry) => entry.agent))]
        .sort((a, b) => a.localeCompare(b, 'fr'))
    : agents;
  agentFilter.innerHTML = '<option value="">Tous les agents</option>' + availableAgents.map((agent) => `<option value="${escapeHtml(agent)}">${escapeHtml(agent)}</option>`).join('');
  agentFilter.value = availableAgents.includes(selectedAgent) ? selectedAgent : '';

  document.querySelector('#agentsList').innerHTML = agents.map((agent) => `<option value="${escapeHtml(agent)}"></option>`).join('');
  document.querySelector('#zonesList').innerHTML = zones.map((zone) => `<option value="${escapeHtml(zone)}"></option>`).join('');

  const filters = currentFilters();
  const statusMatches = (item) => !filters.status || (
    filters.status === '__duplicates' ? item.isDuplicate : item.status === filters.status
  );
  const filtered = records.filter((item) => {
    const haystack = [item.agent, item.code, item.producer, item.village, item.zone, item.status, item.criteria].join(' ').toLocaleLowerCase('fr');
    return (!filters.search || haystack.includes(filters.search)) &&
      (!filters.zone || item.zone === filters.zone) &&
      (!filters.agent || item.agent === filters.agent) &&
      statusMatches(item) &&
      (!filters.from || item.date >= filters.from) &&
      (!filters.to || item.date <= filters.to);
  });

  const hasAppliedFilter = Boolean(
    filters.search || filters.zone || filters.agent || filters.status || filters.from || filters.to,
  );
  document.querySelector('#totalCount').textContent = filtered.length;
  document.querySelector('#agentCount').textContent = hasAppliedFilter
    ? new Set(filtered.map((item) => item.agent).filter(Boolean)).size
    : agents.length;
  document.querySelector('#conformingCount').textContent = filtered.filter((item) => item.status === 'Conforme').length;
  document.querySelector('#nonConformingCount').textContent = filtered.filter((item) => item.status === 'Non conforme').length;

  document.querySelector('#resultCount').textContent = `${filtered.length} résultat${filtered.length > 1 ? 's' : ''}`;
  const duplicateNotice = document.querySelector('#duplicateNotice');
  const duplicateRows = records.filter((item) => item.isDuplicate);
  const duplicateGroupCount = new Set(duplicateRows.map((item) => `${item.duplicateYear}:${item.duplicateDetails}`)).size;
  duplicateNotice.hidden = duplicateRows.length === 0;
  duplicateNotice.querySelector('span').textContent = duplicateRows.length
    ? `${duplicateGroupCount} doublon(s) potentiel(s) repéré(s) : ${duplicateRows.length} enquêtes à vérifier.`
    : '';
  document.querySelector('#duplicateSchemaNotice').hidden = !appState.duplicateCheckSchemaMissing;
  emptyState.classList.toggle('visible', filtered.length === 0);
  recordsBody.style.display = filtered.length ? '' : 'none';
  const canAnnotate = currentProfile?.role === 'supervisor';
  recordsBody.innerHTML = filtered.map((item) => {
    const statusClass = item.status === 'Non conforme' ? 'warning' : item.status === 'À vérifier' ? 'neutral' : '';
    const duplicateBadge = item.isDuplicate
      ? `<span class="badge warning duplicate-badge" title="${escapeHtml(item.duplicateDetails)}">${item.duplicateType === 'confirmed' ? 'Doublon détecté' : 'Doublon possible'}</span>`
      : '';
    return `<tr>
      <td>${formatDate(item.date)}</td>
      <td>${escapeHtml(item.zone || '—')}</td>
      <td class="agent-name">${escapeHtml(item.agent)}</td>
      <td>${escapeHtml(item.code || 'Code non trouvé')}</td>
      <td>${escapeHtml(item.producer || 'Nom non trouvé')}</td>
      <td><span class="badge ${statusClass}">${escapeHtml(item.status)}</span>${duplicateBadge}</td>
      <td>${item.pdfAvailable === false ? '<span class="muted">PDF absent localement</span>' : `<button type="button" class="file-link" data-open-pdf="${escapeHtml(item.id)}">&#8599; Ouvrir <span class="muted">${formatSize(item.size)}</span></button>`}</td>
      <td><div class="annotation-cell">${item.repriseRequired ? '<span class="badge warning">Reprise demandée</span>' : item.annotation ? '<span class="badge neutral">Annotation</span>' : '<span class="muted">Aucune</span>'}${item.annotation ? `<span class="annotation-preview" title="${escapeHtml(item.annotation)}">${escapeHtml(item.annotation)}</span>` : ''}${canAnnotate ? '<button type="button" class="annotation-button" data-annotate="' + escapeHtml(item.id) + '">' + (item.annotation ? 'Modifier' : 'Annoter') + '</button>' : ''}</div></td>
    </tr>`;
  }).join('');
  recordsBody.querySelectorAll('[data-annotate]').forEach((button) => button.addEventListener('click', () => openAnnotation(button.dataset.annotate)));
  recordsBody.querySelectorAll('[data-open-pdf]').forEach((button) => button.addEventListener('click', () => openSurveyPdf(button.dataset.openPdf)));
  renderDashboard();
  if (!document.querySelector('#summaryView').hidden) renderStatistics();
  if (!document.querySelector('#reportsView').hidden) renderMonthlyReport();
}

async function openSurveyPdf(recordId) {
  const viewer = window.open('about:blank', '_blank');
  if (!viewer) { showToast('Autorisez les fenêtres contextuelles pour ouvrir le PDF.'); return; }
  try {
    const response = await fetch(`/api/files/${encodeURIComponent(recordId)}`, {
      headers: { Authorization: `Bearer ${supabaseSession.access_token}` },
    });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new Error(result.error || 'PDF inaccessible pour ce compte.');
    }
    const objectUrl = URL.createObjectURL(await response.blob());
    viewer.location.href = objectUrl;
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
  } catch (error) {
    viewer.close();
    showToast(error.message || 'Impossible d’ouvrir le PDF.');
  }
}

function openAnnotation(recordId) {
  if (currentProfile?.role !== 'supervisor') {
    showToast('Seul le superviseur peut annoter une enquête.');
    return;
  }
  const record = appState.records.find((item) => item.id === recordId);
  if (!record) return;
  const form = document.querySelector('#annotationForm');
  form.elements.pdf_key.value = record.id;
  form.elements.annotation.value = record.annotation || '';
  form.elements.reprise_requise.checked = Boolean(record.repriseRequired);
  document.querySelector('#annotationSurveyName').textContent = `${record.producer || 'Planteur inconnu'} · ${record.agent || 'Agent inconnu'} · ${record.code || 'Code non trouvé'}`;
  document.querySelector('#annotationError').textContent = '';
  document.querySelector('#annotationDialog').showModal();
}

document.querySelector('#annotationForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (currentProfile?.role !== 'supervisor') {
    document.querySelector('#annotationError').textContent = 'Seul le superviseur peut enregistrer une annotation.';
    return;
  }
  const form = event.currentTarget;
  const saveButton = document.querySelector('#saveAnnotation');
  const errorBox = document.querySelector('#annotationError');
  const pdfKey = form.elements.pdf_key.value;
  const annotation = form.elements.annotation.value.trim();
  const repriseRequired = form.elements.reprise_requise.checked;
  if (!annotation) {
    errorBox.textContent = 'Saisissez le motif ou la consigne à transmettre à l’agent.';
    return;
  }
  saveButton.disabled = true;
  errorBox.textContent = '';
  try {
    const payload = {
      pdf_key: pdfKey,
      zone: appState.records.find((record) => record.id === pdfKey)?.zone || '',
      annotation,
      reprise_requise: repriseRequired,
      annotateur: agentDisplayName(supabaseSession?.user),
      updated_at: new Date().toISOString(),
    };
    await supabaseFetch('annotations_enquetes?on_conflict=pdf_key', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify([payload]),
    });
    const target = appState.records.find((record) => record.id === pdfKey);
    if (target) Object.assign(target, annotationFields(payload));
    document.querySelector('#annotationDialog').close();
    render();
    showToast(repriseRequired ? 'Reprise demandée et annotation enregistrée.' : 'Annotation enregistrée.');
  } catch (error) {
    errorBox.textContent = error.message || "Impossible d enregistrer cette annotation dans Supabase.";
  } finally {
    saveButton.disabled = false;
  }
});
document.querySelector('#closeAnnotation').addEventListener('click', () => document.querySelector('#annotationDialog').close());
document.querySelector('#cancelAnnotation').addEventListener('click', () => document.querySelector('#annotationDialog').close());

function renderDashboard() {
  const zoneSelect = document.querySelector('#dashboardZone');
  const selectedZone = zoneSelect.value;
  zoneSelect.innerHTML = '<option value="">Toutes les zones</option>' + appState.zones.map((zone) => `<option value="${escapeHtml(zone)}">${escapeHtml(zone)}</option>`).join('');
  if (appState.zones.includes(selectedZone)) zoneSelect.value = selectedZone;
  const yearSelect = document.querySelector('#dashboardYear');
  const selectedYear = yearSelect.value;
  const availableYears = [...new Set((appState.records || []).map((record) => record.date?.slice(0, 4)).filter((year) => /^\d{4}$/.test(year || '')))];
  const fallbackYear = String(new Date().getFullYear());
  if (!availableYears.includes(fallbackYear)) availableYears.push(fallbackYear);
  availableYears.sort((a, b) => b.localeCompare(a));
  yearSelect.innerHTML = availableYears.map((year) => `<option value="${year}">${year}</option>`).join('');
  yearSelect.value = availableYears.includes(selectedYear) ? selectedYear : availableYears[0];
  const from = document.querySelector('#dashboardFrom').value;
  const to = document.querySelector('#dashboardTo').value;
  const filtered = appState.records.filter((record) =>
    (!zoneSelect.value || record.zone === zoneSelect.value) &&
    (!from || record.date >= from) && (!to || record.date <= to));
  const conforming = filtered.filter((record) => record.status === 'Conforme').length;
  const nonConforming = filtered.filter((record) => record.status === 'Non conforme').length;
  const knownStatuses = conforming + nonConforming;
  document.querySelector('#dashboardTotal').textContent = filtered.length;
  document.querySelector('#dashboardConforming').textContent = conforming;
  document.querySelector('#dashboardNonConforming').textContent = nonConforming;
  document.querySelector('#dashboardRate').textContent = `${knownStatuses ? (conforming / knownStatuses * 100).toFixed(1).replace('.', ',') : '0'} %`;

  const year = yearSelect.value;
  const annualRecords = appState.records.filter((record) =>
    (!zoneSelect.value || record.zone === zoneSelect.value) && record.date?.startsWith(year + '-'));
  const monthly = Array.from({ length: 12 }, (_, index) => ({
    month: index,
    count: annualRecords.filter((record) => Number(record.date.slice(5, 7)) === index + 1).length,
  }));
  const maxMonthly = Math.max(1, ...monthly.map(({ count }) => count));
  const chartWidth = 760;
  const chartHeight = 260;
  const left = 42;
  const right = 12;
  const top = 28;
  const bottom = 214;
  const plotWidth = chartWidth - left - right;
  const plotHeight = bottom - top;
  const points = monthly.map(({ count }, index) => ({
    x: left + index * plotWidth / 11,
    y: bottom - count / maxMonthly * plotHeight,
    count,
  }));
  const curve = points.slice(1).reduce((path, point, index) => {
    const previous = points[index];
    const middle = (previous.x + point.x) / 2;
    return path + ' C ' + middle + ' ' + previous.y + ', ' + middle + ' ' + point.y + ', ' + point.x + ' ' + point.y;
  }, 'M ' + points[0].x + ' ' + points[0].y);
  const monthLabels = monthly.map(({ month }, index) => {
    const label = new Intl.DateTimeFormat('fr-FR', { month: 'short' }).format(new Date(2020, month, 1));
    return '<text class="line-chart-month" x="' + points[index].x + '" y="244" text-anchor="middle">' + escapeHtml(label.replace('.', '')) + '</text>';
  }).join('');
  const gridLines = [0, 1, 2, 3].map((step) => {
    const y = top + step * plotHeight / 3;
    const value = Math.round(maxMonthly * (3 - step) / 3);
    return '<line class="line-chart-grid" x1="' + left + '" y1="' + y + '" x2="' + (chartWidth - right) + '" y2="' + y + '"/><text class="line-chart-axis" x="' + (left - 8) + '" y="' + (y + 4) + '" text-anchor="end">' + value + '</text>';
  }).join('');
  const dots = points.map((point, index) => {
    const label = new Intl.DateTimeFormat('fr-FR', { month: 'long' }).format(new Date(2020, index, 1));
    return '<circle class="line-chart-point" cx="' + point.x + '" cy="' + point.y + '" r="4"><title>' + escapeHtml(label) + ' : ' + point.count + ' enquête(s)</title></circle>';
  }).join('');
  document.querySelector('#dashboardMonthlyTitle').textContent = 'Enquêtes par mois — ' + year;
  document.querySelector('#dashboardMonthlyChart').innerHTML = '<svg class="annual-line-chart" viewBox="0 0 ' + chartWidth + ' ' + chartHeight + '" role="img" aria-label="Enquêtes mensuelles pour l’année ' + year + '">' + gridLines + '<path class="line-chart-path" d="' + curve + '"/>' + dots + monthLabels + '</svg>';
  const unknown = filtered.length - knownStatuses;
  const statusItems = [
    ['Conformes', conforming, 'good'],
    ['Non conformes', nonConforming, 'bad'],
    ['À vérifier / sans statut', unknown, 'neutral'],
  ];
  const maxStatus = Math.max(1, ...statusItems.map(([, count]) => count));
  document.querySelector('#dashboardStatusChart').innerHTML = statusItems.map(([label, count, style]) =>
    `<div class="status-item"><div><span>${label}</span><strong>${count}</strong></div><div class="status-track"><i class="${style}" style="width:${Math.round(count / maxStatus * 100)}%"></i></div></div>`).join('');
}

function renderStatistics() {
  const agentInput = document.querySelector('#statisticsAgent');
  const query = agentInput.value.trim();
  document.querySelector('#statisticsAgentsList').innerHTML = appState.agents
    .map((agent) => `<option value="${escapeHtml(agent)}"></option>`).join('');
  const selectedAgent = appState.agents.find((agent) => agent.toLocaleLowerCase('fr') === query.toLocaleLowerCase('fr')) || '';
  const filtered = selectedAgent ? appState.records.filter((record) => record.agent === selectedAgent) : [];
  const indexed = filtered.filter((record) => Array.isArray(record.answers) && record.answers.length);
  const allCloudRows = (appState.statisticsRows || []).filter((row) => row.agent === selectedAgent);
  const ownCloudRows = allCloudRows.filter((row) => row.source_id === appState.statisticsSourceId);
  const cloudRows = ownCloudRows.length ? ownCloudRows : allCloudRows;
  const missing = cloudRows.length ? 0 : filtered.length - indexed.length;
  document.querySelector('#statisticsCount').textContent = `${filtered.length} enquête${filtered.length > 1 ? 's' : ''}`;
  const notice = document.querySelector('#statisticsNotice');
  if (!query) notice.textContent = 'Recherchez puis choisissez un agent pour afficher uniquement son résumé.';
  else if (!selectedAgent) notice.textContent = 'Choisissez le nom exact d’un agent dans les suggestions.';
  else if (missing) notice.textContent = `${missing} PDF de cet agent ne contiennent aucune réponse exploitable.`;
  else notice.textContent = '';
  const content = document.querySelector('#statisticsContent');
  if (!selectedAgent) {
    content.innerHTML = '<div class="empty visible"><strong>Aucun agent sélectionné</strong><span>Le résumé de l’agent choisi apparaîtra ici.</span></div>';
    return;
  }
  const groupedByAgent = new Map();
  if (cloudRows.length) {
    const agentGroup = { total: filtered.length, questions: new Map() };
    for (const row of cloudRows) {
      const questionKey = JSON.stringify([row.question_ref, row.question]);
      const question = agentGroup.questions.get(questionKey) || { ref: row.question_ref, question: row.question, answers: new Map(), total: 0 };
      const label = row.reponse || '(sans réponse)';
      const count = Number(row.nombre) || 0;
      question.answers.set(label, (question.answers.get(label) || 0) + count);
      question.total += count;
      agentGroup.questions.set(questionKey, question);
    }
    groupedByAgent.set(selectedAgent, agentGroup);
  } else {
    for (const record of indexed) {
      const agentLabel = record.agent || 'Agent inconnu';
      const agentGroup = groupedByAgent.get(agentLabel) || { total: 0, questions: new Map() };
      agentGroup.total += 1;
      for (const answer of record.answers) {
        const questionKey = JSON.stringify([answer.ref, answer.question]);
        const question = agentGroup.questions.get(questionKey) || { ref: answer.ref, question: answer.question, answers: new Map(), total: 0 };
        const label = answer.response || '(sans réponse)';
        question.answers.set(label, (question.answers.get(label) || 0) + 1);
        question.total += 1;
        agentGroup.questions.set(questionKey, question);
      }
      groupedByAgent.set(agentLabel, agentGroup);
    }
  }
  if (!groupedByAgent.size) {
    content.innerHTML = '<div class="empty visible"><strong>Aucune réponse détaillée à afficher</strong><span>Les PDF de cet agent sont vides, scannés comme image ou dans un format non reconnu.</span></div>';
    return;
  }
  const group = groupedByAgent.get(selectedAgent);
  const questionCards = [...group.questions.values()].sort((a, b) => Number(a.ref) - Number(b.ref)).map((question) => {
    const responses = [...question.answers].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'fr'));
    return `<article class="question-stat"><div class="question-stat-head"><span>Q${escapeHtml(question.ref)}</span><strong>${escapeHtml(question.question)}</strong><small>${question.total} réponse${question.total > 1 ? 's' : ''}</small></div><div class="answer-list">${responses.map(([label, count]) => {
      const percent = question.total ? Math.round(count / question.total * 100) : 0;
      return `<div class="answer-row"><div><span>${escapeHtml(label)}</span><strong>${count} · ${percent}%</strong></div><div class="answer-track"><i style="width:${percent}%"></i></div></div>`;
    }).join('')}</div></article>`;
  }).join('');
  content.innerHTML = `<div class="selected-agent-summary"><strong>${escapeHtml(selectedAgent)}</strong><span>${group.total} enquête${group.total > 1 ? 's' : ''} analysée${group.total > 1 ? 's' : ''}</span></div><div class="question-stats">${questionCards}</div>`;
}

function renderMonthlyReport() {
  const monthSelect = document.querySelector('#reportMonth');
  const yearSelect = document.querySelector('#reportYear');
  if (!monthSelect || !yearSelect) return;

  const datedRecords = (appState.records || []).filter((record) => /^\d{4}-\d{2}-\d{2}/.test(record.date || ''));
  const latestDate = datedRecords.map((record) => record.date).sort().at(-1) || new Date().toISOString().slice(0, 10);
  const previousMonth = monthSelect.value;
  const previousYear = yearSelect.value;
  monthSelect.innerHTML = Array.from({ length: 12 }, (_, index) => {
    const value = String(index + 1).padStart(2, '0');
    const label = new Intl.DateTimeFormat('fr-FR', { month: 'long' }).format(new Date(2020, index, 1));
    return `<option value="${value}">${label.charAt(0).toLocaleUpperCase('fr') + label.slice(1)}</option>`;
  }).join('');

  const years = [...new Set([...datedRecords.map((record) => record.date.slice(0, 4)), String(new Date().getFullYear())])].sort((a, b) => b.localeCompare(a));
  yearSelect.innerHTML = years.map((year) => `<option value="${year}">${year}</option>`).join('');
  monthSelect.value = /^\d{2}$/.test(previousMonth) ? previousMonth : latestDate.slice(5, 7);
  yearSelect.value = years.includes(previousYear) ? previousYear : latestDate.slice(0, 4);

  const periodPrefix = `${yearSelect.value}-${monthSelect.value}`;
  const selectedMonthLabel = new Intl.DateTimeFormat('fr-FR', { month: 'long' }).format(new Date(Number(yearSelect.value), Number(monthSelect.value) - 1, 1));
  const periodLabel = `${selectedMonthLabel.charAt(0).toLocaleUpperCase('fr') + selectedMonthLabel.slice(1)} ${yearSelect.value}`;
  document.querySelector('#reportPeriodLabel').textContent = `Période : ${periodLabel}`;
  document.querySelector('#reportPrintPeriod').textContent = `Période : ${periodLabel}`;
  const records = datedRecords.filter((record) => record.date.startsWith(periodPrefix));
  const conforming = records.filter((record) => record.status === 'Conforme').length;
  const nonConforming = records.filter((record) => record.status === 'Non conforme').length;
  const toCheck = records.length - conforming - nonConforming;
  const knownStatuses = conforming + nonConforming;
  document.querySelector('#monthlyReportCount').textContent = `${records.length} enquête${records.length > 1 ? 's' : ''}`;
  document.querySelector('#reportTotal').textContent = records.length;
  document.querySelector('#reportConforming').textContent = conforming;
  document.querySelector('#reportNonConforming').textContent = nonConforming;
  document.querySelector('#reportRate').textContent = `${knownStatuses ? (conforming / knownStatuses * 100).toFixed(1).replace('.', ',') : '0'} %`;
  const rateLabel = `${knownStatuses ? (conforming / knownStatuses * 100).toFixed(1).replace('.', ',') : '0'} %`;
  const monthWord = records.length > 1 ? 'enquêtes' : 'enquête';
  document.querySelector('#reportPrintSummary').textContent = records.length
    ? `Au cours du mois de ${periodLabel}, ${records.length} ${monthWord} ont été enregistrées : ${conforming} conforme(s), ${nonConforming} non conforme(s) et ${toCheck} à vérifier.`
    : `Aucune enquête n’a été enregistrée au cours du mois de ${periodLabel}.`;
  document.querySelector('#reportPrintGeneratedAt').textContent = `Édité le ${new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long' }).format(new Date())}`;
  const comment = document.querySelector('#reportComment').value.trim();
  document.querySelector('#reportPrintComment').textContent = comment || 'Aucun commentaire ajouté.';

  const groups = new Map();
  for (const record of records) {
    const agent = record.agent || 'Agent non renseigné';
    const group = groups.get(agent) || { agent, zones: new Set(), total: 0, conforming: 0, nonConforming: 0, toCheck: 0 };
    group.zones.add(record.zone || 'Zone non renseignée');
    group.total += 1;
    if (record.status === 'Conforme') group.conforming += 1;
    else if (record.status === 'Non conforme') group.nonConforming += 1;
    else group.toCheck += 1;
    groups.set(agent, group);
  }
  const knownRate = (group) => group.conforming + group.nonConforming ? group.conforming / (group.conforming + group.nonConforming) : 0;
  const zoneGroups = new Map();
  for (const record of records) {
    const zone = record.zone || 'Zone non renseignée';
    const group = zoneGroups.get(zone) || { zone, total: 0, conforming: 0, nonConforming: 0, toCheck: 0 };
    group.total += 1;
    if (record.status === 'Conforme') group.conforming += 1;
    else if (record.status === 'Non conforme') group.nonConforming += 1;
    else group.toCheck += 1;
    zoneGroups.set(zone, group);
  }
  const percent = (numerator, denominator) => denominator ? `${(numerator / denominator * 100).toFixed(1).replace('.', ',')} %` : '0 %';
  const zoneRows = [...zoneGroups.values()].sort((a, b) => b.total - a.total || a.zone.localeCompare(b.zone, 'fr'));
  const zoneHtml = zoneRows.length
    ? zoneRows.map((group) => `<tr><td>${escapeHtml(group.zone)}</td><td>${group.total}</td><td>${group.conforming}</td><td>${group.nonConforming}</td><td>${group.toCheck}</td><td>${percent(group.conforming, group.conforming + group.nonConforming)}</td></tr>`).join('')
    : '<tr><td colspan="6">Aucune enquête pour cette période.</td></tr>';
  document.querySelector('#reportZonesBody').innerHTML = zoneHtml;
  document.querySelector('#reportPrintZonesBody').innerHTML = zoneHtml;

  const groupedRows = [...groups.values()].sort((a, b) => b.total - a.total || knownRate(b) - knownRate(a) || a.agent.localeCompare(b.agent, 'fr'));
  const agentRows = groupedRows.length
    ? groupedRows.map((group, index) => `<tr><td>${index + 1}</td><td>${escapeHtml(group.agent)}</td><td>${escapeHtml([...group.zones].sort((a, b) => a.localeCompare(b, 'fr')).join(', '))}</td><td>${group.total}</td><td>${group.conforming}</td><td>${group.nonConforming}</td><td>${percent(group.conforming, group.conforming + group.nonConforming)}</td></tr>`).join('')
    : '<tr><td colspan="7">Aucune enquête pour cette période.</td></tr>';
  document.querySelector('#reportAgentsBody').innerHTML = agentRows;
  document.querySelector('#reportPrintAgentsBody').innerHTML = agentRows;

  const villageGroups = new Map();
  for (const record of records) {
    const zone = record.zone || 'Zone non renseignée';
    const agent = record.agent || 'Agent non renseigné';
    const village = String(record.village || '').trim() || 'Village non renseigné';
    const key = JSON.stringify([zone, village]);
    const group = villageGroups.get(key) || { zone, village, total: 0, conforming: 0, nonConforming: 0, agents: new Set() };
    group.total += 1;
    group.agents.add(agent);
    if (record.status === 'Conforme') group.conforming += 1;
    else if (record.status === 'Non conforme') group.nonConforming += 1;
    villageGroups.set(key, group);
  }
  const villageRows = [...villageGroups.values()].sort((a, b) => a.zone.localeCompare(b.zone, 'fr') || b.total - a.total || a.village.localeCompare(b.village, 'fr'));
  const villageHtml = villageRows.length
    ? villageRows.map((group) => `<tr><td>${escapeHtml(group.zone)}</td><td>${escapeHtml(group.village)}</td><td>${group.total}</td><td>${group.conforming}</td><td>${group.nonConforming}</td><td>${group.agents.size}</td></tr>`).join('')
    : '<tr><td colspan="6">Aucune enquête pour cette période.</td></tr>';
  document.querySelector('#reportVillagesBody').innerHTML = villageHtml;
  document.querySelector('#reportPrintVillagesBody').innerHTML = villageHtml;

  const monthlyStatistics = (appState.statisticsRows || []).filter((row) => String(row.date_enquete || '').startsWith(periodPrefix));
  const sourceStatistics = monthlyStatistics.filter((row) => row.source_id === appState.statisticsSourceId);
  const questionSourceRows = sourceStatistics.length ? sourceStatistics : monthlyStatistics;
  const answerCounts = new Map();
  const addAnswer = (ref, question, response, count = 1) => {
    if (!ref || !response || !count) return;
    const key = JSON.stringify([String(ref), question || '', response]);
    const current = answerCounts.get(key) || { ref: String(ref), question: question || '', response, count: 0 };
    current.count += count;
    answerCounts.set(key, current);
  };
  for (const row of questionSourceRows) addAnswer(row.question_ref, row.question, row.reponse, Number(row.nombre) || 0);
  if (!answerCounts.size) {
    for (const record of records) for (const answer of record.answers || []) {
      addAnswer(answer.ref, answer.question, answer.response);
    }
  }
  const answersByQuestion = new Map();
  for (const answer of answerCounts.values()) {
    const key = JSON.stringify([answer.ref, answer.question]);
    const question = answersByQuestion.get(key) || { ref: answer.ref, question: answer.question, total: 0, responses: [] };
    question.total += answer.count;
    question.responses.push(answer);
    answersByQuestion.set(key, question);
  }
  const averageQuestionLabels = {
    '31': 'Revenu mensuel des travailleurs (FCFA)',
    '32': 'Temps de travail hebdomadaire moyen des travailleurs',
    '42': 'Revenu mensuel moyen du fermier (FCFA)',
    '43': 'Part du revenu mensuel générée par le caoutchouc',
  };
  for (const [ref, question] of Object.entries(averageQuestionLabels)) {
    if (![...answersByQuestion.values()].some((item) => item.ref === ref)) answersByQuestion.set(JSON.stringify([ref, question]), { ref, question, total: 0, responses: [] });
  }
  const questionGroups = [...answersByQuestion.values()].sort((a, b) => Number(a.ref) - Number(b.ref) || a.question.localeCompare(b.question, 'fr'));
  const averageQuestionUnits = { '31': 'FCFA / mois', '32': 'heures / semaine', '42': 'FCFA / mois', '43': '%' };
  const numericResponse = (value) => {
    const token = String(value || '').match(/-?\d[\d\s.,]*/)?.[0]?.replace(/[\s.,]/g, '');
    if (!token) return null;
    const number = Number(token);
    return Number.isFinite(number) ? number : null;
  };
  const displayAverage = (ref, value) => {
    if (ref === '31' || ref === '42') return Math.round(value).toLocaleString('fr-FR');
    return value.toFixed(1).replace('.', ',');
  };
  const answerHtml = questionGroups.length
    ? questionGroups.map((question) => {
      if (Object.hasOwn(averageQuestionUnits, question.ref)) {
        const values = question.responses.map((answer) => ({ value: numericResponse(answer.response), count: answer.count })).filter((item) => item.value !== null);
        const valueCount = values.reduce((sum, item) => sum + item.count, 0);
        const total = values.reduce((sum, item) => sum + item.value * item.count, 0);
        const averageText = valueCount
          ? `Moyenne : ${displayAverage(question.ref, total / valueCount)} ${averageQuestionUnits[question.ref]} (sur ${valueCount} réponse${valueCount > 1 ? 's' : ''})`
          : 'Moyenne indisponible : aucune valeur numérique lisible.';
        return `<tr><td><strong>Q${escapeHtml(question.ref)}</strong> - ${escapeHtml(question.question)}</td><td>${averageText}</td></tr>`;
      }
      const responseSummary = question.responses.sort((a, b) => b.count - a.count || a.response.localeCompare(b.response, 'fr'))
        .map((answer) => `${escapeHtml(answer.response)} : ${answer.count} (${percent(answer.count, question.total)})`).join(' ; ');
      return `<tr><td><strong>Q${escapeHtml(question.ref)}</strong> - ${escapeHtml(question.question)}</td><td>${responseSummary}</td></tr>`;
    }).join('')
    : '<tr><td colspan="2">Réponses détaillées non disponibles pour ce mois.</td></tr>';
  document.querySelector('#reportAnswersBody').innerHTML = answerHtml;
  document.querySelector('#reportPrintAnswersBody').innerHTML = answerHtml;

}

let visibleProducers = [];
let editingProducerId = null;
const editProducerDialog = document.querySelector('#editProducerDialog');
const editProducerForm = document.querySelector('#editProducerForm');
const editProducerError = document.querySelector('#editProducerError');
const saveProducerEdit = document.querySelector('#saveProducerEdit');
const cancelProducerEdit = document.querySelector('#cancelProducerEdit');

document.querySelector('#producersBody').addEventListener('click', (event) => {
  const button = event.target.closest('[data-edit-producer]');
  if (!button) return;
  const producer = visibleProducers[Number(button.dataset.editProducer)];
  if (!producer?.id) {
    showToast('Redémarrez le serveur RubberWay, puis rouvrez l’onglet Producteurs pour modifier cette fiche.');
    return;
  }

  editingProducerId = producer.id;
  for (const field of ['code', 'name', 'contact', 'village']) {
    editProducerForm.elements.namedItem(field).value = producer[field] || '';
  }
  editProducerError.textContent = '';
  editProducerDialog.showModal();
});

cancelProducerEdit.addEventListener('click', () => editProducerDialog.close());
editProducerDialog.addEventListener('cancel', (event) => {
  if (saveProducerEdit.disabled) event.preventDefault();
});

editProducerForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!editingProducerId || saveProducerEdit.disabled) return;

  editProducerError.textContent = '';
  saveProducerEdit.disabled = true;
  cancelProducerEdit.disabled = true;
  saveProducerEdit.textContent = 'Enregistrement…';
  const fields = new FormData(editProducerForm);
  try {
    await adminRequest('PATCH', {
      id: editingProducerId,
      name: fields.get('name'),
      contact: fields.get('contact'),
      village: fields.get('village'),
    }, '/api/producers');
    editProducerDialog.close();
    showToast('Fiche du planteur enregistrée.');
    await loadProducers(producersPage);
  } catch (error) {
    editProducerError.textContent = error.message;
  } finally {
    saveProducerEdit.disabled = false;
    cancelProducerEdit.disabled = false;
    saveProducerEdit.textContent = 'Enregistrer';
  }
});

async function loadProducers(page = 1) {
  const body = document.querySelector('#producersBody');
  const notice = document.querySelector('#producersNotice');
  const empty = document.querySelector('#producersEmpty');
  const previous = document.querySelector('#producersPrevious');
  const next = document.querySelector('#producersNext');
  notice.textContent = 'Chargement des producteurs…';
  previous.disabled = true;
  next.disabled = true;
  try {
    if (supabaseSession.expires_at && supabaseSession.expires_at < Math.floor(Date.now() / 1000) + 30) await refreshSession();
    const query = document.querySelector('#producersSearch').value.trim();
    const response = await fetch(`/api/producers?q=${encodeURIComponent(query)}&page=${page}`, {
      headers: { Authorization: `Bearer ${supabaseSession.access_token}` },
    });
    const result = await readResponse(response);
    producersPage = result.page;
    visibleProducers = result.items;
    body.innerHTML = visibleProducers.map((producer, index) => `
      <tr>
        <td class="agent-name">${escapeHtml(producer.code)}</td>
        <td>${escapeHtml(producer.name)}</td>
        <td>${escapeHtml(producer.contact)}</td>
        <td>${escapeHtml(producer.village)}</td>
        <td><button type="button" class="annotation-button" data-edit-producer="${index}" aria-label="Modifier la fiche de ${escapeHtml(producer.name || producer.code)}">Modifier</button></td>
      </tr>`).join('');
    empty.hidden = false;
    empty.classList.toggle('visible', result.items.length === 0);
    document.querySelector('#producersCount').textContent = `${result.total.toLocaleString('fr-FR')} producteur${result.total > 1 ? 's' : ''}`;
    document.querySelector('#producersPageLabel').textContent = `Page ${result.page} sur ${Math.max(1, Math.ceil(result.total / result.pageSize))}`;
    previous.disabled = result.page <= 1;
    next.disabled = result.page * result.pageSize >= result.total;
    notice.textContent = result.total
      ? `Affichage de ${Math.min(result.total, (result.page - 1) * result.pageSize + 1)} à ${Math.min(result.total, result.page * result.pageSize)} sur ${result.total.toLocaleString('fr-FR')} planteurs.`
      : '';
  } catch (error) {
    visibleProducers = [];
    body.innerHTML = '';
    empty.hidden = true;
    empty.classList.remove('visible');
    notice.textContent = error.message || 'Impossible de charger la base des producteurs.';
  }
}

function setMainTabState(tab, selected) {
  tab.classList.toggle('active', selected);
  if (selected) tab.setAttribute('aria-current', 'page');
  else tab.removeAttribute('aria-current');
}

document.querySelectorAll('.app-tab').forEach((button) => button.addEventListener('click', () => {
  document.querySelectorAll('.app-tab').forEach((tab) => setMainTabState(tab, tab === button));
  document.querySelectorAll('.app-view').forEach((view) => { view.hidden = view.id !== button.dataset.view; });
  if (button.dataset.view === 'summaryView') renderStatistics();
  if (button.dataset.view === 'reportsView') renderMonthlyReport();
  if (button.dataset.view === 'producersView') loadProducers(producersPage);
  if (button.dataset.view === 'settingsView') {
    activateSettingsPanel('settingsFolderPanel');
  }
}));

function activateSettingsPanel(panelId) {
  document.querySelectorAll('[data-settings-tab]').forEach((tab) => {
    const selected = tab.dataset.settingsTab === panelId;
    tab.classList.toggle('is-active', selected);
    tab.setAttribute('aria-selected', String(selected));
  });
  document.querySelectorAll('.settings-panel').forEach((panel) => { panel.hidden = panel.id !== panelId; });
  if (panelId === 'fieldAgentsPanel') loadFieldAgentAccounts();
  if (panelId === 'platformAccountsPanel') loadManagedAccounts();
}

document.querySelectorAll('[data-settings-tab]').forEach((tab) => tab.addEventListener('click', () => activateSettingsPanel(tab.dataset.settingsTab)));
document.querySelector('#producersSearch').addEventListener('input', () => {
  clearTimeout(producersSearchTimer);
  producersSearchTimer = setTimeout(() => loadProducers(1), 250);
});
document.querySelector('#clearProducersSearch').addEventListener('click', () => {
  document.querySelector('#producersSearch').value = '';
  loadProducers(1);
});
document.querySelector('#producersPrevious').addEventListener('click', () => loadProducers(Math.max(1, producersPage - 1)));
document.querySelector('#producersNext').addEventListener('click', () => loadProducers(producersPage + 1));
document.querySelector('#statisticsAgent').addEventListener('input', renderStatistics);
document.querySelector('#statisticsAgent').addEventListener('change', renderStatistics);
document.querySelector('#reportMonth').addEventListener('change', renderMonthlyReport);
document.querySelector('#reportYear').addEventListener('change', renderMonthlyReport);
document.querySelector('#reportComment').addEventListener('input', (event) => {
  document.querySelector('#reportPrintComment').textContent = event.currentTarget.value.trim() || 'Aucun commentaire ajouté.';
});
document.querySelector('#generateMonthlyReportPdf').addEventListener('click', () => {
  renderMonthlyReport();
  const month = document.querySelector('#reportMonth').value;
  const year = document.querySelector('#reportYear').value;
  const monthLabel = new Intl.DateTimeFormat('fr-FR', { month: 'long' }).format(new Date(Number(year), Number(month) - 1, 1));
  const previousTitle = document.title;
  document.title = `Rapport_RDUE_${monthLabel}_${year}`;
  window.onafterprint = () => {
    document.title = previousTitle;
    window.onafterprint = null;
  };
  window.print();
});
document.querySelector('#clearStatistics').addEventListener('click', () => {
  document.querySelector('#statisticsAgent').value = '';
  renderStatistics();
});
['dashboardZone', 'dashboardYear', 'dashboardFrom', 'dashboardTo'].forEach((id) => {
  document.querySelector(`#${id}`).addEventListener('input', renderDashboard);
  document.querySelector(`#${id}`).addEventListener('change', renderDashboard);
});
document.querySelector('#clearDashboard').addEventListener('click', () => {
  ['dashboardZone', 'dashboardYear', 'dashboardFrom', 'dashboardTo'].forEach((id) => { document.querySelector(`#${id}`).value = ''; });
  renderDashboard();
});

function updateFolderPreview() {
  if (supabaseConfig?.cloudStorage) {
    document.querySelector('#folderPreview').textContent = 'Enquête et PDF archivés de façon sécurisée dans Supabase Storage.';
    return;
  }
  const zone = form.elements.zone.value.trim() || 'Zone';
  const agent = form.elements.agent.value.trim() || 'Agent';
  const date = form.elements.date.value || new Date().toISOString().slice(0, 10);
  const year = date.slice(0, 4);
  const code = form.elements.code.value.trim();
  const producer = form.elements.producer.value.trim();
  const filename = [date, code, producer].filter(Boolean).join('_') || 'enquete';
  document.querySelector('#folderPreview').textContent = `${zone} / ${agent} / ${year} / ${filename}.pdf`;
}

function openDialog() {
  form.reset();
  const currentAgent = agentDisplayName(supabaseSession?.user);
  form.elements.agent.value = currentAgent.includes('@') ? '' : currentAgent;
  form.elements.date.value = new Date().toISOString().slice(0, 10);
  document.querySelector('#formError').textContent = '';
  updateFolderPreview();
  dialog.showModal();
}

document.querySelector('#openUpload').addEventListener('click', openDialog);
document.querySelector('#emptyUpload').addEventListener('click', openDialog);
document.querySelector('#chooseFolder').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  const originalText = button.textContent;
  button.textContent = 'Sélection du dossier…';
  try {
    const response = await fetch('/api/select-folder', { method: 'POST' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Impossible de choisir le dossier.');
    if (result.cancelled) {
      showToast('Aucun dossier sélectionné.');
    } else {
      await loadState();
      showToast('Dossier chargé : ' + result.folder);
    }
  } catch (error) {
    showToast(error.message || 'Impossible de choisir le dossier.');
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
});
document.querySelector('#closeDialog').addEventListener('click', () => dialog.close());
document.querySelector('#cancelUpload').addEventListener('click', () => dialog.close());
document.querySelector('#clearFilters').addEventListener('click', () => {
  document.querySelector('#searchInput').value = '';
  document.querySelector('#zoneFilter').value = '';
  document.querySelector('#agentFilter').value = '';
  document.querySelector('#statusFilter').value = '';
  document.querySelector('#fromFilter').value = '';
  document.querySelector('#toFilter').value = '';
  render();
});
document.querySelector('#showDuplicates').addEventListener('click', () => {
  document.querySelector('#statusFilter').value = '__duplicates';
  render();
});
['searchInput', 'zoneFilter', 'agentFilter', 'statusFilter', 'fromFilter', 'toFilter'].forEach((id) => {
  document.querySelector(`#${id}`).addEventListener('input', render);
  document.querySelector(`#${id}`).addEventListener('change', render);
});
['agent', 'zone', 'date', 'code', 'producer'].forEach((field) => form.elements[field].addEventListener('input', updateFolderPreview));

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const errorBox = document.querySelector('#formError');
  const saveButton = document.querySelector('#saveButton');
  const data = new FormData(form);
  const file = data.get('file');
  if (!file || !file.name.toLowerCase().endsWith('.pdf')) {
    errorBox.textContent = 'Choisissez un fichier PDF.';
    return;
  }
  if (file.size > 40 * 1024 * 1024) {
    errorBox.textContent = 'Le PDF dépasse la limite de 40 Mo.';
    return;
  }

  saveButton.disabled = true;
  saveButton.textContent = 'Enregistrement…';
  errorBox.textContent = '';
  try {
    let result;
    const metadata = Object.fromEntries(['agent', 'date', 'code', 'producer', 'village', 'zone', 'status', 'criteria'].map((key) => [key, data.get(key) || '']));
    metadata.filename = file.name;
    if (supabaseConfig?.cloudStorage) {
      if (supabaseSession.expires_at && supabaseSession.expires_at < Math.floor(Date.now() / 1000) + 30) await refreshSession();
      const preparedResponse = await fetch('/api/upload-url', {
        method: 'POST', headers: { Authorization: `Bearer ${supabaseSession.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(metadata),
      });
      const prepared = await readResponse(preparedResponse);
      const signedUpload = new URL(prepared.uploadUrl);
      signedUpload.searchParams.set('token', prepared.token);
      const uploadResponse = await fetch(signedUpload, {
        method: 'PUT', headers: { 'Content-Type': 'application/pdf', 'x-upsert': 'false' }, body: file,
      });
      if (!uploadResponse.ok) throw new Error('Envoi du PDF dans Supabase Storage impossible. Vérifiez le bucket et sa limite de taille.');
      const completeResponse = await fetch('/api/complete-upload', {
        method: 'POST', headers: { Authorization: `Bearer ${supabaseSession.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...metadata, id: prepared.id, path: prepared.path }),
      });
      result = await readResponse(completeResponse);
    } else {
      const parameters = new URLSearchParams(metadata);
      const response = await fetch(`/api/upload?${parameters.toString()}`, { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: file });
      result = await readResponse(response);
    }
    dialog.close();
    await loadState();
    showToast(`Enquête archivée pour ${result.record.agent}.`);
  } catch (error) {
    errorBox.textContent = error.message || 'Une erreur est survenue.';
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = 'Enregistrer le PDF';
  }
});

async function initialize() {
  try {
    if (window.location.protocol === 'file:') {
      throw new Error('Ouvrez DEMARRER.bat pour lancer l’application avec son serveur local. N’ouvrez pas index.html directement.');
    }
    const response = await fetch('/api/config');
    supabaseConfig = await response.json();
    if (supabaseConfig.cloudStorage) {
      const loginNote = document.querySelector('#loginView small');
      if (loginNote) loginNote.textContent = 'Les enquêtes et leurs PDF sont stockés de façon sécurisée dans Supabase.';
      const loadingMessage = document.querySelector('#loadingMessage');
      if (loadingMessage) loadingMessage.textContent = 'Lecture des enquêtes stockées en ligne.';
    }
    const stored = localStorage.getItem(SESSION_KEY);
    if (!stored) return;
    supabaseSession = JSON.parse(stored);
    if (!supabaseConfig.supabaseUrl || !supabaseConfig.supabaseAnonKey) {
      localStorage.removeItem(SESSION_KEY);
      supabaseSession = null;
      return;
    }
    if (supabaseSession.expires_at && supabaseSession.expires_at < Math.floor(Date.now() / 1000) + 30) await refreshSession();
    await loadUserProfile();
    showApplication();
    try {
      await loadState();
    } catch (loadError) {
      document.querySelector('#loadingMessage').hidden = true;
      showToast(`Connecté, mais chargement des données impossible : ${loadError.message}`);
    }
    if (!supabaseConfig.cloudStorage && !appState.sourceDirectoryFound) showToast(`Dossier « Enquête RDUE » introuvable : ${appState.archiveDirectory}`);
  } catch (error) {
    localStorage.removeItem(SESSION_KEY);
    supabaseSession = null;
    document.querySelector('#loginView').hidden = false;
    document.querySelector('#appShell').hidden = true;
    document.querySelector('#loginError').textContent = `Connexion ou chargement Supabase impossible : ${error.message}`;
  }
}
initialize();
