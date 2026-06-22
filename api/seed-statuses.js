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
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

async function main() {
  const units = await dbAll("SELECT bloco, unidade FROM unit_statuses");
  const hierarchy = await dbAll("SELECT id FROM sales_hierarchy WHERE active = 1");

  if (!hierarchy.length) {
    throw new Error("Nenhum vínculo comercial ativo encontrado. Rode o import primeiro.");
  }

  const total = units.length;
  const soldCount = Math.round(total * 0.35);
  const reservedCount = Math.round(total * 0.25);

  console.log(`Total de unidades: ${total}`);
  console.log(`Vendidas (35%): ${soldCount}`);
  console.log(`Reservadas (25%): ${reservedCount}`);
  console.log(`Disponíveis (40%): ${total - soldCount - reservedCount}`);

  const shuffled = shuffle([...units]);
  const sold = shuffled.slice(0, soldCount);
  const reserved = shuffled.slice(soldCount, soldCount + reservedCount);

  await dbRun("BEGIN TRANSACTION");

  // Reset everything
  await dbRun("UPDATE unit_statuses SET status = 'available', updated_at = CURRENT_TIMESTAMP");
  await dbRun("DELETE FROM unit_sales_assignments");

  const hierIds = hierarchy.map((h) => h.id);
  const randHier = () => hierIds[Math.floor(Math.random() * hierIds.length)];

  for (const u of sold) {
    await dbRun(
      "UPDATE unit_statuses SET status = 'sold', updated_at = CURRENT_TIMESTAMP WHERE bloco = ? AND unidade = ?",
      [u.bloco, u.unidade]
    );
    await dbRun(
      "INSERT INTO unit_sales_assignments (bloco, unidade, hierarchy_id, updated_by) VALUES (?, ?, ?, 1)",
      [u.bloco, u.unidade, randHier()]
    );
  }

  for (const u of reserved) {
    await dbRun(
      "UPDATE unit_statuses SET status = 'reserved', updated_at = CURRENT_TIMESTAMP WHERE bloco = ? AND unidade = ?",
      [u.bloco, u.unidade]
    );
    await dbRun(
      "INSERT INTO unit_sales_assignments (bloco, unidade, hierarchy_id, updated_by) VALUES (?, ?, ?, 1)",
      [u.bloco, u.unidade, randHier()]
    );
  }

  await dbRun("COMMIT");

  // Summary by bloco
  const summary = await dbAll(
    "SELECT bloco, status, COUNT(*) as count FROM unit_statuses GROUP BY bloco, status ORDER BY bloco, status"
  );
  console.log("\nDistribuição por bloco:");
  for (const row of summary) {
    console.log(`  Bloco ${row.bloco} | ${row.status.padEnd(10)} | ${row.count}`);
  }

  db.close();
}

main().catch((err) => {
  console.error(err.message || err);
  db.close();
  process.exit(1);
});
