/* ==========================================================================
   OVD News — acervo digital de revistas
   Organização deste arquivo:
     1. Estado e constantes        6. Busca (home e dentro da edição)
     2. Utilitários                7. Leitor (turn.js, controles, setas)
     3. PDF e capas                8. Zoom, lupa e interação com o livro
     4. Catálogo de edições        9. Eventos da interface
     5. Home (carrossel e grade)  10. Arraste do carrossel e inicialização
   Convenção de nomes: a busca por OCR usa nomes em português (legado do módulo);
   o restante usa inglês.
   ========================================================================== */

/* ---------- 1. Estado e constantes ---------- */

const state = {
  issues: [],          // todas as edições do catálogo
  filtered: [],        // edições após filtro de ano/busca (e ordenação)
  active: 0,           // índice da capa em destaque no carrossel
  sortDesc: true,
  readerIssue: null,   // edição aberta no leitor (null = leitor fechado)
  page: 0,             // índice (base 0) da primeira página visível no leitor
  libraryPage: 1,      // página atual da grade "Todas as edições"
  query: '',
  year: 'all',
  zoom: 1
};

const LIBRARY_PAGE_SIZE = 10;
const ZOOM = { min: 1, max: 2.5, step: .25 };
const ZOOMED_THRESHOLD = 1.01;                 // acima disso o leitor se comporta como "ampliado"
const COVER_CACHE = 'ovd-news-covers-v1';
const FILE_MODE = location.protocol === 'file:'; // aberto direto do disco, sem servidor
const COMPACT_PAGINATION = matchMedia('(max-width: 580px)');
// No celular mostra 1 página por vez (tipo Kindle), em vez do spread de 2 do desktop.
const READER_SINGLE_PAGE = matchMedia('(max-width: 580px)');
const REDUCED_MOTION = matchMedia('(prefers-reduced-motion: reduce)');

const $ = selector => document.querySelector(selector);
const els = {
  coverflow: $('#coverflow'), issueGrid: $('#issueGrid'),
  carouselPosition: $('#carouselPosition'), commandBackdrop: $('#commandBackdrop'), searchInput: $('#searchInput'),
  searchResults: $('#searchResults'), reader: $('#reader'), book: $('#book'), thumbnailRail: $('#thumbnailRail'),
  readerSearchBackdrop: $('#readerSearchBackdrop'), readerSearchInput: $('#readerSearchInput'),
  bookShell: $('#bookShell'), readerScroll: $('#readerScroll'), bookMagnifier: $('#bookMagnifier')
};

// Estado interno do leitor / fila de capas
let pdfModulePromise;
let pdfCoverObserver;
let turnBookInstance = null;      // instância jQuery do turn.js
let readerRenderToken = 0;        // invalida renderizações antigas quando o leitor fecha/troca de edição
let readerThumbsRendered = false;
let readerFlipPending = false;    // true enquanto uma virada de página está em andamento
let readerModoUnico = false;      // trava no valor de READER_SINGLE_PAGE no momento em que o leitor abre
let bookSettleTimer = 0;
let gutterRestoreTimer = 0;
const coverQueue = [];
let runningCoverJobs = 0;

/* ---------- 2. Utilitários ---------- */

const icon = name => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const pageNumbers = count => Array.from({ length: count }, (_, index) => index + 1);
const clampZoom = value => Math.max(ZOOM.min, Math.min(ZOOM.max, value));
const libraryTotalPages = () => Math.max(1, Math.ceil(state.filtered.length / LIBRARY_PAGE_SIZE));

const formatDate = value => {
  if (!value) return '';
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric' }).format(date);
};

// Minúsculas e sem acentos: base da comparação em todas as buscas.
function normalize(value = '') { return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); }

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2600);
}

// Capa provisória (SVG) exibida até a capa real do PDF ser gerada.
function placeholderCover(issue) {
  const label = String(issue.number).padStart(3, '0');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 800"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="#243048"/><stop offset="1" stop-color="#101318"/></linearGradient></defs><rect width="600" height="800" fill="url(#g)"/><text x="48" y="82" fill="#fff" font-family="Segoe UI,sans-serif" font-weight="700" font-size="28">OVD NEWS</text><path d="M48 112h504" stroke="#fff" opacity=".25"/><text x="48" y="650" fill="#fff" font-family="Segoe UI,sans-serif" font-size="22">EDIÇÃO</text><text x="48" y="735" fill="#fff" font-family="Segoe UI,sans-serif" font-weight="700" font-size="92">${label}</text></svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

// Página provisória exibida no leitor até a página real ser renderizada.
function readerPagePlaceholder(pageNumber) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 840"><rect width="600" height="840" fill="#f5f2ea"/><path d="M0 0h600v840H0z" fill="url(#p)" opacity=".18"/><defs><pattern id="p" width="7" height="7" patternUnits="userSpaceOnUse"><path d="M0 0v7" stroke="#9e9a91" stroke-width="1"/></pattern></defs><text x="300" y="420" text-anchor="middle" fill="#9d9990" font-family="Segoe UI,sans-serif" font-size="18">Página ${pageNumber}</text></svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

/* ---------- 3. PDF e capas ---------- */

// pdf.js é carregado só quando o primeiro PDF é necessário.
async function getPdfModule() {
  if (!pdfModulePromise) pdfModulePromise = import('./vendor/pdf.min.mjs').then(module => {
    module.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.mjs';
    return module;
  });
  return pdfModulePromise;
}

// Abre o PDF completo da edição (uma vez) e descobre o número de páginas.
async function ensurePdfIssue(issue) {
  if (!issue?.pdf) return issue;
  if (!issue._pdfPromise) issue._pdfPromise = getPdfModule().then(module => module.getDocument(issue.pdf).promise);
  issue._pdfDoc = await issue._pdfPromise;
  if (!issue.pageCount) issue.pageCount = issue._pdfDoc.numPages;
  if (!issue.pages?.length) {
    issue.pages = pageNumbers(issue.pageCount);
  }
  return issue;
}

// Desenha uma página de um documento pdf.js no canvas, na largura pedida.
async function drawPageToCanvas(pdfDoc, pageNumber, canvas, targetWidth) {
  const page = await pdfDoc.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: targetWidth / base.width });
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
}

async function renderPdfToCanvas(issue, pageNumber, canvas, targetWidth = 760) {
  await ensurePdfIssue(issue);
  if (!canvas) return;
  await drawPageToCanvas(issue._pdfDoc, pageNumber, canvas, targetWidth);
}

const canvasToWebp = (canvas, quality) => new Promise(resolve => canvas.toBlob(resolve, 'image/webp', quality));

// Renderiza uma página do PDF como imagem (blob URL), com cache por página.
async function renderPdfPageUrl(issue, pageNumber, targetWidth = 1300) {
  issue._readerPageUrls ||= new Map();
  if (issue._readerPageUrls.has(pageNumber)) return issue._readerPageUrls.get(pageNumber);
  const promise = (async () => {
    const canvas = document.createElement('canvas');
    await renderPdfToCanvas(issue, pageNumber, canvas, targetWidth);
    return URL.createObjectURL(await canvasToWebp(canvas, .9));
  })();
  issue._readerPageUrls.set(pageNumber, promise);
  return promise;
}

function coverCacheUrl(issue) {
  const revision = issue.coverRevision || 'legacy';
  return `${location.origin}/__ovd-cover-cache/${encodeURIComponent(issue.id)}-${encodeURIComponent(revision)}.webp`;
}

// Envia a capa gerada no navegador para o servidor guardar em .cache/covers.
function uploadCover(issue, blob, pageCount) {
  return fetch(issue.coverUpload, {
    method: 'POST',
    headers: { 'Content-Type': 'image/webp', 'X-Page-Count': String(pageCount || 0) },
    body: blob
  });
}

// Usa a capa guardada no Cache Storage (evita reabrir o PDF a cada visita).
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
    issue.pages = pageNumbers(count);
  }
  // Reenvia ao servidor caso ele ainda não tenha essa capa (falha silenciosa).
  if (issue.coverUpload) uploadCover(issue, blob, count).catch(() => {});
  return true;
}

async function savePdfCover(issue, blob, pageCount) {
  const jobs = [];
  if ('caches' in window) {
    jobs.push(caches.open(COVER_CACHE).then(cache => cache.put(coverCacheUrl(issue), new Response(blob, {
      headers: { 'Content-Type': 'image/webp', 'X-Page-Count': String(pageCount || 0) }
    }))));
  }
  if (issue.coverUpload) jobs.push(uploadCover(issue, blob, pageCount));
  await Promise.allSettled(jobs);
}

