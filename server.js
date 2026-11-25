import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { answersFromPdfText, conformityFromPdfText, extractPdfText } from './pdf_reader.js';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4177);
function readLocalEnv(name) {
  if (process.env[name]) return process.env[name];
  try {
    const line = fs.readFileSync(path.join(APP_DIR, '.env'), 'utf8').split(/\r?\n/)
      .find((entry) => entry.trim().startsWith(`${name}=`));
    return line ? line.slice(line.indexOf('=') + 1).trim().replace(/^['"]|['"]$/g, '') : '';
  } catch { return ''; }
}
const SUPABASE_URL = readLocalEnv('SUPABASE_URL').replace(/\/$/, '');
const SUPABASE_ANON_KEY = readLocalEnv('SUPABASE_ANON_KEY');
const SUPABASE_SERVICE_ROLE_KEY = readLocalEnv('SUPABASE_SERVICE_ROLE_KEY');
const SUPERVISOR_EMAIL = readLocalEnv('RUBBERWAY_SUPERVISOR_EMAIL').toLocaleLowerCase('fr');
const APP_MODULES = ['dashboard', 'archives', 'summary', 'reports'];
const FIELD_AGENT_DEFAULT_PASSWORD = '123456';
const ARCHIVE_DIR = path.resolve(
  process.env.RUBBERWAY_ARCHIVE_DIR ||
    path.join(os.homedir(), 'Documents', 'RubberWay_Archives'),
);
const INDEX_PATH = path.join(ARCHIVE_DIR, '.rubberway-index.json');
const FOLDER_SETTINGS_PATH = path.join(ARCHIVE_DIR, '.rubberway-folder.json');
const PDF_CACHE_PATH = path.join(ARCHIVE_DIR, '.rubberway-pdf-cache.json');
const PRODUCERS_DATABASE_PATH = path.join(APP_DIR, 'data', 'producteurs.csv');
const MAX_FILE_SIZE = 40 * 1024 * 1024;
const STORAGE_BUCKET = readLocalEnv('RUBBERWAY_STORAGE_BUCKET') || 'rubberway-enquetes';
const CLOUD_MODE = process.env.VERCEL === '1';
const execFileAsync = promisify(execFile);

if (!CLOUD_MODE) fs.mkdirSync(ARCHIVE_DIR, { recursive: true });

function readSavedSurveyFolder() {
  try {
    return JSON.parse(fs.readFileSync(FOLDER_SETTINGS_PATH, 'utf8')).surveyDirectory;
  } catch {
    return '';
  }
}

const configuredSurveyDirectory = path.resolve(
  process.env.RUBBERWAY_SURVEY_DIR ||
    readSavedSurveyFolder() ||
    path.join(os.homedir(), 'Desktop', 'ENQUÊTE RDUE'),
);
const nestedRdueDirectory = path.join(configuredSurveyDirectory, 'RDUE');
let surveyDirectory = configuredSurveyDirectory.toLocaleLowerCase('fr') !== nestedRdueDirectory.toLocaleLowerCase('fr') &&
  fs.existsSync(nestedRdueDirectory) && fs.statSync(nestedRdueDirectory).isDirectory()
  ? nestedRdueDirectory
  : configuredSurveyDirectory;
if (surveyDirectory !== configuredSurveyDirectory && !process.env.RUBBERWAY_SURVEY_DIR) {
  fs.writeFileSync(FOLDER_SETTINGS_PATH, JSON.stringify({ surveyDirectory }, null, 2), 'utf8');
}

function readRecords() {
  try {
    const parsed = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

let records = readRecords();
function readPdfCache() {
  try {
    const parsed = JSON.parse(fs.readFileSync(PDF_CACHE_PATH, 'utf8'));
    return new Map(Array.isArray(parsed) ? parsed : []);
  } catch { return new Map(); }
}
const pdfCache = readPdfCache();
let pdfCacheDirty = false;
const sourceFilePaths = new Map();
const sourceRecordMetadata = new Map();

function savePdfCache() {
  if (!pdfCacheDirty) return;
  try {
    const temporaryPath = `${PDF_CACHE_PATH}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify([...pdfCache.entries()]), 'utf8');
    fs.renameSync(temporaryPath, PDF_CACHE_PATH);
    pdfCacheDirty = false;
  } catch (error) {
    console.warn(`Le cache des PDF n'a pas pu être enregistré : ${error.message}`);
  }
}

function saveRecords() {
  const temporaryPath = `${INDEX_PATH}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(records, null, 2), 'utf8');
  fs.renameSync(temporaryPath, INDEX_PATH);
}

function cleanName(value, fallback = 'Sans_nom') {
  const cleaned = String(value || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/[^\p{L}\p{N}_.\s-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
    .slice(0, 90);
  return cleaned || fallback;
}

function cleanFilenamePart(value) {
  return cleanName(value, '').replace(/\s+/g, '_');
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(value));
}

function getBody(request, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    request.on('data', (chunk) => {
      total += chunk.length;
      if (total > limit) {
        reject(new Error('La requête dépasse la taille autorisée.'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function bearerToken(request) {
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.authorization || '');
  return match?.[1] || '';
}

async function supabaseAdminRequest(endpoint, options = {}) {
  if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error('Ajoutez SUPABASE_SERVICE_ROLE_KEY au fichier .env pour gérer les comptes.');
  const response = await fetch(`${SUPABASE_URL}/${endpoint}`, {
    ...options,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.msg || body.message || body.error_description || body.error || `Supabase a répondu ${response.status}.`);
    error.supabaseCode = body.code;
    throw error;
  }
  return body;
}

async function storageAdminRequest(endpoint, options = {}) {
  if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error('La cl\u00e9 serveur Supabase est absente de la configuration Vercel.');
  const response = await fetch(`${SUPABASE_URL}/storage/v1/${endpoint}`, {
    ...options,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || body.error || `Supabase Storage a r\u00e9pondu ${response.status}.`);
  return body;
}

function encodeStoragePath(value) {
  return String(value || '').split('/').map(encodeURIComponent).join('/');
}

async function cloudProducerRows() {
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await supabaseAdminRequest(`rest/v1/producteurs?select=code_phi,nom,contact,village&order=nom.asc&limit=1000&offset=${offset}`);
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
}

async function cloudSurveyRows() {
  const rows = [];
  const columns = 'pdf_key,zone,agent,code_phi,nom_planteur,village,statut,date_enquete,pdf_path,nom_fichier,taille_pdf,criteres,reponses';
  for (let offset = 0; ; offset += 1000) {
    const page = await supabaseAdminRequest(`rest/v1/enquetes?select=${columns}&order=date_enquete.desc&limit=1000&offset=${offset}`);
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
}

async function authenticatedUser(request) {
  const token = bearerToken(request);
  if (!token) return null;
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
  });
  if (!response.ok) return null;
  return response.json();
}

async function profileForUser(user, token) {
  const profileFilter = `user_id=eq.${encodeURIComponent(user.id)}`;
  // L'ouverture de session web ne dépend pas des champs de section, réservés aux agents mobiles.
  const profilePath = `rest/v1/user_profiles?${profileFilter}&select=user_id,email,display_name,title,role,permissions,zones`;
  if (SUPERVISOR_EMAIL && user.email?.toLocaleLowerCase('fr') === SUPERVISOR_EMAIL) {
    await supabaseAdminRequest('rest/v1/user_profiles?on_conflict=user_id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify([{ user_id: user.id, email: user.email, display_name: user.user_metadata?.full_name || user.email, role: 'supervisor', permissions: APP_MODULES, zones: [] }]),
    });
  }
  let rows;
  if (SUPABASE_SERVICE_ROLE_KEY) {
    rows = await supabaseAdminRequest(profilePath);
  } else {
    const headers = { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` };
    const response = await fetch(`${SUPABASE_URL}/${profilePath}`, { headers });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.message || 'Exécutez supabase-schema.sql pour créer les profils et les droits.');
    }
    rows = await response.json().catch(() => []);
  }
  return Array.isArray(rows) && rows[0]
    ? rows[0]
    : { user_id: user.id, email: user.email || '', display_name: user.user_metadata?.full_name || user.email || '', title: 'Assistant', role: 'inconnu', permissions: [], zones: [] };
}

