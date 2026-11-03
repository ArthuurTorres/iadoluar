#!/bin/bash

if [ "$1" = "--rebuild" ]; then
  echo "🔨 Reconstruindo container..."
  ssh root@85.31.60.226 "cd ~/ia-sdr-pousada && docker compose up -d --build"
else
  echo "🔄 Sincronizando código com VPS..."
  rsync -avz --exclude='node_modules' --exclude='.git' --exclude='data' \
    ./ root@85.31.60.226:~/ia-sdr-pousada/
  echo "✅ Código sincronizado! O Node vai reiniciar automaticamente."
  echo "📊 Para ver logs: ssh root@85.31.60.226 'cd ~/ia-sdr-pousada && docker compose logs -f'"
fi