function applyPdfCover(issue) {
  document.querySelectorAll(`[data-cover-id="${CSS.escape(issue.id)}"]`).forEach(image => image.src = issue.cover);
  renderCoverMeta();
}

// Gera a capa (1ª página) de uma edição em PDF, lendo só o começo do arquivo.
async function ensurePdfCover(issue) {
  if (!issue?.pdf || issue.cover) return;
  if (!issue._coverPromise) issue._coverPromise = (async () => {
    if (await useCachedPdfCover(issue)) {
      applyPdfCover(issue);
      return;
    }
    const pdfModule = await getPdfModule();
    const task = pdfModule.getDocument({ url: issue.pdf, disableAutoFetch: true, disableStream: true, rangeChunkSize: 65536 });
    const previewDocument = await task.promise;
    const canvas = document.createElement('canvas');
    await drawPageToCanvas(previewDocument, 1, canvas, 620);
    const blob = await canvasToWebp(canvas, .84);
    issue.pageCount = previewDocument.numPages;
    issue.pages = pageNumbers(issue.pageCount);
    issue.cover = URL.createObjectURL(blob);
    await savePdfCover(issue, blob, issue.pageCount);
    await previewDocument.destroy();
    applyPdfCover(issue);
  })().catch(() => showToast(`Não foi possível gerar a capa da ${issue.title}.`));
  return issue._coverPromise;
}

// Fila que limita a 2 capas sendo geradas ao mesmo tempo.
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