function canUseWebPlatform(profile) {
  return ['supervisor', 'responsable'].includes(profile?.role);
}

async function requireSupervisor(request, response) {
  const user = await authenticatedUser(request);
  if (!user) {
    sendJson(response, 401, { error: 'Session expirée. Reconnectez-vous.' });
    return null;
  }
  if (!SUPABASE_SERVICE_ROLE_KEY) {
    sendJson(response, 503, { error: 'Ajoutez SUPABASE_SERVICE_ROLE_KEY dans .env pour activer la gestion des comptes.' });
    return null;
  }
  const profile = await profileForUser(user, bearerToken(request));
  if (profile.role !== 'supervisor') {
    sendJson(response, 403, { error: 'Accès réservé au superviseur.' });
    return null;
  }
  return user;
}

function cleanPermissions(value) {
  return Array.isArray(value) ? [...new Set(value.filter((permission) => APP_MODULES.includes(permission)))] : [];
}

const RESPONSIBLE_TITLES = ['Chef de secteur', 'Chef de département', 'Assistant'];
function cleanResponsibleTitle(value) {
  return RESPONSIBLE_TITLES.includes(value) ? value : 'Assistant';
}

function cleanZoneAssignments(value) {
  return Array.isArray(value)
    ? [...new Set(value.map((zone) => String(zone || '').trim()).filter(Boolean))]
    : [];
}

function fieldAgentNameParts(name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .split(/\s+/)
    .map((part) => part.replace(/[^a-z0-9]/gi, ''))
    .filter(Boolean)
}

function fieldAgentLoginIdentifiers(names) {
  const parts = names.map(fieldAgentNameParts);
  const includedParts = parts.map((tokens) => Math.min(2, tokens.length));
  const disambiguators = names.map(() => '');

  for (let pass = 0; pass <= Math.max(0, ...parts.map((tokens) => tokens.length)); pass += 1) {
    const groups = new Map();
    parts.forEach((tokens, index) => {
      const base = `${tokens.slice(0, includedParts[index]).join('')}_RDUESOGB`;
      const key = base.toLocaleLowerCase('fr');
      const group = groups.get(key) || [];
      group.push(index);
      groups.set(key, group);
    });
    const duplicateGroups = [...groups.values()].filter((group) => group.length > 1);
    if (!duplicateGroups.length) {
      return parts.map((tokens, index) =>
        `${tokens.slice(0, includedParts[index]).join('')}${disambiguators[index]}_RDUESOGB`,
      );
    }
    for (const group of duplicateGroups) {
      const expandable = group.filter((index) => includedParts[index] < parts[index].length);
      if (expandable.length) {
        for (const index of expandable) includedParts[index] += 1;
      } else {
        group.forEach((index, position) => {
          if (position > 0) disambiguators[index] = String(position + 1);
        });
      }
    }
  }
  return parts.map((tokens, index) =>
    `${tokens.slice(0, includedParts[index]).join('')}${disambiguators[index]}_RDUESOGB`,
  );
}

function fieldAgentAuthEmail(loginIdentifier) {
  const encoded = Buffer.from(String(loginIdentifier || '').toLocaleLowerCase('fr'), 'utf8').toString('base64url');
  return `agent.${encoded}@agents.rubberway.invalid`;
}

function normalizeZone(value) {
  return String(value || '').trim().toLocaleLowerCase('fr');
}

function cleanVillageAssignments(value, knownVillages = null) {
  const values = Array.isArray(value)
    ? [...new Map(value.map((village) => [normalizeSearch(village), String(village || '').trim()]).filter(([key, village]) => key && village)).values()]
    : [];
  if (!knownVillages) return values;
  const known = new Map(knownVillages.map((village) => [normalizeSearch(village), village]));
  return values.map((village) => known.get(normalizeSearch(village))).filter(Boolean);
}

function normalizeSearch(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('fr').trim();
}

function parseSemicolonCsv(contents) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let rowStart = 0;
  function finishRow(end) {
    row.push(field.trim());
    if (row.some(Boolean)) {
      const rowEnd = contents[end - 1] === '\r' ? end - 1 : end;
      rows.push({ columns: row, start: rowStart, end: rowEnd });
    }
    row = [];
    field = '';
    rowStart = end + 1;
  }
  for (let i = 0; i < contents.length; i += 1) {
    const character = contents[i];
    if (character === '"') {
      if (quoted && contents[i + 1] === '"') {
        field += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === ';' && !quoted) {
      row.push(field.trim());
      field = '';
    } else if (character === '\n' && !quoted) {
      finishRow(i);
    } else {
      field += character;
    }
  }
  finishRow(contents.length);
  return rows.slice(1).map(({ columns, start, end }, index) => ({
    id: `${index}:${createHash('sha256').update(contents.slice(start, end)).digest('hex')}`,
    start,
    end,
    columns,
    code: columns[0] || '',
    name: columns[1] || '',
    contact: columns[2] || '',
    village: columns[3] || '',
  })).filter((producer) => producer.code || producer.name);
}

let producersCache = null;
let producersCacheMtime = 0;
function readProducerDatabase() {
  const stat = fs.statSync(PRODUCERS_DATABASE_PATH);
  if (!producersCache || stat.mtimeMs !== producersCacheMtime) {
    producersCache = parseSemicolonCsv(fs.readFileSync(PRODUCERS_DATABASE_PATH, 'utf8'));
    producersCacheMtime = stat.mtimeMs;
  }
  return producersCache;
}

// Source unique pour l'onglet Producteurs et le sélecteur des sections agents.
function readProducerVillages() {
  const villagesByName = new Map();
  for (const producer of readProducerDatabase()) {
    const village = String(producer.village || '').trim();
    const key = normalizeSearch(village);
    if (key && !villagesByName.has(key)) villagesByName.set(key, village);
  }
  return [...villagesByName.values()].sort((a, b) => a.localeCompare(b, 'fr'));
}

function safeStoredPath(relativePath) {
  const resolved = path.resolve(ARCHIVE_DIR, relativePath);
  if (!resolved.startsWith(`${ARCHIVE_DIR}${path.sep}`)) return null;
  return resolved;
}

function surveyFilenameDetails(filename) {
  const baseName = path.basename(filename, path.extname(filename));
  const match = /^([A-Z]{2,5}_?\d{2,10})[_-](.+)$/i.exec(baseName);
  return match
    ? { code: match[1].replace(/_/g, ''), producer: match[2].replace(/[_-]+/g, ' ').trim() }
    : { code: '', producer: baseName.replace(/[_-]+/g, ' ').trim() };
}

function localDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function visitPdfFiles(directory, visit) {
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) visitPdfFiles(absolutePath, visit);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.pdf')) visit(absolutePath);
  }
}

