const bcrypt = require("bcryptjs");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");

const [,, username, password, role = "guest"] = process.argv;

if (!username || !password) {
  console.log("Uso: node create-user.js usuario senha [admin|guest]");
  process.exit(1);
}

if (!["admin", "guest"].includes(role)) {
  console.log("Role inválida. Use admin ou guest.");
  process.exit(1);
}

const db = new sqlite3.Database(path.join(__dirname, "data", "units.db"));

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin', 'guest')),
      active INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.get("SELECT id FROM users WHERE username = ?", [username], (err, row) => {
    if (err) {
      console.error("Erro ao verificar usuário:", err.message);
      db.close();
      return;
    }

    if (row) {
      console.log("Usuário já existe.");
      db.close();
      return;
    }

    const password_hash = bcrypt.hashSync(password, 10);

    db.run(
      `INSERT INTO users (username, password_hash, role, active)
       VALUES (?, ?, ?, 1)`,
      [username, password_hash, role],
      function (err) {
        if (err) {
          console.error("Erro ao criar usuário:", err.message);
        } else {
          console.log(`Usuário criado: ${username} (${role})`);
        }
        db.close();
      }
    );
  });
});