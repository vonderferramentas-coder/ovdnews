const state = { issues: [], filtered: [], active: 0, sortDesc: true, readerIssue: null, page: 0, query: '', zoom: 1 };
let pdfModulePromise;
let pdfCoverObserver;
let pageFlipInstance = null;
let readerRenderToken = 0;
let readerThumbsRendered = false;
let readerFlipPending = false;
const coverQueue = [];
let runningCoverJobs = 0;
const COVER_CACHE = 'ovd-news-covers-v1';
const $ = selector => document.querySelector(selector);
const els = {
  coverflow: $('#coverflow'), issueGrid: $('#issueGrid'), activeCaption: $('#activeCaption'),
  carouselPosition: $('#carouselPosition'), commandBackdrop: $('#commandBackdrop'), searchInput: $('#searchInput'),
  searchResults: $('#searchResults'), reader: $('#reader'), book: $('#book'), thumbnailRail: $('#thumbnailRail')
};

const formatDate = value => {
  if (!value) return '';
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat('pt-BR',{month:'long',year:'numeric'}).format(date);
};

function normalize(value='') { return value.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase(); }

function placeholderCover(issue) {
  const label = String(issue.number).padStart(3, '0');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 800"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="#243048"/><stop offset="1" stop-color="#101318"/></linearGradient></defs><rect width="600" height="800" fill="url(#g)"/><text x="48" y="82" fill="#fff" font-family="Segoe UI,sans-serif" font-weight="700" font-size="28">OVD NEWS</text><path d="M48 112h504" stroke="#fff" opacity=".25"/><text x="48" y="650" fill="#fff" font-family="Segoe UI,sans-serif" font-size="22">EDIÇÃO</text><text x="48" y="735" fill="#fff" font-family="Segoe UI,sans-serif" font-weight="700" font-size="92">${label}</text></svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

async function getPdfModule() {
  if (!pdfModulePromise) pdfModulePromise = import('./vendor/pdf.min.mjs').then(module => {
    module.GlobalWorkerOptions.workerSrc = './vendor/pdf.worker.min.mjs';
    return module;
  });
  return pdfModulePromise;
}

async function ensurePdfIssue(issue) {
  if (!issue?.pdf) return issue;
  if (!issue._pdfPromise) issue._pdfPromise = getPdfModule().then(module => module.getDocument(issue.pdf).promise);
  issue._pdfDoc = await issue._pdfPromise;
  if (!issue.pageCount) issue.pageCount = issue._pdfDoc.numPages;
  if (!issue.pages?.length) {
    issue.pages = Array.from({ length: issue.pageCount }, (_, index) => index + 1);
    updateTotals();
    document.querySelectorAll(`[data-info-id="${CSS.escape(issue.id)}"]`).forEach(element => element.textContent = `${issue.pageCount} págs.`);
  }
  return issue;
}

async function renderPdfToCanvas(issue, pageNumber, canvas, targetWidth = 760) {
  await ensurePdfIssue(issue);
  if (!canvas) return;
  const page = await issue._pdfDoc.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: targetWidth / base.width });
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
}

async function renderPdfPageUrl(issue, pageNumber, targetWidth = 1300) {
  issue._readerPageUrls ||= new Map();
  if (issue._readerPageUrls.has(pageNumber)) return issue._readerPageUrls.get(pageNumber);
  const promise = (async () => {
    const canvas = document.createElement('canvas');
    await renderPdfToCanvas(issue, pageNumber, canvas, targetWidth);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', .9));
    return URL.createObjectURL(blob);
  })();
  issue._readerPageUrls.set(pageNumber, promise);
  return promise;
}

function coverCacheUrl(issue) {
  const revision = issue.coverRevision || 'legacy';
  return `${location.origin}/__ovd-cover-cache/${encodeURIComponent(issue.id)}-${encodeURIComponent(revision)}.webp`;
}

async function useCachedPdfCover(issue) {
  if (!('caches' in window)) return false;
  const cache = await caches.open(COVER_CACHE);
  const response = await cache.match(coverCacheUrl(issue));
  if (!response) return false;
  const blob = await response.blob();
  issue.cover = URL.createObjectURL(blob);
  const count = Number(response.headers.get('X-Page-Count') || 0);
  if (count) {
    issue.pageCount = count;
    issue.pages = Array.from({ length: count }, (_, index) => index + 1);
  }
  if (issue.coverUpload) {
    fetch(issue.coverUpload, {
      method: 'POST',
      headers: { 'Content-Type': 'image/webp', 'X-Page-Count': String(count || 0) },
      body: blob
    }).catch(() => {});
  }
  return true;
}

async function savePdfCover(issue, blob, pageCount) {
  const jobs = [];
  if ('caches' in window) {
    jobs.push(caches.open(COVER_CACHE).then(cache => cache.put(coverCacheUrl(issue), new Response(blob, {
      headers: { 'Content-Type': 'image/webp', 'X-Page-Count': String(pageCount || 0) }
    }))));
  }
  if (issue.coverUpload) {
    jobs.push(fetch(issue.coverUpload, {
      method: 'POST',
      headers: { 'Content-Type': 'image/webp', 'X-Page-Count': String(pageCount || 0) },
      body: blob
    }));
  }
  await Promise.allSettled(jobs);
}

