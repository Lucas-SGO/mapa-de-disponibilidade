#!/usr/bin/env python3
"""
Sincroniza status de unidades do WE Barra By Living via API Cyrela → SQLite espelho.
Uso: python3 sync-cyrela.py [--dry-run]

Regra de override:
  O sync nunca retrocede uma unidade no fluxo Disponível → Reservado → Vendido.
  Se o admin adiantou uma unidade em relação ao CRM, mantém a decisão do admin.
  Se o CRM avançou além do admin, segue o CRM.
  Resultado = max(status_atual_db, status_crm) no fluxo.
"""

import urllib.request
import json
import ssl
import sqlite3
import sys
import os
from datetime import datetime

TOKEN = os.environ.get("CYRELA_TOKEN", "")
EMPREENDIMENTO_ID = os.environ.get("CYRELA_WE_BARRA_ID", "1f57bef1-85ed-f011-80dd-00155d81383f")

BLOCO_MAP = {
    "ED. ASPEN":    "1",
    "ED. IBIZA":    "2",
    "ED. MIAMI":    "3",
    "ED. ROMA":     "4",
    "ED. MALDIVAS": "5",
    "ED. DUBAI":    "6",
}

# Cyrela Value → status do espelho
STATUS_MAP = {
    3:  "available",  # DI - Disponível
    19: "reserved",   # TR - Triagem
    1:  "sold",       # AS - Venda Imputada
    12: "sold",       # AG - Suporte
    10: "reserved",   # CA - Contrato na Rua
    11: "reserved",   # PV - Proposta de Venda
    13: "reserved",   # CR - Crédito
    15: "reserved",   # SJ - Suspensa Juridicamente
    2:  "reserved",   # BL - Bloqueio Original
    4:  "reserved",   # IN - Inativo
    5:  "reserved",   # RS
    6:  "reserved",   # SD - Suspensa Definitivamente
    7:  "reserved",   # ST - Suspensão Temporária
    8:  "reserved",   # VI
    9:  "reserved",   # VN - Suporte
    14: "reserved",   # RN - Renda (Alugada)
    16: "reserved",   # DT - Distrato em Trânsito
    17: "reserved",   # BC - Bloqueio Comercial
    18: "reserved",   # NL - Não Lançada
    20: "reserved",   # AN
}

# Ordem do fluxo — nunca retrocede
STATUS_ORDER = {"available": 0, "reserved": 1, "sold": 2}

dry_run = "--dry-run" in sys.argv

if not TOKEN:
    print("Erro: variável CYRELA_TOKEN não definida.")
    sys.exit(1)


def fetch_units():
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE

    url = f"https://gateway.cyrela.com.br/portal/imovel/unidades/{EMPREENDIMENTO_ID}"
    req = urllib.request.Request(
        url,
        data=b"{}",
        headers={
            "Authorization": f"Bearer {TOKEN}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, context=ctx, timeout=30) as r:
        data = json.loads(r.read())
    return data["Data"]


def main():
    print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] Iniciando sync Cyrela → espelho{'  (DRY RUN)' if dry_run else ''}")

    units = fetch_units()
    print(f"  {len(units)} unidades recebidas da API")

    db_path = os.path.join(os.path.dirname(__file__), "data", "units.db")
    db = sqlite3.connect(db_path)

    # Lê status actuais do DB para aplicar regra de override
    current_db = {
        f"{row[0]}_{row[1]}": {"status": row[2], "override": bool(row[3])}
        for row in db.execute("SELECT bloco, unidade, status, manual_override FROM unit_statuses").fetchall()
    }

    counts = {"available": 0, "reserved": 0, "sold": 0}
    protected = 0  # unidades onde admin está à frente do CRM
    unknown_statuses = []
    unknown_blocos = []

    for u in units:
        bloco_name = u["BlocoId"]["Name"]
        bloco = BLOCO_MAP.get(bloco_name)
        if not bloco:
            unknown_blocos.append(bloco_name)
            continue

        unidade = str(int(u["Nome"]))  # '000101' → '101'
        status_value = u["StatusUnidade"]["Value"]
        crm_status = STATUS_MAP.get(status_value)

        if crm_status is None:
            unknown_statuses.append((bloco_name, unidade, status_value, u["StatusUnidade"]["Label"]))
            continue

        # Regra de override: só protege unidades que o admin tocou manualmente
        current = current_db.get(f"{bloco}_{unidade}", {"status": "available", "override": False})
        current_status = current["status"]
        is_override = current["override"]

        if STATUS_ORDER[crm_status] >= STATUS_ORDER[current_status]:
            # CRM avançou ou igualou — segue o CRM e limpa override
            final_status = crm_status
            new_override = 0
        elif is_override:
            # Admin está à frente do CRM — protege
            final_status = current_status
            new_override = 1
            protected += 1
        else:
            # CRM recuou numa unidade que o admin não tocou — segue o CRM
            final_status = crm_status
            new_override = 0

        counts[final_status] += 1

        if not dry_run:
            db.execute(
                """INSERT INTO unit_statuses (bloco, unidade, status, manual_override)
                   VALUES (?, ?, ?, ?)
                   ON CONFLICT(bloco, unidade)
                   DO UPDATE SET status = excluded.status, manual_override = excluded.manual_override, updated_at = CURRENT_TIMESTAMP""",
                (bloco, unidade, final_status, new_override),
            )

    if not dry_run:
        db.commit()
    db.close()

    print(f"  available : {counts['available']}")
    print(f"  reserved  : {counts['reserved']}")
    print(f"  sold      : {counts['sold']}")
    if protected:
        print(f"  protegidas (admin à frente do CRM): {protected}")

    if unknown_statuses:
        print(f"\n  ATENÇÃO — {len(unknown_statuses)} unidade(s) com status desconhecido (não actualizadas):")
        for bloco_name, unidade, val, label in unknown_statuses:
            print(f"    {bloco_name} / {unidade} → Value={val}, Label={label}")

    if unknown_blocos:
        from collections import Counter
        print(f"\n  ATENÇÃO — blocos desconhecidos: {dict(Counter(unknown_blocos))}")

    action = "Simulado" if dry_run else "Concluído"
    print(f"\n  {action}. {sum(counts.values())} unidades processadas.")


if __name__ == "__main__":
    main()