// Gera as capas sob demanda: as da grade quando chegam perto da tela; as do carrossel
// (até 2 de cada lado da ativa) com prioridade, das mais distantes para as mais próximas.
function observePdfCovers() {
  if (FILE_MODE) return;
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

/* ---------- 4. Catálogo de edições ---------- */

// Ordem de tentativa: catálogo embutido (file://) → /api/edicoes (servidor local) → edicoes.json (site estático).
async function fetchIssuesData() {
  if (FILE_MODE) {
    if (!window.OVD_ISSUES_DATA) throw new Error('catálogo local indisponível');
    const data = JSON.parse(JSON.stringify(window.OVD_ISSUES_DATA));
    const localPath = value => {
      if (typeof value !== 'string' || !value.startsWith('/')) return value;
      if (value.startsWith('/capas/')) return `./.cache/covers/${value.slice('/capas/'.length)}`;
      return `.${value}`;
    };
    data.issues.forEach(issue => {
      issue.cover = localPath(issue.cover);
      issue.pdf = localPath(issue.pdf);
      issue.pages = (issue.pages || []).map(localPath);
    });
    return data;
  }
  try {
    const response = await fetch('/api/edicoes', { cache: 'no-store' });
    if (!response.ok) throw new Error('api indisponível');
    return await response.json();
  } catch {
    const response = await fetch('edicoes.json', { cache: 'no-store' });
    const data = await response.json();
    data.issues.forEach(issue => {
      if (issue.cover?.startsWith('/capas/')) issue.cover = '';
      if (issue.pdf?.startsWith('/')) issue.pdf = `.${issue.pdf}`;
    });
    return data;
  }
}

async function loadIssues() {
  try {
    const data = await fetchIssuesData();
    data.issues.forEach(issue => {
      // Edições 1–40 não trazem data no catálogo: deduz o ano/mês pela numeração (12 edições por ano desde 2002).
      const number = Number(issue.number);
      if (!issue.year && number >= 1 && number <= 40) {
        issue.year = 2002 + Math.floor((number - 1) / 12);
        issue.date ||= `${issue.year}-${String((number - 1) % 12 + 1).padStart(2, '0')}`;
      }
    });
    state.issues = data.issues;
    state.filtered = [...state.issues];
    renderYearMenu();
    $('#scanStatus').textContent = `${state.issues.length} edições sincronizadas`;
    render();
    precarregarOcr();
  } catch (error) {
    $('#emptyState').hidden = false;
    $('#emptyState').textContent = 'Não foi possível carregar o acervo.';
  }
}

function renderYearMenu() {
  const years = [...new Set(state.issues.map(issue => issue.year).filter(Boolean))].sort((a, b) => b - a);
  $('#yearMenu').innerHTML = ['all', ...years].map(year => {
    const count = year === 'all' ? state.issues.length : state.issues.filter(issue => issue.year === year).length;
    return `<button class="year-option" type="button" role="option" data-year="${year}" aria-selected="${year === 'all'}"><span>${year === 'all' ? 'Todos os anos' : year}</span><small>${count} ${count === 1 ? 'edição' : 'edições'}</small></button>`;
  }).join('');
}

/* ---------- 5. Home: carrossel e grade ---------- */

function render() { renderCoverflow(); renderGrid(); requestAnimationFrame(observePdfCovers); }

// Distância circular entre dois índices (o carrossel dá a volta).
function relativeOffset(index, active, length) {
  let offset = index - active;
  if (offset > length / 2) offset -= length;
  if (offset < -length / 2) offset += length;
  return offset;
}

function renderCoverflow() {
  const issues = state.filtered;
  if (!issues.length) { els.coverflow.innerHTML = ''; return; }
  state.active = Math.min(state.active, issues.length - 1);
  const totalEditions = Math.max(...state.issues.map(issue => Number(issue.number) || 0));
  // Só reconstrói o DOM quando a lista de edições muda; trocar de capa apenas reposiciona.
  const signature = issues.map(issue => issue.id).join('|');
  if (els.coverflow.dataset.signature !== signature) {
    els.coverflow.dataset.signature = signature;
    els.coverflow.innerHTML = issues.map((issue, index) => `<button class="cover-card far" data-index="${index}" role="listitem" aria-label="Selecionar ${issue.title}"><span class="magazine-pages" aria-hidden="true"><i></i><i></i><i></i></span><img src="${issue.cover || placeholderCover(issue)}" data-cover-id="${issue.id}" alt="Capa da ${issue.title}" loading="${index === 0 ? 'eager' : 'lazy'}"><span class="page-label">${issue.number}/${totalEditions}</span><span class="open-label">Ler mais <b>↗</b></span></button>`).join('');
    requestAnimationFrame(() => positionCoverCards(issues));
  } else {
    positionCoverCards(issues);
  }
  renderCoverMeta();
}

// Com uma busca confirmada, o heading ganha uma linha "Resultados de busca por: X" acima do
// título da edição ativa, que vira h2 (era h1) pra manter só um h1 na hierarquia da página.
// Só reconstrói o DOM quando esse modo muda (não a cada troca de capa), pra não perder foco
// nem disparar o aria-live à toa.
function renderCoverMeta() {
  const issues = state.filtered;
  if (!issues.length) return;
  const active = issues[state.active];
  const termo = state.query.trim();
  const heading = $('.archive-heading');
  if (heading.classList.contains('is-searching') !== Boolean(termo)) {
    heading.classList.toggle('is-searching', Boolean(termo));
    heading.innerHTML = '';
    const eyebrow = document.createElement('p');
    eyebrow.textContent = 'Acervo digital OVD News';
    heading.appendChild(eyebrow);
    if (termo) {
      const resultsHeading = document.createElement('h1');
      resultsHeading.id = 'searchResultsHeading';
      heading.appendChild(resultsHeading);
    }
    const titleEl = document.createElement(termo ? 'h2' : 'h1');
    titleEl.id = 'archiveTitle';
    heading.appendChild(titleEl);
    const dateEl = document.createElement('span');
    dateEl.id = 'archiveDate';
    heading.appendChild(dateEl);
  }
  if (termo) $('#searchResultsHeading').textContent = `Resultados de busca por: "${termo}"`;
  $('#archiveTitle').textContent = active.title;
  $('#archiveDate').textContent = [formatDate(active.date), active.category].filter(Boolean).join(' · ');
  els.carouselPosition.textContent = `${String(state.active + 1).padStart(2, '0')} / ${String(issues.length).padStart(2, '0')}`;
}

// Mostra só as 5 capas centrais (offset -2..2); as demais ficam "far" (escondidas).
function positionCoverCards(issues) {
  [...els.coverflow.children].forEach((card, index) => {
    const offset = relativeOffset(index, state.active, issues.length);
    const visible = Math.abs(offset) <= 2;
    card.dataset.offset = visible ? offset : 'far';
    card.classList.toggle('active', offset === 0);
    card.classList.toggle('far', !visible);
    card.setAttribute('aria-label', `${offset === 0 ? 'Abrir' : 'Selecionar'} ${issues[index].title}`);
  });
}

function moveCover(direction) {
  const length = state.filtered.length;
  if (!length) return;
  state.active = (state.active + direction + length) % length;
  renderCoverflow();
  observePdfCovers();
}

function renderGrid() {
  $('#emptyState').hidden = Boolean(state.filtered.length);
  const totalPages = libraryTotalPages();
  state.libraryPage = Math.min(state.libraryPage, totalPages);
  const start = (state.libraryPage - 1) * LIBRARY_PAGE_SIZE;
  els.issueGrid.innerHTML = state.filtered.slice(start, start + LIBRARY_PAGE_SIZE).map(issue => `<button class="issue-tile" data-id="${issue.id}" aria-label="Ler ${issue.title}"><div class="tile-cover"><img src="${issue.cover || placeholderCover(issue)}" data-cover-id="${issue.id}" alt="Capa da ${issue.title}" loading="lazy"></div><div class="tile-info"><strong>${issue.title}</strong><span>${formatDate(issue.date)}</span></div></button>`).join('');
  renderPagination(totalPages);
}

// Números exibidos na paginação da grade ('…' = intervalo omitido).
// No celular cabem no máximo 7 botões de 44px: anterior, 5 posições e próxima.
function paginationItems(current, total, compact) {
  const range = count => pageNumbers(count);
  if (compact) {
    if (total <= 5) return range(total);
    if (current <= 2) return [1, 2, 3, '…', total];
    if (current >= total - 1) return [1, '…', total - 2, total - 1, total];
    return [1, '…', current, '…', total];
  }
  if (total <= 7) return range(total);
  if (current <= 4) return [1, 2, 3, 4, 5, '…', total];
  if (current >= total - 3) return [1, '…', total - 4, total - 3, total - 2, total - 1, total];
  return [1, '…', current - 1, current, current + 1, '…', total];
}

function renderPagination(totalPages) {
  const pagination = $('#libraryPagination');
  pagination.hidden = totalPages <= 1;
  if (pagination.hidden) return;
  const current = state.libraryPage;
  const items = paginationItems(current, totalPages, COMPACT_PAGINATION.matches);
  pagination.innerHTML = `<button data-page="${current - 1}" aria-label="Página anterior" ${current === 1 ? 'disabled' : ''}>${icon('chevron-left')}</button>${items.map(page => page === '…' ? '<span aria-hidden="true">…</span>' : `<button data-page="${page}" ${page === current ? 'aria-current="page"' : ''} aria-label="Página ${page}">${page}</button>`).join('')}<button data-page="${current + 1}" aria-label="Próxima página" ${current === totalPages ? 'disabled' : ''}>${icon('chevron-right')}</button>`;
}
COMPACT_PAGINATION.addEventListener('change', () => renderPagination(libraryTotalPages()));

/* ---------- 6. Busca ---------- */

// --- 6.1 Índice de texto (OCR) ---
// paginasOcr[id] = [{ numero, texto, offsets: [{inicio,fim,palavra}] }, ...], preenchido sob demanda.
const paginasOcr = {};
const ocrCarregando = {};

function carregarScript(caminho) {
  return new Promise(resolver => {
    const script = document.createElement('script');
    script.src = caminho;
    script.onload = () => resolver(true);
    script.onerror = () => resolver(false); // edição ainda sem OCR: ignora, não é erro
    document.head.appendChild(script);
  });
}

// Junta as palavras de cada página num texto corrido, guardando onde cada palavra cai nele
// (pra depois achar as coordenadas da palavra encontrada e desenhar o destaque).
function indexarOcr(id, paginas) {
  paginasOcr[id] = (paginas || []).map(pagina => {
    let texto = '';
    const offsets = [];
    (pagina.palavras || []).forEach(palavra => {
      if (texto) texto += ' ';
      offsets.push({ inicio: texto.length, fim: texto.length + palavra.t.length, palavra });
      texto += palavra.t;
    });
    return { numero: pagina.numero, texto, offsets };
  });
}

function carregarOcrEdicao(issue) {
  if (paginasOcr[issue.id] || ocrCarregando[issue.id]) return ocrCarregando[issue.id] || Promise.resolve();
  ocrCarregando[issue.id] = carregarScript(`dados/ocr/edicao-${issue.id}.js`).then(carregado => {
    const dados = carregado && window.ACERVO_OCR && window.ACERVO_OCR[issue.id];
    if (dados) indexarOcr(issue.id, dados.paginas);
  });
  return ocrCarregando[issue.id];
}

// Carrega o texto de todas as edições sozinho, em segundo plano, assim que o navegador estiver
// ocioso — pra busca já responder na hora quando a pessoa digitar, sem esperar o primeiro clique.
function precarregarOcr() {
  const iniciar = () => state.issues.forEach(issue => carregarOcrEdicao(issue));
  if ('requestIdleCallback' in window) requestIdleCallback(iniciar, { timeout: 4000 });
  else setTimeout(iniciar, 800);
}

// --- 6.2 Localizar o termo nas páginas ---

// Monta o resultado de uma página pro termo buscado — a posição do trecho com <mark> em volta
// do termo, e as palavras daquele trecho (pra desenhar o destaque no leitor) — ou null se a
// página não contém o termo.
function construirAchadoPagina(pagina, termoNormalizado) {
  const textoNormalizado = normalize(pagina.texto);
  const pos = textoNormalizado.indexOf(termoNormalizado);
  if (pos === -1) return null;
  const fim = pos + termoNormalizado.length;
  const palavras = pagina.offsets.filter(o => o.inicio < fim && o.fim > pos).map(o => o.palavra);

  const inicioTrecho = Math.max(0, pos - 40);
  const fimTrecho = Math.min(pagina.texto.length, fim + 60);
  const trecho = (inicioTrecho > 0 ? '…' : '') +
    pagina.texto.slice(inicioTrecho, fimTrecho).replace(/\s+/g, ' ') +
    (fimTrecho < pagina.texto.length ? '…' : '');
  // Escapa o HTML do trecho antes de inserir o <mark>.
  const seguro = document.createElement('div');
  seguro.textContent = trecho;
  const padrao = new RegExp(termoNormalizado.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const trechoHtml = seguro.innerHTML.replace(padrao, correspondencia => `<mark>${correspondencia}</mark>`);

  return { pagina: pagina.numero, trechoHtml, palavras };
}

// Acha a primeira página cujo texto contém o termo buscado (usado pela busca geral do acervo,
// que só precisa abrir na primeira ocorrência).
function localizarNoOcr(id, termoNormalizado) {
  const paginas = paginasOcr[id];
  if (!paginas || !termoNormalizado) return null;
  for (const pagina of paginas) {
    const achado = construirAchadoPagina(pagina, termoNormalizado);
    if (achado) return achado;
  }
  return null;
}

// Acha TODAS as páginas cujo texto contém o termo (usado pela busca interna da edição aberta,
// que precisa listar e navegar entre todas as ocorrências).
function localizarTodosNoOcr(id, termoNormalizado) {
  const paginas = paginasOcr[id];
  if (!paginas || !termoNormalizado) return [];
  return paginas.map(pagina => construirAchadoPagina(pagina, termoNormalizado)).filter(Boolean);
}

function metadadosTexto(issue) {
  return normalize([issue.title, issue.number, issue.date, issue.year, issue.category, issue.description, ...issue.tags].join(' '));
}

// Edições que casam com o termo (metadados e/ou texto das páginas), da mais relevante à menos.
function candidatosBusca(termoNormalizado) {
  return state.filtered.map(issue => {
    const matchMetadados = metadadosTexto(issue).includes(termoNormalizado);
    const paginas = paginasOcr[issue.id] || [];
    const paginasComMatch = paginas.filter(pagina => normalize(pagina.texto).includes(termoNormalizado)).length;
    if (!matchMetadados && !paginasComMatch) return null;
    const achado = paginasComMatch ? localizarNoOcr(issue.id, termoNormalizado) : null;
    const pontuacao = (matchMetadados ? 100 : 0) + Math.min(paginasComMatch, 5) * 5;
    return { issue, achado, pontuacao };
  }).filter(Boolean).sort((a, b) => b.pontuacao - a.pontuacao);
}

// --- 6.3 Busca do acervo (home) ---

// confirmar=false adia a atualização do carrossel coverflow-wrap (só mexe em grade + dropdown
// de resultados) — usado enquanto a pessoa ainda está digitando, pra não ficar pulando de capa
// em capa a cada tecla. O carrossel só sincroniza quando a busca é confirmada (ver closeCommand).
function applyFilters(confirmar = true) {
  const needle = normalize(state.query.trim());
  state.filtered = state.issues.filter(issue => {
    if (state.year !== 'all' && String(issue.year) !== state.year) return false;
    if (!needle) return true;
    if (metadadosTexto(issue).includes(needle)) return true;
    const paginas = paginasOcr[issue.id];
    return paginas ? paginas.some(pagina => normalize(pagina.texto).includes(needle)) : false;
  });
  if (!state.sortDesc) state.filtered.reverse();
  state.active = 0;
  state.libraryPage = 1;
  $('#allTitle').textContent = state.year === 'all' ? 'Todas as edições' : state.year;
  $('#yearMenu').querySelectorAll('[data-year]').forEach(option => option.setAttribute('aria-selected', option.dataset.year === state.year));
  renderGrid(); requestAnimationFrame(observePdfCovers);
  if (confirmar) renderCoverflow();
  renderSearchResults();
}

function applySearch(query) {
  state.query = query;
  const termo = normalize(query.trim());
  // Garante o texto de todas as edições e refiltra quando terminar (se o termo ainda for o mesmo).
  if (termo) Promise.all(state.issues.map(carregarOcrEdicao)).then(() => { if (normalize(state.query.trim()) === termo) applyFilters(false); });
  applyFilters(false);
}

function renderSearchResults() {
  if (!state.query) { els.searchResults.innerHTML = ''; return; }
  const termo = normalize(state.query.trim());
  const candidatos = candidatosBusca(termo).slice(0, 6);
  els.searchResults.innerHTML = candidatos.length ? `<p class="command-label">Resultados</p>${candidatos.map(({ issue, achado }) => `<button class="result-item" data-id="${issue.id}"><img src="${issue.cover || placeholderCover(issue)}" data-cover-id="${issue.id}" alt=""><span><strong>${issue.title}</strong><small>${[formatDate(issue.date), issue.category, achado ? `encontrado na página ${achado.pagina}` : ''].filter(Boolean).join(' · ')}</small>${achado ? `<small class="trecho">${achado.trechoHtml}</small>` : ''}</span></button>`).join('')}` : '<p class="command-label">Nenhum resultado encontrado</p>';
}

let commandReturnFocus = null;
function openCommand() {
  if (els.commandBackdrop.hidden) commandReturnFocus = document.activeElement;
  els.commandBackdrop.hidden = false;
  $('#commandTrigger').setAttribute('aria-expanded', 'true');
  setTimeout(() => els.searchInput.focus(), 40);
}
// resetQuery=false preserva a pesquisa (usado ao CONFIRMAR: Enter ou clicar na lupa, que deixam
// o carrossel refletindo o resultado). Cancelar a busca (Esc, clicar fora) usa o padrão (true) e
// descarta tudo, voltando pro estado sem pesquisa — carrossel, grade e dropdown revertem pra
// "todas as edições" e o campo limpa, pra reabrir a busca nunca mostrar a palavra anterior.
function closeCommand({ returnFocus = true, resetQuery = true } = {}) {
  const wasOpen = !els.commandBackdrop.hidden;
  els.commandBackdrop.hidden = true;
  $('#commandTrigger').setAttribute('aria-expanded', 'false');
  if (wasOpen && resetQuery) {
    els.searchInput.value = '';
    state.query = '';
    applyFilters();
  }
  if (wasOpen && returnFocus) restoreFocus(commandReturnFocus);
}
// Confirmar a busca (Enter ou clicar na lupa): só reflete os resultados no carrossel da home e
// fecha a busca — nunca abre uma edição direto. Abrir uma edição é só clicando num result-item.
function confirmarBuscaHome() {
  renderCoverflow();
  requestAnimationFrame(observePdfCovers);
  closeCommand({ resetQuery: false });
}

// --- 6.4 Busca dentro da edição aberta ---
// Mesma cara da busca do acervo (mesmas classes .command-* e .result-item), mas os
// resultados são páginas da edição atual, não outras edições.

function renderReaderSearchResults() {
  const issue = state.readerIssue;
  const termo = normalize(els.readerSearchInput.value.trim());
  const resultados = (termo && issue) ? localizarTodosNoOcr(issue.id, termo) : [];
  $('#readerSearchCount').textContent = termo ? `${resultados.length} resultado${resultados.length === 1 ? '' : 's'}` : '';
  $('#readerSearchResults').innerHTML = !termo ? '' : (resultados.length
    ? `<p class="command-label">Resultados</p>${resultados.map(r => `<button class="result-item" data-page="${r.pagina}" data-palavras='${JSON.stringify(r.palavras).replace(/'/g, '&#39;')}'><span class="command-icon">${r.pagina}</span><span><strong>Página ${r.pagina}</strong><small class="trecho">${r.trechoHtml}</small></span></button>`).join('')}`
    : '<p class="command-label">Nenhum resultado encontrado</p>');
}

