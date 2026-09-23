const state = { issues: [], filtered: [], active: 0, sortDesc: true, readerIssue: null, page: 0, libraryPage: 1, query: '', year: 'all', zoom: 1 };
const LIBRARY_PAGE_SIZE = 10;
const COMPACT_PAGINATION = matchMedia('(max-width: 580px)');
// No celular mostra 1 página por vez (tipo Kindle), em vez do spread de 2 do desktop — mantém a
// virada do turn.js, só reduz o que é desenhado por vez, pra pesar menos no aparelho.
const READER_SINGLE_PAGE = matchMedia('(max-width: 580px)');
const icon = name => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
let pdfModulePromise;
let pdfCoverObserver;
let pageFlipInstance = null;
let turnBookInstance = null;
const READER_ENGINE = 'turnjs'; // Use 'stpageflip' para retornar ao leitor anterior.
let readerRenderToken = 0;
let readerThumbsRendered = false;
let readerFlipPending = false;
let readerLayout = [];
let readerModoUnico = false; // trava no valor de READER_SINGLE_PAGE no momento em que o leitor abre
let bookSettleTimer = 0;
const coverQueue = [];
let runningCoverJobs = 0;
const COVER_CACHE = 'ovd-news-covers-v1';
const FILE_MODE = location.protocol === 'file:';
const $ = selector => document.querySelector(selector);
const els = {
  coverflow: $('#coverflow'), issueGrid: $('#issueGrid'),
  carouselPosition: $('#carouselPosition'), commandBackdrop: $('#commandBackdrop'), searchInput: $('#searchInput'),
  searchResults: $('#searchResults'), reader: $('#reader'), book: $('#book'), thumbnailRail: $('#thumbnailRail'),
  readerSearchBackdrop: $('#readerSearchBackdrop')
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
    module.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.mjs';
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
      const number = Number(issue.number);
      if (!issue.year && number >= 1 && number <= 40) {
        issue.year = 2002 + Math.floor((number - 1) / 12);
        issue.date ||= `${issue.year}-${String((number - 1) % 12 + 1).padStart(2, '0')}`;
      }
    });
    state.issues = data.issues;
    state.filtered = [...state.issues];
    const years = [...new Set(state.issues.map(issue => issue.year).filter(Boolean))].sort((a,b)=>b-a);
    $('#yearMenu').innerHTML = ['all', ...years].map(year => {
      const count = year === 'all' ? state.issues.length : state.issues.filter(issue => issue.year === year).length;
      return `<button class="year-option" type="button" role="option" data-year="${year}" aria-selected="${year === 'all'}"><span>${year === 'all' ? 'Todos os anos' : year}</span><small>${count} ${count === 1 ? 'edição' : 'edições'}</small></button>`;
    }).join('');
    $('#scanStatus').textContent = `${state.issues.length} edições sincronizadas`;
    render();
    precarregarOcr();
  } catch (error) {
    $('#emptyState').hidden = false;
    $('#emptyState').textContent = 'Não foi possível carregar o acervo.';
  }
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
  if (!issues.length) { els.coverflow.innerHTML = ''; return; }
  state.active = Math.min(state.active, issues.length - 1);
  const totalEditions = Math.max(...state.issues.map(issue => Number(issue.number) || 0));
  const signature = issues.map(issue => issue.id).join('|');
  if (els.coverflow.dataset.signature !== signature) {
    els.coverflow.dataset.signature = signature;
    els.coverflow.innerHTML = issues.map((issue,index) => `<button class="cover-card far" data-index="${index}" role="listitem" aria-label="Selecionar ${issue.title}"><span class="magazine-pages" aria-hidden="true"><i></i><i></i><i></i></span><img src="${issue.cover || placeholderCover(issue)}" data-cover-id="${issue.id}" alt="Capa da ${issue.title}" loading="${index===0?'eager':'lazy'}"><span class="page-label">${issue.number}/${totalEditions}</span><span class="open-label">Ler mais <b>↗</b></span></button>`).join('');
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
  const totalPages = Math.max(1, Math.ceil(state.filtered.length / LIBRARY_PAGE_SIZE));
  state.libraryPage = Math.min(state.libraryPage, totalPages);
  const start = (state.libraryPage - 1) * LIBRARY_PAGE_SIZE;
  els.issueGrid.innerHTML = state.filtered.slice(start,start + LIBRARY_PAGE_SIZE).map(issue => `<button class="issue-tile" data-id="${issue.id}" aria-label="Ler ${issue.title}"><div class="tile-cover"><img src="${issue.cover || placeholderCover(issue)}" data-cover-id="${issue.id}" alt="Capa da ${issue.title}" loading="lazy"></div><div class="tile-info"><strong>${issue.title}</strong><span data-info-id="${issue.id}">${[formatDate(issue.date), issue.pageCount ? `${issue.pageCount} págs.` : 'PDF'].filter(Boolean).join(' · ')}</span></div></button>`).join('');
  renderPagination(totalPages);
}

function renderPagination(totalPages) {
  const pagination = $('#libraryPagination');
  pagination.hidden = totalPages <= 1;
  if (pagination.hidden) return;
  const current = state.libraryPage;
  // No celular cabem no máximo 7 botões de 44px: anterior, 5 posições e próxima.
  const pages = COMPACT_PAGINATION.matches ? (totalPages <= 5 ? Array.from({length:totalPages},(_,index)=>index+1) : current <= 2 ? [1,2,3,'…',totalPages] : current >= totalPages-1 ? [1,'…',totalPages-2,totalPages-1,totalPages] : [1,'…',current,'…',totalPages]) : totalPages <= 7 ? Array.from({length:totalPages},(_,index)=>index+1) : current <= 4 ? [1,2,3,4,5,'…',totalPages] : current >= totalPages-3 ? [1,'…',totalPages-4,totalPages-3,totalPages-2,totalPages-1,totalPages] : [1,'…',current-1,current,current+1,'…',totalPages];
  pagination.innerHTML = `<button data-page="${current-1}" aria-label="Página anterior" ${current===1?'disabled':''}>${icon('chevron-left')}</button>${pages.map(page=>page==='…'?'<span aria-hidden="true">…</span>':`<button data-page="${page}" ${page===current?'aria-current="page"':''} aria-label="Página ${page}">${page}</button>`).join('')}<button data-page="${current+1}" aria-label="Próxima página" ${current===totalPages?'disabled':''}>${icon('chevron-right')}</button>`;
}
COMPACT_PAGINATION.addEventListener('change', () => renderPagination(Math.max(1, Math.ceil(state.filtered.length / LIBRARY_PAGE_SIZE))));