function applyPdfCover(issue) {
  document.querySelectorAll(`[data-cover-id="${CSS.escape(issue.id)}"]`).forEach(image => image.src = issue.cover);
  updateTotals();
  document.querySelectorAll(`[data-info-id="${CSS.escape(issue.id)}"]`).forEach(element => {
    element.textContent = issue.pageCount ? `${issue.pageCount} págs.` : 'PDF';
  });
  renderCoverMeta();
}

async function ensurePdfCover(issue) {
  if (!issue?.pdf || issue.cover) return;
  if (!issue._coverPromise) issue._coverPromise = (async () => {
    if (await useCachedPdfCover(issue)) {
      applyPdfCover(issue);
      return;
    }
    const pdfModule = await getPdfModule();
    const task = pdfModule.getDocument({
      url: issue.pdf,
      disableAutoFetch: true,
      disableStream: true,
      rangeChunkSize: 65536
    });
    const previewDocument = await task.promise;
    const canvas = document.createElement('canvas');
    const page = await previewDocument.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: 620 / base.width });
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', .84));
    issue.pageCount = previewDocument.numPages;
    issue.pages = Array.from({ length: issue.pageCount }, (_, index) => index + 1);
    issue.cover = URL.createObjectURL(blob);
    await savePdfCover(issue, blob, issue.pageCount);
    await previewDocument.destroy();
    applyPdfCover(issue);
  })().catch(() => showToast(`Não foi possível gerar a capa da ${issue.title}.`));
  return issue._coverPromise;
}

function runCoverQueue() {
  while (runningCoverJobs < 2 && coverQueue.length) {
    const job = coverQueue.shift();
    runningCoverJobs += 1;
    ensurePdfCover(job.issue).finally(() => {
      runningCoverJobs -= 1;
      job.resolve();
      runCoverQueue();
    });
  }
}

function queuePdfCover(issue, priority = false) {
  if (!issue?.pdf || issue.cover) return Promise.resolve();
  if (issue._coverQueuedPromise) return issue._coverQueuedPromise;
  issue._coverQueuedPromise = new Promise(resolve => {
    const job = { issue, resolve };
    priority ? coverQueue.unshift(job) : coverQueue.push(job);
    runCoverQueue();
  });
  return issue._coverQueuedPromise;
}

function updateTotals() {
  $('#issueCount').textContent = state.issues.length;
  $('#pageCount').textContent = state.issues.reduce((sum, issue) => sum + Number(issue.pageCount || 0), 0) || '—';
}

function observePdfCovers() {
  pdfCoverObserver?.disconnect();
  pdfCoverObserver = new IntersectionObserver(entries => entries.forEach(entry => {
    if (!entry.isIntersecting) return;
    const issue = state.issues.find(item => item.id === entry.target.dataset.coverId);
    if (issue?.pdf) queuePdfCover(issue);
    pdfCoverObserver.unobserve(entry.target);
  }), { rootMargin: '700px 0px' });
  document.querySelectorAll('#issueGrid [data-cover-id]').forEach(image => pdfCoverObserver.observe(image));
  state.filtered
    .map((issue, index) => ({ issue, distance: Math.abs(relativeOffset(index, state.active, state.filtered.length)) }))
    .filter(item => item.issue.pdf && item.distance <= 2)
    .sort((a, b) => b.distance - a.distance)
    .forEach(item => queuePdfCover(item.issue, true));
}

async function loadIssues() {
  try {
    const response = await fetch('/api/edicoes', { cache: 'no-store' });
    if (!response.ok) throw new Error('API indisponível');
    const data = await response.json();
    state.issues = data.issues;
  } catch (error) {
    // ponytail: mantenha esta lista em sincronia ao adicionar PDFs no Pages; use uma API quando o acervo precisar ser atualizado sem publicar.
    state.issues = [1, 2, 3, ...Array.from({ length: 36 }, (_, index) => index + 5)].map(number => ({
      id: `pdf-${String(number).padStart(3, '0')}`, number, title: `Edição nº ${number}`,
      eyebrow: 'Revista OVD', date: '', year: 0, category: 'Acervo PDF', description: '',
      featured: false, tags: [String(number)], pageCount: 0, cover: '', pages: [], sourceType: 'pdf',
      pdf: `./arquivos/${String(number).padStart(3, '0')}.pdf`
    }));
    const sourceBase = 'https://www.ovd.com.br/ftp/GRAFICOS/teste/aplicativo/acervo-digital/acervo/arquivos/edicao-0142';
    state.issues.unshift({
      id: '0142', number: 142, title: 'Edição nº 142', eyebrow: 'Revista OVD', date: '2022-08', year: 2022,
      category: 'Economia', description: '', featured: true, tags: ['economia', 'negócios', 'ovd'], pageCount: 12,
      cover: `${sourceBase}/pagina-01.webp`, pages: Array.from({ length: 12 }, (_, index) => `${sourceBase}/pagina-${String(index + 1).padStart(2, '0')}.webp`)
    });
  }
  state.issues.sort((a, b) => Number(b.number) - Number(a.number));
  state.filtered = [...state.issues];
  updateTotals();
  $('#scanStatus').textContent = `${state.issues.length} edições sincronizadas`;
  render();
}