let readerSearchReturnFocus = null;
function openReaderSearch() {
  if (!state.readerIssue) return;
  readerSearchReturnFocus = document.activeElement;
  els.readerSearchBackdrop.hidden = false;
  $('#readerSearchTrigger').setAttribute('aria-expanded', 'true');
  carregarOcrEdicao(state.readerIssue).then(renderReaderSearchResults);
  setTimeout(() => els.readerSearchInput.focus(), 40);
}
function closeReaderSearch({ returnFocus = true } = {}) {
  const wasOpen = !els.readerSearchBackdrop.hidden;
  els.readerSearchBackdrop.hidden = true;
  $('#readerSearchTrigger').setAttribute('aria-expanded', 'false');
  if (wasOpen && returnFocus) restoreFocus(readerSearchReturnFocus);
}
function resetReaderSearch() {
  closeReaderSearch({ returnFocus: false });
  els.readerSearchInput.value = '';
  $('#readerSearchResults').innerHTML = '';
  $('#readerSearchCount').textContent = '';
}

// Desenha um retângulo amarelo sobre cada palavra encontrada e o some depois de 2,4 s.
let destaqueTimer = 0;
function destacarPalavras(palavras) {
  const pagina = els.book.querySelector(`.p${state.page + 1}`);
  if (!pagina) return;
  pagina.querySelectorAll('.ocr-destaque').forEach(el => el.remove());
  palavras.forEach(palavra => {
    const marca = document.createElement('div');
    marca.className = 'ocr-destaque';
    marca.style.left = `${palavra.x * 100}%`; marca.style.top = `${palavra.y * 100}%`;
    marca.style.width = `${palavra.w * 100}%`; marca.style.height = `${palavra.h * 100}%`;
    pagina.appendChild(marca);
  });
  clearTimeout(destaqueTimer);
  destaqueTimer = setTimeout(() => pagina.querySelectorAll('.ocr-destaque').forEach(el => el.classList.add('sumindo')), 2400);
}

function irParaResultadoBusca(pagina, palavras) {
  if (!state.readerIssue) return;
  goToReaderPage(pagina - 1);
  closeReaderSearch({ returnFocus: false });
  if (palavras && palavras.length) destacarPalavras(palavras);
}
// Abre o resultado representado por um botão .result-item da busca interna.
function abrirResultadoLeitor(button) {
  irParaResultadoBusca(Number(button.dataset.page), button.dataset.palavras ? JSON.parse(button.dataset.palavras) : null);
}

/* ---------- 7. Leitor ---------- */

// --- 7.1 Foco e acessibilidade ---
let readerReturnFocus = null;
function restoreFocus(element) { if (element?.isConnected) element.focus({ preventScroll: true }); }
// Mantém o Tab dentro do diálogo aberto (leitor ou busca).
function trapFocus(event, container) {
  const items = [...container.querySelectorAll('button,input,[href],[tabindex]:not([tabindex="-1"])')].filter(el => !el.disabled && el.getClientRects().length);
  if (!items.length) return;
  const first = items[0], last = items[items.length - 1], inside = container.contains(document.activeElement);
  if (event.shiftKey && (!inside || document.activeElement === first)) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && (!inside || document.activeElement === last)) { event.preventDefault(); first.focus(); }
}
// Setas ↑/↓ percorrem uma lista de elementos focáveis, dando a volta nas pontas.
function moveFocusInList(event, items) {
  const index = Math.max(0, items.indexOf(document.activeElement));
  event.preventDefault();
  items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
}

// --- 7.2 Abrir e fechar ---