function moveCover(direction) {
  const length = state.filtered.length;
  if (!length) return;
  state.active = (state.active + direction + length) % length;
  renderCoverflow();
  observePdfCovers();
}

function metadadosTexto(issue) {
  return normalize([issue.title, issue.number, issue.date, issue.year, issue.category, issue.description, ...issue.tags].join(' '));
}

// ---------- busca no texto das páginas (OCR) ----------
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
  $('#allTitle').textContent = state.year === 'all' ? 'Todas as edições' : `Edições de ${state.year}`;
  $('#yearFilterLabel').textContent = state.year === 'all' ? 'Todos' : state.year;
  $('#yearMenu').querySelectorAll('[data-year]').forEach(option => option.setAttribute('aria-selected', option.dataset.year === state.year));
  renderGrid(); requestAnimationFrame(observePdfCovers);
  if (confirmar) renderCoverflow();
  renderSearchResults();
}

function applySearch(query) {
  state.query = query;
  const termo = normalize(query.trim());
  if (termo) Promise.all(state.issues.map(carregarOcrEdicao)).then(() => { if (normalize(state.query.trim()) === termo) applyFilters(false); });
  applyFilters(false);
}

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

function renderSearchResults() {
  if (!state.query) { els.searchResults.innerHTML = ''; return; }
  const termo = normalize(state.query.trim());
  const candidatos = candidatosBusca(termo).slice(0, 6);
  els.searchResults.innerHTML = candidatos.length ? `<p class="command-label">Resultados</p>${candidatos.map(({ issue, achado }) => `<button class="result-item" data-id="${issue.id}"><img src="${issue.cover || placeholderCover(issue)}" data-cover-id="${issue.id}" alt=""><span><strong>${issue.title}</strong><small>${[formatDate(issue.date), issue.category, achado ? `encontrado na página ${achado.pagina}` : ''].filter(Boolean).join(' · ')}</small>${achado ? `<small class="trecho">${achado.trechoHtml}</small>` : ''}</span></button>`).join('')}` : '<p class="command-label">Nenhum resultado encontrado</p>';
}

// Busca interna da edição aberta: mesma cara da busca do acervo (mesmas classes .command-*
// e .result-item), mas os resultados são páginas da edição atual, não outras edições.
function renderReaderSearchResults() {
  const issue = state.readerIssue;
  const termo = normalize($('#readerSearchInput').value.trim());
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
  setTimeout(() => $('#readerSearchInput').focus(), 40);
}
function closeReaderSearch({ returnFocus = true } = {}) {
  const wasOpen = !els.readerSearchBackdrop.hidden;
  els.readerSearchBackdrop.hidden = true;
  $('#readerSearchTrigger').setAttribute('aria-expanded', 'false');
  if (wasOpen && returnFocus) restoreFocus(readerSearchReturnFocus);
}
function irParaResultadoBusca(pagina, palavras) {
  if (!state.readerIssue) return;
  cancelPageTurn();
  state.page = Math.max(0, Math.min(state.readerIssue.pageCount - 1, pagina - 1));
  renderPages();
  closeReaderSearch({ returnFocus: false });
  if (palavras && palavras.length) destacarPalavras(palavras);
}

