#!/bin/bash
set -e

echo "=== Setup: Mapa de Disponibilidade ==="

# Install Node dependencies
echo "[1/3] Instalando dependências..."
cd api
npm install --omit=dev
cd ..

# Install PM2 globally if not present
if ! command -v pm2 &> /dev/null; then
  echo "[2/3] Instalando PM2..."
  npm install -g pm2
else
  echo "[2/3] PM2 já instalado."
fi

# Start with PM2
echo "[3/3] Iniciando servidor com PM2..."
pm2 start ecosystem.config.js
pm2 save
pm2 startup

echo ""
echo "=== Pronto! Servidor rodando na porta 3000 ==="
echo "  pm2 status           -> ver status"
echo "  pm2 logs             -> ver logs"
echo "  pm2 restart mapa-disponibilidade -> reiniciar"