async function openReader(id, sourceImage = null) {
  const issue = state.issues.find(item => item.id === String(id));
  if (!issue) return;
  readerReturnFocus = els.commandBackdrop.hidden ? document.activeElement : commandReturnFocus;
  if (FILE_MODE && issue.pdf) {
    // Sem servidor não dá pra usar o leitor: abre o PDF direto em outra aba.
    window.open(issue.pdf, '_blank', 'noopener');
    closeCommand();
    return;
  }
  if (issue.pdf) {
    showToast(`Abrindo ${issue.title}...`);
    try { await ensurePdfIssue(issue); } catch { showToast('Não foi possível abrir este PDF.'); return; }
    // Pré-carrega todas as páginas antes de revelar o leitor — sem isso, ele abre já mostrando
    // o placeholder "Página N" até a renderização em segundo plano alcançar aquela página,
    // principalmente ao navegar rápido. Guarda a URL já resolvida (não a promise) num mapa à
    // parte pra initTurnJs poder montar o book já com o conteúdo real, sem esperar de novo.
    issue._readerPageUrlsReady ||= new Map();
    await Promise.all(
      pageNumbers(issue.pageCount)
        .filter(pageNumber => !(pageNumber === 1 && issue.cover))
        .map(async pageNumber => {
          try { issue._readerPageUrlsReady.set(pageNumber, await renderPdfPageUrl(issue, pageNumber)); } catch {}
        })
    );
  }
  const animated = sourceImage && document.startViewTransition && !REDUCED_MOTION.matches;
  const reveal = async () => {
    state.readerIssue = issue;
    state.page = 0;
    state.zoom = 1; readerThumbsRendered = false;
    els.reader.classList.toggle('is-opening', Boolean(animated));
    els.reader.hidden = false; document.body.style.overflow = 'hidden';
    $('#readerTitle').textContent = issue.title; $('#readerDate').textContent = formatDate(issue.date);
    els.thumbnailRail.innerHTML = issue.pdf
      ? issue.pages.map((page, index) => `<button data-page="${index}" aria-label="Ir para página ${index + 1}"><canvas data-thumb-page="${page}" aria-label="Página ${index + 1}"></canvas></button>`).join('')
      : issue.pages.map((page, index) => `<button data-page="${index}" aria-label="Ir para página ${index + 1}"><img src="${page}" alt="Página ${index + 1}" loading="lazy"></button>`).join('');
    applyZoom(); closeCommand({ returnFocus: false }); $('#closeReader').focus({ preventScroll: true });
    await initTurnJs(issue);
  };
  if (!animated) return reveal();
  // Mantém a abertura suave, sem compartilhar a imagem da capa com o livro.
  // A camada compartilhada criava um retângulo branco durante o redimensionamento.
  const transition = document.startViewTransition(reveal);
  await transition.finished.catch(() => undefined);
  requestAnimationFrame(() => els.reader.classList.remove('is-opening'));
}

function closeReader() {
  resetBook();
  readerFlipPending = false;
  els.reader.classList.remove('is-opening');
  els.reader.hidden = true;
  document.body.style.overflow = '';
  state.readerIssue = null;
  state.zoom = 1;
  resetReaderSearch();
  restoreFocus(readerReturnFocus);
}

// Miniaturas do PDF, renderizadas uma a uma (só na primeira vez que o painel é aberto).
async function renderPdfThumbnails(issue) {
  for (const canvas of els.thumbnailRail.querySelectorAll('[data-thumb-page]')) {
    if (state.readerIssue !== issue) break;
    await renderPdfToCanvas(issue, Number(canvas.dataset.thumbPage), canvas, 150);
  }
}

// --- 7.3 Livro (turn.js) ---

// Descarta o livro atual e monta um contêiner #book novo e vazio.
function resetBook() {
  readerRenderToken += 1;
  if (turnBookInstance) try { turnBookInstance.turn('destroy'); } catch {}
  turnBookInstance = null;
  const mount = document.createElement('div');
  mount.className = 'book'; mount.id = 'book';
  els.book.replaceWith(mount);
  els.book = mount;
}

// Índice da primeira página do spread que contém `page` (capa sozinha; depois pares 2-3, 4-5…).
function getSpreadStart(page) { if (readerModoUnico) return page; if (page === 0) return 0; return page % 2 === 0 ? page - 1 : page; }

function canTurnPage(direction) {
  const issue = state.readerIssue;
  if (!issue) return false;
  const start = getSpreadStart(state.page);
  const tamanhoSpread = readerModoUnico ? 1 : (start === 0 ? 1 : 2);
  return direction < 0 ? start > 0 : start + tamanhoSpread < issue.pageCount;
}

// Dimensões do livro (1 página) que cabem no book-shell, mantendo a proporção da revista.
function getTurnJsSize(paginasVisiveis = 2) {
  const shell = els.bookShell.getBoundingClientRect();
  const aspect = 540 / 760;
  let height = Math.max(352, Math.min(858, Math.floor(shell.height)));
  let width = Math.round(height * aspect);
  if (width * paginasVisiveis > shell.width) { width = Math.floor(shell.width / paginasVisiveis); height = Math.round(width / aspect); }
  return { width, height };
}

async function initTurnJs(issue) {
  resetBook();
  const token = ++readerRenderToken;
  els.book.classList.add('turnjs-book');
  els.book.innerHTML = pageNumbers(issue.pages.length).map(pageNumber => {
    const initial = issue.pdf ? (pageNumber === 1 && issue.cover ? issue.cover : (issue._readerPageUrlsReady?.get(pageNumber) || readerPagePlaceholder(pageNumber))) : issue.pages[pageNumber - 1];
    return `<div class="flip-page"><img data-reader-page="${pageNumber}" src="${initial}" alt="Página ${pageNumber} de ${issue.pageCount}"></div>`;
  }).join('');
  readerModoUnico = READER_SINGLE_PAGE.matches;
  const size = getTurnJsSize(readerModoUnico ? 1 : 2);
  const $book = window.jQuery(els.book);
  $book.turn({ width: readerModoUnico ? size.width : size.width * 2, height: size.height, display: readerModoUnico ? 'single' : 'double', autoCenter: true, duration: 720, gradients: true, acceleration: true, elevation: 40, corners: 'all', cornerSize: 160, page: (state.page || 0) + 1 });
  turnBookInstance = $book;
  // Classes do book-shell que controlam a lombada (gutter): escondida durante a virada, visível quando assenta.
  $book.on('turning', () => {
    clearTimeout(bookSettleTimer);
    els.bookShell.classList.add('is-page-flipping');
    els.bookShell.classList.remove('book-settled');
  });
  $book.on('turned', () => {
    readerFlipPending = false;
    clearTimeout(gutterRestoreTimer);
    els.bookShell.classList.remove('is-page-flipping', 'is-page-dragging');
    syncReaderControls();
    clearTimeout(bookSettleTimer);
    bookSettleTimer = setTimeout(() => els.bookShell.classList.add('book-settled'), 80);
  });
  readerFlipPending = false;
  syncReaderControls();
  requestAnimationFrame(() => els.bookShell.classList.add('book-settled'));
  hydrateReaderPages(issue, token);
}

// Troca o placeholder de uma página pela imagem real (renderizada do PDF ou da pasta de imagens).
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
  for (const pageNumber of pageNumbers(issue.pageCount)) {
    if (!await hydrateReaderPage(issue, pageNumber, token)) return;
  }
}

// Vira uma página (direction: 1 = próxima, -1 = anterior), já garantindo que as páginas de destino estejam renderizadas.
function turnPage(direction) {
  const issue = state.readerIssue;
  if (!turnBookInstance || !issue || readerFlipPending || !canTurnPage(direction)) return;
  readerFlipPending = true;
  turnBookInstance.turn(direction > 0 ? 'next' : 'previous');
  const targetPages = direction > 0 ? [state.page + 2, state.page + 3] : [state.page - 1, state.page];
  Promise.all(targetPages.filter(page => page >= 1 && page <= issue.pageCount).map(page => hydrateReaderPage(issue, page))).catch(() => {});
}

// Salta direto para uma página (índice base 0), sem animação de virada folha a folha.
function goToReaderPage(pageIndex) {
  const issue = state.readerIssue;
  if (!issue || !turnBookInstance) return;
  state.page = Math.max(0, Math.min(issue.pageCount - 1, pageIndex));
  turnBookInstance.turn('page', state.page + 1);
}

// --- 7.4 Controles (indicador, progresso, botões, setas) ---

