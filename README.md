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

## Atalhos

- `/`: abre a busca.
- `Esc`: fecha a busca ou o leitor.
- `←` e `→`: navegam pelas páginas no leitor.
- Em telas touch, deslize lateralmente para virar a página.
