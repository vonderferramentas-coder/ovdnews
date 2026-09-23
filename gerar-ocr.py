"""Gera o texto pesquisavel de cada edicao, via OCR.

Le edicoes.json (produzido por gerar-edicoes.py) para saber quais edicoes
existem, roda o Tesseract pagina a pagina e grava o resultado em
dados/ocr/edicao-<id>.js — um arquivo por edicao, carregado sob demanda pela
busca do site (veja app.js).

Requisitos nesta maquina (nao precisam existir no servidor onde o site fica
publicado, so aqui, na hora de gerar):
  - Tesseract OCR, com o pacote de idioma portugues ("por")
  - Poppler (pdftoppm e pdfinfo) — so usado para edicoes com PDF
  - Pillow (pip install pillow) — so usado para edicoes em pasta de imagens

Processa dois formatos de edicao:
  - Com PDF (issue["pdf"]): renderiza cada pagina via pdftoppm antes do OCR.
  - Em pasta de imagens soltas (issue["pages"], sem "pdf"): baixa cada pagina
    da URL e converte para PNG antes do OCR.

Reprocessa uma edicao somente quando a fonte mudou — para PDF, tamanho +
data de modificacao do arquivo; para paginas soltas, a lista de URLs. Rodar
de novo sem alterar nada nao refaz OCR do que ja esta pronto. Roda quantas
edicoes novas houver numa unica chamada, uma atras da outra.
"""

import glob
import hashlib
import json
import os
import re
import shutil
import ssl
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from datetime import datetime, timezone

from PIL import Image

# O servidor de imagens (www.ovd.com.br) usa um parametro DH fraco no TLS que o
# nivel de seguranca padrao do OpenSSL 3 recusa ("dh key too small"). Baixa o
# nivel so pra essas requisicoes, sem afetar o resto do sistema.
_SSL_CONTEXTO_PAGINAS = ssl.create_default_context()
_SSL_CONTEXTO_PAGINAS.set_ciphers('DEFAULT@SECLEVEL=1')

ROOT = os.path.dirname(os.path.abspath(__file__))
ISSUES_JSON = os.path.join(ROOT, 'edicoes.json')
OCR_DIR = os.path.join(ROOT, 'dados', 'ocr')
STATE_FILE = os.path.join(OCR_DIR, '.estado.json')

TESSERACT_LANG = 'por'
MIN_CONFIDENCE = 40  # descarta palavras muito ruidosas do OCR (ex.: capas com pouco texto real)
RENDER_DPI = 200

# Onde procurar as ferramentas quando elas nao estao no PATH — comum quando o instalador roda
# sem privilegio de administrador (caso do winget sem elevacao) e cai num diretorio por usuario
# em vez de "Program Files". Cada padrao pode ter curinga (ex.: versao do Poppler muda a cada
# atualizacao) — glob.glob resolve e pega o mais recente.
LOCAIS_EXTRAS = {
    'tesseract': [
        r'C:\Program Files\Tesseract-OCR\tesseract.exe',
        r'C:\Program Files (x86)\Tesseract-OCR\tesseract.exe',
        os.path.expandvars(r'%LOCALAPPDATA%\Programs\Tesseract-OCR\tesseract.exe'),
    ],
    'pdftoppm': [
        os.path.expandvars(r'%LOCALAPPDATA%\Microsoft\WinGet\Packages\oschwartz10612.Poppler_*\poppler-*\Library\bin\pdftoppm.exe'),
        r'C:\Program Files\poppler*\Library\bin\pdftoppm.exe',
        r'C:\poppler*\Library\bin\pdftoppm.exe',
    ],
    'pdfinfo': [
        os.path.expandvars(r'%LOCALAPPDATA%\Microsoft\WinGet\Packages\oschwartz10612.Poppler_*\poppler-*\Library\bin\pdfinfo.exe'),
        r'C:\Program Files\poppler*\Library\bin\pdfinfo.exe',
        r'C:\poppler*\Library\bin\pdfinfo.exe',
    ],
}

_FERRAMENTAS_RESOLVIDAS = {}