// Sincroniza toda a UI do leitor com a(s) página(s) visíveis do turn.js.
function syncReaderControls() {
  const issue = state.readerIssue;
  if (!issue || !turnBookInstance) return;
  const turnView = turnBookInstance.turn('view') || [];
  const visible = turnView.filter(Number.isInteger).map(page => page - 1).filter(page => page >= 0 && page < issue.pageCount);
  if (!visible.length) return;
  const start = Math.min(...visible);
  const end = Math.max(...visible) + 1;
  state.page = start;
  // No modo desktop uma página sozinha (capa/contracapa) é recentralizada no espaço de 2 páginas
  // deslocando o livro em 1/4 da largura. No modo 1 página (celular) isso nunca é necessário.
  if (readerModoUnico) {
    els.book.style.removeProperty('--turnjs-offset');
  } else {
    const turnSize = turnBookInstance.turn('size');
    els.book.style.setProperty('--turnjs-offset', !turnView[0] ? `${-Math.round(turnSize.width / 4)}px` : !turnView[1] ? `${Math.round(turnSize.width / 4)}px` : '0px');
  }
  els.bookShell.classList.toggle('book-opened', visible.length > 1);
  $('#pageIndicator').textContent = start === 0 ? `Capa · 1 de ${issue.pageCount}` : `Páginas ${start + 1}${end > start + 1 ? `–${end}` : ''} de ${issue.pageCount}`;
  $('#readerProgress').style.width = `${Math.min(100, (end / issue.pageCount) * 100)}%`;
  $('#prevPage').disabled = $('#readerPrev').disabled = start === 0;
  $('#nextPage').disabled = $('#readerNext').disabled = end >= issue.pageCount;
  $('#readerFirst').disabled = start === 0;
  $('#readerLast').disabled = end >= issue.pageCount;
  els.thumbnailRail.querySelectorAll('button').forEach((button, index) => button.classList.toggle('active', index >= start && index < end));
  positionPageArrows();
}

// Encosta as setas nas bordas reais da(s) página(s) visível(is) — uma só no modo 1 página
// (celular) ou na capa/contracapa do modo 2 páginas (desktop); duas no miolo do desktop.
// No modo desktop não mede as páginas em si: durante a virada elas usam transforms 3D
// (perspective/rotateY) que distorcem o retângulo lido via getBoundingClientRect, então a seta
// acabava caindo perto da lombada, no centro. Em vez disso usa a mesma regra de geometria do
// --turnjs-offset: o #book sempre ocupa a largura cheia do book-shell; com 1 página só,
// ela fica recentralizada nos 50% do meio dessa largura. No modo 1 página não existe esse truque
// de deslocamento, então mede o #book direto — ele já tem a largura exata da página visível.
// Em ambos os casos, dividir por state.zoom devolve a posição "natural" (100%), então as setas
// não se movem quando o usuário aplica zoom manual, só quando a página muda.
function positionPageArrows() {
  if (!turnBookInstance || !state.readerIssue) return;
  const view = turnBookInstance.turn('view') || [];
  if (!view.some(Number.isInteger)) return;
  const prevArrow = $('#prevPage'), nextArrow = $('#nextPage');
  // Com zoom aplicado, a página ampliada pode cobrir a posição "natural" das setas.
  // Nesse caso solta o posicionamento inline e deixa as setas nas bordas da tela
  // (margem definida em CSS), voltando à posição encostada na página quando o zoom
  // retorna a 100%.
  if (state.zoom > ZOOMED_THRESHOLD) {
    prevArrow.style.removeProperty('left');
    nextArrow.style.removeProperty('right');
    return;
  }
  const stageRect = $('#readerStage').getBoundingClientRect();
  const shellRect = els.bookShell.getBoundingClientRect();
  const shellLeft = shellRect.left - stageRect.left;
  let naturalLeft, naturalRight;
  if (readerModoUnico) {
    const bookRect = els.book.getBoundingClientRect();
    naturalLeft = shellLeft + (bookRect.left - shellRect.left) / state.zoom;
    naturalRight = naturalLeft + bookRect.width / state.zoom;
  } else {
    const single = !view[0] || !view[1];
    const shellWidth = shellRect.width / state.zoom;
    naturalLeft = shellLeft + (single ? shellWidth * .25 : 0);
    naturalRight = shellLeft + (single ? shellWidth * .75 : shellWidth);
  }
  const gap = 18;
  const prevWidth = prevArrow.getBoundingClientRect().width || 46;
  const nextWidth = nextArrow.getBoundingClientRect().width || 46;
  prevArrow.style.left = `${Math.max(8, naturalLeft - gap - prevWidth)}px`;
  nextArrow.style.right = `${Math.max(8, stageRect.width - naturalRight - gap - nextWidth)}px`;
}

/* ---------- 8. Zoom, lupa e interação com o livro ---------- */

function applyZoom(center = true) {
  state.zoom = clampZoom(state.zoom);
  $('#zoomLevel').textContent = `${Math.round(state.zoom * 100)}%`;
  els.bookShell.style.setProperty('--reader-zoom', state.zoom);
  const zoomed = state.zoom > ZOOMED_THRESHOLD;
  els.readerScroll.classList.toggle('zoomed', zoomed);
  if (zoomed) {
    // Sem zoom, as setas só precisam da margem fixa do CSS — não depende de medir
    // a página, então já pode aplicar na hora.
    positionPageArrows();
  } else {
    // Voltando ao zoom original: a posição "encostada" na página só pode ser medida
    // com o book-shell já assentado na escala 1, senão pega a geometria no meio da
    // transição e a seta trava numa posição errada. Espera o transform terminar.
    els.bookShell.addEventListener('transitionend', positionPageArrows, { once: true });
    els.readerScroll.scrollTo({ left: 0, top: 0 });
    return;
  }
  if (center) requestAnimationFrame(() => {
    els.readerScroll.scrollLeft = Math.max(0, (els.readerScroll.scrollWidth - els.readerScroll.clientWidth) / 2);
    els.readerScroll.scrollTop = Math.max(0, (els.readerScroll.scrollHeight - els.readerScroll.clientHeight) / 2);
  });
}

function setZoom(value) { state.zoom = value; applyZoom(); }

// Zoom pelos botões +/−, com uma pequena animação de "pulso" no botão e no valor.
function adjustZoom(delta, button) {
  const previous = state.zoom;
  setZoom(state.zoom + delta);
  if (state.zoom === previous || REDUCED_MOTION.matches) return;
  button.animate([{ transform: 'scale(1)' }, { transform: 'scale(.76)' }, { transform: 'scale(1.12)' }, { transform: 'scale(1)' }], { duration: 260, easing: 'cubic-bezier(.2,.8,.2,1)' });
  $('#zoomLevel').animate([{ opacity: .35, transform: `translateY(${delta > 0 ? -4 : 4}px) scale(.92)` }, { opacity: 1, transform: 'none' }], { duration: 240, easing: 'ease-out' });
}

// Zoom com a roda do mouse, mantendo o ponto sob o cursor no mesmo lugar.
function zoomAtPointer(delta, event) {
  const previous = state.zoom;
  const next = clampZoom(previous + delta);
  if (next === previous) return;
  const stageRect = els.readerScroll.getBoundingClientRect();
  const shellRect = els.bookShell.getBoundingClientRect();
  // Âncora do book-shell em coordenadas de conteúdo: como o transform-origin é
  // top-left, o canto do shell nunca se move com o zoom, só o conteúdo cresce a
  // partir dele — por isso essa posição serve de referência estável entre escalas.
  const anchorX = shellRect.left - stageRect.left + els.readerScroll.scrollLeft;
  const anchorY = shellRect.top - stageRect.top + els.readerScroll.scrollTop;
  // Ponto sob o cursor, em coordenadas locais do shell na escala 1 (descontando o
  // zoom atual), pra poder recolocar esse mesmo ponto sob o cursor na escala nova.
  const localX = (event.clientX - shellRect.left) / previous;
  const localY = (event.clientY - shellRect.top) / previous;
  state.zoom = next;
  applyZoom(false);
  // A escala precisa ficar sem transição durante o wheel-zoom (ver .is-wheel-zoom)
  // pra isso funcionar: só assim o scrollWidth já reflete o tamanho novo aqui,
  // sem o navegador limitar (clampar) o scroll a um valor ainda "no meio" da
  // animação e a mira acabar saindo do lugar.
  els.readerScroll.scrollLeft = Math.max(0, anchorX + localX * next - (event.clientX - stageRect.left));
  els.readerScroll.scrollTop = Math.max(0, anchorY + localY * next - (event.clientY - stageRect.top));
}

// --- 8.1 Arrastar para mover a página ampliada (pan) ---
const zoomPan = { active: false, pointerId: null, startX: 0, startY: 0, scrollLeft: 0, scrollTop: 0 };

