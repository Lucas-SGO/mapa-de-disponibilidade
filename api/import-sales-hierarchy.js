const path = require("path");
const sqlite3 = require("sqlite3").verbose();
const XLSX = require("xlsx");

const defaultExcelPath = path.join(__dirname, "..", "..", "Corretores.xlsx");
const excelPath = process.argv[2] ? path.resolve(process.argv[2]) : defaultExcelPath;
const dbPath = path.join(__dirname, "data", "units.db");

function normalizeText(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function normalizeName(value) {
  const cleaned = normalizeText(value)
    .replace(/^[\s._,:;\-]+/, "")
    .replace(/[\s._,:;\-]+$/, "");

  if (!cleaned) return "";

  const lower = cleaned.toLocaleLowerCase("pt-BR");
  return lower.replace(/(^|[\s'-])([a-z\u00c0-\u00ff])/g, (_, prefix, letter) => {
    return `${prefix}${letter.toLocaleUpperCase("pt-BR")}`;
  });
}

function normalizeKey(value) {
  return normalizeText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function shouldSkipTeam(teamName) {
  return normalizeKey(teamName) === "marcel";
}

function buildBrokerLabel(warName, fullName) {
  const normalizedWarName = normalizeName(warName);
  const normalizedFullName = normalizeName(fullName);

  if (!normalizedFullName) return "";
  if (!normalizedWarName) return normalizedFullName;
  if (normalizeKey(normalizedWarName) === normalizeKey(normalizedFullName)) {
    return normalizedFullName;
  }

  return `${normalizedWarName} - ${normalizedFullName}`;
}

function toFlag(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) return 1;
  return normalized !== "inativo" ? 1 : 0;
}

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

async function main() {
  const workbook = XLSX.readFile(excelPath);
  let sheetName = workbook.SheetNames.find((name) => {
    const normalized = normalizeKey(name).replace(/\s+/g, "");
    return normalized === "corretores(ativos)" || normalized === "corretoresativos";
  });

  // Fallback: use any sheet that contains Equipe and Nome headers.
  if (!sheetName) {
    for (const candidate of workbook.SheetNames) {
      const candidateRows = XLSX.utils.sheet_to_json(workbook.Sheets[candidate], {
        defval: "",
        range: 0,
        blankrows: false
      });
      if (!candidateRows.length) continue;

      const candidateKeys = Object.keys(candidateRows[0] || {});
      const candidateMap = new Map(candidateKeys.map((key) => [normalizeKey(key), key]));
      if (candidateMap.get("equipe") && candidateMap.get("nome")) {
        sheetName = candidate;
        break;
      }
    }
  }

  if (!sheetName) {
    throw new Error(
      'A planilha precisa conter a aba "Corretores(Ativos)" ou alguma aba com as colunas Equipe e Nome'
    );
  }

  const sheet = workbook.Sheets[sheetName];
  const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: "" });

  if (!rawRows.length) {
    throw new Error("A planilha está vazia");
  }

  const firstRow = rawRows[0];
  const keys = Object.keys(firstRow);
  const keyMap = new Map(keys.map((key) => [normalizeKey(key), key]));

  const superintendentKey = keyMap.get("superintendente");
  const teamKey = keyMap.get("equipe");
  const nameKey = keyMap.get("nome");
  const rankingNameKey = keyMap.get("nome ranking");
  const statusKey = keyMap.get("status");

  if (!teamKey || !nameKey) {
    throw new Error(
      "A aba Corretores(Ativos) precisa ter as colunas Equipe e Nome (Superintendente é opcional)"
    );
  }

  const rows = rawRows
    .map((row) => ({
      director:
        normalizeName(superintendentKey ? row[superintendentKey] : "") ||
        normalizeName(row[teamKey]),
      manager: normalizeName(row[teamKey]),
      broker: buildBrokerLabel(rankingNameKey ? row[rankingNameKey] : "", row[nameKey]),
      status: statusKey ? row[statusKey] : "Ativo"
    }))
    .filter((row) => row.director && row.manager && row.broker)
    .filter((row) => !shouldSkipTeam(row.manager));

  const db = new sqlite3.Database(dbPath);

  try {
    await dbRun(
      db,
      `CREATE TABLE IF NOT EXISTS sales_hierarchy (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        director TEXT NOT NULL,
        manager TEXT NOT NULL,
        broker TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(director, manager, broker)
      )`
    );

    await dbRun(db, "BEGIN TRANSACTION");
    await dbRun(db, `UPDATE sales_hierarchy SET active = 0, updated_at = CURRENT_TIMESTAMP`);

    let imported = 0;
    for (const row of rows) {
      await dbRun(
        db,
        `INSERT INTO sales_hierarchy (director, manager, broker, active)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(director, manager, broker)
         DO UPDATE SET
           active = excluded.active,
           updated_at = CURRENT_TIMESTAMP`,
        [row.director, row.manager, row.broker, toFlag(row.status)]
      );
      imported += 1;
    }

    await dbRun(db, "COMMIT");
    console.log(`Planilha importada com sucesso: ${imported} vínculos processados.`);
  } catch (err) {
    await dbRun(db, "ROLLBACK").catch(() => {});
    throw err;
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});