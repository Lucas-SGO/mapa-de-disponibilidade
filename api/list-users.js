const sqlite3 = require("sqlite3").verbose();
const path = require("path");

const db = new sqlite3.Database(path.join(__dirname, "data", "units.db"));

db.all(
  `SELECT id, username, role, active, created_at
   FROM users
   ORDER BY username`,
  [],
  (err, rows) => {
    if (err) {
      console.error("Erro ao listar usuários:", err.message);
    } else {
      console.table(rows);
    }
    db.close();
  }
);