let commandReturnFocus = null, readerReturnFocus = null;
function restoreFocus(element) { if (element?.isConnected) element.focus({ preventScroll: true }); }
function trapFocus(event, container) {
  const items = [...container.querySelectorAll('button,input,[href],[tabindex]:not([tabindex="-1"])')].filter(el => !el.disabled && el.getClientRects().length);
  if (!items.length) return;
  const first = items[0], last = items[items.length - 1], inside = container.contains(document.activeElement);
  if (event.shiftKey && (!inside || document.activeElement === first)) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && (!inside || document.activeElement === last)) { event.preventDefault(); first.focus(); }
}
function openCommand() { if (els.commandBackdrop.hidden) commandReturnFocus = document.activeElement; els.commandBackdrop.hidden = false; $('#commandTrigger').setAttribute('aria-expanded','true'); setTimeout(()=>els.searchInput.focus(),40); }
// resetQuery=false preserva a pesquisa (usado ao CONFIRMAR: Enter ou clicar na lupa, que deixam
// o carrossel refletindo o resultado). Cancelar a busca (Esc, clicar fora) usa o padrão (true) e
// descarta tudo, voltando pro estado sem pesquisa — carrossel, grade e dropdown revertem pra
// "todas as edições" e o campo limpa, pra reabrir a busca nunca mostrar a palavra anterior.
function closeCommand({ returnFocus = true, resetQuery = true } = {}) {
  const wasOpen = !els.commandBackdrop.hidden;
  els.commandBackdrop.hidden = true;
  $('#commandTrigger').setAttribute('aria-expanded','false');
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

async function openReader(id, sourceImage = null) {
  const issue = state.issues.find(item => item.id === String(id));
  if (!issue) return;
  readerReturnFocus = els.commandBackdrop.hidden ? document.activeElement : commandReturnFocus;
  if (FILE_MODE && issue.pdf) {
    window.open(issue.pdf, '_blank', 'noopener');
    closeCommand();
    return;
  }
  if (issue.pdf) {
    showToast(`Abrindo ${issue.title}...`);
    try { await ensurePdfIssue(issue); } catch { showToast('Não foi possível abrir este PDF.'); return; }
  }
  const animated = sourceImage && document.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches;
  const reveal = async () => {
    state.readerIssue = issue;
    state.page = 0;
    state.zoom = 1; readerThumbsRendered = false;
    els.reader.classList.toggle('is-opening', Boolean(animated));
    els.reader.hidden = false; document.body.style.overflow = 'hidden';
    $('#readerTitle').textContent = issue.title; $('#readerDate').textContent = formatDate(issue.date);
    els.thumbnailRail.innerHTML = issue.pdf
      ? issue.pages.map((page,index)=>`<button data-page="${index}" aria-label="Ir para página ${index+1}"><canvas data-thumb-page="${page}" aria-label="Página ${index+1}"></canvas></button>`).join('')
      : issue.pages.map((page,index)=>`<button data-page="${index}" aria-label="Ir para página ${index+1}"><img src="${page}" alt="Página ${index+1}" loading="lazy"></button>`).join('');
    applyZoom(); closeCommand({ returnFocus: false }); $('#closeReader').focus({ preventScroll: true }); await initPageFlip(issue);
  };
  if (!animated) return reveal();
  // Mantém a abertura suave, sem compartilhar a imagem da capa com o livro.
  // A camada compartilhada criava um retângulo branco durante o redimensionamento.
  const transition = document.startViewTransition(reveal);
  await transition.finished.catch(() => undefined);
  requestAnimationFrame(() => els.reader.classList.remove('is-opening'));
}

async function renderPdfThumbnails(issue) {
  for (const canvas of els.thumbnailRail.querySelectorAll('[data-thumb-page]')) {
    if (state.readerIssue !== issue) break;
    await renderPdfToCanvas(issue, Number(canvas.dataset.thumbPage), canvas, 150);
  }
}

function resetPageFlip() {
  readerRenderToken += 1;
  if (pageFlipInstance) try { pageFlipInstance.destroy(); } catch {}
  if (turnBookInstance) try { turnBookInstance.turn('destroy'); } catch {}
  pageFlipInstance = null;
  turnBookInstance = null;
  const mount = document.createElement('div');
  mount.className = 'book'; mount.id = 'book';
  els.book.replaceWith(mount);
  els.book = mount;
}
function closeReader() { cancelPageTurn(); resetPageFlip(); readerFlipPending = false; els.reader.classList.remove('is-opening'); els.reader.hidden = true; document.body.style.overflow = ''; state.readerIssue = null; state.zoom = 1; closeReaderSearch({ returnFocus: false }); $('#readerSearchInput').value = ''; $('#readerSearchResults').innerHTML = ''; $('#readerSearchCount').textContent = ''; restoreFocus(readerReturnFocus); }

function getSpreadStart(page) { if (readerModoUnico) return page; if (page === 0) return 0; return page % 2 === 0 ? page - 1 : page; }

function readerPagePlaceholder(pageNumber) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 840"><rect width="600" height="840" fill="#f5f2ea"/><path d="M0 0h600v840H0z" fill="url(#p)" opacity=".18"/><defs><pattern id="p" width="7" height="7" patternUnits="userSpaceOnUse"><path d="M0 0v7" stroke="#9e9a91" stroke-width="1"/></pattern></defs><text x="300" y="420" text-anchor="middle" fill="#9d9990" font-family="Segoe UI,sans-serif" font-size="18">Página ${pageNumber}</text></svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function setBookSpreadOffset(spreadIndex = pageFlipInstance?.getPageCollection().getCurrentSpreadIndex()) {
  if (!pageFlipInstance || !Number.isInteger(spreadIndex)) return;
  const collection = pageFlipInstance.getPageCollection();
  const spread = collection.getSpread()[spreadIndex] || [];
  const realPageIndex = spread.find(index => Number.isInteger(readerLayout[index]));
  const realPageCount = spread.filter(index => Number.isInteger(readerLayout[index])).length;
  let offset = 0;
  if (pageFlipInstance.getOrientation() === 'landscape' && realPageCount === 1) {
    const page = els.book.querySelectorAll('.stf__item')[realPageIndex];
    const width = page?.getBoundingClientRect().width || pageFlipInstance.getBoundsRect().pageWidth;
    offset = spread.indexOf(realPageIndex) === 0 ? width / 2 : -width / 2;
  }
  els.book.style.setProperty('--book-offset', `${offset}px`);
}
function syncReaderControls() {
  if (READER_ENGINE === 'turnjs') return syncTurnJsControls();
  const issue = state.readerIssue; if (!issue) return;
  const portrait = pageFlipInstance?.getOrientation() === 'portrait';
  const collection = pageFlipInstance?.getPageCollection();
  const spread = collection?.getSpread()[collection.getCurrentSpreadIndex()] || [];
  const visible = spread.map(index => readerLayout[index]).filter(Number.isInteger).map(page => page - 1);
  if (!visible.length) return;
  const start = Math.min(...visible);
  const end = Math.max(...visible) + 1;
  state.page = start;
  setBookSpreadOffset(collection.getCurrentSpreadIndex());
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

// Encosta as setas nas bordas reais da(s) página(s) visível(is) — uma só no modo 1 página
// (celular) ou na capa/contracapa do modo 2 páginas (desktop); duas no miolo do desktop.
// No modo desktop não mede as páginas em si: durante a virada elas usam transforms 3D
// (perspective/rotateY) que distorcem o retângulo lido via getBoundingClientRect, então a seta
// acabava caindo perto da lombada, no centro. Em vez disso usa a mesma regra de geometria do
// --turnjs-offset (abaixo): o #book sempre ocupa a largura cheia do book-shell; com 1 página só,
// ela fica recentralizada nos 50% do meio dessa largura. No modo 1 página não existe esse truque
// de deslocamento, então mede o #book direto — ele já tem a largura exata da página visível.
// Em ambos os casos, dividir por state.zoom devolve a posição "natural" (100%), então as setas
// não se movem quando o usuário aplica zoom manual, só quando a página muda.
function positionPageArrows() {
  if (READER_ENGINE !== 'turnjs' || !turnBookInstance || !state.readerIssue) return;
  const view = turnBookInstance.turn('view') || [];
  if (!view.some(Number.isInteger)) return;
  const prevPageEl = $('#prevPage'), nextPageEl = $('#nextPage');
  // Com zoom aplicado, a página ampliada pode cobrir a posição "natural" das setas.
  // Nesse caso solta o posicionamento inline e deixa as setas nas bordas da tela
  // (margem definida em CSS), voltando à posição encostada na página quando o zoom
  // retorna a 100%.
  if ((state.zoom || 1) > 1.01) {
    prevPageEl.style.removeProperty('left');
    nextPageEl.style.removeProperty('right');
    return;
  }
  const stageRect = $('#readerStage').getBoundingClientRect();
  const zoom = state.zoom || 1;
  let naturalLeft, naturalRight;
  if (readerModoUnico) {
    // Modo 1 página: sem o truque de deslocamento, o próprio #book já tem a largura exata da
    // página visível (centralizada pelo flex do .reader-scroll), então mede ele direto. Ainda
    // assim precisa decompor a partir do canto do book-shell (que não se move com o zoom) pra
    // não deslocar as setas quando o usuário aplica zoom manual.
    const shellRect = $('#bookShell').getBoundingClientRect();
    const bookRect = els.book.getBoundingClientRect();
    const shellLeft = shellRect.left - stageRect.left;
    naturalLeft = shellLeft + (bookRect.left - shellRect.left) / zoom;
    naturalRight = naturalLeft + bookRect.width / zoom;
  } else {
    const shellRect = $('#bookShell').getBoundingClientRect();
    const single = !view[0] || !view[1];
    const shellLeft = shellRect.left - stageRect.left;
    const shellWidth = shellRect.width / zoom;
    naturalLeft = shellLeft + (single ? shellWidth * .25 : 0);
    naturalRight = shellLeft + (single ? shellWidth * .75 : shellWidth);
  }
  const gap = 18;
  const prevPage = $('#prevPage'), nextPage = $('#nextPage');
  const prevWidth = prevPage.getBoundingClientRect().width || 46;
  const nextWidth = nextPage.getBoundingClientRect().width || 46;
  prevPage.style.left = `${Math.max(8, naturalLeft - gap - prevWidth)}px`;
  nextPage.style.right = `${Math.max(8, stageRect.width - naturalRight - gap - nextWidth)}px`;
}
function syncTurnJsControls() {
  const issue = state.readerIssue;
  if (!issue || !turnBookInstance) return;
  const turnView = turnBookInstance.turn('view') || [];
  const visible = turnView.filter(Number.isInteger).map(page => page - 1).filter(page => page >= 0 && page < issue.pageCount);
  if (!visible.length) return;
  const start = Math.min(...visible);
  const end = Math.max(...visible) + 1;
  state.page = start;
  els.book.style.removeProperty('--book-offset');
  // No modo 1 página (celular) nunca precisa desse deslocamento de recentralização — só existe
  // pra centralizar uma página sozinha dentro do espaço largo de 2 páginas do modo desktop.
  if (readerModoUnico) {
    els.book.style.removeProperty('--turnjs-offset');
  } else {
    const turnSize = turnBookInstance.turn('size');
    els.book.style.setProperty('--turnjs-offset', !turnView[0] ? `${-Math.round(turnSize.width / 4)}px` : !turnView[1] ? `${Math.round(turnSize.width / 4)}px` : '0px');
  }
  $('#bookShell').classList.toggle('book-opened', visible.length > 1);
  $('#pageIndicator').textContent = start === 0 ? `Capa · 1 de ${issue.pageCount}` : `Páginas ${start + 1}${end > start + 1 ? `–${end}` : ''} de ${issue.pageCount}`;
  $('#readerProgress').style.width = `${Math.min(100, (end / issue.pageCount) * 100)}%`;
  $('#prevPage').disabled = $('#readerPrev').disabled = start === 0;
  $('#nextPage').disabled = $('#readerNext').disabled = end >= issue.pageCount;
  $('#readerFirst').disabled = start === 0;
  $('#readerLast').disabled = end >= issue.pageCount;
  els.thumbnailRail.querySelectorAll('button').forEach((button, index) => button.classList.toggle('active', index >= start && index < end));
  positionPageArrows();
}

function getTurnJsSize(paginasVisiveis = 2) {
  const shell = $('#bookShell').getBoundingClientRect();
  const aspect = 540 / 760;
  let height = Math.max(352, Math.min(858, Math.floor(shell.height)));
  let width = Math.round(height * aspect);
  if (width * paginasVisiveis > shell.width) { width = Math.floor(shell.width / paginasVisiveis); height = Math.round(width / aspect); }
  return { width, height };
}

async function initTurnJs(issue) {
  resetPageFlip();
  const token = ++readerRenderToken;
  readerLayout = issue.pages.map((_, index) => index + 1);
  els.book.classList.add('turnjs-book');
  els.book.innerHTML = readerLayout.map(pageNumber => {
    const initial = issue.pdf ? (pageNumber === 1 && issue.cover ? issue.cover : readerPagePlaceholder(pageNumber)) : issue.pages[pageNumber - 1];
    return `<div class="flip-page"><img data-reader-page="${pageNumber}" src="${initial}" alt="Página ${pageNumber} de ${issue.pageCount}"></div>`;
  }).join('');
  readerModoUnico = READER_SINGLE_PAGE.matches;
  const size = getTurnJsSize(readerModoUnico ? 1 : 2);
  const $book = window.jQuery(els.book);
  $book.turn({ width: readerModoUnico ? size.width : size.width * 2, height: size.height, display: readerModoUnico ? 'single' : 'double', autoCenter: true, duration: 720, gradients: true, acceleration: true, elevation: 40, corners: 'all', cornerSize: 160, page: (state.page || 0) + 1 });
  turnBookInstance = $book;
    $book.on('turning', () => { clearTimeout(bookSettleTimer); const shell = $('#bookShell'); shell.classList.add('is-page-flipping'); shell.classList.remove('book-settled'); });
  $book.on('turned', () => { readerFlipPending = false; clearTimeout(gutterRestoreTimer); const shell = $('#bookShell'); shell.classList.remove('is-page-flipping'); shell.classList.remove('is-page-dragging'); syncTurnJsControls(); clearTimeout(bookSettleTimer); bookSettleTimer = setTimeout(() => shell.classList.add('book-settled'), 80); });  readerFlipPending = false;
  syncTurnJsControls();
  requestAnimationFrame(() => $('#bookShell').classList.add('book-settled'));
  hydrateReaderPages(issue, token);
}

async function turnTurnJsPage(direction) {
  const issue = state.readerIssue;
  if (!turnBookInstance || !issue || readerFlipPending || !canTurnPage(direction)) return;
  readerFlipPending = true;
  direction > 0 ? turnBookInstance.turn('next') : turnBookInstance.turn('previous');
  const targetPages = direction > 0 ? [state.page + 2, state.page + 3] : [state.page - 1, state.page];
  Promise.all(targetPages.filter(page => page >= 1 && page <= issue.pageCount).map(page => hydrateReaderPage(issue, page))).catch(() => {});
}
async function initPageFlip(issue) {
  if (READER_ENGINE === 'turnjs') return initTurnJs(issue);
  resetPageFlip();
  const token = ++readerRenderToken;
  els.book.classList.add('no-book-shift-transition');
  readerLayout = [null, ...issue.pages.map((_, index) => index + 1), null];
  els.book.innerHTML = readerLayout.map(pageNumber => {
    if (!Number.isInteger(pageNumber)) return '<div class="flip-page flip-spacer" aria-hidden="true"></div>';
    const initial = issue.pdf ? (pageNumber === 1 && issue.cover ? issue.cover : readerPagePlaceholder(pageNumber)) : issue.pages[pageNumber - 1];
    return `<div class="flip-page"><img data-reader-page="${pageNumber}" src="${initial}" alt="Página ${pageNumber} de ${issue.pageCount}"></div>`;
  }).join('');  pageFlipInstance = new St.PageFlip(els.book, {
    width: 540, height: 760, size: 'stretch',
    minWidth: 250, maxWidth: 610, minHeight: 352, maxHeight: 858,
    drawShadow: false, maxShadowOpacity: 0, flippingTime: 720,
    autoSize: false, startPage: 0,
    usePortrait: false, mobileScrollSupport: false, useMouseEvents: true, showCover: false,
    showPageCorners: false, disableFlipByClick: true
  });
  pageFlipInstance.on('changeState', event => {
    const isTurning = event.data === 'user_fold' || event.data === 'flipping';
    const shell = $('#bookShell');
    shell.classList.toggle('is-page-flipping', isTurning);
    if (isTurning) {
      clearTimeout(bookSettleTimer);
      shell.classList.remove('book-settled');
    }
    if (event.data === 'read') {
      readerFlipPending = false;
      syncReaderControls();
      clearTimeout(bookSettleTimer);
      bookSettleTimer = setTimeout(() => shell.classList.add('book-settled'), 760);
    }
  });
  pageFlipInstance.on('changeOrientation', event => {
    $('#bookShell').dataset.orientation = event.data;
    syncReaderControls();
  });
  pageFlipInstance.loadFromHTML([...els.book.querySelectorAll('.flip-page')]);
  $('#bookShell').dataset.orientation = pageFlipInstance.getOrientation();
  readerFlipPending = false;
  syncReaderControls();
  requestAnimationFrame(() => els.book.classList.remove('no-book-shift-transition'));
  hydrateReaderPages(issue, token);
}

function renderPages() {
  if (READER_ENGINE === 'turnjs') { if (turnBookInstance) turnBookInstance.turn('page', Math.min(state.readerIssue.pageCount, state.page + 1)); return; }
  if (!pageFlipInstance) return;
  pageFlipInstance.turnToPage(readerLayout.indexOf(state.page + 1));
  syncReaderControls();
}

function getTargetPageIndexes(direction) {
  if (!pageFlipInstance) return [];
  const collection = pageFlipInstance.getPageCollection();
  const spread = collection.getSpread()[collection.getCurrentSpreadIndex() + direction] || [];
  return spread.map(index => readerLayout[index]).filter(Number.isInteger).map(page => page - 1);
}

async function turnPage(direction) {
  if (READER_ENGINE === 'turnjs') return turnTurnJsPage(direction);
  const issue = state.readerIssue;
  if (!pageFlipInstance || !issue || readerFlipPending) return;
  const pageIndexes = getTargetPageIndexes(direction);
  if (!pageIndexes.length) return;
  readerFlipPending = true;
  const ready = await Promise.all(pageIndexes.map(index => hydrateReaderPage(issue, index + 1)));
  if (!ready.every(Boolean) || state.readerIssue !== issue || !pageFlipInstance) { readerFlipPending = false; return; }
  if (USE_CUSTOM_PAGE_TURN) {
    const collection = pageFlipInstance.getPageCollection();
    const target = collection.getSpread()[collection.getCurrentSpreadIndex() + direction] || [];
    pageFlipInstance.turnToPage(target[0]);
    readerFlipPending = false;
    syncReaderControls();
    return;
  }
  direction > 0 ? pageFlipInstance.flipNext('bottom') : pageFlipInstance.flipPrev('bottom');
}
function applyZoom(center = true) {
  state.zoom = Math.max(1, Math.min(2.5, state.zoom));
  $('#zoomLevel').textContent = `${Math.round(state.zoom * 100)}%`;
  $('#bookShell').style.setProperty('--reader-zoom', state.zoom);
  const zoomed = state.zoom > 1.01;
  $('#readerScroll').classList.toggle('zoomed', zoomed);
  if (zoomed) {
    // Sem zoom, as setas só precisam da margem fixa do CSS — não depende de medir
    // a página, então já pode aplicar na hora.
    positionPageArrows();
  } else {
    // Voltando ao zoom original: a posição "encostada" na página só pode ser medida
    // com o book-shell já assentado na escala 1, senão pega a geometria no meio da
    // transição e a seta trava numa posição errada. Espera o transform terminar.
    $('#bookShell').addEventListener('transitionend', positionPageArrows, { once: true });
  }
  if (!zoomed) {
    $('#readerScroll').scrollTo({ left: 0, top: 0 });
    return;
  }
  if (center) requestAnimationFrame(() => {
    const stage = $('#readerScroll');
    stage.scrollLeft = Math.max(0, (stage.scrollWidth - stage.clientWidth) / 2);
    stage.scrollTop = Math.max(0, (stage.scrollHeight - stage.clientHeight) / 2);
  });
}
function adjustZoom(delta, button) {
  const previous = state.zoom;
  state.zoom += delta;
  applyZoom();
  if (state.zoom === previous || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  button.animate([{transform:'scale(1)'},{transform:'scale(.76)'},{transform:'scale(1.12)'},{transform:'scale(1)'}],{duration:260,easing:'cubic-bezier(.2,.8,.2,1)'});
  $('#zoomLevel').animate([{opacity:.35,transform:`translateY(${delta>0?-4:4}px) scale(.92)`},{opacity:1,transform:'none'}],{duration:240,easing:'ease-out'});
}

function zoomAtPointer(delta, event) {
  const previous = state.zoom;
  const next = Math.max(1, Math.min(2.5, previous + delta));
  if (next === previous) return;
  const stage = $('#readerScroll'), shell = $('#bookShell');
  const stageRect = stage.getBoundingClientRect();
  const shellRect = shell.getBoundingClientRect();
  // Âncora do book-shell em coordenadas de conteúdo: como o transform-origin é
  // top-left, o canto do shell nunca se move com o zoom, só o conteúdo cresce a
  // partir dele — por isso essa posição serve de referência estável entre escalas.
  const anchorX = shellRect.left - stageRect.left + stage.scrollLeft;
  const anchorY = shellRect.top - stageRect.top + stage.scrollTop;
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
  const targetX = anchorX + localX * next;
  const targetY = anchorY + localY * next;
  stage.scrollLeft = Math.max(0, targetX - (event.clientX - stageRect.left));
  stage.scrollTop = Math.max(0, targetY - (event.clientY - stageRect.top));
}
const zoomPan = { active: false, pointerId: null, startX: 0, startY: 0, scrollLeft: 0, scrollTop: 0 };

function finishZoomPan(event) {
  if (!zoomPan.active || event.pointerId !== zoomPan.pointerId) return;
  const shell = $('#bookShell');
  if (shell.hasPointerCapture(event.pointerId)) shell.releasePointerCapture(event.pointerId);
  shell.classList.remove('is-panning');
  Object.assign(zoomPan, { active: false, pointerId: null });
}

const USE_CUSTOM_PAGE_TURN = false; // Set false to restore the native PageFlip interaction.
const pageTurn = { active: false, animating: false, pointerId: null, direction: 0, startX: 0, progress: 0, moved: false, leaf: null, underlay: null, source: null };
let turnCornerClick = null;
let turnCornerDragged = false;
let gutterRestoreTimer = 0;
const bookMagnifier = $('#bookMagnifier');
function updateBookMagnifier(event) {
  if (state.zoom > 1.01 || $('#bookShell').classList.contains('is-page-dragging')) return bookMagnifier.classList.remove('visible');
  const image = document.elementFromPoint(event.clientX, event.clientY)?.closest?.('#book img');
  if (!image) return bookMagnifier.classList.remove('visible');
  const rect = image.getBoundingClientRect();
  const x = event.clientX - rect.left, y = event.clientY - rect.top, scale = 2.15, diameter = 220;
  if (x < 0 || y < 0 || x > rect.width || y > rect.height) return bookMagnifier.classList.remove('visible');
  const shell = $('#bookShell').getBoundingClientRect();
  bookMagnifier.style.left = `${event.clientX - shell.left - diameter / 2}px`;
  bookMagnifier.style.top = `${event.clientY - shell.top - diameter / 2}px`;
  bookMagnifier.style.backgroundImage = `url("${image.currentSrc || image.src}")`;
  bookMagnifier.style.backgroundSize = `${rect.width * scale}px ${rect.height * scale}px`;
  bookMagnifier.style.backgroundPosition = `${diameter / 2 - x * scale}px ${diameter / 2 - y * scale}px`;
  bookMagnifier.classList.add('visible');
}
$('#bookShell').addEventListener('pointermove', updateBookMagnifier);
$('#bookShell').addEventListener('pointerleave', () => bookMagnifier.classList.remove('visible'));
$('#bookShell').addEventListener('pointerdown', () => bookMagnifier.classList.remove('visible'));
let wheelZoomFrame = 0, wheelZoomDelta = 0, wheelZoomEvent, wheelZoomSettle;
$('#bookShell').addEventListener('wheel', event => {
  if (!state.readerIssue || !event.deltaY) return;
  event.preventDefault();
  wheelZoomDelta += Math.sign(-event.deltaY) * .08;
  wheelZoomEvent = event;
  if (wheelZoomFrame) return;
  wheelZoomFrame = requestAnimationFrame(() => {
    const delta = Math.max(-.16, Math.min(.16, wheelZoomDelta));
    wheelZoomDelta = 0; wheelZoomFrame = 0;
    $('#bookShell').classList.add('is-wheel-zoom');
    clearTimeout(wheelZoomSettle);
    wheelZoomSettle = setTimeout(() => $('#bookShell').classList.remove('is-wheel-zoom'), 120);
    zoomAtPointer(delta, wheelZoomEvent);
  });
}, { passive: false });
$('#bookShell').addEventListener('pointerdown', event => {
  if (READER_ENGINE === 'turnjs' && event.button === 0) {
    clearTimeout(gutterRestoreTimer);
    const shell = $('#bookShell');
    shell.classList.add('is-page-dragging');
    shell.classList.remove('book-settled');
    turnCornerDragged = false;
    turnCornerClick = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
  }
});
$('#bookShell').addEventListener('pointermove', event => {
  if (turnCornerClick?.pointerId === event.pointerId && Math.hypot(event.clientX - turnCornerClick.x, event.clientY - turnCornerClick.y) > 8) turnCornerDragged = true;
});
$('#bookShell').addEventListener('pointercancel', () => { turnCornerClick = null; });
$('#bookShell').addEventListener('pointerup', () => {
  if (READER_ENGINE !== 'turnjs') return;
  clearTimeout(gutterRestoreTimer);
  gutterRestoreTimer = setTimeout(() => {
    const shell = $('#bookShell');
    if (!shell.classList.contains('is-page-flipping')) { shell.classList.remove('is-page-dragging'); shell.classList.add('book-settled'); }
  }, 900);
});
$('#bookShell').addEventListener('click', event => {
  if (READER_ENGINE !== 'turnjs' || turnCornerDragged) { turnCornerDragged = false; return; }
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
function canTurnPage(direction) {
  const issue = state.readerIssue;
  if (!issue) return false;
  const start = getSpreadStart(state.page);
  const tamanhoSpread = readerModoUnico ? 1 : (start === 0 ? 1 : 2);
  return direction < 0 ? start > 0 : start + tamanhoSpread < issue.pageCount;
}

function pageSnapshot(element) {
  const surface = element instanceof HTMLCanvasElement || element instanceof HTMLImageElement ? element : element?.querySelector?.('img,canvas');
  if (surface instanceof HTMLCanvasElement) return surface.toDataURL('image/jpeg', .9);
  return surface?.currentSrc || surface?.src || '';
}

function getSpreadPageElement(index) {
  return els.book.querySelectorAll('.stf__item')[index] || null;
}

function createTurningLeaf(direction) {
  const collection = pageFlipInstance?.getPageCollection();
  const current = collection?.getSpread()[collection.getCurrentSpreadIndex()] || [];
  const target = collection?.getSpread()[collection.getCurrentSpreadIndex() + direction] || [];
  const sourceIndex = direction > 0 ? current[current.length - 1] : current[0];
  const targetIndex = target.find(index => Number.isInteger(readerLayout[index]));
  const source = getSpreadPageElement(sourceIndex);
  if (!source) return null;
  const shellRect = $('#bookShell').getBoundingClientRect();
  const rect = source.getBoundingClientRect();
  const leaf = document.createElement('div');
  const underlay = document.createElement('div');
  underlay.className = 'turn-underlay';
  Object.assign(underlay.style, { left: `${rect.left - shellRect.left}px`, top: `${rect.top - shellRect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
  const underlaySrc = pageSnapshot(getSpreadPageElement(targetIndex));
  if (underlaySrc) underlay.innerHTML = `<img src="${underlaySrc}" alt="">`;
  leaf.className = `turning-leaf ${direction > 0 ? 'turning-next' : 'turning-prev'}`;
  Object.assign(leaf.style, { left: `${rect.left - shellRect.left}px`, top: `${rect.top - shellRect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`, '--turn-angle': '0deg' });
  const snapshot = pageSnapshot(source);
  if (!snapshot) return null;
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
  if (READER_ENGINE === 'turnjs') return turnPage(direction);
  if (pageFlipInstance && !USE_CUSTOM_PAGE_TURN) return turnPage(direction);
  if (pageTurn.active || pageTurn.animating || !canTurnPage(direction)) return;
  const visual = createTurningLeaf(direction);
  if (!visual) return turnPage(direction);
  Object.assign(pageTurn, { active: true, animating: false, direction, leaf: visual.leaf, underlay: visual.underlay, source: visual.source, progress: 0 });
  $('#bookShell').classList.add('is-turning');
  requestAnimationFrame(() => finishPageTurn(true));
}

const carouselDrag = { active: false, moved: false, suppressClickUntil: 0, startX: 0, delta: 0, pointerId: null, lastStepAt: 0 };
$('#prevIssue').addEventListener('click',()=>moveCover(-1)); $('#nextIssue').addEventListener('click',()=>moveCover(1));
els.coverflow.addEventListener('click',event=>{if(performance.now()<carouselDrag.suppressClickUntil){event.preventDefault();return;}const card=event.target.closest('.cover-card');if(!card)return;const index=Number(card.dataset.index);if(index===state.active)openReader(state.filtered[index].id,card.querySelector('img'));else{state.active=index;renderCoverflow();observePdfCovers();}});
els.issueGrid.addEventListener('click',event=>{const tile=event.target.closest('.issue-tile');if(tile)openReader(tile.dataset.id,tile.querySelector('img'));});
$('#libraryPagination').addEventListener('click',event=>{const button=event.target.closest('[data-page]');if(!button||button.disabled)return;state.libraryPage=Number(button.dataset.page);renderGrid();requestAnimationFrame(observePdfCovers);document.querySelector('.all-issues').scrollIntoView({behavior:'smooth'});});
$('#commandTrigger').addEventListener('click',openCommand); els.commandBackdrop.addEventListener('click',event=>{if(event.target===els.commandBackdrop)closeCommand();});
els.searchInput.addEventListener('input',event=>applySearch(event.target.value));
$('#searchConfirm').addEventListener('click',confirmarBuscaHome);
function toggleYearMenu(open = $('#yearMenu').hidden) { const menu=$('#yearMenu');menu.hidden=!open;$('#yearFilter').setAttribute('aria-expanded',open);if(open)requestAnimationFrame(()=>menu.querySelector('[aria-selected="true"]')?.focus());else if(menu.contains(document.activeElement))$('#yearFilter').focus(); }
$('#yearFilter').addEventListener('click',()=>toggleYearMenu());
$('#yearFilter').addEventListener('keydown',event=>{if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();toggleYearMenu(true);}});
$('#yearMenu').addEventListener('keydown',event=>{
  const options=[...$('#yearMenu').querySelectorAll('[data-year]')];
  const index=options.indexOf(document.activeElement);
  const target={ArrowDown:index+1,ArrowUp:index-1,Home:0,End:options.length-1}[event.key];
  if(target!==undefined){event.preventDefault();options[Math.max(0,Math.min(options.length-1,target))].focus();}
  else if(event.key==='Tab')toggleYearMenu(false);
});
$('#yearMenu').addEventListener('click',event=>{const option=event.target.closest('[data-year]');if(option){state.year=option.dataset.year;applyFilters();toggleYearMenu(false);}});
document.addEventListener('click',event=>{if(!event.target.closest('#yearPicker'))toggleYearMenu(false);});
els.searchResults.addEventListener('click',event=>{
  const result=event.target.closest('[data-id]');
  if(!result)return;
  openReader(result.dataset.id,result.querySelector('img'));
});
document.querySelectorAll('.command-item').forEach(button=>button.addEventListener('click',()=>{if(button.dataset.command==='latest'&&state.issues[0])openReader(state.issues[0].id);else{els.searchInput.value='';state.year='all';applySearch('');closeCommand();document.querySelector('.all-issues').scrollIntoView();}}));
$('#sortButton').addEventListener('click',()=>{state.sortDesc=!state.sortDesc;state.filtered.reverse();$('#sortButton').innerHTML=`${state.sortDesc?'Mais recentes':'Mais antigas'} ${icon(state.sortDesc?'arrow-down':'arrow-up')}`;state.active=0;state.libraryPage=1;render();});
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
$('#readerSearchTrigger').addEventListener('click',openReaderSearch);
els.readerSearchBackdrop.addEventListener('click',event=>{if(event.target===els.readerSearchBackdrop)closeReaderSearch();});
$('#readerSearchInput').addEventListener('input',renderReaderSearchResults);
$('#readerSearchResults').addEventListener('click',event=>{
  const button=event.target.closest('[data-page]');
  if(!button)return;
  irParaResultadoBusca(Number(button.dataset.page),button.dataset.palavras?JSON.parse(button.dataset.palavras):null);
});
els.thumbnailRail.addEventListener('click',event=>{const button=event.target.closest('[data-page]');if(button){state.page=Number(button.dataset.page);renderPages();}});
$('#zoomIn').addEventListener('click',event=>adjustZoom(.25,event.currentTarget));
$('#zoomOut').addEventListener('click',event=>adjustZoom(-.25,event.currentTarget));
$('#resetZoom').addEventListener('click',()=>{state.zoom=1;applyZoom();});
$('#toggleFullscreen').addEventListener('click',async()=>{try{if(!document.fullscreenElement)await els.reader.requestFullscreen();else await document.exitFullscreen();}catch{showToast('Tela cheia não disponível neste navegador.');}});
document.addEventListener('keydown',event=>{
  const typing=event.target.matches?.('input,textarea,[contenteditable="true"]');
  const commandOpen=!els.commandBackdrop.hidden;
  const readerSearchOpen=!els.readerSearchBackdrop.hidden;
  if(event.key==='Tab'&&(state.readerIssue||commandOpen))trapFocus(event,state.readerIssue?els.reader:els.commandBackdrop);
  if(event.key==='/'&&!state.readerIssue&&!typing){event.preventDefault();openCommand();}
  if(commandOpen&&!state.readerIssue&&(event.key==='ArrowDown'||event.key==='ArrowUp')){
    const items=[els.searchInput,...els.commandBackdrop.querySelectorAll('.command-item,.result-item')];
    const index=Math.max(0,items.indexOf(document.activeElement));
    event.preventDefault();items[(index+(event.key==='ArrowDown'?1:-1)+items.length)%items.length].focus();
  }
  if(readerSearchOpen&&(event.key==='ArrowDown'||event.key==='ArrowUp')){
    const items=[$('#readerSearchInput'),...$('#readerSearchResults').querySelectorAll('.result-item')];
    const index=Math.max(0,items.indexOf(document.activeElement));
    event.preventDefault();items[(index+(event.key==='ArrowDown'?1:-1)+items.length)%items.length].focus();
  }
  if(!state.readerIssue&&!commandOpen&&event.target.closest?.('.coverflow-wrap')&&(event.key==='ArrowLeft'||event.key==='ArrowRight')){
    event.preventDefault();moveCover(event.key==='ArrowRight'?1:-1);
    if(event.target.closest('.coverflow'))els.coverflow.querySelector('.cover-card.active')?.focus({preventScroll:true});
  }
  if(event.key==='Escape'){toggleYearMenu(false);if(readerSearchOpen)closeReaderSearch();else if(state.readerIssue)closeReader();else closeCommand();}
  if(state.readerIssue&&!typing&&event.key==='ArrowRight')requestPageTurn(1); if(state.readerIssue&&!typing&&event.key==='ArrowLeft')requestPageTurn(-1);
  if(state.readerIssue&&!typing&&(event.key==='+'||event.key==='=')){state.zoom+=.25;applyZoom();}
  if(state.readerIssue&&!typing&&event.key==='-'){state.zoom-=.25;applyZoom();}
  if(state.readerIssue&&!typing&&event.key==='0'){state.zoom=1;applyZoom();}
  if(commandOpen&&event.key==='Enter'&&event.target===els.searchInput){event.preventDefault();confirmarBuscaHome();}
  if(readerSearchOpen&&event.key==='Enter'&&event.target===$('#readerSearchInput')){
    const primeiro=$('#readerSearchResults .result-item');
    if(primeiro)irParaResultadoBusca(Number(primeiro.dataset.page),primeiro.dataset.palavras?JSON.parse(primeiro.dataset.palavras):null);
  }
});
$('#bookShell').addEventListener('pointerdown', event => {
  if (state.zoom > 1.01) {
    if (event.button !== 0) return;
    const stage = $('#readerScroll');
    Object.assign(zoomPan, { active: true, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, scrollLeft: stage.scrollLeft, scrollTop: stage.scrollTop });
    $('#bookShell').classList.add('is-panning');
    $('#bookShell').setPointerCapture(event.pointerId);
    event.preventDefault();
    return;
  }
  if (READER_ENGINE === 'turnjs' || (pageFlipInstance && !USE_CUSTOM_PAGE_TURN)) return;
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
    const stage = $('#readerScroll');
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
$('#bookShell').addEventListener('dblclick', event => {
  if (state.zoom <= 1.01) return;
  event.preventDefault();
  state.zoom = 1;
  applyZoom();
});
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