function finishZoomPan(event) {
  if (!zoomPan.active || event.pointerId !== zoomPan.pointerId) return;
  if (els.bookShell.hasPointerCapture(event.pointerId)) els.bookShell.releasePointerCapture(event.pointerId);
  els.bookShell.classList.remove('is-panning');
  Object.assign(zoomPan, { active: false, pointerId: null });
}

// --- 8.2 Lupa (círculo que amplia a página sob o cursor) ---
function updateBookMagnifier(event) {
  const magnifier = els.bookMagnifier;
  if (state.zoom > ZOOMED_THRESHOLD || els.bookShell.classList.contains('is-page-dragging')) return magnifier.classList.remove('visible');
  const image = document.elementFromPoint(event.clientX, event.clientY)?.closest?.('#book img');
  if (!image) return magnifier.classList.remove('visible');
  const rect = image.getBoundingClientRect();
  const x = event.clientX - rect.left, y = event.clientY - rect.top, scale = 2.15, diameter = 220;
  if (x < 0 || y < 0 || x > rect.width || y > rect.height) return magnifier.classList.remove('visible');
  const shell = els.bookShell.getBoundingClientRect();
  magnifier.style.left = `${event.clientX - shell.left - diameter / 2}px`;
  magnifier.style.top = `${event.clientY - shell.top - diameter / 2}px`;
  magnifier.style.backgroundImage = `url("${image.currentSrc || image.src}")`;
  magnifier.style.backgroundSize = `${rect.width * scale}px ${rect.height * scale}px`;
  magnifier.style.backgroundPosition = `${diameter / 2 - x * scale}px ${diameter / 2 - y * scale}px`;
  magnifier.classList.add('visible');
}

// --- 8.3 Eventos do book-shell ---
let turnCornerClick = null;     // posição do clique inicial, pra distinguir clique de arraste
let turnCornerDragged = false;

// Roda do mouse = zoom. Acumula o delta e aplica no máximo uma vez por frame.
let wheelZoomFrame = 0, wheelZoomDelta = 0, wheelZoomEvent, wheelZoomSettle;
els.bookShell.addEventListener('wheel', event => {
  if (!state.readerIssue || !event.deltaY) return;
  event.preventDefault();
  wheelZoomDelta += Math.sign(-event.deltaY) * .08;
  wheelZoomEvent = event;
  if (wheelZoomFrame) return;
  wheelZoomFrame = requestAnimationFrame(() => {
    const delta = Math.max(-.16, Math.min(.16, wheelZoomDelta));
    wheelZoomDelta = 0; wheelZoomFrame = 0;
    els.bookShell.classList.add('is-wheel-zoom');
    clearTimeout(wheelZoomSettle);
    wheelZoomSettle = setTimeout(() => els.bookShell.classList.remove('is-wheel-zoom'), 120);
    zoomAtPointer(delta, wheelZoomEvent);
  });
}, { passive: false });

els.bookShell.addEventListener('pointerdown', event => {
  els.bookMagnifier.classList.remove('visible');
  if (event.button !== 0) return;
  // Começou um possível arraste de canto (turn.js): esconde a lombada até assentar.
  clearTimeout(gutterRestoreTimer);
  els.bookShell.classList.add('is-page-dragging');
  els.bookShell.classList.remove('book-settled');
  turnCornerDragged = false;
  turnCornerClick = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
  // Com zoom, arrastar move a página ampliada.
  if (state.zoom > ZOOMED_THRESHOLD) {
    Object.assign(zoomPan, { active: true, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, scrollLeft: els.readerScroll.scrollLeft, scrollTop: els.readerScroll.scrollTop });
    els.bookShell.classList.add('is-panning');
    els.bookShell.setPointerCapture(event.pointerId);
    event.preventDefault();
  }
});

els.bookShell.addEventListener('pointermove', event => {
  updateBookMagnifier(event);
  if (turnCornerClick?.pointerId === event.pointerId && Math.hypot(event.clientX - turnCornerClick.x, event.clientY - turnCornerClick.y) > 8) turnCornerDragged = true;
  if (zoomPan.active && event.pointerId === zoomPan.pointerId) {
    els.readerScroll.scrollLeft = zoomPan.scrollLeft - (event.clientX - zoomPan.startX);
    els.readerScroll.scrollTop = zoomPan.scrollTop - (event.clientY - zoomPan.startY);
    event.preventDefault();
  }
});

els.bookShell.addEventListener('pointerup', event => {
  clearTimeout(gutterRestoreTimer);
  gutterRestoreTimer = setTimeout(() => {
    if (!els.bookShell.classList.contains('is-page-flipping')) { els.bookShell.classList.remove('is-page-dragging'); els.bookShell.classList.add('book-settled'); }
  }, 900);
  finishZoomPan(event);
});
els.bookShell.addEventListener('pointercancel', event => { turnCornerClick = null; finishZoomPan(event); });
els.bookShell.addEventListener('lostpointercapture', finishZoomPan);
els.bookShell.addEventListener('pointerleave', () => els.bookMagnifier.classList.remove('visible'));

// Clique nos cantos superior/inferior de uma página vira a página (turn.js só reage a arraste).
els.bookShell.addEventListener('click', event => {
  if (turnCornerDragged) { turnCornerDragged = false; return; }
  turnCornerClick = null;
  const page = event.target.closest('.flip-page') || [...els.book.querySelectorAll('.flip-page')].find(candidate => {
    const bounds = candidate.getBoundingClientRect();
    return event.clientX >= bounds.left && event.clientX <= bounds.right && event.clientY >= bounds.top && event.clientY <= bounds.bottom;
  });
  if (!page) return;
  const rect = page.getBoundingClientRect();
  const corner = Math.min(120, rect.width * .28, rect.height * .2);
  const atTopOrBottom = event.clientY <= rect.top + corner || event.clientY >= rect.bottom - corner;
  if (!atTopOrBottom) return;
  if (event.clientX <= rect.left + corner) turnPage(-1);
  else if (event.clientX >= rect.right - corner) turnPage(1);
}, true);

// Com zoom, o navegador não pode iniciar seleção/arraste nativo de imagem.
els.bookShell.addEventListener('mousedown', event => {
  if (state.zoom > ZOOMED_THRESHOLD) { event.preventDefault(); event.stopPropagation(); }
}, true);
// Duplo clique com zoom volta a 100%.
els.bookShell.addEventListener('dblclick', event => {
  if (state.zoom <= ZOOMED_THRESHOLD) return;
  event.preventDefault();
  setZoom(1);
});

/* ---------- 9. Eventos da interface ---------- */

// --- 9.1 Home: carrossel, grade, filtro de ano, busca ---
$('#prevIssue').addEventListener('click', () => moveCover(-1));
$('#nextIssue').addEventListener('click', () => moveCover(1));

els.coverflow.addEventListener('click', event => {
  if (performance.now() < carouselDrag.suppressClickUntil) { event.preventDefault(); return; }
  // Não confia só no hit-test nativo do navegador (event.target): com transform-style:preserve-3d
  // + rotateY, as capas das pontas (offset ±2) às vezes ficam com uma área clicável menor do que
  // parecem visualmente, e o clique cai "no vazio". Em vez disso, olha o retângulo real de cada
  // capa visível e escolhe a mais central entre as que contêm o ponto clicado — replica a mesma
  // prioridade visual (capa do centro por cima) sem depender do hit-test 3D do navegador.
  const cards = [...els.coverflow.querySelectorAll('.cover-card')].filter(el => el.dataset.offset !== 'far');
  cards.sort((a, b) => Math.abs(Number(a.dataset.offset)) - Math.abs(Number(b.dataset.offset)));
  const card = cards.find(el => {
    const rect = el.getBoundingClientRect();
    return event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
  });
  if (!card) return;
  const index = Number(card.dataset.index);
  if (index === state.active) openReader(state.filtered[index].id, card.querySelector('img'));
  else { state.active = index; renderCoverflow(); observePdfCovers(); }
});

els.issueGrid.addEventListener('click', event => {
  const tile = event.target.closest('.issue-tile');
  if (tile) openReader(tile.dataset.id, tile.querySelector('img'));
});

$('#editionPromoButton')?.addEventListener('click', () => openReader('0142'));

$('#libraryPagination').addEventListener('click', event => {
  const button = event.target.closest('[data-page]');
  if (!button || button.disabled) return;
  state.libraryPage = Number(button.dataset.page);
  renderGrid();
  requestAnimationFrame(observePdfCovers);
  $('.all-issues').scrollIntoView({ behavior: 'smooth' });
});

