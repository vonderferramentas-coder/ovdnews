import json
import hashlib
import re
import os
import urllib.parse
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.abspath(__file__))
ISSUES_DIR = os.path.join(ROOT, 'arquivos')
OUTPUT_FILE = os.path.join(ROOT, 'edicoes.json')
SCRIPT_OUTPUT_FILE = os.path.join(ROOT, 'edicoes-data.js')
COVER_CACHE_DIR = os.path.join(ROOT, '.cache', 'covers')

FOLDER_RE = re.compile(r'^edicao-[\w-]+$', re.IGNORECASE)
PAGE_RE = re.compile(r'^pagina-(\d+)\.(webp|png|jpe?g)$', re.IGNORECASE)


def safe_json(path):
    try:
        with open(path, 'r', encoding='utf-8') as handle:
            return json.load(handle)
    except Exception:
        return {}


def to_number(value, default=0):
    try:
        return int(value)
    except (TypeError, ValueError):
        try:
            return int(float(value))
        except (TypeError, ValueError):
            return default


def scan_folder_issues():
    issues = []
    for name in sorted(os.listdir(ISSUES_DIR)):
        full = os.path.join(ISSUES_DIR, name)
        if not os.path.isdir(full) or not FOLDER_RE.match(name):
            continue
        meta = safe_json(os.path.join(full, 'metadata.json'))
        local_pages = sorted(
            (f for f in os.listdir(full) if PAGE_RE.match(f)),
            key=lambda f: int(PAGE_RE.match(f).group(1))
        )
        issue_id = re.sub(r'^edicao-', '', name, flags=re.IGNORECASE)
        count = len(local_pages) or to_number(meta.get('pageCount'), 0)
        if local_pages:
            pages = [f'/arquivos/{name}/{f}' for f in local_pages]
        else:
            base = str(meta.get('sourceBase') or '').rstrip('/')
            pages = [f'{base}/pagina-{str(i + 1).zfill(2)}.webp' for i in range(count)]
        number = to_number(meta.get('number'), to_number(issue_id, 0))
        issue = {
            'id': issue_id,
            'folder': name,
            'number': number,
            'title': meta.get('title') or f'Edição nº {number}',
            'eyebrow': meta.get('eyebrow') or 'Revista OVD',
            'date': meta.get('date') or '',
            'year': to_number(meta.get('year'), to_number(str(meta.get('date') or '')[:4], 0)),
            'category': meta.get('category') or 'Notícias OVD',
            'description': meta.get('description') or '',
            'featured': bool(meta.get('featured')),
            'tags': meta.get('tags') if isinstance(meta.get('tags'), list) else [],
            'pageCount': len(pages),
            'cover': meta.get('cover') or (pages[0] if pages else ''),
            'pages': pages
        }
        if issue['pageCount'] > 0:
            issues.append(issue)
    return issues


def scan_pdf_issues():
    issues = []
    for name in sorted(os.listdir(ISSUES_DIR)):
        full = os.path.join(ISSUES_DIR, name)
        if not os.path.isfile(full) or not name.lower().endswith('.pdf'):
            continue
        basename = re.sub(r'\.pdf$', '', name, flags=re.IGNORECASE)
        numeric_match = re.search(r'\d+', basename)
        number = to_number(numeric_match.group(0), basename) if numeric_match else basename
        stat = os.stat(full)
        revision = f'{stat.st_size}-{stat.st_mtime_ns // 1_000_000}'
        digest = hashlib.sha1(name.encode('utf-8')).hexdigest()[:16]
        cache_id = f'{digest}-{revision}'
        cached_cover = os.path.join(COVER_CACHE_DIR, f'{cache_id}.webp')
        cached_meta = safe_json(os.path.join(COVER_CACHE_DIR, f'{cache_id}.json'))
        page_count = to_number(cached_meta.get('pageCount'), 0)
        issues.append({
            'id': f'pdf-{basename}',
            'folder': None,
            'number': number,
            'title': f'Edição nº {number}',
            'eyebrow': 'Revista OVD',
            'date': '',
            'year': 0,
            'category': 'Acervo PDF',
            'description': '',
            'featured': False,
            'tags': [basename],
            'pageCount': page_count,
            'cover': f'/capas/{cache_id}.webp' if os.path.isfile(cached_cover) else '',
            'pages': list(range(1, page_count + 1)),
            'sourceType': 'pdf',
            'pdf': f'/arquivos/{urllib.parse.quote(name)}',
            'coverRevision': revision
        })
    return issues


def main():
    if not os.path.isdir(ISSUES_DIR):
        issues = []
    else:
        by_number = {}
        for issue in scan_folder_issues():
            by_number[str(to_number(issue['number']))] = issue
        for issue in scan_pdf_issues():
            by_number[str(to_number(issue['number']))] = issue
        issues = sorted(by_number.values(), key=lambda i: (-i['year'], -to_number(i['number'])))

    data = {'issues': issues, 'scannedAt': datetime.now(timezone.utc).isoformat()}
    with open(OUTPUT_FILE, 'w', encoding='utf-8') as handle:
        json.dump(data, handle, ensure_ascii=False, indent=2)

    with open(SCRIPT_OUTPUT_FILE, 'w', encoding='utf-8') as handle:
        handle.write('window.OVD_ISSUES_DATA = ')
        json.dump(data, handle, ensure_ascii=False, separators=(',', ':'))
        handle.write(';\n')

    print(f'{len(issues)} edições gravadas em {OUTPUT_FILE} e {SCRIPT_OUTPUT_FILE}')


if __name__ == '__main__':
    main()
