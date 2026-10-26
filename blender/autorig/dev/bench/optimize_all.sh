#!/bin/sh
# Pose-optimize the skin of every benchmark rig in <rig dir>, writing optimizer output to <out dir>.
# blender/autorig/dev/bench/optimize_all.sh <rig dir> <out dir> [optimize.py args]
RIGS=$1; OUT=$2; shift 2
PY=${RIGSMITH_TORCH_PYTHON:-.venv/bin/python}
cd "$(dirname "$0")/../../../.."
EX=mixamo-Walking_19,mixamo-Dying,mixamo-Standing_Draw_Arrow,mixamo-Carrying,mixamo-Digging,mixamo-Combo_Punch,mixamo-Flying_Kick,mixamo-Air_Squat,mixamo-Push_Up,mixamo-Backflip_2,mixamo-Climbing_6,mixamo-Pick_Up_Item_2,mixamo-Spell_Cast,mixamo-Crouched_Sneaking_Left,mixamo-Arm_Stretching,mixamo-Great_Sword_Jump_Attack,mixamo-Dive_Roll,mixamo-Breakdance_1990
mkdir -p "$OUT"
for f in "$RIGS"/*.glb; do
  n=$(basename "$f" .glb)
  node tools/skin_opt/pose_set.ts "$f" "$OUT/$n" --poses 256 --exclude $EX > /dev/null
  "$PY" tools/skin_opt/optimize.py "$OUT/$n" "$@" 2>&1 | grep "objective before" | sed "s/^/$n /"
done
