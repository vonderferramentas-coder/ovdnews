const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const PUBLIC_DIR = ROOT;
const ISSUES_DIR = path.join(ROOT, 'arquivos');
const COVER_CACHE_DIR = path.join(ROOT, '.cache', 'covers');
const PORT = Number(process.env.PORT || 4173);
fs.mkdirSync(COVER_CACHE_DIR, { recursive: true });

const PUBLIC_FILES = new Set(['index.html', 'styles.css', 'app.js', 'edicoes.json', 'edicoes-data.js']);
const PUBLIC_DIRS = new Set(['assets', 'vendor']);
function isPublicPath(relative) {
  if (!relative) return true;
  const first = relative.split(/[\\/]/)[0];
  return PUBLIC_FILES.has(relative) || PUBLIC_DIRS.has(first);
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.mjs': 'text/javascript; charset=utf-8'
};

function safeJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

function scanIssues() {
  if (!fs.existsSync(ISSUES_DIR)) return [];
  const entries = fs.readdirSync(ISSUES_DIR, { withFileTypes: true });
  const folderIssues = entries
    .filter(entry => entry.isDirectory() && /^edicao-[\w-]+$/i.test(entry.name))
    .map(entry => {
      const dir = path.join(ISSUES_DIR, entry.name);
      const meta = safeJson(path.join(dir, 'metadata.json'));
      const localPages = fs.readdirSync(dir)
        .filter(file => /^pagina-\d+\.(webp|png|jpe?g)$/i.test(file))
        .sort((a, b) => a.localeCompare(b, 'pt-BR', { numeric: true }));
      const id = entry.name.replace(/^edicao-/i, '');
      const count = localPages.length || Number(meta.pageCount || 0);
      const pages = localPages.length
        ? localPages.map(file => `/arquivos/${entry.name}/${file}`)
        : Array.from({ length: count }, (_, i) => {
            const base = String(meta.sourceBase || '').replace(/\/$/, '');
            return `${base}/pagina-${String(i + 1).padStart(2, '0')}.webp`;
          });
      return {
        id, folder: entry.name, number: Number(meta.number || id),
        title: meta.title || `Edição nº ${Number(id)}`,
        eyebrow: meta.eyebrow || 'Revista OVD', date: meta.date || '',
        year: Number(meta.year || String(meta.date || '').slice(0, 4) || 0),
        category: meta.category || 'Notícias OVD', description: meta.description || '',
        featured: Boolean(meta.featured), tags: Array.isArray(meta.tags) ? meta.tags : [],
        pageCount: pages.length, cover: meta.cover || pages[0] || '', pages
      };
    })
    .filter(issue => issue.pageCount > 0);
  const pdfIssues = entries
    .filter(entry => entry.isFile() && /\.pdf$/i.test(entry.name))
    .map(entry => {
      const pdfPath = path.join(ISSUES_DIR, entry.name);
      const pdfStat = fs.statSync(pdfPath);
      const basename = entry.name.replace(/\.pdf$/i, '');
      const revision = `${pdfStat.size}-${Math.trunc(pdfStat.mtimeMs)}`;
      const cacheId = `${crypto.createHash('sha1').update(entry.name).digest('hex').slice(0, 16)}-${revision}`;
      const cachedCover = path.join(COVER_CACHE_DIR, `${cacheId}.webp`);
      const cachedMeta = safeJson(path.join(COVER_CACHE_DIR, `${cacheId}.json`));
      const numericPart = basename.match(/\d+/)?.[0] || basename;
      const number = Number(numericPart) || numericPart;
      return {
        id: `pdf-${basename}`, folder: null, number,
        title: `Edição nº ${number}`, eyebrow: 'Revista OVD', date: '', year: 0,
        category: 'Acervo PDF', description: '', featured: false, tags: [basename],
        pageCount: Number(cachedMeta.pageCount || 0),
        cover: fs.existsSync(cachedCover) ? `/capas/${cacheId}.webp` : '',
        pages: [], sourceType: 'pdf',
        pdf: `/arquivos/${encodeURIComponent(entry.name)}`,
        coverRevision: revision,
        coverUpload: `/api/capas/${cacheId}.webp`
      };
    });
  const byNumber = new Map(folderIssues.map(issue => [String(Number(issue.number)), issue]));
  pdfIssues.forEach(issue => byNumber.set(String(Number(issue.number)), issue));
  return [...byNumber.values()]
    .sort((a, b) => (b.year - a.year) || (b.number - a.number));
}

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': type.includes('json') ? 'no-store' : 'public, max-age=300' });
  res.end(body);
}

