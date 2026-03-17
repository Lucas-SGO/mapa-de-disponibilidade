const express = require("express");
const cors = require("cors");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = 3000;

app.set("trust proxy", 1);

app.use(cors({
  origin: true,
  credentials: true
}));

app.use(express.json({ limit: "1mb" }));

const dataDir = path.join(__dirname, "data");
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, "units.db");
const db = new sqlite3.Database(dbPath);

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row || null);
    });
  });
}

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

app.use(session({
  secret: process.env.SESSION_SECRET || "troque-essa-chave-secreta-agora",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: false,
    maxAge: 1000 * 60 * 60 * 12
  }
}));

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS unit_statuses (
      bloco TEXT NOT NULL,
      unidade TEXT NOT NULL,
      status TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (bloco, unidade)
    )
  `);

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

  db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS sales_hierarchy (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      director TEXT NOT NULL,
      manager TEXT NOT NULL,
      broker TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(director, manager, broker)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS unit_sales_assignments (
      bloco TEXT NOT NULL,
      unidade TEXT NOT NULL,
      hierarchy_id INTEGER NOT NULL,
      updated_by INTEGER,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (bloco, unidade),
      FOREIGN KEY (hierarchy_id) REFERENCES sales_hierarchy(id)
    )
  `);

  // Initialize default stats visibility settings
  db.run(`
    INSERT OR IGNORE INTO settings (key, value) VALUES ('stats_available_visible', 'true')
  `);
  db.run(`
    INSERT OR IGNORE INTO settings (key, value) VALUES ('stats_reserved_visible', 'true')
  `);
  db.run(`
    INSERT OR IGNORE INTO settings (key, value) VALUES ('stats_sold_visible', 'true')
  `);
  db.run(`
    INSERT OR IGNORE INTO settings (key, value) VALUES ('minimap_visible', 'true')
  `);
});

function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({ error: "Não autenticado" });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({ error: "Não autenticado" });
  }
  if (req.session.user.role !== "admin") {
    return res.status(403).json({ error: "Acesso restrito ao administrador" });
  }
  next();
}

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

async function buildSalesHierarchyResponse() {
  const rows = await dbAll(
    `SELECT id, director, manager, broker, active
     FROM sales_hierarchy
     ORDER BY director, manager, broker`
  );

  const directorMap = new Map();

  for (const row of rows) {
    if (!row.active) continue;

    let director = directorMap.get(row.director);
    if (!director) {
      director = {
        name: row.director,
        managers: []
      };
      directorMap.set(row.director, director);
    }

    let manager = director.managers.find((item) => item.name === row.manager);
    if (!manager) {
      manager = {
        name: row.manager,
        brokers: []
      };
      director.managers.push(manager);
    }

    manager.brokers.push({
      id: row.id,
      name: row.broker
    });
  }

  return {
    directors: Array.from(directorMap.values())
  };
}

async function getUnitAssignment(bloco, unidade) {
  return dbGet(
    `SELECT usa.bloco, usa.unidade, usa.hierarchy_id AS hierarchyId, usa.updated_by AS updatedBy,
            usa.updated_at AS updatedAt, sh.director, sh.manager, sh.broker, sh.active
     FROM unit_sales_assignments usa
     JOIN sales_hierarchy sh ON sh.id = usa.hierarchy_id
     WHERE usa.bloco = ? AND usa.unidade = ?`,
    [String(bloco), String(unidade)]
  );
}

async function getUnitStatus(bloco, unidade) {
  const row = await dbGet(
    `SELECT status FROM unit_statuses WHERE bloco = ? AND unidade = ?`,
    [String(bloco), String(unidade)]
  );

  return row && row.status ? row.status : "available";
}

app.post("/api/login", (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ error: "Usuário e senha são obrigatórios" });
  }

  db.get(
    `SELECT id, username, password_hash, role, active
     FROM users
     WHERE username = ?`,
    [username],
    (err, user) => {
      if (err) {
        return res.status(500).json({ error: "Erro interno no login" });
      }

      if (!user || !user.active) {
        return res.status(401).json({ error: "Credenciais inválidas" });
      }

      const ok = bcrypt.compareSync(password, user.password_hash);
      if (!ok) {
        return res.status(401).json({ error: "Credenciais inválidas" });
      }

      req.session.user = {
        id: user.id,
        username: user.username,
        role: user.role
      };

      res.json({
        success: true,
        user: req.session.user
      });
    }
  );
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("connect.sid");
    res.json({ success: true });
  });
});

app.get("/api/me", (req, res) => {
  res.json({
    authenticated: !!req.session.user,
    user: req.session.user || null
  });
});