function scanSurveyFolder() {
  sourceFilePaths.clear();
  sourceRecordMetadata.clear();
  if (CLOUD_MODE) return { agents: [], zones: [], zoneAgents: [], surveys: [] };
  if (!fs.existsSync(surveyDirectory)) return { agents: [], zones: [], zoneAgents: [], surveys: [] };
  const producerVillageByCode = new Map();
  try {
    for (const producer of readProducerDatabase()) {
      const code = String(producer.code || '').toLocaleUpperCase('fr').replace(/[^A-Z0-9]/g, '');
      if (code && producer.village) producerVillageByCode.set(code, producer.village);
    }
  } catch { /* Le dossier d'enquêtes reste consultable si la base producteurs est absente. */ }
  const directoriesAt = (directory) => {
    try {
      return fs.readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'));
    } catch {
      return [];
    }
  };
  const firstLevelDirectories = directoriesAt(surveyDirectory);
  const agentFolders = [];
  const zones = new Set();
  for (const firstLevel of firstLevelDirectories) {
    const firstLevelPath = path.join(surveyDirectory, firstLevel.name);
    const subdirectories = directoriesAt(firstLevelPath);
    if (subdirectories.length > 0) {
      zones.add(firstLevel.name);
      for (const agentDirectory of subdirectories) {
        agentFolders.push({
          zone: firstLevel.name,
          agent: agentDirectory.name,
          folder: path.join(firstLevelPath, agentDirectory.name),
        });
      }
    } else {
      // Compatibilité avec les anciens dossiers organisés directement par agent.
      agentFolders.push({ zone: '', agent: firstLevel.name, folder: firstLevelPath });
    }
  }
  const agents = [...new Set(agentFolders.map((entry) => entry.agent))]
    .sort((a, b) => a.localeCompare(b, 'fr'));
  const surveys = [];
  for (const agentDirectory of agentFolders) {
    const agentFolder = agentDirectory.folder;
    visitPdfFiles(agentFolder, (absolutePath) => {
      let stat;
      try { stat = fs.statSync(absolutePath); } catch { return; }
      const relativePath = path.relative(surveyDirectory, absolutePath);
      const metadataKey = relativePath.toLocaleLowerCase('fr');
      const cacheKey = `${surveyDirectory}:${metadataKey}:${stat.size}:${stat.mtimeMs}`;
      let cached = pdfCache.get(cacheKey);
      if (!cached) {
        let text = '';
        try { text = extractPdfText(fs.readFileSync(absolutePath)); } catch { /* Le PDF reste listé même si son contenu n'est pas lisible. */ }
        const codeFromPdf = /Code\s*PHI\s*:\s*([A-Z0-9_-]+)/i.exec(text)?.[1] ?? '';
        const nameFromPdf = /PRODUCTEUR\s+Code\s+PHI\s*:\s*[A-Z0-9_-]+\s+Nom\s*:\s*(.*?)\s+Contact\s*:/i.exec(text)?.[1]?.trim() ?? '';
        const dateFromPdf = /Date\s*:\s*(\d{2})\/(\d{2})\/(\d{4})/.exec(text);
        cached = {
          conformity: conformityFromPdfText(text),
          answers: answersFromPdfText(text),
          code: codeFromPdf,
          producer: nameFromPdf,
          date: dateFromPdf ? `${dateFromPdf[3]}-${dateFromPdf[2]}-${dateFromPdf[1]}` : localDate(stat.mtime),
        };
        pdfCache.set(cacheKey, cached);
        pdfCacheDirty = true;
      }
      const filenameDetails = surveyFilenameDetails(path.basename(absolutePath));
      const recordId = createHash('sha1').update(metadataKey).digest('hex').slice(0, 24);
      sourceFilePaths.set(recordId, absolutePath);
      const indexedRecord = records.find((item) =>
        item.sourceRoot === surveyDirectory &&
        item.sourcePath?.toLocaleLowerCase('fr') === metadataKey,
      );
      const surveyRecord = {
        id: indexedRecord?.id || recordId,
        agent: agentDirectory.agent,
        date: cached.date,
        code: cached.code || filenameDetails.code,
        producer: cached.producer || filenameDetails.producer,
        village: indexedRecord?.village || producerVillageByCode.get(String(cached.code || filenameDetails.code || '').toLocaleUpperCase('fr').replace(/[^A-Z0-9]/g, '')) || '',
        zone: agentDirectory.zone,
        status: cached.conformity,
        answers: cached.answers || [],
        criteria: '',
        originalName: path.basename(absolutePath),
        relativePath,
        size: stat.size,
        savedAt: stat.mtime.toISOString(),
        sourceFolder: true,
      };
      sourceRecordMetadata.set(surveyRecord.id, surveyRecord);
      surveys.push(surveyRecord);
    });
  }
  const zoneAgents = agentFolders
    .filter((entry) => entry.zone)
    .map(({ zone, agent }) => ({ zone, agent }));
  savePdfCache();
  return {
    agents,
    zones: [...zones].sort((a, b) => a.localeCompare(b, 'fr')),
    zoneAgents,
    surveys,
  };
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || '/', `http://127.0.0.1:${PORT}`);

  if (request.method === 'GET' && url.pathname === '/api/profile') {
    try {
      const user = await authenticatedUser(request);
      if (!user) return sendJson(response, 401, { error: 'Session expirée. Reconnectez-vous.' });
      const profile = await profileForUser(user, bearerToken(request));
      if (!canUseWebPlatform(profile)) {
        return sendJson(response, 403, { error: 'Ce compte est réservé à l’application mobile. La plateforme web est accessible au superviseur et aux responsables.' });
      }
      return sendJson(response, 200, { profile, adminReady: Boolean(SUPABASE_SERVICE_ROLE_KEY && SUPERVISOR_EMAIL) });
    } catch (error) {
      return sendJson(response, 503, { error: error.message || 'Profil utilisateur indisponible.' });
    }
  }

  if (url.pathname === '/api/admin/users' && ['GET', 'POST', 'PATCH'].includes(request.method)) {
    try {
      const user = await requireSupervisor(request, response);
      if (!user) return;
      if (request.method === 'GET') {
        const [authData, profiles] = await Promise.all([
          supabaseAdminRequest('auth/v1/admin/users?page=1&per_page=1000'),
          supabaseAdminRequest('rest/v1/user_profiles?select=user_id,email,display_name,title,role,permissions,zones&order=email.asc'),
        ]);
        const profileById = new Map(profiles.map((profile) => [profile.user_id, profile]));
        const accounts = (authData.users || []).map((account) => profileById.get(account.id) || ({
          user_id: account.id,
          email: account.email || '',
          display_name: account.user_metadata?.full_name || account.email || '',
          title: 'Assistant',
          role: 'responsable',
          permissions: [],
          zones: [],
        }));
        return sendJson(response, 200, { accounts: accounts.filter((account) => ['supervisor', 'responsable'].includes(account.role)) });
      }

      const body = JSON.parse((await getBody(request)).toString('utf8') || '{}');
      if (request.method === 'POST') {
        const email = String(body.email || '').trim().toLowerCase();
        const displayName = String(body.display_name || '').trim();
        const title = cleanResponsibleTitle(body.title);
        const password = String(body.password || '');
        if (!/^\S+@\S+\.\S+$/.test(email) || displayName.length < 2 || password.length < 8) {
          return sendJson(response, 400, { error: 'Indiquez un nom, un e-mail valide et un mot de passe provisoire de 8 caractères minimum.' });
        }
        if (email === SUPERVISOR_EMAIL) return sendJson(response, 400, { error: 'Cette adresse est réservée au compte superviseur.' });
        const created = await supabaseAdminRequest('auth/v1/admin/users', {
          method: 'POST', body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { full_name: displayName } }),
        });
        const account = created.user || created;
        try {
          await supabaseAdminRequest('rest/v1/user_profiles?on_conflict=user_id', {
            method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
            body: JSON.stringify([{ user_id: account.id, email, display_name: displayName, title, role: 'responsable', permissions: cleanPermissions(body.permissions), zones: cleanZoneAssignments(body.zones) }]),
          });
        } catch (error) {
          return sendJson(response, 502, { error: `Compte créé, mais ses accès n'ont pas été enregistrés : ${error.message}` });
        }
        return sendJson(response, 201, { account: { user_id: account.id, email, display_name: displayName, title, role: 'responsable', permissions: cleanPermissions(body.permissions), zones: cleanZoneAssignments(body.zones) } });
      }

      const userId = String(body.user_id || '');
      if (!/^[0-9a-f-]{36}$/i.test(userId)) return sendJson(response, 400, { error: 'Identifiant de compte invalide.' });
      const rows = await supabaseAdminRequest(`rest/v1/user_profiles?user_id=eq.${encodeURIComponent(userId)}&select=user_id,email,display_name,title,role,permissions,zones`);
      if (!rows.length) return sendJson(response, 404, { error: 'Compte introuvable.' });
      if (rows[0].email?.toLowerCase() === SUPERVISOR_EMAIL) return sendJson(response, 400, { error: 'Les droits du superviseur ne peuvent pas être réduits ici.' });
      const displayName = body.display_name === undefined ? rows[0].display_name : String(body.display_name || '').trim();
      if (body.display_name !== undefined && displayName.length < 2) return sendJson(response, 400, { error: 'Le nom doit contenir au moins 2 caractères.' });
      const password = body.password === undefined ? '' : String(body.password);
      if (password && password.length < 8) return sendJson(response, 400, { error: 'Le nouveau mot de passe doit contenir au moins 8 caractères.' });
      const permissions = Array.isArray(body.permissions) ? cleanPermissions(body.permissions) : (rows[0].permissions || []);
      const zones = Array.isArray(body.zones) ? cleanZoneAssignments(body.zones) : (rows[0].zones || []);
      const title = body.title === undefined ? (rows[0].title || 'Assistant') : cleanResponsibleTitle(body.title);
      if (password || body.display_name !== undefined) {
        const authChanges = {};
        if (password) authChanges.password = password;
        if (body.display_name !== undefined) authChanges.user_metadata = { full_name: displayName };
        await supabaseAdminRequest(`auth/v1/admin/users/${encodeURIComponent(userId)}`, {
          method: 'PUT', body: JSON.stringify(authChanges),
        });
      }
      await supabaseAdminRequest(`rest/v1/user_profiles?user_id=eq.${encodeURIComponent(userId)}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ display_name: displayName, permissions, zones, title, role: 'responsable', updated_at: new Date().toISOString() }),
      });
      return sendJson(response, 200, { user_id: userId, display_name: displayName, permissions, zones, title });
    } catch (error) {
      return sendJson(response, 500, { error: error.message || 'Gestion des comptes impossible.' });
    }
  }

  if (url.pathname === '/api/admin/field-agents' && ['GET', 'POST', 'PATCH'].includes(request.method)) {
    try {
      const user = await requireSupervisor(request, response);
      if (!user) return;
      const [scanned, surveyAgents] = await Promise.all([
        Promise.resolve(scanSurveyFolder()),
        supabaseAdminRequest('rest/v1/enquetes?select=agent,zone&order=agent.asc'),
      ]);
      const folderAgents = [...new Set([
        ...scanned.agents,
        ...surveyAgents.map((entry) => String(entry.agent || '').trim()).filter(Boolean),
      ])].sort((a, b) => a.localeCompare(b, 'fr'));
      const zonesByAgent = new Map();
      for (const entry of [...scanned.zoneAgents, ...surveyAgents]) {
        if (!entry.zone) continue;
        const zones = zonesByAgent.get(entry.agent) || new Set();
        zones.add(entry.zone);
        zonesByAgent.set(entry.agent, zones);
      }
      const loginIdentifiers = fieldAgentLoginIdentifiers(folderAgents);
      const agentRows = folderAgents.map((name, index) => ({
        name,
        login_identifier: loginIdentifiers[index],
        email: fieldAgentAuthEmail(loginIdentifiers[index]),
      }));
      const profileQuery = 'rest/v1/user_profiles?role=eq.agent_terrain&select=user_id,display_name,login_identifier,email,section_name,villages';
      let hasAgentSourceName = true;
      let profiles;
      try {
        profiles = await supabaseAdminRequest(`${profileQuery},agent_source_name`);
      } catch (error) {
        if (!['42703', 'PGRST204'].includes(error.supabaseCode)
            || !/\bagent_source_name\b/i.test(error.message)) throw error;
        hasAgentSourceName = false;
        profiles = await supabaseAdminRequest(profileQuery);
      }
      const profilesByLogin = new Map(profiles.map((profile) => [String(profile.login_identifier || '').toLocaleLowerCase('fr'), profile]));
      if (request.method === 'GET') {
        const matched = new Set();
        const agents = agentRows.map((agent) => {
          const account = profiles.find((profile) =>
            !matched.has(profile.user_id) && normalizeSearch(profile.agent_source_name) === normalizeSearch(agent.name),
          ) || (() => {
            const byLogin = profilesByLogin.get(agent.login_identifier.toLocaleLowerCase('fr'));
            return byLogin && !matched.has(byLogin.user_id) ? byLogin : null;
          })() || profiles.find((profile) =>
            !matched.has(profile.user_id) && normalizeSearch(profile.display_name) === normalizeSearch(agent.name),
          );
          if (account) matched.add(account.user_id);
          return account
            ? { ...agent, name: account.display_name || agent.name, source_name: account.agent_source_name || agent.name, login_identifier: account.login_identifier || agent.login_identifier, email: account.email || agent.email, exists: true, user_id: account.user_id, section_name: account.section_name || '', villages: account.villages || [] }
            : { ...agent, source_name: agent.name, exists: false, user_id: null, section_name: '', villages: [] };
        });
        for (const account of profiles) {
          if (matched.has(account.user_id)) continue;
          agents.push({ name: account.display_name || account.login_identifier, source_name: account.agent_source_name || account.display_name || '', login_identifier: account.login_identifier || '', email: account.email || '', exists: true, user_id: account.user_id, section_name: account.section_name || '', villages: account.villages || [] });
        }
        const villages = CLOUD_MODE
          ? [...new Set((await cloudProducerRows()).map((row) => String(row.village || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'fr'))
          : readProducerVillages();
        return sendJson(response, 200, { agents, villages });
      }

      if (request.method === 'PATCH') {
        const body = JSON.parse((await getBody(request)).toString('utf8') || '{}');
        const profile = profiles.find((row) => row.user_id === String(body.user_id || ''));
        if (!profile) return sendJson(response, 404, { error: 'Compte agent introuvable.' });
        const sectionName = body.section_name === undefined ? (profile.section_name || '') : String(body.section_name || '').trim();
        const availableVillages = CLOUD_MODE
          ? [...new Set((await cloudProducerRows()).map((row) => String(row.village || '').trim()).filter(Boolean))]
          : readProducerVillages();
        const villages = body.villages === undefined ? (profile.villages || []) : cleanVillageAssignments(body.villages, availableVillages);
        if (sectionName && !villages.length) return sendJson(response, 400, { error: 'Ajoutez au moins un village à la section.' });
        if (!sectionName && villages.length) return sendJson(response, 400, { error: 'Indiquez le nom de la section.' });

        const displayName = body.display_name === undefined ? profile.display_name : String(body.display_name || '').trim();
        const loginIdentifier = body.login_identifier === undefined ? profile.login_identifier : String(body.login_identifier || '').trim();
        const password = body.password === undefined ? '' : String(body.password);
        if (body.display_name !== undefined && displayName.length < 2) return sendJson(response, 400, { error: 'Le nom doit contenir au moins 2 caractères.' });
        if (body.login_identifier !== undefined && loginIdentifier.length < 3) return sendJson(response, 400, { error: 'L’identifiant doit contenir au moins 3 caractères.' });
        if (password && password.length < 6) return sendJson(response, 400, { error: 'Le mot de passe doit contenir au moins 6 caractères.' });
        const normalizedIdentifier = String(loginIdentifier || '').toLocaleLowerCase('fr');
        if (profiles.some((row) => row.user_id !== profile.user_id && String(row.login_identifier || '').toLocaleLowerCase('fr') === normalizedIdentifier)) {
          return sendJson(response, 409, { error: 'Cet identifiant est déjà utilisé par un autre agent.' });
        }
        const email = fieldAgentAuthEmail(loginIdentifier);
        const identityChanged = displayName !== profile.display_name || loginIdentifier !== profile.login_identifier;
        if (identityChanged && !hasAgentSourceName) {
          return sendJson(response, 409, {
            error: 'Exécutez sections-migration.sql dans Supabase avant de modifier le nom ou l’identifiant de l’agent.',
          });
        }
        if (identityChanged || password) {
          await supabaseAdminRequest(`auth/v1/admin/users/${encodeURIComponent(profile.user_id)}`, {
            method: 'PUT',
            body: JSON.stringify({
              ...(identityChanged ? { email, email_confirm: true } : {}),
              ...(password ? { password } : {}),
              ...(identityChanged ? { user_metadata: { full_name: displayName, login_identifier: loginIdentifier, account_type: 'field_agent' } } : {}),
            }),
          });
        }
        const profileChanges = {
          display_name: displayName,
          login_identifier: loginIdentifier,
          email,
          ...(hasAgentSourceName && { agent_source_name: profile.agent_source_name || profile.display_name }),
          section_name: sectionName,
          villages,
          updated_at: new Date().toISOString(),
        };
        await supabaseAdminRequest(`rest/v1/user_profiles?user_id=eq.${encodeURIComponent(profile.user_id)}`, {
          method: 'PATCH', headers: { Prefer: 'return=minimal' },
          body: JSON.stringify(profileChanges),
        });
        return sendJson(response, 200, { user_id: profile.user_id, display_name: displayName, login_identifier: loginIdentifier, email, section_name: sectionName, villages });
      }

      const created = [];
      const alreadyExists = [];
      const errors = [];
      for (const agent of agentRows) {
        const existingAccount = profilesByLogin.get(agent.login_identifier.toLocaleLowerCase('fr')) || profiles.find((profile) =>
          normalizeSearch(profile.agent_source_name || profile.display_name) === normalizeSearch(agent.name),
        );
        if (existingAccount) {
          alreadyExists.push(existingAccount.login_identifier || agent.login_identifier);
          continue;
        }
        try {
          let createdUserId;
          try {
          const authResult = await supabaseAdminRequest('auth/v1/admin/users', {
            method: 'POST',
            body: JSON.stringify({
              email: agent.email,
              password: FIELD_AGENT_DEFAULT_PASSWORD,
              email_confirm: true,
              user_metadata: { full_name: agent.name, login_identifier: agent.login_identifier, account_type: 'field_agent' },
            }),
          });
          const account = authResult.user || authResult;
          createdUserId = account.id;
          const zoneNames = [...(zonesByAgent.get(agent.name) || [])];
          await supabaseAdminRequest('rest/v1/user_profiles?on_conflict=user_id', {
            method: 'POST',
            headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
            body: JSON.stringify([{
              user_id: account.id,
              email: agent.email,
              display_name: agent.name,
              title: 'Agent de terrain',
              role: 'agent_terrain',
              login_identifier: agent.login_identifier,
              ...(hasAgentSourceName && { agent_source_name: agent.name }),
              permissions: [],
              zones: zoneNames,
            }]),
          });
          } catch (error) {
            if (createdUserId) {
              await supabaseAdminRequest(`auth/v1/admin/users/${encodeURIComponent(createdUserId)}`, { method: 'DELETE' }).catch(() => {});
            }
            throw error;
          }
          created.push(agent.login_identifier);
          profilesByLogin.set(agent.login_identifier.toLocaleLowerCase('fr'), { user_id: createdUserId });
        } catch (error) {
          errors.push({ login_identifier: agent.login_identifier, error: error.message });
        }
      }
      return sendJson(response, errors.length ? 207 : 200, {
        created,
        already_exists: alreadyExists,
        errors,
        default_password: FIELD_AGENT_DEFAULT_PASSWORD,
      });
    } catch (error) {
      const missingSectionColumn =
        ['42703', 'PGRST204'].includes(error.supabaseCode)
        && /\b(section_name|villages|agent_source_name)\b/i.test(error.message);
      return sendJson(response, 500, {
        error: error.message || 'Opération sur les comptes agents impossible.',
        ...(missingSectionColumn && { code: 'SECTIONS_SCHEMA_MISSING' }),
      });
    }
  }

  if (url.pathname === '/api/admin/sync-producers' && request.method === 'POST') {
    try {
      const user = await requireSupervisor(request, response);
      if (!user) return;
      const { user_id: agentId } = JSON.parse((await getBody(request)).toString('utf8') || '{}');
      if (CLOUD_MODE) {
        const producerRows = await cloudProducerRows();
        let assignedVillages = null;
        if (agentId !== undefined) {
          const [agent] = await supabaseAdminRequest(`rest/v1/user_profiles?user_id=eq.${encodeURIComponent(agentId)}&role=eq.agent_terrain&select=villages&limit=1`);
          if (!agent) return sendJson(response, 404, { error: 'Compte agent introuvable.' });
          assignedVillages = new Set((agent.villages || []).map((village) => village.trim().toLocaleLowerCase('fr')));
        }
        const count = producerRows.filter((row) => !assignedVillages || assignedVillages.has(String(row.village || '').trim().toLocaleLowerCase('fr'))).length;
        return sendJson(response, 200, { synchronized: count, already_shared: true, ...(assignedVillages && { assigned_villages: assignedVillages.size }) });
      }
      let assignedVillages = null;
      if (agentId !== undefined) {
        if (typeof agentId !== 'string' || !agentId.trim()) {
          return sendJson(response, 400, { error: 'Sélectionnez un agent de terrain.' });
        }
        const [agent] = await supabaseAdminRequest(
          `rest/v1/user_profiles?user_id=eq.${encodeURIComponent(agentId)}&role=eq.agent_terrain&select=villages&limit=1`,
          { signal: AbortSignal.timeout(15000) },
        );
        if (!agent) return sendJson(response, 404, { error: 'Compte agent introuvable.' });
        assignedVillages = new Set((agent.villages || []).map((village) => village.trim().toLowerCase()));
      }
      const source = readProducerDatabase();
      const rowsByCode = new Map();
      for (const producer of source) {
        const code = producer.code.trim();
        if (!code) continue;
        rowsByCode.set(code.toLocaleUpperCase('fr'), {
          code_phi: code, nom: producer.name.trim(), contact: producer.contact.trim(), village: producer.village.trim(),
        });
      }
      const rows = [...rowsByCode.values()].filter((row) =>
        !assignedVillages || assignedVillages.has(row.village.toLowerCase()),
      );
      for (let start = 0; start < rows.length; start += 500) {
        await supabaseAdminRequest('rest/v1/producteurs?on_conflict=code_phi', {
          method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify(rows.slice(start, start + 500)),
          signal: AbortSignal.timeout(30000),
        });
      }
      return sendJson(response, 200, {
        synchronized: rows.length,
        ...(assignedVillages && { assigned_villages: assignedVillages.size }),
      });
    } catch (error) {
      return sendJson(response, 500, { error: `Synchronisation impossible : ${error.message}` });
    }
  }

  if (request.method === 'GET' && url.pathname === '/api/config') {
    return sendJson(response, 200, { supabaseUrl: SUPABASE_URL, supabaseAnonKey: SUPABASE_ANON_KEY, cloudStorage: CLOUD_MODE, storageBucket: STORAGE_BUCKET });
  }

  if (request.method === 'GET' && url.pathname === '/api/producers') {
    const user = await authenticatedUser(request);
    if (!user) return sendJson(response, 401, { error: 'Connectez-vous pour consulter les producteurs.' });
    try {
      const profile = await profileForUser(user, bearerToken(request));
      if (profile.role !== 'supervisor') {
        return sendJson(response, 403, { error: 'L’accès à la base des producteurs est réservé au superviseur.' });
      }
      const allProducers = CLOUD_MODE
        ? (await cloudProducerRows()).map((row) => ({ id: row.code_phi, code: row.code_phi, name: row.nom || '', contact: row.contact || '', village: row.village || '' }))
        : readProducerDatabase();
      const query = normalizeSearch(url.searchParams.get('q') || '');
      const filtered = query
        ? allProducers.filter((producer) => normalizeSearch(
          `${producer.code} ${producer.name} ${producer.contact} ${producer.village}`,
        ).includes(query))
        : allProducers;
      const requestedPageSize = Number.parseInt(url.searchParams.get('pageSize') || '100', 10) || 100;
      const pageSize = Math.max(1, Math.min(1000, requestedPageSize));
      const page = Math.max(1, Math.min(100000, Number.parseInt(url.searchParams.get('page') || '1', 10) || 1));
      const start = (page - 1) * pageSize;
      return sendJson(response, 200, {
        total: filtered.length,
        page,
        pageSize,
        items: filtered.slice(start, start + pageSize).map(({ id, code, name, contact, village }) => ({
          id, code, name, contact, village,
        })),
      });
    } catch (error) {
      console.error(`Lecture de la base des producteurs impossible : ${error.message}`);
      return sendJson(response, 500, { error: 'Lecture de la base des producteurs impossible. Vérifiez le fichier de données.' });
    }
  }

  if (request.method === 'PATCH' && url.pathname === '/api/producers') {
    try {
      if (!await requireSupervisor(request, response)) return;
      let changes;
      try {
        changes = JSON.parse((await getBody(request, 8192)).toString('utf8'));
      } catch {
        return sendJson(response, 400, { error: 'Les données de la fiche sont invalides.' });
      }
      if (!changes || typeof changes.id !== 'string') {
        return sendJson(response, 400, { error: 'Sélectionnez une fiche de producteur.' });
      }

      const fields = [
        { key: 'name', label: 'Le nom', limit: 200, required: true },
        { key: 'contact', label: 'Le contact', limit: 80 },
        { key: 'village', label: 'Le village', limit: 150 },
      ];
      const values = [];
      for (const { key, label, limit, required } of fields) {
        const value = typeof changes[key] === 'string' ? changes[key].trim() : null;
        if (value === null || (required && !value) || value.length > limit || /[\r\n\x00]/.test(value)) {
          return sendJson(response, 400, { error: `${label} est invalide (maximum ${limit} caractères).` });
        }
        values.push(value);
      }

      if (CLOUD_MODE) {
        const [existing] = await supabaseAdminRequest(`rest/v1/producteurs?code_phi=eq.${encodeURIComponent(changes.id)}&select=code_phi&limit=1`);
        if (!existing) return sendJson(response, 409, { error: 'Cette fiche a chang\u00e9. Actualisez la liste avant de r\u00e9essayer.' });
        await supabaseAdminRequest(`rest/v1/producteurs?code_phi=eq.${encodeURIComponent(changes.id)}`, {
          method: 'PATCH', headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ nom: values[0], contact: values[1], village: values[2] }),
        });
        return sendJson(response, 200, { updated: true });
      }
      const contents = fs.readFileSync(PRODUCERS_DATABASE_PATH, 'utf8');
      const producer = parseSemicolonCsv(contents).find(({ id }) => id === changes.id);
      if (!producer) {
        return sendJson(response, 409, { error: 'Cette fiche a changé. Fermez le formulaire et actualisez la liste avant de réessayer.' });
      }
      const columns = [producer.code, ...values, ...producer.columns.slice(4)];
      const row = columns.map((value) => /[;"\r\n]/.test(value)
        ? `"${value.replaceAll('"', '""')}"`
        : value).join(';');
      const updatedCsv = contents.slice(0, producer.start) + row + contents.slice(producer.end);
      const temporaryFile = `${PRODUCERS_DATABASE_PATH}.${randomUUID()}.tmp`;
      try {
        fs.writeFileSync(temporaryFile, updatedCsv, { encoding: 'utf8', flag: 'wx' });
        fs.renameSync(temporaryFile, PRODUCERS_DATABASE_PATH);
      } finally {
        fs.rmSync(temporaryFile, { force: true });
      }
      producersCache = null;
      return sendJson(response, 200, { updated: true });
    } catch (error) {
      console.error(`Enregistrement du producteur impossible : ${error.message}`);
      return sendJson(response, 500, { error: 'Impossible d’enregistrer la fiche. Vérifiez que le fichier des producteurs est accessible en écriture.' });
    }
  }

  if (request.method === 'GET' && url.pathname === '/api/state') {
    const user = await authenticatedUser(request);
    if (!user) return sendJson(response, 401, { error: 'Connectez-vous pour consulter les enquêtes.' });
    let profile;
    try {
      profile = await profileForUser(user, bearerToken(request));
    } catch (error) {
      return sendJson(response, 503, { error: error.message || 'Profil utilisateur indisponible.' });
    }
    if (!canUseWebPlatform(profile)) {
      return sendJson(response, 403, { error: 'Ce compte est réservé à l’application mobile.' });
    }
    if (CLOUD_MODE) {
      try {
        const rows = await cloudSurveyRows();
        const isSupervisor = profile.role === 'supervisor';
        const permitted = isSupervisor
          ? rows
          : (profile.permissions || []).some((module) => APP_MODULES.includes(module))
            ? rows.filter((row) => (profile.zones || []).some((zone) => normalizeZone(zone) === normalizeZone(row.zone)))
            : [];
        const records = permitted.map((row) => ({
          id: row.pdf_key, date: row.date_enquete || '', zone: row.zone || '', agent: row.agent || '',
          code: row.code_phi || '', producer: row.nom_planteur || '', village: row.village || '',
          status: row.statut || '\u00c0 v\u00e9rifier', criteria: row.criteres || '', answers: Array.isArray(row.reponses) ? row.reponses : [],
          originalName: row.nom_fichier || '', size: row.taille_pdf || 0, pdfAvailable: Boolean(row.pdf_path),
        }));
        const agents = [...new Set(records.map((row) => row.agent).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'fr'));
        const zones = [...new Set(records.map((row) => row.zone).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'fr'));
        const zoneAgents = [...new Map(records.filter((row) => row.zone && row.agent).map(({ zone, agent }) => [`${normalizeZone(zone)}\u0000${normalizeZone(agent)}`, { zone, agent }])).values()];
        return sendJson(response, 200, { records, agents, zones, zoneAgents, statisticsSourceId: '', archiveDirectory: 'PDF stock\u00e9s dans Supabase Storage', sourceDirectoryFound: true });
      } catch (error) {
        console.error(`Lecture des enqu\u00eates Supabase impossible : ${error.message}`);
        return sendJson(response, 500, { error: `Lecture des enqu\u00eates impossible : ${error.message}` });
      }
    }
    const scanned = scanSurveyFolder();
    const legacyRecords = records.filter((item) => !item.sourcePath && safeStoredPath(item.relativePath) && fs.existsSync(safeStoredPath(item.relativePath)));
    const allSurveys = [...scanned.surveys, ...legacyRecords];
    const isSupervisor = profile.role === 'supervisor';
    const allowedZones = new Set(isSupervisor ? [] : (profile.zones || []).map(normalizeZone));
    const canReadSurveys = isSupervisor || (profile.permissions || []).some((module) => APP_MODULES.includes(module));
    const surveys = isSupervisor
      ? allSurveys
      : canReadSurveys ? allSurveys.filter((record) => allowedZones.has(normalizeZone(record.zone))) : [];
    const agents = [...new Set([...scanned.agents, ...surveys.map((record) => record.agent).filter(Boolean)])]
      .sort((a, b) => a.localeCompare(b, 'fr'));
    const zones = [...new Set([...scanned.zones, ...surveys.map((record) => record.zone).filter(Boolean)])]
      .sort((a, b) => a.localeCompare(b, 'fr'));
    const zoneAgentKeys = new Set();
    const zoneAgents = [...scanned.zoneAgents, ...surveys
      .filter((record) => record.zone && record.agent)
      .map(({ zone, agent }) => ({ zone, agent }))]
      .filter((entry) => {
        const key = `${entry.zone.toLocaleLowerCase('fr')}\u0000${entry.agent.toLocaleLowerCase('fr')}`;
        if (zoneAgentKeys.has(key)) return false;
        zoneAgentKeys.add(key);
        return true;
      });
    return sendJson(response, 200, {
      records: surveys.sort((a, b) => b.date.localeCompare(a.date)),
      agents,
      zones: isSupervisor ? zones : zones.filter((zone) => allowedZones.has(normalizeZone(zone))),
      zoneAgents: isSupervisor ? zoneAgents : zoneAgents.filter((entry) => allowedZones.has(normalizeZone(entry.zone))),
      statisticsSourceId: isSupervisor ? createHash('sha256').update(surveyDirectory.toLocaleLowerCase('fr')).digest('hex').slice(0, 24) : '',
      archiveDirectory: isSupervisor ? surveyDirectory : '',
      sourceDirectoryFound: fs.existsSync(surveyDirectory),
    });
  }

  if (request.method === 'POST' && url.pathname === '/api/select-folder') {
    if (process.platform !== 'win32') {
      return sendJson(response, 501, { error: 'Le sélecteur de dossier Windows est indisponible sur ce système.' });
    }
    try {
      const pickerScript = [
        'Add-Type -AssemblyName System.Windows.Forms',
        '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
        "$dialog.Description = 'Choisir le dossier contenant les enquêtes'",
        '$dialog.ShowNewFolderButton = $false',
        "$dialog.SelectedPath = [Environment]::GetFolderPath('Desktop')",
        'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }',
      ].join('; ');
      const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-STA', '-Command', pickerScript],
        { timeout: 120000, windowsHide: false },
      );
      const selectedFolder = stdout.replace(/^\uFEFF/, '').trim();
      if (!selectedFolder) return sendJson(response, 200, { cancelled: true });
      if (!fs.existsSync(selectedFolder) || !fs.statSync(selectedFolder).isDirectory()) {
        return sendJson(response, 400, { error: 'Le dossier sélectionné est introuvable.' });
      }
      const resolvedSelection = path.resolve(selectedFolder);
      const selectedRdueDirectory = path.join(resolvedSelection, 'RDUE');
      surveyDirectory = resolvedSelection.toLocaleLowerCase('fr') !== selectedRdueDirectory.toLocaleLowerCase('fr') &&
        fs.existsSync(selectedRdueDirectory) && fs.statSync(selectedRdueDirectory).isDirectory()
        ? selectedRdueDirectory
        : resolvedSelection;
      const temporarySettings = `${FOLDER_SETTINGS_PATH}.tmp`;
      fs.writeFileSync(temporarySettings, JSON.stringify({ surveyDirectory }, null, 2), 'utf8');
      fs.renameSync(temporarySettings, FOLDER_SETTINGS_PATH);
      sourceFilePaths.clear();
      return sendJson(response, 200, { cancelled: false, folder: surveyDirectory });
    } catch (error) {
      return sendJson(response, 500, { error: `Impossible de choisir le dossier : ${error.message}` });
    }
  }

  if (CLOUD_MODE && request.method === 'POST' && url.pathname === '/api/upload-url') {
    try {
      if (!await requireSupervisor(request, response)) return;
      const body = JSON.parse((await getBody(request, 16384)).toString('utf8') || '{}');
      const agent = String(body.agent || '').trim();
      const zone = String(body.zone || '').trim();
      const date = String(body.date || '').trim();
      const originalName = path.basename(String(body.filename || 'enquete.pdf')).slice(0, 180);
      if (!agent || !zone || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !originalName.toLowerCase().endsWith('.pdf')) {
        return sendJson(response, 400, { error: 'Renseignez la zone, l’agent, la date et un fichier PDF valide.' });
      }
      const id = randomUUID();
      const pdfPath = `uploads/${id}.pdf`;
      const signed = await storageAdminRequest(`object/upload/sign/${encodeURIComponent(STORAGE_BUCKET)}/${encodeStoragePath(pdfPath)}`, { method: 'POST', body: JSON.stringify({}) });
      const uploadUrl = signed.signedURL || signed.signedUrl || signed.url;
      if (!signed.token || !uploadUrl) throw new Error('Supabase n’a pas fourni de lien de dépôt sécurisé.');
      return sendJson(response, 200, { id, path: pdfPath, token: signed.token, uploadUrl: `${SUPABASE_URL}/storage/v1${uploadUrl.startsWith('/') ? uploadUrl : `/${uploadUrl}`}` });
    } catch (error) {
      return sendJson(response, 500, { error: error.message || 'Préparation de l’envoi du PDF impossible.' });
    }
  }

  if (CLOUD_MODE && request.method === 'POST' && url.pathname === '/api/complete-upload') {
    try {
      if (!await requireSupervisor(request, response)) return;
      const body = JSON.parse((await getBody(request, 16384)).toString('utf8') || '{}');
      const pdfPath = String(body.path || '');
      const id = String(body.id || '');
      const agent = String(body.agent || '').trim();
      const zone = String(body.zone || '').trim();
      const date = String(body.date || '').trim();
      if (!/^uploads\/[0-9a-f-]{36}\.pdf$/i.test(pdfPath) || id !== pdfPath.slice(8, -4) || !agent || !zone || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return sendJson(response, 400, { error: 'Les informations de dépôt sont invalides.' });
      }
      const fileResponse = await fetch(`${SUPABASE_URL}/storage/v1/object/${encodeURIComponent(STORAGE_BUCKET)}/${encodeStoragePath(pdfPath)}`, {
        headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
      });
      if (!fileResponse.ok) return sendJson(response, 400, { error: 'Le PDF n’a pas été reçu dans Supabase Storage.' });
      const pdf = Buffer.from(await fileResponse.arrayBuffer());
      if (pdf.length < 5 || pdf.length > MAX_FILE_SIZE || pdf.subarray(0, 5).toString() !== '%PDF-') {
        return sendJson(response, 400, { error: 'Le fichier reçu n’est pas un PDF valide ou dépasse 40 Mo.' });
      }
      const textContent = extractPdfText(pdf);
      const answers = answersFromPdfText(textContent);
      const extractedCode = /Code\s*PHI\s*:\s*([A-Z0-9_-]+)/i.exec(textContent)?.[1] || '';
      const extractedName = /PRODUCTEUR\s+Code\s+PHI\s*:\s*[A-Z0-9_-]+\s+Nom\s*:\s*(.*?)\s+Contact\s*:/i.exec(textContent)?.[1]?.trim() || '';
      const extractedDate = /Date\s*:\s*(\d{2})\/(\d{2})\/(\d{4})/.exec(textContent);
      const status = conformityFromPdfText(textContent);
      const record = {
        pdf_key: id, zone, agent, code_phi: extractedCode || String(body.code || '').trim(),
        nom_planteur: extractedName || String(body.producer || '').trim(), village: String(body.village || '').trim(),
        statut: ['Conforme', 'Non conforme'].includes(status) ? status : 'À vérifier',
        date_enquete: extractedDate ? `${extractedDate[3]}-${extractedDate[2]}-${extractedDate[1]}` : date,
        pdf_path: pdfPath, nom_fichier: path.basename(String(body.filename || 'enquete.pdf')).slice(0, 180),
        taille_pdf: pdf.length, criteres: String(body.criteria || '').trim().slice(0, 300), reponses: answers,
      };
      await supabaseAdminRequest('rest/v1/enquetes?on_conflict=pdf_key', {
        method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify([record]),
      });
      const stats = new Map();
      for (const answer of answers) {
        const reponse = String(answer.response || '').trim();
        if (!reponse) continue;
        const key = `${String(answer.ref || '')}\u0000${reponse}`;
        const item = stats.get(key) || {
          source_id: `cloud:${id}`, date_enquete: record.date_enquete, zone, agent,
          question_ref: String(answer.ref || ''), question: String(answer.question || ''), reponse, nombre: 0,
        };
        item.nombre += 1;
        stats.set(key, item);
      }
      if (stats.size) await supabaseAdminRequest('rest/v1/statistiques_reponses?on_conflict=source_id,date_enquete,zone,agent,question_ref,reponse', {
        method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify([...stats.values()]),
      });
      return sendJson(response, 201, { record: { id, agent, status: record.statut } });
    } catch (error) {
      console.error(`Archivage cloud du PDF impossible : ${error.message}`);
      return sendJson(response, 500, { error: `Archivage impossible : ${error.message}` });
    }
  }

  if (request.method === 'POST' && url.pathname === '/api/upload') {
    if (CLOUD_MODE) return sendJson(response, 410, { error: 'Utilisez le dépôt sécurisé vers Supabase Storage.' });
    try {
      const agent = String(url.searchParams.get('agent') || '').trim();
      const zone = String(url.searchParams.get('zone') || '').trim();
      const date = String(url.searchParams.get('date') || '').trim();
      const originalName = String(url.searchParams.get('filename') || 'enquete.pdf');
      if (!agent || !zone || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return sendJson(response, 400, { error: "La zone, le nom de l'agent et une date valide sont requis." });
      }

      const pdf = await getBody(request, MAX_FILE_SIZE);
      if (pdf.length < 5 || pdf.subarray(0, 5).toString() !== '%PDF-') {
        return sendJson(response, 400, { error: "Le fichier sélectionné n'est pas un PDF valide." });
      }

      const folder = path.join(surveyDirectory, cleanName(zone), cleanName(agent), date.slice(0, 4));
      fs.mkdirSync(folder, { recursive: true });
      const parts = [
        date,
        cleanFilenamePart(url.searchParams.get('code')),
        cleanFilenamePart(url.searchParams.get('producer')),
      ].filter(Boolean);
      let filename = `${parts.join('_') || date}.pdf`;
      let diskPath = path.join(folder, filename);
      let suffix = 2;
      while (fs.existsSync(diskPath)) {
        filename = `${parts.join('_') || date}_${suffix++}.pdf`;
        diskPath = path.join(folder, filename);
      }
      fs.writeFileSync(diskPath, pdf, { flag: 'wx' });

      const record = {
        id: randomUUID(),
        agent,
        date,
        code: String(url.searchParams.get('code') || '').trim(),
        producer: String(url.searchParams.get('producer') || '').trim(),
        village: String(url.searchParams.get('village') || '').trim(),
        zone,
        status: String(url.searchParams.get('status') || 'Réalisée').trim(),
        criteria: String(url.searchParams.get('criteria') || '').trim(),
        originalName: path.basename(originalName),
        relativePath: path.relative(surveyDirectory, diskPath),
        sourcePath: path.relative(surveyDirectory, diskPath),
        sourceRoot: surveyDirectory,
        size: pdf.length,
        savedAt: new Date().toISOString(),
      };
      records.push(record);
      saveRecords();
      return sendJson(response, 201, { record });
    } catch (error) {
      return sendJson(response, 500, { error: error.message || 'Enregistrement impossible.' });
    }
  }

  if (request.method === 'GET' && url.pathname.startsWith('/api/files/')) {
    const id = decodeURIComponent(url.pathname.slice('/api/files/'.length));
    const user = await authenticatedUser(request);
    if (!user) return sendJson(response, 401, { error: 'Connectez-vous pour consulter le PDF.' });
    let profile;
    try {
      profile = await profileForUser(user, bearerToken(request));
    } catch (error) {
      return sendJson(response, 503, { error: error.message || 'Profil utilisateur indisponible.' });
    }
    if (CLOUD_MODE) {
      try {
        const [record] = await supabaseAdminRequest(`rest/v1/enquetes?pdf_key=eq.${encodeURIComponent(id)}&select=pdf_key,zone,pdf_path&limit=1`);
        const isSupervisor = profile.role === 'supervisor';
        if (!record || !record.pdf_path || (!isSupervisor && (!(profile.permissions || []).includes('archives') || !(profile.zones || []).map(normalizeZone).includes(normalizeZone(record.zone))))) {
          return sendJson(response, 404, { error: 'PDF introuvable ou hors des zones autoris\u00e9es.' });
        }
        const signed = await storageAdminRequest(`object/sign/${encodeURIComponent(STORAGE_BUCKET)}/${encodeStoragePath(record.pdf_path)}`, {
          method: 'POST', body: JSON.stringify({ expiresIn: 90 }),
        });
        const signedUrl = signed.signedURL || signed.signedUrl;
        if (!signedUrl) throw new Error('Lien de consultation s\u00e9curis\u00e9 indisponible.');
        const location = signedUrl.startsWith('http') ? signedUrl : `${SUPABASE_URL}/storage/v1${signedUrl.startsWith('/') ? signedUrl : `/${signedUrl}`}`;
        response.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
        return response.end();
      } catch (error) {
        return sendJson(response, 500, { error: `Ouverture du PDF impossible : ${error.message}` });
      }
    }
    const record = sourceRecordMetadata.get(id) || records.find((item) => item.id === id);
    const isSupervisor = profile.role === 'supervisor';
    if (!record || (!isSupervisor && (!(profile.permissions || []).includes('archives') || !(profile.zones || []).map(normalizeZone).includes(normalizeZone(record.zone))))) {
      return sendJson(response, 404, { error: 'PDF introuvable ou hors des zones autorisées.' });
    }
    const diskPath = sourceFilePaths.get(id) || (record?.sourcePath
      ? record.sourceRoot === surveyDirectory
        ? path.resolve(surveyDirectory, record.sourcePath)
        : null
      : record ? safeStoredPath(record.relativePath) : null);
    if (!diskPath) return sendJson(response, 404, { error: 'Enquête introuvable. Actualisez la liste.' });
    if (record?.sourcePath && !diskPath.startsWith(`${surveyDirectory}${path.sep}`)) {
      return sendJson(response, 403, { error: 'Chemin de fichier non autorisé.' });
    }
    if (!diskPath || !fs.existsSync(diskPath)) {
      return sendJson(response, 404, { error: "Le fichier PDF est introuvable dans le dossier d'archives." });
    }
    response.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Length': fs.statSync(diskPath).size,
      'Content-Disposition': `${url.searchParams.has('download') ? 'attachment' : 'inline'}; filename="${path.basename(diskPath)}"`,
      'X-Content-Type-Options': 'nosniff',
    });
    return fs.createReadStream(diskPath).pipe(response);
  }

  const requestedPath = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = path.resolve(APP_DIR, `.${requestedPath}`);
  if (!filePath.startsWith(`${APP_DIR}${path.sep}`) || requestedPath.startsWith('/data/') || filePath === path.resolve(PRODUCERS_DATABASE_PATH) || path.basename(filePath) === '.env' || !fs.existsSync(filePath)) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return response.end('Page introuvable.');
  }
  const contentTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' };
  response.writeHead(200, { 'Content-Type': contentTypes[path.extname(filePath)] || 'application/octet-stream' });
  return fs.createReadStream(filePath).pipe(response);
});

if (!CLOUD_MODE) {
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`RubberWay Archives disponible sur http://127.0.0.1:${PORT}`);
    console.log(`Dossier des enquêtes lu et utilisé pour les nouveaux fichiers : ${surveyDirectory}`);
    console.log(`Index de gestion : ${INDEX_PATH}`);
  });
}

export default function vercelHandler(request, response) {
  return server.emit('request', request, response);
}
