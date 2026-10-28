# Headless check that a game unit's GLB works in Godot: the <models dir>/<unit>.glb the Ship step's export writes
# (tools/game_export.ts, tools/lib/unit_export.ts; the generic browser export is gone, DESIGN.md §0.1). It reads the file
# as Godot's glTF import does, then needs a skeleton and an animation player, every clip track to find its node or bone,
# and reports how far each clip moves the bones (a clip that silently does nothing shows 0). Prints
# GODOT_RESULT <json> (bones, meshes, skinned meshes, node types, bone attachments, each clip's length, loop, tracks,
# unresolved tracks and largest bone move) and exits 1 when a track doesn't resolve; GODOT_FAIL <why> when it can't load.
#   godot --headless --script tests/godot/check_export.gd -- <models dir>/<unit>.glb
#   npm run test:godot -- <models dir>/<unit>.glb
# The game's rules themselves (mesh names, levels, Main, root above Hips, Prop_ bones, budget, soles at 0, clip names,
# the build record) are checked in node by tests/contract/unit.test.ts. A unit to try this on without the game: run that
# test with RIGSMITH_CONTRACT_KEEP=1, which keeps its temp workspace and prints where its testunit.glb is.
extends SceneTree

var _started := false

func _process(_delta: float) -> bool:
	if not _started:
		_started = true
		_run()
	return false

func _run() -> void:
	var args := OS.get_cmdline_user_args()
	var path: String = args[0] if args.size() > 0 else ""
	var doc := GLTFDocument.new()
	var state := GLTFState.new()
	var err := doc.append_from_file(path, state)
	if err != OK:
		_fail("could not read %s (error %d)" % [path, err])
		return
	var scene: Node = doc.generate_scene(state)
	root.add_child(scene)
	var skeletons := scene.find_children("*", "Skeleton3D", true, false)
	var players := scene.find_children("*", "AnimationPlayer", true, false)
	var meshes := scene.find_children("*", "MeshInstance3D", true, false)
	meshes.append_array(scene.find_children("*", "ImporterMeshInstance3D", true, false))
	if skeletons.is_empty() or players.is_empty():
		_fail("missing skeleton (%d) or animation player (%d)" % [skeletons.size(), players.size()])
		return
	var skeleton: Skeleton3D = skeletons[0]
	var player: AnimationPlayer = players[0]
	var result := {"bones": skeleton.get_bone_count(), "meshes": meshes.size(), "skinned": 0, "animations": []}
	for m in meshes:
		if m.get("skin") != null:
			result["skinned"] += 1
	result["types"] = _types(scene)
	var attachments := scene.find_children("*", "BoneAttachment3D", true, false)
	result["bone_attachments"] = attachments.map(func(a): return "%s -> %s" % [a.name, (a as BoneAttachment3D).bone_name])
	var bad_tracks := 0
	for anim_name in player.get_animation_list():
		var anim := player.get_animation(anim_name)
		var unresolved := 0
		for t in anim.get_track_count():
			var p := anim.track_get_path(t)
			var node := player.get_node(player.root_node).get_node_or_null(NodePath(str(p).split(":")[0]))
			var bone := p.get_concatenated_subnames()
			if node == null or (node is Skeleton3D and bone != "" and (node as Skeleton3D).find_bone(bone) < 0):
				unresolved += 1
		bad_tracks += unresolved
		# Play and measure how far the bones move (catches clips that silently do nothing).
		player.play(anim_name)
		player.seek(0.0, true)
		var start := _pose(skeleton)
		player.seek(anim.length * 0.5, true)
		var mid := _pose(skeleton)
		var moved := 0.0
		for i in start.size():
			moved = max(moved, start[i].distance_to(mid[i]))
		result["animations"].append({"name": anim_name, "length": snappedf(anim.length, 0.01), "loop": anim.loop_mode != Animation.LOOP_NONE, "tracks": anim.get_track_count(), "unresolved": unresolved, "max_bone_move": snappedf(moved, 0.001)})
	result["unresolved_tracks"] = bad_tracks
	print("GODOT_RESULT " + JSON.stringify(result))
	quit(0 if bad_tracks == 0 else 1)

func _types(node: Node) -> Array:
	var out := [node.get_class()]
	for c in node.get_children():
		out.append_array(_types(c))
	return out

func _pose(skeleton: Skeleton3D) -> Array:
	var out := []
	for b in skeleton.get_bone_count():
		out.append(skeleton.get_bone_global_pose(b).origin)
	return out

func _fail(message: String) -> void:
	print("GODOT_FAIL " + message)
	quit(1)