def localizar_ferramenta(nome):
    """Acha o executavel pelo PATH normal e, se nao achar, procura nos locais de instalacao
    comuns no Windows (glob, porque pastas como a do Poppler mudam de nome a cada versao)."""
    if nome in _FERRAMENTAS_RESOLVIDAS:
        return _FERRAMENTAS_RESOLVIDAS[nome]
    caminho = shutil.which(nome)
    if not caminho:
        for padrao in LOCAIS_EXTRAS.get(nome, []):
            candidatos = sorted(glob.glob(padrao), reverse=True)  # a versao mais nova primeiro
            if candidatos:
                caminho = candidatos[0]
                break
    _FERRAMENTAS_RESOLVIDAS[nome] = caminho
    return caminho


def preflight():
    faltando = [nome for nome in ('tesseract', 'pdftoppm', 'pdfinfo') if not localizar_ferramenta(nome)]
    if faltando:
        print('Ferramentas de OCR ausentes nesta maquina: ' + ', '.join(faltando))
        print('Instale o Tesseract OCR (com o pacote de idioma "por") e o Poppler antes de rodar de novo.')
        print('  Tesseract (Windows): https://github.com/UB-Mannheim/tesseract/wiki')
        print('  Poppler (Windows):   https://github.com/oschwartz10612/poppler-windows/releases')
        return False
    try:
        saida = subprocess.run([localizar_ferramenta('tesseract'), '--list-langs'], capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=10)
        idiomas = saida.stdout + saida.stderr
        if TESSERACT_LANG not in idiomas:
            print('O Tesseract esta instalado, mas falta o pacote de idioma portugues ("por").')
            print('Sem ele o texto reconhecido sai errado (acentos e cedilha ficam incorretos).')
            return False
    except Exception:
        pass  # se a checagem falhar por algum motivo, deixa seguir — o erro real aparece no processamento
    return True


def carregar_edicoes():
    if not os.path.isfile(ISSUES_JSON):
        return None
    with open(ISSUES_JSON, 'r', encoding='utf-8') as f:
        return json.load(f).get('issues', [])


def revisao_arquivo(caminho):
    st = os.stat(caminho)
    return f'{st.st_size}-{int(st.st_mtime)}'