function render() { renderCoverflow(); renderGrid(); requestAnimationFrame(observePdfCovers); }

function relativeOffset(index, active, length) {
  let offset = index - active;
  if (offset > length / 2) offset -= length;
  if (offset < -length / 2) offset += length;
  return offset;
}

function renderCoverflow() {
  const issues = state.filtered;
  if (!issues.length) { els.coverflow.innerHTML = ''; els.activeCaption.innerHTML = ''; return; }
  state.active = Math.min(state.active, issues.length - 1);
  const signature = issues.map(issue => issue.id).join('|');
  if (els.coverflow.dataset.signature !== signature) {
    els.coverflow.dataset.signature = signature;
    els.coverflow.innerHTML = issues.map((issue,index) => `<button class="cover-card far" data-index="${index}" role="listitem" aria-label="Selecionar ${issue.title}"><span class="magazine-pages" aria-hidden="true"><i></i><i></i><i></i></span><img src="${issue.cover || placeholderCover(issue)}" data-cover-id="${issue.id}" alt="Capa da ${issue.title}" loading="${index===0?'eager':'lazy'}"><span class="page-label">${index+1} / ${issues.length}</span><span class="open-label">Abrir edição <b>↗</b></span></button>`).join('');
    requestAnimationFrame(() => positionCoverCards(issues));
  } else {
    positionCoverCards(issues);
  }
  renderCoverMeta();
}

function renderCoverMeta() {
  const issues = state.filtered;
  if (!issues.length) return;
  const active = issues[state.active];
  $('#archiveTitle').textContent = active.title;
  $('#archiveDate').textContent = [formatDate(active.date), active.category].filter(Boolean).join(' · ');
  els.activeCaption.innerHTML = active.pageCount ? `<strong>${active.pageCount}</strong> páginas` : '<strong>PDF</strong> carregando';
  els.carouselPosition.textContent = `${String(state.active+1).padStart(2,'0')} / ${String(issues.length).padStart(2,'0')}`;
}

function positionCoverCards(issues) {
  [...els.coverflow.children].forEach((card,index) => {
    const offset = relativeOffset(index,state.active,issues.length);
    const visible = Math.abs(offset) <= 2;
    card.dataset.offset = visible ? offset : 'far';
    card.classList.toggle('active', offset === 0);
    card.classList.toggle('far', !visible);
    card.setAttribute('aria-label', `${offset === 0 ? 'Abrir' : 'Selecionar'} ${issues[index].title}`);
  });
}

function renderGrid() {
  $('#emptyState').hidden = Boolean(state.filtered.length);
  els.issueGrid.innerHTML = state.filtered.map(issue => `<button class="issue-tile" data-id="${issue.id}" aria-label="Ler ${issue.title}"><div class="tile-cover"><img src="${issue.cover || placeholderCover(issue)}" data-cover-id="${issue.id}" alt="Capa da ${issue.title}" loading="lazy"></div><div class="tile-info"><strong>${issue.title}</strong><span data-info-id="${issue.id}">${[formatDate(issue.date), issue.pageCount ? `${issue.pageCount} págs.` : 'PDF'].filter(Boolean).join(' · ')}</span></div></button>`).join('');
}

function moveCover(direction) {
  const length = state.filtered.length;
  if (!length) return;
  state.active = (state.active + direction + length) % length;
  renderCoverflow();
  observePdfCovers();
}

function applySearch(query) {
  state.query = query;
  const needle = normalize(query.trim());
  state.filtered = state.issues.filter(issue => normalize([issue.title,issue.number,issue.date,issue.year,issue.category,issue.description,...issue.tags].join(' ')).includes(needle));
  if (!state.sortDesc) state.filtered.reverse();
  state.active = 0;
  render(); renderSearchResults();
}

function renderSearchResults() {
  const results = state.query ? state.filtered.slice(0,6) : [];
  els.searchResults.innerHTML = results.length ? `<p class="command-label">Resultados</p>${results.map(issue => `<button class="result-item" data-id="${issue.id}"><img src="${issue.cover || placeholderCover(issue)}" data-cover-id="${issue.id}" alt=""><span><strong>${issue.title}</strong><small>${[formatDate(issue.date),issue.category].filter(Boolean).join(' · ')}</small></span><kbd>↵</kbd></button>`).join('')}` : state.query ? '<p class="command-label">Nenhum resultado encontrado</p>' : '';
}