app.get("/api/users", requireAdmin, (req, res) => {
  db.all(
    `SELECT id, username, role, active, created_at
     FROM users
     ORDER BY username`,
    [],
    (err, rows) => {
      if (err) {
        return res.status(500).json({ error: "Erro ao listar usuários" });
      }
      res.json(rows);
    }
  );
});

app.post("/api/users/:id/toggle-active", requireAdmin, (req, res) => {
  const id = Number(req.params.id);

  db.get("SELECT id, active FROM users WHERE id = ?", [id], (err, user) => {
    if (err) {
      return res.status(500).json({ error: "Erro interno" });
    }

    if (!user) {
      return res.status(404).json({ error: "Usuário não encontrado" });
    }

    db.run(
      "UPDATE users SET active = ? WHERE id = ?",
      [user.active ? 0 : 1, id],
      function (err) {
        if (err) {
          return res.status(500).json({ error: "Erro ao atualizar usuário" });
        }
        res.json({ success: true });
      }
    );
  });
});

app.get("/api/statuses", requireAuth, (req, res) => {
  db.all(`SELECT bloco, unidade, status FROM unit_statuses`, [], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: "Erro ao buscar status" });
    }

    const result = {};
    for (const row of rows) {
      result[`${row.bloco}_${row.unidade}`] = row.status;
    }

    res.json(result);
  });
});

app.post("/api/status", requireAdmin, async (req, res) => {
  const { bloco, unidade, status } = req.body || {};

  if (!bloco || !unidade || !status) {
    return res.status(400).json({ error: "bloco, unidade e status são obrigatórios" });
  }

  const allowed = ["available", "reserved", "sold"];
  if (!allowed.includes(status)) {
    return res.status(400).json({ error: "status inválido" });
  }

  try {
    await dbRun(
      `
      INSERT OR REPLACE INTO unit_statuses (bloco, unidade, status, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      `,
      [String(bloco), String(unidade), status]
    );

    if (status === "available") {
      await dbRun(
        `DELETE FROM unit_sales_assignments WHERE bloco = ? AND unidade = ?`,
        [String(bloco), String(unidade)]
      );
    }

    res.json({ success: true, bloco, unidade, status });
  } catch (err) {
    console.error("Erro em /api/status:", err && err.message ? err.message : err);
    res.status(500).json({ error: "Erro ao salvar status" });
  }
});

app.post("/api/statuses/bulk", requireAdmin, (req, res) => {
  const { updates } = req.body || {};

  if (!Array.isArray(updates) || updates.length === 0) {
    return res.status(400).json({ error: "updates é obrigatório e deve conter ao menos 1 item" });
  }

  const allowed = ["available", "reserved", "sold"];
  const prepared = [];

  for (const item of updates) {
    const bloco = item && item.bloco;
    const unidade = item && item.unidade;
    const status = item && item.status;

    if (!bloco || !unidade || !status) {
      return res.status(400).json({ error: "Cada item deve conter bloco, unidade e status" });
    }

    if (!allowed.includes(status)) {
      return res.status(400).json({ error: "status inválido" });
    }

    prepared.push([String(bloco), String(unidade), status]);
  }

  (async () => {
    let processed = 0;

    try {
      await dbRun("BEGIN TRANSACTION");

      for (const [bloco, unidade, status] of prepared) {
        await dbRun(
          `
          INSERT OR REPLACE INTO unit_statuses (bloco, unidade, status, updated_at)
          VALUES (?, ?, ?, CURRENT_TIMESTAMP)
          `,
          [bloco, unidade, status]
        );

        if (status === "available") {
          await dbRun(
            `DELETE FROM unit_sales_assignments WHERE bloco = ? AND unidade = ?`,
            [bloco, unidade]
          );
        }

        processed += 1;
      }

      await dbRun("COMMIT");
      res.json({ success: true, updated: processed });
    } catch (err) {
      await dbRun("ROLLBACK").catch(() => {});
      console.error("Erro em /api/statuses/bulk:", err && err.message ? err.message : err);
      res.status(500).json({ error: "Erro ao salvar alterações em massa" });
    }
  })();
});

app.get("/api/admin/sales-hierarchy", requireAdmin, async (req, res) => {
  try {
    const payload = await buildSalesHierarchyResponse();
    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: "Erro ao carregar hierarquia comercial" });
  }
});

