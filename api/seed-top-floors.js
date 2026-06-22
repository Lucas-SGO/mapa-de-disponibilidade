const sqlite3 = require("sqlite3").verbose();
const path = require("path");

const db = new sqlite3.Database(path.join(__dirname, "data", "units.db"));

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

// Top unit ranges per block as defined by the building layout
const TOP_RANGES = {
  "1": { min: 1073, max: 1373 },
  "2": { min: 828,  max: 1328 },
};

function isTopUnit(bloco, unidade) {
  const range = TOP_RANGES[bloco];
  const n = parseInt(unidade, 10);
  return range && n >= range.min && n <= range.max;
}

function pickStatus() {
  return Math.random() < 0.6 ? "sold" : "reserved";
}

async function main() {
  const units = await dbAll("SELECT bloco, unidade FROM unit_statuses");
  const hierarchy = await dbAll("SELECT id FROM sales_hierarchy WHERE active = 1");

  if (!hierarchy.length) throw new Error("Nenhuma hierarquia ativa encontrada.");

  const hierIds = hierarchy.map((h) => h.id);
  const randHier = () => hierIds[Math.floor(Math.random() * hierIds.length)];

  const targets = units.filter((u) => isTopUnit(u.bloco, u.unidade));

  console.log(`Unidades nos andares mais altos: ${targets.length}`);
  console.log(`  Bloco 1 (1073-1373): ${targets.filter(u => u.bloco === "1").length}`);
  console.log(`  Bloco 2 (828-1328):  ${targets.filter(u => u.bloco === "2").length}`);

  await dbRun("BEGIN TRANSACTION");

  // Reset assignments for these units first
  for (const u of targets) {
    await dbRun(
      "DELETE FROM unit_sales_assignments WHERE bloco = ? AND unidade = ?",
      [u.bloco, u.unidade]
    );
  }

  let sold = 0, reserved = 0;

  for (const u of targets) {
    const status = pickStatus();
    if (status === "sold") sold++; else reserved++;

    await dbRun(
      "UPDATE unit_statuses SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE bloco = ? AND unidade = ?",
      [status, u.bloco, u.unidade]
    );

    await dbRun(
      `INSERT INTO unit_sales_assignments (bloco, unidade, hierarchy_id, updated_by)
       VALUES (?, ?, ?, 1)`,
      [u.bloco, u.unidade, randHier()]
    );
  }

  await dbRun("COMMIT");

  console.log(`\nResultado: ${sold} vendidas, ${reserved} reservadas`);

  const summary = await dbAll(
    `SELECT bloco, CAST(CAST(unidade AS INTEGER) / 100 AS INTEGER) as andar, status, COUNT(*) as count
     FROM unit_statuses
     GROUP BY bloco, andar, status
     ORDER BY CAST(bloco AS INTEGER), andar, status`
  );

  console.log("\nDistribuição final:");
  let lastKey = null;
  for (const r of summary) {
    const key = `Bloco ${r.bloco} | Andar ${r.andar}`;
    if (key !== lastKey) { console.log(`  ${key}`); lastKey = key; }
    console.log(`    ${r.status.padEnd(10)} ${r.count}`);
  }

  db.close();
}

main().catch((err) => {
  console.error(err.message || err);
  db.close();
  process.exit(1);
});