function openCommand() { els.commandBackdrop.hidden = false; $('#commandTrigger').setAttribute('aria-expanded','true'); setTimeout(()=>els.searchInput.focus(),40); }
function closeCommand() { els.commandBackdrop.hidden = true; $('#commandTrigger').setAttribute('aria-expanded','false'); }

async function openReader(id) {
  const issue = state.issues.find(item => item.id === String(id));
  if (!issue) return;
  if (issue.pdf) {
    showToast(`Abrindo ${issue.title}...`);
    try { await ensurePdfIssue(issue); } catch { showToast('Não foi possível abrir este PDF.'); return; }
  }
  state.readerIssue = issue; state.page = 0; state.zoom = 1; readerThumbsRendered = false;
  els.reader.hidden = false; document.body.style.overflow = 'hidden';
  $('#readerTitle').textContent = issue.title; $('#readerDate').textContent = formatDate(issue.date);
  els.thumbnailRail.innerHTML = issue.pdf
    ? issue.pages.map((page,index)=>`<button data-page="${index}" aria-label="Ir para página ${index+1}"><canvas data-thumb-page="${page}" aria-label="Página ${index+1}"></canvas></button>`).join('')
    : issue.pages.map((page,index)=>`<button data-page="${index}" aria-label="Ir para página ${index+1}"><img src="${page}" alt="Página ${index+1}" loading="lazy"></button>`).join('');
  applyZoom(); await initPageFlip(issue); closeCommand();
}

async function renderPdfThumbnails(issue) {
  for (const canvas of els.thumbnailRail.querySelectorAll('[data-thumb-page]')) {
    if (state.readerIssue !== issue) break;
    await renderPdfToCanvas(issue, Number(canvas.dataset.thumbPage), canvas, 150);
  }
}

function resetPageFlip() {
  readerRenderToken += 1;
  if (!pageFlipInstance) return;
  try { pageFlipInstance.destroy(); } catch {}
  pageFlipInstance = null;
  const mount = document.createElement('div');
  mount.className = 'book'; mount.id = 'book';
  $('#bookShell').insertBefore(mount, $('#bookShell').firstChild);
  els.book = mount;
}

function closeReader() { cancelPageTurn(); resetPageFlip(); readerFlipPending = false; els.reader.hidden = true; document.body.style.overflow = ''; state.readerIssue = null; state.zoom = 1; }

function getSpreadStart(page) { if (page === 0) return 0; return page % 2 === 0 ? page - 1 : page; }

function readerPagePlaceholder(pageNumber) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 840"><rect width="600" height="840" fill="#f5f2ea"/><path d="M0 0h600v840H0z" fill="url(#p)" opacity=".18"/><defs><pattern id="p" width="7" height="7" patternUnits="userSpaceOnUse"><path d="M0 0v7" stroke="#9e9a91" stroke-width="1"/></pattern></defs><text x="300" y="420" text-anchor="middle" fill="#9d9990" font-family="Segoe UI,sans-serif" font-size="18">Página ${pageNumber}</text></svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function syncReaderControls(pageIndex = 0) {
  const issue = state.readerIssue; if (!issue) return;
  const portrait = pageFlipInstance?.getOrientation() === 'portrait';
  const start = Number(pageIndex || 0);
  const end = Math.min(issue.pageCount, start + (start === 0 || portrait ? 1 : 2));
  state.page = start;
  $('#bookShell').classList.toggle('book-opened', start > 0 && end > start + 1 && !portrait);
  const label = start === 0 ? `Capa · 1 de ${issue.pageCount}` : `Páginas ${start+1}${end>start+1?`–${end}`:''} de ${issue.pageCount}`;
  $('#pageIndicator').textContent = label;
  $('#readerProgress').style.width = `${Math.min(100,(end/issue.pageCount)*100)}%`;
  $('#prevPage').disabled = $('#readerPrev').disabled = start===0;
  $('#nextPage').disabled = $('#readerNext').disabled = end>=issue.pageCount;
  $('#readerFirst').disabled = start === 0;
  $('#readerLast').disabled = end >= issue.pageCount;
  els.thumbnailRail.querySelectorAll('button').forEach((button,index)=>button.classList.toggle('active', index>=start&&index<end));
}

async function hydrateReaderPage(issue, pageNumber, token = readerRenderToken) {
  if (token !== readerRenderToken || state.readerIssue !== issue) return false;
  const src = issue.pdf ? (pageNumber === 1 && issue.cover ? issue.cover : await renderPdfPageUrl(issue, pageNumber)) : issue.pages[pageNumber - 1];
  if (token !== readerRenderToken || state.readerIssue !== issue) return false;
  const images = [...els.book.querySelectorAll(`[data-reader-page="${pageNumber}"]`)];
  images.forEach(image => image.src = src);
  await Promise.all(images.map(image => image.decode?.().catch(() => undefined)));
  return token === readerRenderToken && state.readerIssue === issue;
}