app.get("/api/admin/dashboard", requireAdmin, async (req, res) => {
  try {
    const statusCounts = { sold: 0, reserved: 0, available: 0 };
    const statusRows = await dbAll(
      `SELECT status, COUNT(*) AS count FROM unit_statuses GROUP BY status`
    );
    for (const row of statusRows) {
      if (Object.prototype.hasOwnProperty.call(statusCounts, row.status)) {
        statusCounts[row.status] = row.count;
      }
    }

    const statusByBloco = await dbAll(
      `SELECT bloco, status, COUNT(*) AS count
       FROM unit_statuses
       GROUP BY bloco, status
       ORDER BY bloco, status`
    );

    const salesByDirector = await dbAll(
      `SELECT sh.director, COUNT(usa.hierarchy_id) AS count
       FROM unit_sales_assignments usa
       JOIN sales_hierarchy sh ON sh.id = usa.hierarchy_id
       JOIN unit_statuses us ON us.bloco = usa.bloco AND us.unidade = usa.unidade
       WHERE us.status = 'sold'
       GROUP BY sh.director
       ORDER BY count DESC`
    );

    const salesByManager = await dbAll(
      `SELECT sh.director, sh.manager, COUNT(usa.hierarchy_id) AS count
       FROM unit_sales_assignments usa
       JOIN sales_hierarchy sh ON sh.id = usa.hierarchy_id
       JOIN unit_statuses us ON us.bloco = usa.bloco AND us.unidade = usa.unidade
       WHERE us.status = 'sold'
       GROUP BY sh.director, sh.manager
       ORDER BY count DESC
       LIMIT 20`
    );

    const salesByBroker = await dbAll(
      `SELECT sh.director, sh.manager, sh.broker, COUNT(usa.hierarchy_id) AS count
       FROM unit_sales_assignments usa
       JOIN sales_hierarchy sh ON sh.id = usa.hierarchy_id
       JOIN unit_statuses us ON us.bloco = usa.bloco AND us.unidade = usa.unidade
       WHERE us.status = 'sold'
       GROUP BY sh.director, sh.manager, sh.broker
       ORDER BY count DESC
       LIMIT 20`
    );

    const soldWithoutAssignmentRow = await dbGet(
      `SELECT COUNT(*) AS count
       FROM unit_statuses us
       LEFT JOIN unit_sales_assignments usa
         ON usa.bloco = us.bloco AND usa.unidade = us.unidade
       WHERE us.status = 'sold' AND usa.hierarchy_id IS NULL`
    );

    const assignedNotSoldRow = await dbGet(
      `SELECT COUNT(*) AS count
       FROM unit_sales_assignments usa
       LEFT JOIN unit_statuses us
         ON us.bloco = usa.bloco AND us.unidade = usa.unidade
       WHERE COALESCE(us.status, 'available') != 'sold'`
    );

    const recentAssignments = await dbAll(
      `SELECT usa.bloco, usa.unidade, sh.director, sh.manager, sh.broker,
              usa.updated_at AS updatedAt
       FROM unit_sales_assignments usa
       JOIN sales_hierarchy sh ON sh.id = usa.hierarchy_id
       ORDER BY usa.updated_at DESC
       LIMIT 10`
    );

    res.json({
      statusCounts,
      statusByBloco,
      salesByDirector,
      salesByManager,
      salesByBroker,
      soldWithoutAssignment: soldWithoutAssignmentRow ? soldWithoutAssignmentRow.count : 0,
      assignedNotSold: assignedNotSoldRow ? assignedNotSoldRow.count : 0,
      recentAssignments
    });
  } catch (err) {
    res.status(500).json({ error: "Erro ao carregar dashboard" });
  }
});

app.get("/api/admin/units/:bloco/:unidade/assignment", requireAdmin, async (req, res) => {
  try {
    const assignment = await getUnitAssignment(req.params.bloco, req.params.unidade);
    res.json({ assignment });
  } catch (err) {
    res.status(500).json({ error: "Erro ao carregar vínculo da unidade" });
  }
});

