const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

const state = {
  file: null, jobs: [], documents: [], folders: [], products: [],
  selectedFolder: 'all', activeJobId: null, pollTimer: null,
  diagnostics: null, editingProduct: null, removeProductImageIds: new Set(), deepSeekTemplate: ''
};

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}
function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}
function formatDuration(seconds) {
  if (!seconds) return '';
  if (seconds < 60) return '< 1 мин';
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} мин` : `${Math.floor(minutes / 60)} ч ${minutes % 60} мин`;
}
function formatDate(iso) {
  return new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
}
function statusLabel(status) {
  return ({ queued: 'В очереди', processing: 'В работе', done: 'Готово', failed: 'Ошибка', canceled: 'Остановлено' })[status] || status;
}
function toast(message, error = false) {
  const box = $('#toast');
  box.textContent = message;
  box.classList.toggle('error', error);
  box.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => box.classList.add('hidden'), 4500);
}
function showNotice(message, good = false) {
  const box = $('#notice');
  box.textContent = message;
  box.classList.remove('hidden', 'good');
  if (good) box.classList.add('good');
}
function clearNotice() { $('#notice').classList.add('hidden'); }

async function api(url, options) {
  const response = await fetch(url, options);
  let body = {};
  try { body = await response.json(); } catch {}
  if (!response.ok) throw new Error(body.error || 'Локальное приложение вернуло ошибку.');
  return body;
}

function goTo(page) {
  $$('.page').forEach(node => node.classList.toggle('active', node.id === `page-${page}`));
  $$('.nav-item').forEach(node => node.classList.toggle('active', node.dataset.page === page));
  if (page === 'library') loadLibrary();
  if (page === 'products') loadProducts();
  if (page === 'diagnostics') loadDiagnostics();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
$$('[data-page]').forEach(button => button.addEventListener('click', () => goTo(button.dataset.page)));
$$('[data-close-dialog]').forEach(button => button.addEventListener('click', () => document.getElementById(button.dataset.closeDialog)?.close()));

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('travnik-theme', theme);
  $('#theme-icon').textContent = theme === 'dark' ? '☀' : '☾';
  $('#theme-label').textContent = theme === 'dark' ? 'Светлая тема' : 'Тёмная тема';
}
applyTheme(document.documentElement.dataset.theme || 'light');
$('#theme-toggle').addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));

$$('.source-tab').forEach(button => button.addEventListener('click', () => {
  $$('.source-tab').forEach(node => node.classList.toggle('active', node === button));
  $$('.source-panel').forEach(node => node.classList.toggle('active', node.id === `source-${button.dataset.source}`));
  clearNotice();
}));

const dropZone = $('#drop-zone');
const fileInput = $('#file-input');
for (const eventName of ['dragenter', 'dragover']) dropZone.addEventListener(eventName, event => { event.preventDefault(); dropZone.classList.add('dragging'); });
for (const eventName of ['dragleave', 'drop']) dropZone.addEventListener(eventName, event => { event.preventDefault(); dropZone.classList.remove('dragging'); });
dropZone.addEventListener('drop', event => selectMediaFile(event.dataTransfer.files[0]));
fileInput.addEventListener('change', () => selectMediaFile(fileInput.files[0]));

function selectMediaFile(file) {
  if (!file) return;
  state.file = file;
  dropZone.classList.add('has-file');
  $('#drop-title').textContent = file.name;
  $('#drop-subtitle').textContent = formatBytes(file.size);
  $('#start-file').disabled = false;
  clearNotice();
}

function uploadFile(file, onProgress = null) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = event => {
      if (event.lengthComputable) onProgress?.(Math.round(event.loaded / event.total * 100));
    };
    xhr.onerror = () => reject(new Error('Соединение с локальным приложением прервалось.'));
    xhr.onload = () => {
      let body = {};
      try { body = JSON.parse(xhr.responseText); } catch {}
      xhr.status >= 200 && xhr.status < 300 ? resolve(body) : reject(new Error(body.error || 'Не удалось загрузить файл.'));
    };
    xhr.send(file);
  });
}

$('#start-file').addEventListener('click', async () => {
  if (!state.file) return;
  const button = $('#start-file');
  const progress = $('#upload-progress');
  button.disabled = true;
  button.textContent = 'Копирую файл…';
  progress.classList.remove('hidden');
  clearNotice();
  try {
    const uploaded = await uploadFile(state.file, percent => progress.firstElementChild.style.width = `${percent}%`);
    const result = await api('/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'file', uploadId: uploaded.id, folderId: 'folder_lectures' }) });
    state.activeJobId = result.job.id;
    showNotice(result.duplicate ? 'Этот файл уже был расшифрован — открываю готовый результат.' : 'Лекция добавлена в очередь.', true);
    renderCurrentJob(result.job);
    schedulePoll(350);
  } catch (error) { showNotice(error.message); }
  finally {
    button.disabled = false;
    button.textContent = 'Начать расшифровку';
    progress.classList.add('hidden');
    progress.firstElementChild.style.width = '0';
  }
});

$('#start-url').addEventListener('click', async () => {
  const url = $('#url-input').value.trim();
  if (!url) return showNotice('Вставьте ссылку на запись.');
  const button = $('#start-url');
  button.disabled = true;
  button.textContent = 'Добавляю…';
  clearNotice();
  try {
    const result = await api('/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'url', url, folderId: 'folder_lectures' }) });
    state.activeJobId = result.job.id;
    showNotice('Ссылка добавлена в очередь.', true);
    renderCurrentJob(result.job);
    schedulePoll(350);
  } catch (error) { showNotice(error.message); }
  finally { button.disabled = false; button.textContent = 'Загрузить и расшифровать'; }
});

function jobActions(job) {
  const downloads = job.status === 'done' ? job.downloads.map(item => `<a class="download-link" href="${item.url}">↓ ${escapeHtml(item.label || item.ext.toUpperCase())}</a>`).join('') : '';
  const deepSeek = job.status === 'done' ? `<button class="secondary-button" data-deepseek="${job.id}">Конспект в DeepSeek</button>` : '';
  const retry = job.status === 'failed' ? `<button class="secondary-button" data-retry="${job.id}">Повторить</button>` : '';
  const cancel = ['queued', 'processing'].includes(job.status) ? `<button class="danger-button" data-cancel="${job.id}">Остановить</button>` : '';
  return downloads + deepSeek + retry + cancel;
}

function renderCurrentJob(job) {
  if (!job) return;
  const box = $('#current-job');
  box.classList.remove('hidden');
  box.innerHTML = `<div class="job-head"><div><p class="eyebrow">Текущее задание</p><h2>${escapeHtml(job.sourceName)}</h2></div><span class="status-pill ${job.status}">${statusLabel(job.status)}</span></div>
    <div class="progress-track"><span style="width:${job.progress || 0}%"></span></div>
    <div class="job-meta"><span>${escapeHtml(job.stage)}</span><span>${job.progress || 0}%${job.durationSeconds ? ` · ${formatDuration(job.durationSeconds)}` : ''}</span></div>
    ${job.errorMessage ? `<div class="job-error"><strong>Что произошло:</strong> ${escapeHtml(job.errorMessage)}</div>` : ''}
    ${job.status === 'done' && job.warningMessage ? `<div class="job-warning"><strong>Обратите внимание:</strong> ${escapeHtml(job.warningMessage)}</div>` : ''}
    <div class="job-actions">${jobActions(job)}</div>
    ${job.log ? `<details class="tech-details"><summary>Технические подробности</summary><pre>${escapeHtml(job.log)}</pre></details>` : ''}`;
  box.querySelector('[data-retry]')?.addEventListener('click', () => retryJob(job.id));
  box.querySelector('[data-cancel]')?.addEventListener('click', () => cancelJob(job.id));
  box.querySelector('[data-deepseek]')?.addEventListener('click', () => openDeepSeek(job.id));
}

async function retryJob(id) {
  try { const result = await api(`/api/jobs/${id}/retry`, { method: 'POST' }); state.activeJobId = id; renderCurrentJob(result.job); schedulePoll(300); }
  catch (error) { toast(error.message, true); }
}
async function cancelJob(id) {
  try { const result = await api(`/api/jobs/${id}/cancel`, { method: 'POST' }); renderCurrentJob(result.job); schedulePoll(500); }
  catch (error) { toast(error.message, true); }
}

async function copyText(value) {
  try { await navigator.clipboard.writeText(value); return true; }
  catch {
    const area = document.createElement('textarea');
    area.value = value;
    area.style.position = 'fixed'; area.style.opacity = '0';
    document.body.append(area); area.select();
    const ok = document.execCommand('copy'); area.remove(); return ok;
  }
}
async function openDeepSeek(id) {
  const popup = window.open('about:blank', '_blank');
  try {
    const result = await api(`/api/jobs/${id}/deepseek-prompt`);
    const copied = await copyText(result.prompt);
    if (popup) popup.location.href = 'https://chat.deepseek.com/';
    else window.open('https://chat.deepseek.com/', '_blank');
    toast(copied ? 'Промпт скопирован. В DeepSeek нажмите Ctrl+V.' : 'DeepSeek открыт. Скопируйте промпт повторно из диагностики.', !copied);
  } catch (error) { popup?.close(); toast(error.message, true); }
}

async function loadDeepSeekTemplate() {
  if (!state.deepSeekTemplate) state.deepSeekTemplate = (await api('/api/deepseek-template')).prompt;
  $('#deepseek-template-text').value = state.deepSeekTemplate;
  return state.deepSeekTemplate;
}
$('#open-deepseek-template').addEventListener('click', async () => {
  try { await loadDeepSeekTemplate(); $('#prompt-modal').showModal(); }
  catch (error) { toast(error.message, true); }
});
$('#copy-deepseek-template').addEventListener('click', async () => {
  try { toast(await copyText(await loadDeepSeekTemplate()) ? 'Промпт скопирован.' : 'Не удалось скопировать промпт.', false); }
  catch (error) { toast(error.message, true); }
});
$('#launch-deepseek-template').addEventListener('click', async () => {
  try {
    const copied = await copyText(await loadDeepSeekTemplate());
    window.open('https://chat.deepseek.com/', '_blank');
    toast(copied ? 'DeepSeek открыт. Нажмите Ctrl+V.' : 'DeepSeek открыт. Скопируйте текст из окна вручную.', !copied);
  } catch (error) { toast(error.message, true); }
});

async function poll() {
  try {
    const body = await api('/api/jobs');
    state.jobs = body.jobs;
    const job = state.jobs.find(item => item.id === state.activeJobId) || state.jobs.find(item => ['processing', 'queued'].includes(item.status));
    if (job) { state.activeJobId = job.id; renderCurrentJob(job); }
    if ($('#page-library').classList.contains('active')) renderLibrary();
    schedulePoll(state.jobs.some(item => ['processing', 'queued'].includes(item.status)) ? 1800 : 6500);
  } catch { schedulePoll(5000); }
}
function schedulePoll(delay) { clearTimeout(state.pollTimer); state.pollTimer = setTimeout(poll, delay); }

async function loadHealth() {
  try {
    const status = await api('/api/health');
    const row = $('#health-row');
    const free = status.disk.freeBytes === null ? '' : ` · свободно ${formatBytes(status.disk.freeBytes)}`;
    row.textContent = status.ok ? `Safe Mode · ${status.safeMode.whisperThreads} потока${free}` : 'Не всё установлено — запустите install.cmd';
    row.classList.toggle('bad', !status.ok || (status.disk.freeBytes !== null && status.disk.freeBytes < 2 * 1024 ** 3));
  } catch { $('#health-row').textContent = 'Нет связи с локальным сервером'; }
}

async function loadLibrary() {
  try {
    const [folderBody, jobBody, documentBody] = await Promise.all([api('/api/folders'), api('/api/jobs'), api('/api/documents')]);
    state.folders = folderBody.folders;
    state.jobs = jobBody.jobs;
    state.documents = documentBody.documents;
    renderFolders();
    renderLibrary();
  } catch (error) { toast(error.message, true); }
}

function folderCount(id) {
  return state.jobs.filter(item => item.folderId === id).length + state.documents.filter(item => item.folderId === id).length;
}
function renderFolders() {
  const total = state.jobs.length + state.documents.length;
  $('#folder-tree').innerHTML = `<button class="folder-item ${state.selectedFolder === 'all' ? 'active' : ''}" data-folder="all"><span>Все файлы</span><small>${total}</small></button>` +
    state.folders.map(folder => `<button class="folder-item ${state.selectedFolder === folder.id ? 'active' : ''}" data-folder="${folder.id}"><span>${escapeHtml(folder.name)}</span><small>${folderCount(folder.id)}</small></button>`).join('');
  $('#folder-tree').querySelectorAll('[data-folder]').forEach(button => {
    button.addEventListener('click', () => { state.selectedFolder = button.dataset.folder; renderFolders(); renderLibrary(); });
    button.addEventListener('dragover', event => { event.preventDefault(); button.classList.add('drag-over'); });
    button.addEventListener('dragleave', () => button.classList.remove('drag-over'));
    button.addEventListener('drop', event => {
      event.preventDefault(); button.classList.remove('drag-over');
      const folderId = button.dataset.folder === 'all' ? null : button.dataset.folder;
      if (event.dataTransfer.files.length) return uploadDocuments([...event.dataTransfer.files], folderId);
      try { const item = JSON.parse(event.dataTransfer.getData('application/json')); moveLibraryItem(item, folderId); } catch {}
    });
  });
}

function documentIcon(item) {
  if (item.kind === 'job') return '▶';
  if (item.mimeType?.includes('pdf')) return 'PDF';
  if (item.mimeType?.includes('word')) return 'DOC';
  return 'TXT';
}

function renderLibrary() {
  const query = $('#library-search').value.trim().toLowerCase();
  if (query.length >= 2) return runSearch(query);
  const jobs = state.jobs.filter(item => state.selectedFolder === 'all' || item.folderId === state.selectedFolder).map(item => ({ ...item, kind: 'job', name: item.sourceName }));
  const documents = state.documents.filter(item => state.selectedFolder === 'all' || item.folderId === state.selectedFolder).map(item => ({ ...item, kind: 'document' }));
  const items = [...jobs, ...documents].sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));
  const list = $('#library-list');
  if (!items.length) { list.innerHTML = '<div class="empty-state"><strong>В этой папке пока пусто</strong>Добавьте файл или перетащите его сюда.</div>'; return; }
  list.innerHTML = items.map(item => `<article class="library-card" draggable="true" data-kind="${item.kind}" data-id="${item.id}">
    <div class="library-icon">${documentIcon(item)}</div><div><h3>${escapeHtml(item.name)}</h3><p>${formatDate(item.createdAt)}${item.kind === 'job' ? ` · ${statusLabel(item.status)}${item.durationSeconds ? ` · ${formatDuration(item.durationSeconds)}` : ''}` : ` · ${formatBytes(item.size)}`}</p></div>
    <div class="library-actions">
      <button class="secondary-button" data-open="${item.id}" data-kind="${item.kind}">Открыть</button>
      ${item.kind === 'job' && item.status === 'done' ? `<button class="secondary-button" data-deepseek="${item.id}">DeepSeek</button>` : ''}
      ${item.kind === 'document' ? `<button class="danger-button" data-delete-doc="${item.id}">Удалить</button>` : ''}
      ${item.kind === 'job' ? `<button class="danger-button" data-delete-job="${item.id}">Удалить</button>` : ''}
    </div>
  </article>`).join('');
  bindLibraryActions(list);
}

function bindLibraryActions(list) {
  list.querySelectorAll('[data-delete-job]').forEach(button => button.addEventListener('click', async () => {
    if (!window.confirm('Удалить эту лекцию из истории и с диска?')) return;
    try { await api(`/api/jobs/${button.dataset.deleteJob}`, { method: 'DELETE' }); await loadLibrary(); toast('Лекция удалена.'); }
    catch (error) { toast(error.message, true); }
  }));
  list.querySelectorAll('.library-card').forEach(card => {
    card.addEventListener('dragstart', event => { card.classList.add('dragging'); event.dataTransfer.setData('application/json', JSON.stringify({ kind: card.dataset.kind, id: card.dataset.id })); });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
  });
  list.querySelectorAll('[data-open]').forEach(button => button.addEventListener('click', () => {
    if (button.dataset.kind === 'job') {
      const job = state.jobs.find(item => item.id === button.dataset.open);
      state.activeJobId = job?.id; renderCurrentJob(job); goTo('transcribe');
    } else previewDocument(state.documents.find(item => item.id === button.dataset.open));
  }));
  list.querySelectorAll('[data-deepseek]').forEach(button => button.addEventListener('click', () => openDeepSeek(button.dataset.deepseek)));
  list.querySelectorAll('[data-delete-doc]').forEach(button => button.addEventListener('click', () => removeDocument(button.dataset.deleteDoc)));
}

let searchRequest = 0;
async function runSearch(query) {
  const request = ++searchRequest;
  try {
    const body = await api(`/api/search?q=${encodeURIComponent(query)}`);
    if (request !== searchRequest) return;
    const list = $('#library-list');
    if (!body.results.length) { list.innerHTML = `<div class="empty-state"><strong>Ничего не найдено</strong>Попробуйте другое слово или форму слова.</div>`; return; }
    list.innerHTML = body.results.map(result => {
      const labels = { job: 'ЛЕКЦИЯ', document: 'ФАЙЛ', product: 'ЗАГОТОВКА' };
      return `<article class="library-card"><div class="library-icon">${labels[result.entity_type].slice(0,3)}</div><div><h3>${escapeHtml(result.title)}</h3><p>${escapeHtml(result.preview || 'Совпадение найдено в названии')}</p></div><div class="library-actions"><button class="secondary-button" data-search-open="${result.entity_id}" data-kind="${result.entity_type}">Открыть</button></div></article>`;
    }).join('');
    list.querySelectorAll('[data-search-open]').forEach(button => button.addEventListener('click', () => openSearchResult(button.dataset.kind, button.dataset.searchOpen)));
  } catch (error) { toast(error.message, true); }
}
function openSearchResult(kind, id) {
  if (kind === 'job') { const job = state.jobs.find(item => item.id === id); state.activeJobId = id; renderCurrentJob(job); goTo('transcribe'); }
  else if (kind === 'document') previewDocument(state.documents.find(item => item.id === id));
  else { const product = state.products.find(item => item.id === id); if (product) openProductModal(product); else loadProducts().then(() => openProductModal(state.products.find(item => item.id === id))); }
}

let searchTimer;
$('#library-search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(renderLibrary, 280); });
$('#add-documents').addEventListener('click', () => $('#document-input').click());
$('#document-input').addEventListener('change', () => uploadDocuments([...$('#document-input').files], state.selectedFolder === 'all' ? null : state.selectedFolder));
const documentDrop = $('#document-drop');
for (const name of ['dragenter', 'dragover']) documentDrop.addEventListener(name, event => { event.preventDefault(); documentDrop.classList.add('dragging'); });
for (const name of ['dragleave', 'drop']) documentDrop.addEventListener(name, event => { event.preventDefault(); documentDrop.classList.remove('dragging'); });
documentDrop.addEventListener('drop', event => uploadDocuments([...event.dataTransfer.files], state.selectedFolder === 'all' ? null : state.selectedFolder));

async function uploadDocuments(files, folderId) {
  const accepted = files.filter(file => /\.(pdf|docx?|txt|md)$/i.test(file.name));
  if (!accepted.length) return toast('Выберите PDF, DOCX, DOC, TXT или MD.', true);
  for (let index = 0; index < accepted.length; index++) {
    const file = accepted[index];
    toast(`Загружаю ${index + 1} из ${accepted.length}: ${file.name}`);
    try {
      const uploaded = await uploadFile(file);
      await api('/api/documents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uploadId: uploaded.id, folderId }) });
    } catch (error) { toast(`${file.name}: ${error.message}`, true); }
  }
  $('#document-input').value = '';
  await loadLibrary();
  toast('Файлы добавлены в библиотеку.');
}

async function moveLibraryItem(item, folderId) {
  try {
    const url = item.kind === 'job' ? `/api/jobs/${item.id}` : `/api/documents/${item.id}`;
    await api(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folderId }) });
    await loadLibrary();
    toast('Перемещено.');
  } catch (error) { toast(error.message, true); }
}

async function removeDocument(id) {
  const document = state.documents.find(item => item.id === id);
  if (!window.confirm(`Удалить файл «${document?.name || ''}»? Это действие нельзя отменить.`)) return;
  try { await api(`/api/documents/${id}`, { method: 'DELETE' }); await loadLibrary(); toast('Документ удалён.'); }
  catch (error) { toast(error.message, true); }
}

function previewDocument(document) {
  if (!document) return;
  if (!document.mimeType.includes('pdf') && !document.mimeType.startsWith('text/')) { window.open(document.downloadUrl, '_blank'); return; }
  $('#preview-title').textContent = document.name;
  $('#document-preview').src = document.previewUrl;
  $('#preview-download').href = document.downloadUrl;
  $('#preview-modal').showModal();
}
$('#close-preview').addEventListener('click', () => { $('#preview-modal').close(); $('#document-preview').src = 'about:blank'; });

$('#create-folder').addEventListener('click', () => { $('#folder-name').value = ''; $('#folder-modal').showModal(); setTimeout(() => $('#folder-name').focus(), 50); });
$('#folder-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (event.submitter?.value === 'cancel') { $('#folder-modal').close(); return; }
  try { await api('/api/folders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: $('#folder-name').value }) }); $('#folder-modal').close(); await loadLibrary(); toast('Папка создана.'); }
  catch (error) { toast(error.message, true); }
});

async function loadProducts() {
  try { const body = await api('/api/products'); state.products = body.products; renderProducts(); }
  catch (error) { toast(error.message, true); }
}
function renderProducts() {
  const grid = $('#product-grid');
  if (!state.products.length) { grid.innerHTML = '<div class="empty-state"><strong>Заготовок пока нет</strong>Добавьте первую карточку. Достаточно названия и фотографии.</div>'; return; }
  grid.innerHTML = state.products.map(product => `<button class="product-card" data-product="${product.id}"><div class="product-photo">${product.imageUrl ? `<img src="${product.imageUrl}" alt="">` : '⌁'}</div><div class="product-body"><h2>${escapeHtml(product.name)}</h2>${product.series ? `<p class="product-series">Серия: ${escapeHtml(product.series)}</p>` : ''}<p>${escapeHtml(product.description || product.composition || 'Описание можно добавить позже')}</p></div></button>`).join('');
  grid.querySelectorAll('[data-product]').forEach(card => card.addEventListener('click', () => openProductModal(state.products.find(item => item.id === card.dataset.product))));
}
$('#add-product').addEventListener('click', () => openProductModal(null));

function openProductModal(product) {
  $('#product-form').reset();
  state.editingProduct = product || null;
  state.removeProductImageIds = new Set();
  $('#product-id').value = product?.id || '';
  $('#product-modal-title').textContent = product ? 'Редактировать заготовку' : 'Новая заготовка';
  $('#product-name').value = product?.name || '';
  $('#product-series').value = product?.series || '';
  $('#product-description').value = product?.description || '';
  $('#product-composition').value = product?.composition || '';
  $('#product-indications').value = product?.indications || '';
  $('#product-contraindications').value = product?.contraindications || '';
  $('#product-application').value = product?.application || '';
  $('#delete-product').classList.toggle('hidden', !product);
  renderProductImageGallery();
  $('#product-modal').showModal();
}
function renderProductImageGallery() {
  const existing = (state.editingProduct?.images || []).filter(image => !state.removeProductImageIds.has(image.id));
  const selected = [...($('#product-image').files || [])];
  const gallery = $('#product-image-gallery');
  gallery.innerHTML = [
    ...existing.map(image => `<div class="gallery-image"><img src="${image.url}" alt=""><button type="button" data-remove-existing-image="${image.id}" aria-label="Убрать фотографию">×</button></div>`),
    ...selected.map(file => `<div class="gallery-image new"><img src="${URL.createObjectURL(file)}" alt=""><span>Новое</span></div>`)
  ].join('');
  gallery.querySelectorAll('[data-remove-existing-image]').forEach(button => button.addEventListener('click', () => {
    state.removeProductImageIds.add(button.dataset.removeExistingImage);
    renderProductImageGallery();
  }));
}
$('#product-image').addEventListener('change', renderProductImageGallery);

$('#product-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (event.submitter?.value === 'cancel') { $('#product-modal').close(); return; }
  const id = $('#product-id').value;
  const name = $('#product-name').value.trim();
  if (!name) return toast('Введите название заготовки.', true);
  const button = $('#save-product');
  button.disabled = true; button.textContent = 'Сохраняю…';
  try {
    const imageUploadIds = [];
    for (const imageFile of [...$('#product-image').files].slice(0, 12)) imageUploadIds.push((await uploadFile(imageFile)).id);
    const body = {
      name,
      series: $('#product-series').value,
      description: $('#product-description').value,
      composition: $('#product-composition').value,
      indications: $('#product-indications').value,
      contraindications: $('#product-contraindications').value,
      application: $('#product-application').value,
      imageUploadIds,
      removeImageIds: [...state.removeProductImageIds]
    };
    await api(id ? `/api/products/${id}` : '/api/products', { method: id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    $('#product-modal').close(); await loadProducts(); toast('Заготовка сохранена.');
  } catch (error) { toast(error.message, true); }
  finally { button.disabled = false; button.textContent = 'Сохранить'; }
});
$('#delete-product').addEventListener('click', async () => {
  const id = $('#product-id').value;
  if (!id || !window.confirm('Удалить эту заготовку и её фотографию? Это действие нельзя отменить.')) return;
  try { await api(`/api/products/${id}`, { method: 'DELETE' }); $('#product-modal').close(); await loadProducts(); toast('Заготовка удалена.'); }
  catch (error) { toast(error.message, true); }
});

function formatLog(lines) {
  if (!lines?.length) return 'Записей пока нет.';
  return lines.map(line => {
    try { const entry = JSON.parse(line); return `${new Date(entry.time).toLocaleString('ru-RU')}  ${entry.level.toUpperCase()}  ${entry.message}${Object.keys(entry.context || {}).length ? `\n  ${JSON.stringify(entry.context)}` : ''}${entry.error?.stack ? `\n  ${entry.error.stack}` : ''}`; }
    catch { return line; }
  }).join('\n\n');
}
async function loadDiagnostics() {
  try {
    state.diagnostics = await api('/api/diagnostics');
    const data = state.diagnostics;
    const free = data.health.disk.freeBytes;
    $('#diagnostic-summary').innerHTML = `<div class="diagnostic-card"><strong>${data.health.ok ? 'Готово' : 'Нужна настройка'}</strong><span>Компоненты распознавания</span></div><div class="diagnostic-card"><strong>${free === null ? '—' : formatBytes(free)}</strong><span>Свободно на диске с данными</span></div><div class="diagnostic-card"><strong>${data.health.safeMode.whisperThreads} потока</strong><span>Whisper Safe Mode</span></div>`;
    $('#error-log').textContent = formatLog(data.logs.errors);
    $('#app-log').textContent = formatLog(data.logs.app);
    $('#log-path').textContent = `Журналы находятся здесь: ${data.logPaths.errors}`;
  } catch (error) { toast(error.message, true); }
}
$('#refresh-diagnostics').addEventListener('click', loadDiagnostics);
$('#copy-diagnostics').addEventListener('click', async () => {
  if (!state.diagnostics) await loadDiagnostics();
  const ok = await copyText(JSON.stringify(state.diagnostics, null, 2));
  $('#copy-status').textContent = ok ? 'Скопировано. Можно отправить сыну.' : 'Не удалось скопировать.';
});

loadHealth();
loadProducts();
poll();