$('#sortButton').addEventListener('click', () => {
  state.sortDesc = !state.sortDesc;
  state.filtered.reverse();
  $('#sortButton').innerHTML = `${state.sortDesc ? 'Mais recentes' : 'Mais antigas'} ${icon(state.sortDesc ? 'arrow-down' : 'arrow-up')}`;
  state.active = 0;
  state.libraryPage = 1;
  render();
});

// Filtro de ano (dropdown acessível com teclado)
function toggleYearMenu(open = $('#yearMenu').hidden) {
  const menu = $('#yearMenu');
  menu.hidden = !open;
  $('#yearFilter').setAttribute('aria-expanded', open);
  if (open) requestAnimationFrame(() => menu.querySelector('[aria-selected="true"]')?.focus());
  else if (menu.contains(document.activeElement)) $('#yearFilter').focus();
}
$('#yearFilter').addEventListener('click', () => toggleYearMenu());
$('#yearFilter').addEventListener('keydown', event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); toggleYearMenu(true); } });
$('#yearMenu').addEventListener('keydown', event => {
  const options = [...$('#yearMenu').querySelectorAll('[data-year]')];
  const index = options.indexOf(document.activeElement);
  const target = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: options.length - 1 }[event.key];
  if (target !== undefined) { event.preventDefault(); options[Math.max(0, Math.min(options.length - 1, target))].focus(); }
  else if (event.key === 'Tab') toggleYearMenu(false);
});
$('#yearMenu').addEventListener('click', event => {
  const option = event.target.closest('[data-year]');
  if (option) { state.year = option.dataset.year; applyFilters(); toggleYearMenu(false); }
});
document.addEventListener('click', event => { if (!event.target.closest('#yearPicker')) toggleYearMenu(false); });

// Busca do acervo
$('#commandTrigger').addEventListener('click', openCommand);
els.commandBackdrop.addEventListener('click', event => { if (event.target === els.commandBackdrop) closeCommand(); });
els.searchInput.addEventListener('input', event => applySearch(event.target.value));
$('#searchConfirm').addEventListener('click', confirmarBuscaHome);
els.searchResults.addEventListener('click', event => {
  const result = event.target.closest('[data-id]');
  if (result) openReader(result.dataset.id, result.querySelector('img'));
});
// Atalhos do painel de busca: "ver edição mais recente" e "mostrar todas".
document.querySelectorAll('.command-item').forEach(button => button.addEventListener('click', () => {
  if (button.dataset.command === 'latest' && state.issues[0]) { openReader(state.issues[0].id); return; }
  els.searchInput.value = '';
  state.year = 'all';
  applySearch('');
  closeCommand();
  $('.all-issues').scrollIntoView();
}));

// --- 9.2 Leitor: botões ---
['#closeReader', '#closeReaderX'].forEach(selector => $(selector).addEventListener('click', closeReader));
['#nextPage', '#readerNext'].forEach(selector => $(selector).addEventListener('click', () => turnPage(1)));
['#prevPage', '#readerPrev'].forEach(selector => $(selector).addEventListener('click', () => turnPage(-1)));
$('#readerFirst').addEventListener('click', () => goToReaderPage(0));
$('#readerLast').addEventListener('click', () => goToReaderPage(Infinity));
$('#toggleThumbs').addEventListener('click', () => {
  els.thumbnailRail.hidden = !els.thumbnailRail.hidden;
  if (!els.thumbnailRail.hidden && !readerThumbsRendered && state.readerIssue?.pdf) {
    readerThumbsRendered = true;
    renderPdfThumbnails(state.readerIssue);
  }
});
els.thumbnailRail.addEventListener('click', event => {
  const button = event.target.closest('[data-page]');
  if (button) goToReaderPage(Number(button.dataset.page));
});
$('#zoomIn').addEventListener('click', event => adjustZoom(ZOOM.step, event.currentTarget));
$('#zoomOut').addEventListener('click', event => adjustZoom(-ZOOM.step, event.currentTarget));
$('#resetZoom').addEventListener('click', () => setZoom(1));
$('#toggleFullscreen').addEventListener('click', async () => {
  try { if (!document.fullscreenElement) await els.reader.requestFullscreen(); else await document.exitFullscreen(); }
  catch { showToast('Tela cheia não disponível neste navegador.'); }
});

// Busca dentro da edição
$('#readerSearchTrigger').addEventListener('click', openReaderSearch);
els.readerSearchBackdrop.addEventListener('click', event => { if (event.target === els.readerSearchBackdrop) closeReaderSearch(); });
els.readerSearchInput.addEventListener('input', renderReaderSearchResults);
$('#readerSearchResults').addEventListener('click', event => {
  const button = event.target.closest('[data-page]');
  if (button) abrirResultadoLeitor(button);
});

// --- 9.3 Teclado ---
document.addEventListener('keydown', event => {
  const typing = event.target.matches?.('input,textarea,[contenteditable="true"]');
  const commandOpen = !els.commandBackdrop.hidden;
  const readerSearchOpen = !els.readerSearchBackdrop.hidden;
  const inReader = Boolean(state.readerIssue);

  if (event.key === 'Tab' && (inReader || commandOpen)) trapFocus(event, inReader ? els.reader : els.commandBackdrop);
  if (event.key === '/' && !inReader && !typing) { event.preventDefault(); openCommand(); }

  // ↑/↓ percorrem os resultados da busca aberta
  if (commandOpen && !inReader && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
    moveFocusInList(event, [els.searchInput, ...els.commandBackdrop.querySelectorAll('.command-item,.result-item')]);
  }
  if (readerSearchOpen && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
    moveFocusInList(event, [els.readerSearchInput, ...$('#readerSearchResults').querySelectorAll('.result-item')]);
  }

  // ←/→ no carrossel (quando o foco está nele)
  if (!inReader && !commandOpen && event.target.closest?.('.coverflow-wrap') && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
    event.preventDefault();
    moveCover(event.key === 'ArrowRight' ? 1 : -1);
    if (event.target.closest('.coverflow')) els.coverflow.querySelector('.cover-card.active')?.focus({ preventScroll: true });
  }

  // Esc fecha, do mais interno para o mais externo
  if (event.key === 'Escape') {
    toggleYearMenu(false);
    if (readerSearchOpen) closeReaderSearch();
    else if (inReader) closeReader();
    else closeCommand();
  }

  // Atalhos do leitor (desativados enquanto digita)
  if (inReader && !typing) {
    if (event.key === 'ArrowRight') turnPage(1);
    if (event.key === 'ArrowLeft') turnPage(-1);
    if (event.key === '+' || event.key === '=') setZoom(state.zoom + ZOOM.step);
    if (event.key === '-') setZoom(state.zoom - ZOOM.step);
    if (event.key === '0') setZoom(1);
  }

  if (commandOpen && event.key === 'Enter' && event.target === els.searchInput) { event.preventDefault(); confirmarBuscaHome(); }
  if (readerSearchOpen && event.key === 'Enter' && event.target === els.readerSearchInput) {
    const primeiro = $('#readerSearchResults .result-item');
    if (primeiro) abrirResultadoLeitor(primeiro);
  }
});

/* ---------- 10. Arraste do carrossel e inicialização ---------- */

const carouselDrag = { active: false, moved: false, suppressClickUntil: 0, startX: 0, delta: 0, pointerId: null, lastStepAt: 0 };

// Encerra o arraste; se houve movimento, ignora o clique que o navegador dispara em seguida.
function endCarouselDrag() {
  carouselDrag.active = false;
  carouselDrag.suppressClickUntil = carouselDrag.moved ? performance.now() + 180 : 0;
  els.coverflow.classList.remove('dragging');
  els.coverflow.style.transform = 'none';
}

els.coverflow.addEventListener('dragstart', event => event.preventDefault());
els.coverflow.addEventListener('pointerdown', event => {
  if (event.button !== 0) return;
  Object.assign(carouselDrag, { active: true, moved: false, suppressClickUntil: 0, startX: event.clientX, delta: 0, pointerId: event.pointerId, lastStepAt: 0 });
  els.coverflow.classList.add('dragging');
  els.coverflow.style.transform = 'none';
});
// Cada `stepDistance` px arrastados avançam uma capa (no máximo uma a cada 360 ms).
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
const finishCarouselDrag = event => { if (carouselDrag.active && event.pointerId === carouselDrag.pointerId) endCarouselDrag(); };
els.coverflow.addEventListener('pointerup', finishCarouselDrag);
els.coverflow.addEventListener('pointercancel', finishCarouselDrag);
window.addEventListener('pointerup', finishCarouselDrag, true);
window.addEventListener('blur', endCarouselDrag);

loadIssues();
