#!/usr/bin/env bash
#
# Puente entre Karma (que corre en Linux/WSL) y el Chrome de Windows.
#
# Por que existe esto: en este equipo el repo vive en WSL y el unico navegador disponible es el
# Chrome de Windows, alcanzable por interop. Lanzarlo directo casi funciona, pero Karma le pasa
# argumentos con rutas de Linux (--user-data-dir=/tmp/karma-XXXX). Chrome de Windows no entiende esa
# ruta, arranca y se muere con codigo 21 sin decir nada, y Karma solo sabe reportar
# "Cannot start ChromeHeadless" sin stderr. Este script traduce esas rutas a rutas de Windows con
# wslpath y reenvia el resto de argumentos tal cual.
#
# Se usa solo cuando CHROME_BIN apunta a un .exe de Windows. En Linux nativo no hace falta.
#
#   CHROME_BIN="$(pwd)/tools/chrome-wsl.sh" npx ng test --watch=false

set -euo pipefail

CHROME="${CHROME_WSL_BIN:-/mnt/c/Program Files/Google/Chrome/Application/chrome.exe}"

if [ ! -x "$CHROME" ] && [ ! -f "$CHROME" ]; then
  echo "[chrome-wsl] no encuentro el Chrome de Windows en: $CHROME" >&2
  echo "[chrome-wsl] exporta CHROME_WSL_BIN con la ruta correcta" >&2
  exit 1
fi

argumentos=()
for arg in "$@"; do
  case "$arg" in
    --user-data-dir=*)
      ruta="${arg#--user-data-dir=}"
      # /tmp es el /tmp de Linux; el Chrome de Windows necesita C:\... para poder usarlo.
      traducida="$(wslpath -w "$ruta" 2>/dev/null || printf '%s' "$ruta")"
      argumentos+=("--user-data-dir=$traducida")
      ;;
    *)
      argumentos+=("$arg")
      ;;
  esac
done

# exec: el proceso de Chrome sustituye a este script, asi Karma ve un solo proceso y su
# deteccion de "el navegador se ha caido" sigue funcionando.
exec "$CHROME" "${argumentos[@]}"
