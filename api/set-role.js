const sqlite3 = require("sqlite3").verbose();
const path = require("path");

const [,, username, role] = process.argv;

if (!username || !role) {
  console.log("Uso: node set-role.js usuario admin|guest");
  process.exit(1);
}

if (!["admin", "guest"].includes(role)) {
  console.log("Role inválida.");
  process.exit(1);
}

const db = new sqlite3.Database(path.join(__dirname, "data", "units.db"));

db.run(
  "UPDATE users SET role = ? WHERE username = ?",
  [role, username],
  function (err) {
    if (err) {
      console.error("Erro ao alterar role:", err.message);
    } else if (this.changes === 0) {
      console.log("Usuário não encontrado.");
    } else {
      console.log(`Role de ${username} alterada para ${role}.`);
    }
    db.close();
  }
);