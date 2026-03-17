const bcrypt = require("bcryptjs");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");

const [,, username, newPassword] = process.argv;

if (!username || !newPassword) {
  console.log("Uso: node reset-password.js usuario novaSenha");
  process.exit(1);
}

const db = new sqlite3.Database(path.join(__dirname, "data", "units.db"));

const hash = bcrypt.hashSync(newPassword, 10);

db.run(
  "UPDATE users SET password_hash = ? WHERE username = ?",
  [hash, username],
  function (err) {
    if (err) {
      console.error("Erro ao atualizar senha:", err.message);
    } else if (this.changes === 0) {
      console.log("Usuário não encontrado.");
    } else {
      console.log("Senha atualizada com sucesso.");
    }
    db.close();
  }
);