function serveFile(req, res, file) {
  fs.stat(file, (error, stat) => {
    if (error || !stat.isFile()) return send(res, 404, 'Não encontrado');
    const extension = path.extname(file).toLowerCase();
    const isAppAsset = ['.html', '.js', '.css', '.mjs'].includes(extension);
    const headers = {
      'Content-Type': MIME[extension] || 'application/octet-stream',
      'Cache-Control': isAppAsset ? 'no-store, no-cache, must-revalidate' : 'public, max-age=86400',
      'Accept-Ranges': 'bytes',
      ...(isAppAsset ? { 'Pragma': 'no-cache', 'Expires': '0' } : {})
    };
    const range = req.headers.range;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match) {
        res.writeHead(416, { ...headers, 'Content-Range': `bytes */${stat.size}` });
        return res.end();
      }
      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= stat.size) {
        res.writeHead(416, { ...headers, 'Content-Range': `bytes */${stat.size}` });
        return res.end();
      }
      res.writeHead(206, {
        ...headers,
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Content-Length': end - start + 1
      });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...headers, 'Content-Length': stat.size });
    fs.createReadStream(file).pipe(res);
  });
}

http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/api/edicoes') {
    return send(res, 200, JSON.stringify({ issues: scanIssues(), scannedAt: new Date().toISOString() }), 'application/json; charset=utf-8');
  }
  if (req.method === 'POST' && url.pathname.startsWith('/api/capas/')) {
    const filename = decodeURIComponent(url.pathname.slice('/api/capas/'.length));
    if (!/^[a-f0-9]{16}-\d+-\d+\.webp$/.test(filename)) return send(res, 400, 'Nome de capa inválido');
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size <= 2 * 1024 * 1024) chunks.push(chunk);
      else req.destroy();
    });
    req.on('end', () => {
      if (!size || size > 2 * 1024 * 1024) return send(res, 413, 'Capa muito grande');
      const target = path.join(COVER_CACHE_DIR, filename);
      fs.writeFileSync(target, Buffer.concat(chunks));
      const pageCount = Number(req.headers['x-page-count'] || 0);
      fs.writeFileSync(target.replace(/\.webp$/, '.json'), JSON.stringify({ pageCount }));
      send(res, 201, 'Capa armazenada');
    });
    return;
  }
  const isIssueAsset = url.pathname.startsWith('/arquivos/');
  const isCachedCover = url.pathname.startsWith('/capas/');
  const roots = isIssueAsset ? ISSUES_DIR : isCachedCover ? COVER_CACHE_DIR : PUBLIC_DIR;
  const relative = decodeURIComponent(isIssueAsset ? url.pathname.slice('/arquivos/'.length) : isCachedCover ? url.pathname.slice('/capas/'.length) : url.pathname.slice(1));
  if (!isIssueAsset && !isCachedCover && !isPublicPath(relative)) return send(res, 404, 'Não encontrado');
  let file = path.resolve(roots, relative || 'index.html');
  if (!file.startsWith(path.resolve(roots))) return send(res, 403, 'Acesso negado');
  if (!path.extname(file)) file = path.join(PUBLIC_DIR, 'index.html');
  serveFile(req, res, file);
}).listen(PORT, () => console.log(`OVD News em http://localhost:${PORT}`));