app.post("/api/admin/units/:bloco/:unidade/assignment", requireAdmin, async (req, res) => {
  const bloco = String(req.params.bloco || "").trim();
  const unidade = String(req.params.unidade || "").trim();
  const hierarchyId = req.body && req.body.hierarchyId != null
    ? Number(req.body.hierarchyId)
    : null;

  if (!bloco || !unidade) {
    return res.status(400).json({ error: "bloco e unidade são obrigatórios" });
  }

  try {
    if (hierarchyId == null || Number.isNaN(hierarchyId)) {
      await dbRun(
        `DELETE FROM unit_sales_assignments WHERE bloco = ? AND unidade = ?`,
        [bloco, unidade]
      );

      return res.json({ success: true, assignment: null });
    }

    const unitStatus = await getUnitStatus(bloco, unidade);
    if (unitStatus === "available") {
      await dbRun(
        `DELETE FROM unit_sales_assignments WHERE bloco = ? AND unidade = ?`,
        [bloco, unidade]
      );

      return res.status(400).json({
        error: "Unidades disponíveis não podem ter vínculo comercial. Altere para reservada ou vendida."
      });
    }

    const hierarchy = await dbGet(
      `SELECT id, director, manager, broker, active
       FROM sales_hierarchy
       WHERE id = ?`,
      [hierarchyId]
    );

    if (!hierarchy) {
      return res.status(404).json({ error: "Vínculo comercial não encontrado" });
    }

    await dbRun(
      `INSERT INTO unit_sales_assignments (bloco, unidade, hierarchy_id, updated_by)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(bloco, unidade)
       DO UPDATE SET
         hierarchy_id = excluded.hierarchy_id,
         updated_by = excluded.updated_by,
         updated_at = CURRENT_TIMESTAMP`,
      [bloco, unidade, hierarchyId, req.session.user.id]
    );

    const assignment = await getUnitAssignment(bloco, unidade);
    res.json({ success: true, assignment });
  } catch (err) {
    res.status(500).json({ error: "Erro ao salvar vínculo da unidade" });
  }
});

app.post("/api/admin/sales-hierarchy/import", requireAdmin, async (req, res) => {
  const rows = Array.isArray(req.body && req.body.rows) ? req.body.rows : null;

  if (!rows || rows.length === 0) {
    return res.status(400).json({ error: "rows é obrigatório e deve conter ao menos 1 item" });
  }

  try {
    await dbRun("BEGIN TRANSACTION");
    await dbRun(`UPDATE sales_hierarchy SET active = 0, updated_at = CURRENT_TIMESTAMP`);

    let imported = 0;
    for (const entry of rows) {
      const rawSuperintendent =
        entry.superintendent ?? entry.superintendente ?? entry.director ?? entry.diretor ?? "";
      const rawTeam = entry.team ?? entry.equipe ?? entry.manager ?? entry.gerente ?? "";
      const rawName = entry.name ?? entry.nome ?? entry.broker ?? entry.corretor ?? "";
      const rawRankingName =
        entry.rankingName ?? entry.nomeRanking ?? entry.nome_ranking ?? entry["nome ranking"] ?? "";

      const director = normalizeName(rawSuperintendent) || normalizeName(rawTeam);
      const manager = normalizeName(rawTeam);
      const broker = buildBrokerLabel(rawRankingName, rawName);
      const active = toFlag(entry.status ?? entry.situacao ?? entry.situação);

      if (shouldSkipTeam(manager)) continue;
      if (!director || !manager || !broker) continue;

      await dbRun(
        `INSERT INTO sales_hierarchy (director, manager, broker, active)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(director, manager, broker)
         DO UPDATE SET
           active = excluded.active,
           updated_at = CURRENT_TIMESTAMP`,
        [director, manager, broker, active]
      );
      imported += 1;
    }

    await dbRun("COMMIT");

    const payload = await buildSalesHierarchyResponse();
    res.json({ success: true, imported, ...payload });
  } catch (err) {
    await dbRun("ROLLBACK").catch(() => {});
    res.status(500).json({ error: "Erro ao importar hierarquia comercial" });
  }
});

// Get stats visibility settings (any authenticated user can read)
app.get("/api/settings/stats-visibility", requireAuth, (req, res) => {
  db.all(
    `SELECT key, value FROM settings WHERE key LIKE 'stats_%_visible' OR key = 'minimap_visible'`,
    [],
    (err, rows) => {
      if (err) {
        return res.status(500).json({ error: "Erro ao buscar configurações" });
      }
      
      const result = {};
      for (const row of rows) {
        result[row.key] = row.value === 'true';
      }
      
      res.json(result);
    }
  );
});

// Update stats visibility (admin only)
app.post("/api/settings/stats-visibility", requireAdmin, (req, res) => {
  const { key, visible } = req.body || {};
  
  const allowedKeys = ['stats_available_visible', 'stats_reserved_visible', 'stats_sold_visible', 'minimap_visible'];
  if (!allowedKeys.includes(key)) {
    return res.status(400).json({ error: "Chave inválida" });
  }
  
  db.run(
    `UPDATE settings SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = ?`,
    [visible ? 'true' : 'false', key],
    function (err) {
      if (err) {
        return res.status(500).json({ error: "Erro ao salvar configuração" });
      }
      res.json({ success: true, key, visible });
    }
  );
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`API rodando na porta ${PORT}`);
});