async function hydrateReaderPages(issue, token) {
  const order = Array.from({ length: issue.pageCount }, (_, index) => index + 1);
  for (const pageNumber of order) {
    if (!await hydrateReaderPage(issue, pageNumber, token)) return;
  }
}

async function initPageFlip(issue) {
  resetPageFlip();
  const token = ++readerRenderToken;
  els.book.innerHTML = issue.pages.map((_, index) => {
    const pageNumber = index + 1;
    const initial = issue.pdf ? (pageNumber === 1 && issue.cover ? issue.cover : readerPagePlaceholder(pageNumber)) : issue.pages[index];
    return `<div class="flip-page"><img data-reader-page="${pageNumber}" src="${initial}" alt="Página ${pageNumber} de ${issue.pageCount}"></div>`;
  }).join('');
  pageFlipInstance = new St.PageFlip(els.book, {
    width: 540, height: 760, size: 'stretch',
    minWidth: 250, maxWidth: 610, minHeight: 352, maxHeight: 858,
    drawShadow: true, maxShadowOpacity: .46, flippingTime: 720,
    autoSize: false,
    usePortrait: true, mobileScrollSupport: false, showCover: true,
    showPageCorners: false, disableFlipByClick: false
  });
  pageFlipInstance.on('flip', event => syncReaderControls(Number(event.data || 0)));
  pageFlipInstance.on('changeState', event => {
    $('#bookShell').classList.toggle('is-page-flipping', event.data === 'user_fold' || event.data === 'flipping');
    if (event.data === 'read') readerFlipPending = false;
  });
  pageFlipInstance.on('changeOrientation', event => {
    $('#bookShell').dataset.orientation = event.data;
    syncReaderControls(pageFlipInstance.getCurrentPageIndex());
  });
  pageFlipInstance.loadFromHTML([...els.book.querySelectorAll('.flip-page')]);
  // Mantém capa e contracapa em páginas isoladas, sem o comportamento rígido.
  pageFlipInstance.getPage(0).setDensity('soft');
  pageFlipInstance.getPage(issue.pageCount - 1).setDensity('soft');
  $('#bookShell').dataset.orientation = pageFlipInstance.getOrientation();
  readerFlipPending = false;
  syncReaderControls(0);
  hydrateReaderPages(issue, token);
}

function renderPages() {
  if (!pageFlipInstance) return;
  pageFlipInstance.turnToPage(state.page);
  syncReaderControls(pageFlipInstance.getCurrentPageIndex());
}

function getTargetPageIndex(direction) {
  const issue = state.readerIssue;
  if (!issue || !pageFlipInstance) return null;
  const current = pageFlipInstance.getCurrentPageIndex();
  if (direction > 0) return current === 0 ? 1 : current + 2;
  if (current === issue.pageCount - 1) return Math.max(0, current - 2);
  return current === 1 ? 0 : current - 2;
}

async function turnPage(direction) {
  const issue = state.readerIssue;
  if (!pageFlipInstance || !issue || readerFlipPending) return;
  const target = getTargetPageIndex(direction);
  if (target === null || target < 0 || target >= issue.pageCount) return;
  readerFlipPending = true;
  const pageIndexes = target === 0 || target === issue.pageCount - 1 ? [target] : [target, target + 1];
  const ready = await Promise.all(pageIndexes.filter(index => index < issue.pageCount).map(index => hydrateReaderPage(issue, index + 1)));
  if (!ready.every(Boolean) || state.readerIssue !== issue || !pageFlipInstance) { readerFlipPending = false; return; }
  direction > 0 ? pageFlipInstance.flipNext('bottom') : pageFlipInstance.flipPrev('bottom');
}

function applyZoom() {
  state.zoom = Math.max(.75, Math.min(2.5, state.zoom));
  $('#zoomLevel').textContent = `${Math.round(state.zoom * 100)}%`;
  $('#bookShell').style.setProperty('--reader-zoom', state.zoom);
  const zoomed = state.zoom > 1.01;
  $('#readerStage').classList.toggle('zoomed', zoomed);
  if (!zoomed) {
    $('#readerStage').scrollTo({ left: 0, top: 0 });
    return;
  }
  requestAnimationFrame(() => {
    const stage = $('#readerStage');
    stage.scrollLeft = Math.max(0, (stage.scrollWidth - stage.clientWidth) / 2);
    stage.scrollTop = Math.max(0, (stage.scrollHeight - stage.clientHeight) / 2);
  });
}

const zoomPan = { active: false, pointerId: null, startX: 0, startY: 0, scrollLeft: 0, scrollTop: 0 };

function finishZoomPan(event) {
  if (!zoomPan.active || event.pointerId !== zoomPan.pointerId) return;
  const shell = $('#bookShell');
  if (shell.hasPointerCapture(event.pointerId)) shell.releasePointerCapture(event.pointerId);
  shell.classList.remove('is-panning');
  Object.assign(zoomPan, { active: false, pointerId: null });
}

