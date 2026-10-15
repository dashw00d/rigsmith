#!/bin/sh
# Auto-rig the 12 benchmark characters into <out dir> (finger level matching the user's Mixamo rigs).
# blender/autorig/dev/bench/rig_all.sh <out dir> [extra rig.py args]
OUT=$1; shift
EXTRA="$*"
T=$HOME/Downloads/mixamo/tripo_out
cd "$(dirname "$0")/../../../.."
mkdir -p "$OUT"
for n in archer:two bearguard:one berserker:two caravan_trader:one huntress:two raider:one seer:two siege_engineer:two skirmisher:two spearman:two villager:two warrior:one; do echo $n; done |
  xargs -P 6 -I{} sh -c 'n=$(echo {} | cut -d: -f1); f=${FINGERS:-$(echo {} | cut -d: -f2)}; ${BLENDER:-/snap/bin/blender} -b --factory-startup --python blender/autorig/rig.py -- --input '"$T"'/$n.zip --output '"$OUT"'/$n.glb --fingers $f '"$EXTRA"' 2>&1 | grep -E "Error|Traceback" | sed "s/^/$n /"'
