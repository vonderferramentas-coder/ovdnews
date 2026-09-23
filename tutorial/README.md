# Instalar o OCR (busca por conteúdo das páginas)

Este guia é só para quem vai **gerar** o texto pesquisável das edições nesta máquina (rodando `atualizar-edicoes.bat`). Quem só visita o site publicado não precisa instalar nada disso — o resultado já sai pronto, como arquivo estático.

O passo a passo abaixo foi seguido e testado de ponta a ponta nesta máquina (Windows 10, sem direitos de administrador) em 23/09/2026: as duas ferramentas foram instaladas com sucesso, uma edição real do acervo foi processada e a busca encontrou o texto certinho, já linkando para a página exata.

## O que precisa instalar

1. **[Tesseract OCR](https://github.com/UB-Mannheim/tesseract/wiki)** — o motor que lê o texto das páginas.
2. **[Poppler](https://github.com/oschwartz10612/poppler-windows/releases)** — converte cada página do PDF em imagem antes do OCR.

## Passo 1 — Instalar com o winget (recomendado)

O Windows 10/11 já vem com o `winget` (gerenciador de pacotes). Abra o PowerShell e rode:

```powershell
winget install --id UB-Mannheim.TesseractOCR --silent --accept-package-agreements --accept-source-agreements
winget install --id oschwartz10612.Poppler --silent --accept-package-agreements --accept-source-agreements
```

Não precisa ser administrador — sem privilégio elevado, o instalador do Tesseract cai sozinho numa pasta por usuário (algo como `C:\Users\<seu-usuário>\AppData\Local\Programs\Tesseract-OCR`), em vez de "Program Files". Tudo bem, o `gerar-ocr.py` já sabe procurar nesse lugar também (veja a seção "Se a ferramenta não for encontrada" abaixo).

> Não tem `winget` nesta máquina? Baixe e instale manualmente pelos links da seção "O que precisa instalar" acima — os dois têm instalador `.exe` comum, next-next-finish.

## Passo 2 — Instalar o pacote de idioma português

Esse é o passo que passa despercebido: **a instalação silenciosa do Tesseract não vem com o pacote de português**, só inglês. Sem ele, o texto reconhecido sai com os acentos errados.

Baixe o arquivo de idioma e copie para a pasta `tessdata` do Tesseract:

```powershell
# Ajuste o caminho se o Tesseract tiver instalado em outro lugar (veja o Passo 3)
$tessdata = "$env:LOCALAPPDATA\Programs\Tesseract-OCR\tessdata"
Invoke-WebRequest -Uri "https://github.com/tesseract-ocr/tessdata/raw/main/por.traineddata" -OutFile "$tessdata\por.traineddata"
```

## Passo 3 — Confirmar que instalou certo

```powershell
$tess = "$env:LOCALAPPDATA\Programs\Tesseract-OCR\tesseract.exe"
& $tess --list-langs
```

Deve aparecer `por` na lista (junto com `eng` e `osd`, que já vêm por padrão). Se o Tesseract tiver ido para outro lugar (por exemplo `C:\Program Files\Tesseract-OCR`, quando instalado como administrador), ajuste o caminho no comando acima.

## Passo 4 — Rodar

Depois de instalado, é só usar o `atualizar-edicoes.bat` de sempre — ele já chama o `gerar-ocr.py` sozinho, depois de atualizar o catálogo.

Se quiser rodar só o OCR manualmente (por exemplo, pra testar antes de processar tudo):

```powershell
python gerar-ocr.py
```

Para testar com só 1 ou 2 edições antes de rodar o acervo inteiro (útil na primeira vez, já que cada edição pode levar um tempinho):

```powershell
python gerar-ocr.py --limite 2
```

Rodar de novo sem `--limite` continua de onde parou — o script pula tudo que já está em dia e processa só o que falta.

## Se a ferramenta não for encontrada

O `gerar-ocr.py` primeiro procura `tesseract`, `pdftoppm` e `pdfinfo` no PATH do Windows. Se não achar (comum logo depois de instalar, antes de abrir um terminal novo, ou quando o instalador caiu numa pasta de usuário em vez do PATH do sistema), ele procura sozinho nesses lugares, nessa ordem:

- `C:\Program Files\Tesseract-OCR\tesseract.exe`
- `C:\Program Files (x86)\Tesseract-OCR\tesseract.exe`
- `%LOCALAPPDATA%\Programs\Tesseract-OCR\tesseract.exe`
- `%LOCALAPPDATA%\Microsoft\WinGet\Packages\oschwartz10612.Poppler_*\poppler-*\Library\bin\` (pdftoppm/pdfinfo)
- `C:\Program Files\poppler*\Library\bin\` (pdftoppm/pdfinfo)

Se mesmo assim não achar, o script avisa exatamente o que está faltando e para sem quebrar o resto do processo (o catálogo continua sendo atualizado normalmente pelo `gerar-edicoes.py`).

## Erro visto durante o teste (e já corrigido no script)

Na primeira tentativa aqui, o `gerar-ocr.py` falhava em toda página com o erro `UnicodeDecodeError: 'charmap' codec can't decode byte...`. A causa: o Windows lê a saída de programas externos usando a "página de código" do sistema (geralmente `cp1252`), mas o Tesseract sempre devolve o texto em UTF-8 — com acento em português, os bytes não batem com esse formato e o Python quebra. Já está corrigido no script (força leitura em UTF-8), mas fica registrado aqui caso apareça de novo em outra máquina com uma versão diferente do script.
