import pandas as pd
import sqlite3
import unicodedata
import sys

DB_PATH = r"C:\Github\mapa-de-disponibilidade\api\data\units.db"
EXCEL_PATH = r"C:\Users\Lucas.Graca\Downloads\New_Query_2026_06_18_17_01_32.xlsx"

BLOCO_MAP = {"Ed. Boulevard": "1", "Ed. Park": "2"}

# Corrections: gabarito name (normalized) -> DB name (normalized)
MGR_CORRECTIONS = {
    "conrado .": "conrado",
}
BROKER_CORRECTIONS = {
    "beta pachec":    "beta pacheco",
    "magalhaes .":   "magalhaes",
    "suyanne almeida": "suyanne oliveira",
}

def norm(s):
    s = str(s or "").strip().lower()
    return unicodedata.normalize("NFD", s).encode("ascii", "ignore").decode()

def title_pt(s):
    s = str(s or "").strip()
    if not s or s.lower() == "nan": return ""
    # Simple title case preserving existing spaces
    return " ".join(w.capitalize() for w in s.split())

def is_nan(s):
    return str(s).strip().lower() in ("nan", "", "none")

def find_hierarchy_id(cursor, dir_n, mgr_n, broker_n, hierarchy_cache):
    """Find best matching hierarchy_id. broker_n is normalized war-name from gabarito."""
    for hid, hdir, hmgr, hbroker in hierarchy_cache:
        if norm(hdir) == dir_n and norm(hmgr) == mgr_n:
            nb = norm(hbroker)
            # exact match or broker stored as "WarName - FullName"
            if nb == broker_n or nb.startswith(broker_n + " - "):
                return hid
    return None

def ensure_hierarchy(cursor, director, manager, broker, hierarchy_cache):
    """Return existing hierarchy_id or insert a new row."""
    dir_n = norm(director)
    mgr_n = norm(manager)
    broker_n = norm(broker)

    hid = find_hierarchy_id(cursor, dir_n, mgr_n, broker_n, hierarchy_cache)
    if hid:
        return hid

    # Insert new
    cursor.execute(
        "INSERT OR IGNORE INTO sales_hierarchy (director, manager, broker, active) VALUES (?, ?, ?, 1)",
        [title_pt(director), title_pt(manager), title_pt(broker)]
    )
    if cursor.lastrowid:
        new_id = cursor.lastrowid
    else:
        row = cursor.execute(
            "SELECT id FROM sales_hierarchy WHERE director=? AND manager=? AND broker=?",
            [title_pt(director), title_pt(manager), title_pt(broker)]
        ).fetchone()
        new_id = row[0]

    hierarchy_cache.append((new_id, title_pt(director), title_pt(manager), title_pt(broker)))
    return new_id

def main():
    df = pd.read_excel(EXCEL_PATH, header=0)
    conn = sqlite3.connect(DB_PATH, isolation_level=None)
    cur = conn.cursor()
    cur.execute("PRAGMA journal_mode=WAL")

    # Load current hierarchy
    hierarchy_cache = cur.execute(
        "SELECT id, director, manager, broker FROM sales_hierarchy"
    ).fetchall()

    # Prepare the sold set: (bloco, unidade) -> hierarchy_id or None
    sold_units = {}
    skipped = 0
    new_hierarchy = 0
    correction_log = []

    for _, row in df.iterrows():
        raw_bloco   = str(row.get("bloco", "") or "")
        raw_unidade = str(row.get("unidade", "") or "").lstrip("0") or "0"
        raw_dir     = str(row.get("diretor", "") or "")
        raw_mgr     = str(row.get("gerente", "") or "")
        raw_broker  = str(row.get("corretor", "") or "")

        bloco = BLOCO_MAP.get(raw_bloco.strip())
        if not bloco:
            skipped += 1
            continue

        unidade = raw_unidade

        # Rows with no real hierarchy data
        if is_nan(raw_dir) or is_nan(raw_mgr) or is_nan(raw_broker):
            sold_units[(bloco, unidade)] = None
            continue

        # Apply name corrections
        mgr_norm   = norm(raw_mgr)
        broker_norm = norm(raw_broker)
        mgr_corrected    = MGR_CORRECTIONS.get(mgr_norm, mgr_norm)
        broker_corrected = BROKER_CORRECTIONS.get(broker_norm, broker_norm)

        if mgr_corrected != mgr_norm:
            correction_log.append(f"  gerente: '{raw_mgr}' -> norma corrigida '{mgr_corrected}'")
        if broker_corrected != broker_norm:
            correction_log.append(f"  corretor: '{raw_broker}' -> norma corrigida '{broker_corrected}'")

        # Find or create hierarchy
        dir_n    = norm(raw_dir)
        mgr_n    = mgr_corrected
        broker_n = broker_corrected

        hid = find_hierarchy_id(cur, dir_n, mgr_n, broker_n, hierarchy_cache)
        if hid is None:
            # Add new hierarchy entry using cleaned names
            hid = ensure_hierarchy(cur, raw_dir, raw_mgr, raw_broker, hierarchy_cache)
            new_hierarchy += 1
            print(f"  [NOVO] dir={raw_dir} | mgr={raw_mgr} | broker={raw_broker} -> id={hid}")

        sold_units[(bloco, unidade)] = hid

    print(f"\nGabarito: {len(sold_units)} unidades vendidas | {skipped} ignoradas | {new_hierarchy} novos na hierarquia")

    if correction_log:
        print("Correções de nome aplicadas:")
        for c in set(correction_log):
            print(c)

    # --- Apply to DB ---
    cur.execute("BEGIN")

    # 1. Reset ALL units to available and clear assignments
    cur.execute("UPDATE unit_statuses SET status='available', updated_at=CURRENT_TIMESTAMP")
    cur.execute("DELETE FROM unit_sales_assignments")

    # 2. Mark sold units
    sold_ok = 0
    sold_missing = 0

    for (bloco, unidade), hid in sold_units.items():
        r = cur.execute(
            "UPDATE unit_statuses SET status='sold', updated_at=CURRENT_TIMESTAMP WHERE bloco=? AND unidade=?",
            [bloco, unidade]
        )
        if cur.rowcount == 0:
            sold_missing += 1
            # Unit not in DB yet — insert it
            cur.execute(
                "INSERT OR IGNORE INTO unit_statuses (bloco, unidade, status) VALUES (?,?,'sold')",
                [bloco, unidade]
            )
        else:
            sold_ok += 1

        if hid is not None:
            cur.execute(
                "INSERT OR IGNORE INTO unit_sales_assignments (bloco, unidade, hierarchy_id, updated_by) VALUES (?,?,?,1)",
                [bloco, unidade, hid]
            )

    cur.execute("COMMIT")

    print(f"\nUnidades vendidas aplicadas: {sold_ok} existentes + {sold_missing} inseridas")

    # Summary
    rows = cur.execute(
        "SELECT status, COUNT(*) FROM unit_statuses GROUP BY status"
    ).fetchall()
    print("\nResumo final:")
    for r in rows:
        print(f"  {r[0]}: {r[1]}")

    conn.close()

if __name__ == "__main__":
    main()
