#!/bin/sh
# Pose-optimize the skin of every benchmark rig in <rig dir>, writing optimizer output to <out dir>.
# blender/autorig/dev/bench/optimize_all.sh <rig dir> <out dir> [optimize.py args]
RIGS=$1; OUT=$2; shift 2
PY=${RIGSMITH_TORCH_PYTHON:-.venv/bin/python}
cd "$(dirname "$0")/../../../.."
EX=c5dd9d93edee,594aa124446c,4358b1d9096c,3623f0314d26,e923445ab87b,535ff6653eda,275ecf82779d,96fb5d36590f,ca94fd1bb4cd,6cbfcd32e205,2ac9006e0a5a,4f32811358e8,1acdf8a3500a,1b1d0345a75e,11f10d679a40,a1af69683d26,4f099eb0787e,dcd88ede66b0
mkdir -p "$OUT"
for f in "$RIGS"/*.glb; do
  n=$(basename "$f" .glb)
  node tools/skin_opt/pose_set.ts "$f" "$OUT/$n" --poses 256 --exclude $EX > /dev/null
  "$PY" tools/skin_opt/optimize.py "$OUT/$n" "$@" 2>&1 | grep "objective before" | sed "s/^/$n /"
done
