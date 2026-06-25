#!/usr/bin/env python3
"""
Sincroniza status de unidades do WE Barra By Living via API Cyrela → SQLite espelho.
Uso: python3 sync-cyrela.py [--dry-run]
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
    19: "available",  # TR - Triagem
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

    counts = {"available": 0, "reserved": 0, "sold": 0}
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
        status = STATUS_MAP.get(status_value)

        if status is None:
            unknown_statuses.append((bloco_name, unidade, status_value, u["StatusUnidade"]["Label"]))
            continue

        counts[status] += 1

        if not dry_run:
            db.execute(
                """INSERT INTO unit_statuses (bloco, unidade, status)
                   VALUES (?, ?, ?)
                   ON CONFLICT(bloco, unidade)
                   DO UPDATE SET status = excluded.status, updated_at = CURRENT_TIMESTAMP""",
                (bloco, unidade, status),
            )

    if not dry_run:
        db.commit()
    db.close()

    print(f"  available : {counts['available']}")
    print(f"  reserved  : {counts['reserved']}")
    print(f"  sold      : {counts['sold']}")

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
