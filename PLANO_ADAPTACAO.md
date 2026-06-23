# Plano: Adaptar Mapa de Disponibilidade para Novo Empreendimento

## Contexto
O site `espelho.rjzcyrela.site` foi construído para o empreendimento "In The Park - Cidade Jardim". Vamos reutilizá-lo para um novo lançamento, substituindo todas as referências específicas: nome, blocos, unidades, corretores, cores e identidade visual.

O projeto está em `/home/lucas.graca/projects/espelho`.  
Todo o frontend está num único ficheiro: `site/index.html`.  
O backend é Node.js + SQLite em `api/`.

---

## Divisão de Tarefas

### Tipo A — Conteúdo / Dados (sem código — pode ser feito por qualquer pessoa)
Reúne as informações do novo empreendimento para entregar ao Tipo B.

| # | Tarefa | O que entregar |
|---|--------|----------------|
| A1 | Nome do empreendimento | Ex: "Parque das Flores - Alphaville" |
| A2 | Estrutura de blocos e unidades | Quantos blocos, nome de cada um, quantos andares, quantas unidades por andar, convenção de numeração |
| A3 | Identidade visual | Logo em PNG/JPG, paleta de cores (hex), fontes (se diferente de Montserrat/Playfair) |
| A4 | Planilha de corretores | Excel no mesmo formato actual: colunas Equipe, Nome, (opcionalmente: Superintendente, Nome Ranking, Status) |
| A5 | Planilha de gabarito de vendas | Excel com colunas: bloco (nome), unidade, diretor, gerente, corretor — para unidades já vendidas/reservadas |
| A6 | Regras de negócio | Equipes/gerentes a ignorar? Andares "premium"? Percentuais de seed para testes? |

---

### Tipo B — Técnico / Código (requer editar ficheiros)
Executa as mudanças com base no que o Tipo A entregou.

#### B1 — Frontend: `site/index.html`
- **Nome do empreendimento** — 6 locais: `<title>`, `.header-center-sub`, `.dashboard-subtitle`, `.info-box-value`, e 2 strings no JavaScript
- **Logo principal** — trocar imagem base64 no `<img class="logo-img">` (alt: `"IN THE PARK Cidade Jardim"`)
- **Logo da construtora** — trocar imagem em `.cyrela-logo` se aplicável
- **Paleta de cores** — bloco `:root` no topo do CSS (16 variáveis: `--green-dark`, `--green-mid`, `--gold`, `--cream`, etc.)
- **Fontes** — link Google Fonts (linha 7) se necessário
- **BUILDING_DATA** (JavaScript, linha ~2143) — substituir objecto completo com nova estrutura de blocos/andares/unidades
- **blocoNames** — mapa `{ '1': 'Ed. Boulevard', '2': 'Ed. Park' }` → novos nomes

#### B2 — Backend: `api/seed.js`
- Substituir `BUILDING_DATA` (igual ao do frontend) com nova estrutura de unidades
- Ajustar nomes dos blocos

#### B3 — Backend: `api/import-gabarito.py`
- Actualizar `BLOCO_MAP` — mapa nome-do-Excel → ID interno (ex: `"Ed. Boulevard": "1"`)
- Actualizar correções manuais de nomes de corretores/gerentes se necessário

#### B4 — Backend: `api/server.js` + `api/import-sales-hierarchy.js`
- `shouldSkipTeam()` — actualmente ignora equipe "Marcel"; actualizar para o novo empreendimento (2 ficheiros)

#### B5 — Backend: `api/seed-top-floors.js`
- Actualizar `TOP_RANGES` com os ranges de unidades dos andares premium do novo empreendimento

#### B6 — Reset e re-seed da base de dados
```bash
cd /home/lucas.graca/projects/espelho
rm api/data/units.db          # apaga DB actual (In The Park)
node api/seed.js              # cria unidades do novo empreendimento
node api/import-sales-hierarchy.js  # importa corretores (Ativos.xlsx actualizado)
python3 api/import-gabarito.py      # importa gabarito de vendas
pm2 restart mapa-disponibilidade
```

---

## Ficheiros Críticos a Modificar

| Ficheiro | Responsável | O que muda |
|----------|-------------|------------|
| `site/index.html` | B | Nome, cores, logo, fontes, BUILDING_DATA, blocoNames |
| `api/seed.js` | B | BUILDING_DATA |
| `api/import-gabarito.py` | B | BLOCO_MAP, correções de nomes |
| `api/server.js` | B | shouldSkipTeam() |
| `api/import-sales-hierarchy.js` | B | shouldSkipTeam() |
| `api/seed-top-floors.js` | B | TOP_RANGES |
| `Ativos.xlsx` | A | Substituir por planilha do novo empreendimento |

---

## Verificação
1. `pm2 logs mapa-disponibilidade` — sem erros de startup
2. Abrir https://espelho.rjzcyrela.site — título e logo correctos
3. Navegar pelos blocos — estrutura bate com o novo empreendimento
4. Login como admin → alterar status de uma unidade → confirma que persiste
5. Importar planilha de corretores → verificar no painel de admin
