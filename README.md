# OVD News

Portal responsivo para navegar e ler o acervo digital da OVD.

## Executar

```powershell
npm start
```

Abra `http://localhost:4173`.

## Adicionar uma edição

### Opção 1: PDF solto (recomendado)

Coloque o PDF diretamente dentro de `arquivos`. O nome do arquivo define o número da edição:

```text
arquivos/
  001.pdf
  002.pdf
  003.pdf
  142.pdf
```

A primeira página vira a capa automaticamente e o leitor detecta a quantidade de páginas do PDF. Não é preciso criar pasta, imagens ou metadados.

### Opção 2: páginas já convertidas

Crie uma nova pasta dentro de `arquivos`, seguindo o padrão:

```text
arquivos/
  edicao-0143/
    pagina-01.webp
    pagina-02.webp
    pagina-03.webp
```

Só isso já é suficiente: o servidor detecta a pasta, ordena as páginas pelo número e publica a edição automaticamente. O arquivo opcional `metadata.json` melhora os dados exibidos:

```json
{
  "number": 143,
  "title": "Edição nº 143",
  "date": "2026-09",
  "category": "Institucional",
  "tags": ["inovação", "pessoas"]
}
```

Os quatro `metadata.json` incluídos usam as imagens do acervo atual como demonstração. Ao copiar os arquivos WEBP reais para cada pasta, eles passam a ser priorizados automaticamente. Se houver uma pasta e um PDF com o mesmo número, o PDF será usado para evitar uma edição duplicada.

## Busca por conteúdo (OCR)

A busca (`/`) também encontra páginas pelo texto que elas contêm, não só por número, data ou tags — o resultado já linka direto para a página onde a palavra foi encontrada e destaca o trecho na própria imagem.

Isso depende de um passo a mais, feito com `atualizar-edicoes.bat` (ele já chama `gerar-ocr.py` sozinho, além do `gerar-edicoes.py` de sempre). Na primeira vez, instale nesta máquina:

- [Tesseract OCR](https://github.com/UB-Mannheim/tesseract/wiki), com o pacote de idioma **português** marcado na instalação.
- [Poppler para Windows](https://github.com/oschwartz10612/poppler-windows/releases), e adicione a pasta `Library/bin` dele ao PATH do Windows.

Depois disso, é só rodar o `.bat` normalmente sempre que adicionar edições novas — o OCR roda sozinho, uma edição por vez, e só processa o que ainda não tem texto gerado (ou que teve o PDF substituído). Editar sem os dois programas instalados não quebra nada: o script avisa o que falta e o catálogo continua sendo atualizado normalmente.

Limitação atual: só funciona para edições publicadas como PDF solto (Opção 1). Edições em pasta de imagens (Opção 2) ainda não têm OCR automático.

## Atalhos

- `/`: abre a busca.
- `Esc`: fecha a busca ou o leitor.
- `←` e `→`: navegam pelas páginas no leitor.
- Em telas touch, deslize lateralmente para virar a página.