def carregar_estado():
    if os.path.isfile(STATE_FILE):
        try:
            with open(STATE_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception:
            return {}
    return {}


def escrever_atomico(caminho, conteudo):
    pasta = os.path.dirname(caminho)
    os.makedirs(pasta, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=pasta, prefix='.tmp-')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            f.write(conteudo)
        os.replace(tmp, caminho)  # so troca pelo arquivo definitivo se a escrita terminou sem erro
    except Exception:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise


def salvar_estado(estado):
    escrever_atomico(STATE_FILE, json.dumps(estado, ensure_ascii=False, indent=2))


def revisao_paginas(urls_paginas):
    resumo = hashlib.sha1('|'.join(urls_paginas).encode('utf-8')).hexdigest()[:12]
    return f'paginas-{len(urls_paginas)}-{resumo}'


def baixar_pagina(url, destino_png):
    """Baixa a imagem da pagina e grava como PNG (formato de entrada previsivel
    para o tesseract, independente do formato original — webp, jpg etc.)."""
    requisicao = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(requisicao, timeout=30, context=_SSL_CONTEXTO_PAGINAS) as resposta:
        dados = resposta.read()
    origem = destino_png + '.origem'
    with open(origem, 'wb') as f:
        f.write(dados)
    try:
        with Image.open(origem) as imagem:
            imagem.convert('RGB').save(destino_png, 'PNG')
    finally:
        os.remove(origem)
    return destino_png


def contar_paginas(pdf_path):
    resultado = subprocess.run([localizar_ferramenta('pdfinfo'), pdf_path], capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=30)
    for linha in resultado.stdout.splitlines():
        if linha.startswith('Pages:'):
            return int(linha.split(':', 1)[1].strip())
    raise RuntimeError('nao foi possivel determinar o numero de paginas (pdfinfo)')


def renderizar_pagina(pdf_path, numero, destino_sem_extensao):
    resultado = subprocess.run(
        [localizar_ferramenta('pdftoppm'), '-png', '-r', str(RENDER_DPI), '-f', str(numero), '-l', str(numero),
         pdf_path, destino_sem_extensao],
        capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=90
    )
    if resultado.returncode != 0:
        raise RuntimeError(resultado.stderr.strip() or 'pdftoppm falhou')
    pasta = os.path.dirname(destino_sem_extensao) or '.'
    base = os.path.basename(destino_sem_extensao)
    candidatos = sorted(f for f in os.listdir(pasta) if f.startswith(base))
    if not candidatos:
        raise RuntimeError('pdftoppm nao gerou a imagem esperada')
    return os.path.join(pasta, candidatos[0])


def ocr_pagina(imagem_path):
    """Roda o Tesseract numa imagem de pagina e devolve as palavras com posicao
    relativa (0 a 1) dentro da pagina, prontas para desenhar um destaque por cima
    da imagem depois, em qualquer tamanho de tela."""
    saida = subprocess.run(
        [localizar_ferramenta('tesseract'), imagem_path, 'stdout', '-l', TESSERACT_LANG, '--psm', '3', 'tsv'],
        capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=120
    )
    if saida.returncode != 0:
        raise RuntimeError(saida.stderr.strip() or 'tesseract falhou')

    linhas = saida.stdout.splitlines()
    if len(linhas) < 2:
        return []
    cabecalho = linhas[0].split('\t')
    idx = {nome: i for i, nome in enumerate(cabecalho)}
    campos_esperados = {'level', 'left', 'top', 'width', 'height', 'conf', 'text'}
    if not campos_esperados.issubset(idx):
        raise RuntimeError('saida do tesseract em formato inesperado')

    largura_pagina = altura_pagina = None
    palavras = []
    for linha in linhas[1:]:
        campos = linha.split('\t')
        if len(campos) != len(cabecalho):
            continue
        nivel = campos[idx['level']]
        if nivel == '1':  # nivel "page": usa pra saber o tamanho total da imagem
            largura_pagina = float(campos[idx['width']]) or None
            altura_pagina = float(campos[idx['height']]) or None
            continue
        if nivel != '5' or not largura_pagina or not altura_pagina:  # so nos interessa nivel "word"
            continue
        texto = campos[idx['text']].strip()
        if not texto:
            continue
        try:
            confianca = float(campos[idx['conf']])
        except ValueError:
            confianca = -1
        if confianca < MIN_CONFIDENCE:
            continue
        palavras.append({
            't': texto,
            'x': round(float(campos[idx['left']]) / largura_pagina, 4),
            'y': round(float(campos[idx['top']]) / altura_pagina, 4),
            'w': round(float(campos[idx['width']]) / largura_pagina, 4),
            'h': round(float(campos[idx['height']]) / altura_pagina, 4),
        })
    return palavras


def processar_paginas(id_, total_paginas, obter_imagem):
    """Roda o OCR pagina a pagina. obter_imagem(numero, destino_base) precisa
    devolver o caminho de uma imagem raster pronta pra ler (PNG do pdftoppm
    ou pagina baixada e convertida)."""
    paginas_saida = []
    falhas = 0
    with tempfile.TemporaryDirectory(prefix='ovd-ocr-') as tmp_dir:
        for numero in range(1, total_paginas + 1):
            destino_base = os.path.join(tmp_dir, f'pagina-{numero:03d}')
            try:
                imagem = obter_imagem(numero, destino_base)
                palavras = ocr_pagina(imagem)
            except Exception as erro:
                falhas += 1
                print(f'  aviso: pagina {numero} da edicao {id_} falhou no OCR ({erro})')
                palavras = []
            paginas_saida.append({'numero': numero, 'palavras': palavras})
    return paginas_saida, falhas


def processar_edicao(caminho_pdf, total_paginas, id_):
    return processar_paginas(
        id_, total_paginas,
        lambda numero, destino_base: renderizar_pagina(caminho_pdf, numero, destino_base)
    )


def processar_edicao_imagens(urls_paginas, id_):
    def obter_imagem(numero, destino_base):
        return baixar_pagina(urls_paginas[numero - 1], destino_base + '.png')
    return processar_paginas(id_, len(urls_paginas), obter_imagem)


def gravar_ocr_edicao(id_, paginas, gerado_em):
    caminho = os.path.join(OCR_DIR, f'edicao-{id_}.js')
    corpo = (
        'window.ACERVO_OCR = window.ACERVO_OCR || {};\n'
        f'window.ACERVO_OCR[{json.dumps(id_)}] = ' +
        json.dumps({'paginas': paginas, 'geradoEm': gerado_em}, ensure_ascii=False, separators=(',', ':')) +
        ';\n'
    )
    escrever_atomico(caminho, corpo)


def limpar_orfaos(ids_validos):
    if not os.path.isdir(OCR_DIR):
        return 0
    removidos = 0
    for nome in os.listdir(OCR_DIR):
        m = re.match(r'^edicao-(.+)\.js$', nome)
        if m and m.group(1) not in ids_validos:
            os.remove(os.path.join(OCR_DIR, nome))
            removidos += 1
    return removidos


def main():
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--limite', type=int, default=None,
                         help='processa no maximo N edicoes pendentes nesta chamada (util pra testar antes de rodar tudo)')
    args = parser.parse_args()

    if not preflight():
        sys.exit(1)

    edicoes = carregar_edicoes()
    if edicoes is None:
        print(f'{ISSUES_JSON} nao encontrado. Rode gerar-edicoes.py antes deste script.')
        sys.exit(1)

    estado = carregar_estado()
    novo_estado = {}
    ignoradas = 0

    # Primeiro calcula quem TEM uma fonte valida (pdf local ou paginas soltas), sem processar
    # nada — precisa disso pra saber quais arquivos de OCR sao legitimos, mesmo quando --limite
    # deixa edicoes pendentes de fora desta rodada (senao a limpeza de orfaos ia apagar OCR de
    # edicoes so ainda nao alcancadas).
    ids_validos = set()
    pendentes = []
    for issue in edicoes:
        pdf = issue.get('pdf')
        paginas_urls = issue.get('pages') or []
        if pdf:
            caminho_pdf = os.path.join(ROOT, pdf.lstrip('/'))
            if not os.path.isfile(caminho_pdf):
                continue
            ids_validos.add(issue['id'])
            pendentes.append((issue, caminho_pdf))
        elif paginas_urls:
            ids_validos.add(issue['id'])
            pendentes.append((issue, None))
        else:
            ignoradas += 1

    processadas = puladas = falhas_total = 0
    for issue, caminho_pdf in pendentes:
        id_ = issue['id']
        paginas_urls = issue.get('pages') or []
        revisao = revisao_arquivo(caminho_pdf) if caminho_pdf else revisao_paginas(paginas_urls)
        if estado.get(id_, {}).get('revisao') == revisao:
            novo_estado[id_] = estado[id_]
            puladas += 1
            continue
        if args.limite is not None and processadas >= args.limite:
            continue  # ainda pendente; entra na proxima rodada, e o estado antigo (se houver) fica preservado

        if caminho_pdf:
            try:
                total_paginas = contar_paginas(caminho_pdf)
            except Exception as erro:
                print(f"aviso: nao foi possivel abrir {issue.get('pdf')} ({erro}) — pulando esta edicao")
                continue
            print(f'Processando edicao {id_} ({total_paginas} paginas)...')
            paginas, falhas = processar_edicao(caminho_pdf, total_paginas, id_)
        else:
            print(f'Processando edicao {id_} ({len(paginas_urls)} paginas, imagens)...')
            paginas, falhas = processar_edicao_imagens(paginas_urls, id_)

        gerado_em = datetime.now(timezone.utc).isoformat()
        gravar_ocr_edicao(id_, paginas, gerado_em)
        novo_estado[id_] = {'revisao': revisao, 'falhas': falhas, 'geradoEm': gerado_em}
        processadas += 1
        falhas_total += falhas

    removidos = limpar_orfaos(ids_validos)
    salvar_estado(novo_estado)

    print('')
    print('Resumo:')
    print(f'  {processadas} edicao(oes) processada(s)')
    print(f'  {puladas} ja estavam em dia')
    if ignoradas:
        print(f'  {ignoradas} edicao(oes) sem PDF nem paginas, ignorada(s)')
    if falhas_total:
        print(f'  {falhas_total} pagina(s) com falha no OCR (ver avisos acima)')
    if removidos:
        print(f'  {removidos} arquivo(s) de OCR orfao(s) removido(s)')


if __name__ == '__main__':
    main()