const pageTurn = { active: false, animating: false, pointerId: null, direction: 0, startX: 0, progress: 0, moved: false, leaf: null, underlay: null, source: null };

function canTurnPage(direction) {
  const issue = state.readerIssue;
  if (!issue) return false;
  const start = getSpreadStart(state.page);
  return direction < 0 ? start > 0 : start + (start === 0 ? 1 : 2) < issue.pageCount;
}

function pageSnapshot(element) {
  if (element instanceof HTMLCanvasElement) return element.toDataURL('image/jpeg', .9);
  return element?.currentSrc || element?.src || '';
}

function createTurningLeaf(direction) {
  const source = direction > 0 ? els.book.lastElementChild : els.book.firstElementChild;
  if (!source) return null;
  const shellRect = $('#bookShell').getBoundingClientRect();
  const rect = source.getBoundingClientRect();
  const leaf = document.createElement('div');
  const underlay = document.createElement('div');
  underlay.className = 'turn-underlay';
  Object.assign(underlay.style, {
    left: `${rect.left - shellRect.left}px`, top: `${rect.top - shellRect.top}px`,
    width: `${rect.width}px`, height: `${rect.height}px`
  });
  leaf.className = `turning-leaf ${direction > 0 ? 'turning-next' : 'turning-prev'}`;
  Object.assign(leaf.style, {
    left: `${rect.left - shellRect.left}px`, top: `${rect.top - shellRect.top}px`,
    width: `${rect.width}px`, height: `${rect.height}px`, '--turn-angle': '0deg'
  });
  const snapshot = pageSnapshot(source);
  leaf.innerHTML = `<span class="leaf-face leaf-front"><img src="${snapshot}" alt=""></span><span class="leaf-face leaf-back"></span><i class="leaf-light"></i>`;
  $('#bookShell').append(underlay, leaf);
  source.classList.add('turn-source');
  return { leaf, underlay, source, width: rect.width };
}

function setTurnProgress(progress) {
  pageTurn.progress = Math.max(0, Math.min(1, progress));
  if (!pageTurn.leaf) return;
  const softened = 1 - Math.pow(1 - pageTurn.progress, 1.16);
  const direction = pageTurn.direction > 0 ? -1 : 1;
  const fade = softened < .9 ? 1 : Math.max(0, 1 - (softened - .9) / .1);
  pageTurn.leaf.style.setProperty('--turn-angle', `${direction * softened * 17}deg`);
  pageTurn.leaf.style.setProperty('--turn-shift', `${direction * softened * 13}%`);
  pageTurn.leaf.style.setProperty('--turn-skew', `${direction * softened * 1.4}deg`);
  pageTurn.leaf.style.setProperty('--curl-x', `${softened * 78}%`);
  pageTurn.leaf.style.setProperty('--curl-y', `${softened * 72}%`);
  pageTurn.leaf.style.setProperty('--shadow-x', `${direction * softened * 18}px`);
  pageTurn.leaf.style.setProperty('--shadow-y', `${10 + softened * 14}px`);
  pageTurn.leaf.style.setProperty('--shadow-blur', `${12 + softened * 24}px`);
  pageTurn.leaf.style.setProperty('--turn-light', .12 + softened * .48);
  pageTurn.leaf.style.setProperty('--turn-progress', softened);
  pageTurn.leaf.style.opacity = fade;
}

function clearTurningLeaf() {
  pageTurn.source?.classList.remove('turn-source');
  pageTurn.leaf?.remove();
  pageTurn.underlay?.remove();
  Object.assign(pageTurn, { active: false, animating: false, pointerId: null, direction: 0, progress: 0, moved: false, leaf: null, underlay: null, source: null });
  $('#bookShell').classList.remove('is-turning');
}

function cancelPageTurn() {
  if (pageTurn.leaf) clearTurningLeaf();
}

function finishPageTurn(complete) {
  if (!pageTurn.leaf || pageTurn.animating) return;
  pageTurn.animating = true;
  pageTurn.leaf.classList.add('settling');
  const leaf = pageTurn.leaf;
  const direction = pageTurn.direction;
  const from = pageTurn.progress;
  const target = complete ? 1 : 0;
  const duration = complete ? 520 : 300;
  const startedAt = performance.now();
  const animate = now => {
    if (pageTurn.leaf !== leaf) return;
    const elapsed = Math.min(1, (now - startedAt) / duration);
    const eased = 1 - Math.pow(1 - elapsed, 2.35);
    setTurnProgress(from + (target - from) * eased);
    if (elapsed < 1) return requestAnimationFrame(animate);
    clearTurningLeaf();
    if (complete) turnPage(direction);
  };
  requestAnimationFrame(animate);
}

function requestPageTurn(direction) {
  if (pageFlipInstance) return turnPage(direction);
  if (pageTurn.active || pageTurn.animating || !canTurnPage(direction)) return;
  const visual = createTurningLeaf(direction);
  if (!visual) return turnPage(direction);
  Object.assign(pageTurn, { active: true, animating: false, direction, leaf: visual.leaf, underlay: visual.underlay, source: visual.source, progress: 0 });
  $('#bookShell').classList.add('is-turning');
  requestAnimationFrame(() => finishPageTurn(true));
}

