#!/usr/bin/env bash
# ======================================================================
#  LumaGrain - ZXP build script (bash / Git Bash on Windows)
#  Packages the CEP extension into a SIGNED CinemaFX.zxp using Adobe's
#  ZXPSignCmd tool (self-signed certificate, generated automatically).
#
#  Usage:   ./build.sh
#  Output:  CinemaFX.zxp  (next to this script)
# ======================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STAGE="$ROOT/build/stage"
OUT_ZXP="$ROOT/LumaGrain.zxp"
CERT_DIR="$ROOT/build"
CERT_FILE="$CERT_DIR/lumagrain-selfsigned.p12"

# ---- Certificate fields (placeholders - edit to taste) ---------------
CERT_COUNTRY="US"
CERT_STATE="California"
CERT_ORG="Film Tools"
CERT_NAME="LumaGrain Developer"
CERT_PASS="cinemafx2026"

# ---- Locate ZXPSignCmd (same folder or PATH; on Windows it is .exe) --
ZXP_TOOL=""
for candidate in "$ROOT/ZXPSignCmd.exe" "$ROOT/ZXPSignCmd" ZXPSignCmd.exe ZXPSignCmd; do
    if command -v "$candidate" >/dev/null 2>&1 || [ -x "$candidate" ]; then
        ZXP_TOOL="$candidate"
        break
    fi
done
if [ -z "$ZXP_TOOL" ]; then
    echo ""
    echo "[ERROR] ZXPSignCmd was not found."
    echo "        Put ZXPSignCmd(.exe) next to build.sh, or add it to PATH."
    echo "        Download it from Adobe:"
    echo "        https://github.com/Adobe-CEP/CEP-Resources/tree/master/ZXPSignCMD"
    exit 1
fi
echo "[1/4] Using ZXPSignCmd: $ZXP_TOOL"

# ---- [2/4] Stage a clean copy of the extension -----------------------
echo "[2/4] Staging extension files ..."
rm -rf "$STAGE"
mkdir -p "$STAGE"
cp -r "$ROOT/CSXS" "$STAGE/CSXS"
cp -r "$ROOT/jsx"  "$STAGE/jsx"
cp -r "$ROOT/lib"  "$STAGE/lib"
cp "$ROOT/index.html" "$STAGE/index.html"
cp "$ROOT/style.css"  "$STAGE/style.css"
cp "$ROOT/main.js"    "$STAGE/main.js"
cp "$ROOT/.debug"     "$STAGE/.debug"

# ---- [3/4] Create the self-signed certificate (only once) ------------
mkdir -p "$CERT_DIR"
if [ -f "$CERT_FILE" ]; then
    echo "[3/4] Reusing existing self-signed certificate ..."
else
    echo "[3/4] Generating self-signed certificate ..."
    "$ZXP_TOOL" -selfSignedCert "$CERT_COUNTRY" "$CERT_STATE" \
        "$CERT_ORG" "$CERT_NAME" "$CERT_PASS" "$CERT_FILE"
    echo "      Certificate: $CERT_FILE"
fi

# ---- [4/4] Sign and package the ZXP ----------------------------------
echo "[4/4] Signing and packaging LumaGrain.zxp ..."
rm -f "$OUT_ZXP"
"$ZXP_TOOL" -sign "$STAGE" "$OUT_ZXP" "$CERT_FILE" "$CERT_PASS"

echo ""
echo "====================================================="
echo "  SUCCESS: $OUT_ZXP"
echo "  Install it with any ZXP installer, then restart"
echo "  Premiere Pro and open Window > Extensions > LumaGrain"
echo "====================================================="