const carouselDrag = { active: false, moved: false, suppressClickUntil: 0, startX: 0, delta: 0, pointerId: null, lastStepAt: 0 };
$('#prevIssue').addEventListener('click',()=>moveCover(-1)); $('#nextIssue').addEventListener('click',()=>moveCover(1));
els.coverflow.addEventListener('click',event=>{if(performance.now()<carouselDrag.suppressClickUntil){event.preventDefault();return;}const card=event.target.closest('.cover-card');if(!card)return;const index=Number(card.dataset.index);if(index===state.active)openReader(state.filtered[index].id);else{state.active=index;renderCoverflow();observePdfCovers();}});
els.issueGrid.addEventListener('click',event=>{const tile=event.target.closest('.issue-tile');if(tile)openReader(tile.dataset.id);});
$('#commandTrigger').addEventListener('click',openCommand); els.commandBackdrop.addEventListener('click',event=>{if(event.target===els.commandBackdrop)closeCommand();});
els.searchInput.addEventListener('input',event=>applySearch(event.target.value));
els.searchResults.addEventListener('click',event=>{const result=event.target.closest('[data-id]');if(result)openReader(result.dataset.id);});
document.querySelectorAll('.command-item').forEach(button=>button.addEventListener('click',()=>{if(button.dataset.command==='latest'&&state.issues[0])openReader(state.issues[0].id);else{els.searchInput.value='';applySearch('');closeCommand();document.querySelector('.all-issues').scrollIntoView();}}));
$('#sortButton').addEventListener('click',()=>{state.sortDesc=!state.sortDesc;state.filtered.reverse();$('#sortButton').innerHTML=`${state.sortDesc?'Mais recentes':'Mais antigas'} <span>${state.sortDesc?'↓':'↑'}</span>`;state.active=0;render();});
['#closeReader','#closeReaderX'].forEach(selector=>$(selector).addEventListener('click',closeReader));
['#nextPage','#readerNext'].forEach(selector=>$(selector).addEventListener('click',()=>requestPageTurn(1))); ['#prevPage','#readerPrev'].forEach(selector=>$(selector).addEventListener('click',()=>requestPageTurn(-1)));
$('#readerFirst').addEventListener('click',()=>{if(state.readerIssue){cancelPageTurn();state.page=0;renderPages();}});
$('#readerLast').addEventListener('click',()=>{if(state.readerIssue){cancelPageTurn();state.page=Math.max(0,state.readerIssue.pageCount-1);renderPages();}});
$('#toggleThumbs').addEventListener('click',()=>{
  els.thumbnailRail.hidden = !els.thumbnailRail.hidden;
  if (!els.thumbnailRail.hidden && !readerThumbsRendered && state.readerIssue?.pdf) {
    readerThumbsRendered = true;
    renderPdfThumbnails(state.readerIssue);
  }
});
els.thumbnailRail.addEventListener('click',event=>{const button=event.target.closest('[data-page]');if(button){state.page=Number(button.dataset.page);renderPages();}});
$('#zoomIn').addEventListener('click',()=>{state.zoom+=.25;applyZoom();});
$('#zoomOut').addEventListener('click',()=>{state.zoom-=.25;applyZoom();});
$('#resetZoom').addEventListener('click',()=>{state.zoom=1;applyZoom();});
$('#toggleFullscreen').addEventListener('click',async()=>{try{if(!document.fullscreenElement)await els.reader.requestFullscreen();else await document.exitFullscreen();}catch{showToast('Tela cheia não disponível neste navegador.');}});
$('#infoButton').addEventListener('click',()=>showToast('O acervo é atualizado automaticamente a partir da pasta de edições.'));
document.addEventListener('keydown',event=>{
  if(event.key==='/'&&!state.readerIssue){event.preventDefault();openCommand();}
  if(event.key==='Escape'){if(state.readerIssue)closeReader();else closeCommand();}
  if(state.readerIssue&&event.key==='ArrowRight')requestPageTurn(1); if(state.readerIssue&&event.key==='ArrowLeft')requestPageTurn(-1);
  if(state.readerIssue&&(event.key==='+'||event.key==='=')){state.zoom+=.25;applyZoom();}
  if(state.readerIssue&&event.key==='-'){state.zoom-=.25;applyZoom();}
  if(state.readerIssue&&event.key==='0'){state.zoom=1;applyZoom();}
  if(!els.commandBackdrop.hidden&&event.key==='Enter'&&state.filtered[0])openReader(state.filtered[0].id);
});
$('#bookShell').addEventListener('pointerdown', event => {
  if (state.zoom > 1.01) {
    if (event.button !== 0) return;
    const stage = $('#readerStage');
    Object.assign(zoomPan, { active: true, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, scrollLeft: stage.scrollLeft, scrollTop: stage.scrollTop });
    $('#bookShell').classList.add('is-panning');
    $('#bookShell').setPointerCapture(event.pointerId);
    event.preventDefault();
    return;
  }
  if (pageFlipInstance) return;
  if (event.button !== 0 || pageTurn.active || pageTurn.animating) return;
  const rect = $('#bookShell').getBoundingClientRect();
  const direction = event.clientX < rect.left + rect.width / 2 ? -1 : 1;
  if (!canTurnPage(direction)) return;
  const visual = createTurningLeaf(direction);
  if (!visual) return;
  Object.assign(pageTurn, { active: true, animating: false, pointerId: event.pointerId, direction, startX: event.clientX, progress: 0, moved: false, leaf: visual.leaf, underlay: visual.underlay, source: visual.source, width: visual.width });
  $('#bookShell').classList.add('is-turning');
  $('#bookShell').setPointerCapture(event.pointerId);
  event.preventDefault();
});
$('#bookShell').addEventListener('pointermove', event => {
  if (zoomPan.active && event.pointerId === zoomPan.pointerId) {
    const stage = $('#readerStage');
    stage.scrollLeft = zoomPan.scrollLeft - (event.clientX - zoomPan.startX);
    stage.scrollTop = zoomPan.scrollTop - (event.clientY - zoomPan.startY);
    event.preventDefault();
    return;
  }
  if (!pageTurn.active || pageTurn.animating || event.pointerId !== pageTurn.pointerId) return;
  const distance = pageTurn.direction > 0 ? pageTurn.startX - event.clientX : event.clientX - pageTurn.startX;
  if (Math.abs(distance) > 4) pageTurn.moved = true;
  setTurnProgress(distance / Math.max(120, pageTurn.width * .82));
});
function releasePagePointer(event, cancelled = false) {
  if (!pageTurn.active || pageTurn.animating || event.pointerId !== pageTurn.pointerId) return;
  if ($('#bookShell').hasPointerCapture(event.pointerId)) $('#bookShell').releasePointerCapture(event.pointerId);
  finishPageTurn(!cancelled && (!pageTurn.moved || pageTurn.progress > .2));
}
$('#bookShell').addEventListener('pointerup', event => releasePagePointer(event));
$('#bookShell').addEventListener('pointercancel', event => releasePagePointer(event, true));
$('#bookShell').addEventListener('pointerup', finishZoomPan);
$('#bookShell').addEventListener('pointercancel', finishZoomPan);
$('#bookShell').addEventListener('lostpointercapture', finishZoomPan);
$('#bookShell').addEventListener('mousedown', event => {
  if (state.zoom > 1.01) { event.preventDefault(); event.stopPropagation(); }
}, true);
els.coverflow.addEventListener('dragstart', event => event.preventDefault());
els.coverflow.addEventListener('pointerdown', event => {
  if (event.button !== 0) return;
  Object.assign(carouselDrag, { active: true, moved: false, suppressClickUntil: 0, startX: event.clientX, delta: 0, pointerId: event.pointerId, lastStepAt: 0 });
  els.coverflow.classList.add('dragging');
  els.coverflow.style.transform = 'none';
});
window.addEventListener('pointermove', event => {
  if (!carouselDrag.active || event.pointerId !== carouselDrag.pointerId) return;
  carouselDrag.delta = event.clientX - carouselDrag.startX;
  const stepDistance = event.pointerType === 'touch' ? 105 : 150;
  const now = performance.now();
  if (Math.abs(carouselDrag.delta) > stepDistance && now - carouselDrag.lastStepAt > 360) {
    carouselDrag.moved = true;
    moveCover(carouselDrag.delta < 0 ? 1 : -1);
    carouselDrag.startX = event.clientX;
    carouselDrag.delta = 0;
    carouselDrag.lastStepAt = now;
  }
});
function finishCarouselDrag(event, cancelled = false) {
  if (!carouselDrag.active || event.pointerId !== carouselDrag.pointerId) return;
  carouselDrag.active = false;
  carouselDrag.suppressClickUntil = carouselDrag.moved ? performance.now() + 180 : 0;
  els.coverflow.classList.remove('dragging');
  els.coverflow.style.transform = 'none';
}
els.coverflow.addEventListener('pointerup', event => finishCarouselDrag(event));
els.coverflow.addEventListener('pointercancel', event => finishCarouselDrag(event, true));
window.addEventListener('pointerup', event => finishCarouselDrag(event), true);
window.addEventListener('blur', () => {
  carouselDrag.active = false;
  carouselDrag.suppressClickUntil = carouselDrag.moved ? performance.now() + 180 : 0;
  els.coverflow.classList.remove('dragging');
  els.coverflow.style.transform = 'none';
});
function showToast(message){const toast=$('#toast');toast.textContent=message;toast.classList.add('show');setTimeout(()=>toast.classList.remove('show'),2600);}
loadIssues();
