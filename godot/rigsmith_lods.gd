@tool
extends EditorScenePostImport
## Rigsmith distance LODs. Exported characters carry simplified copies of each mesh named <mesh>_LOD1,
## _LOD2, _LOD3 with the switch distances in their glTF extras. This import script turns those into
## visibility ranges, so the full mesh shows up close and lighter copies further out.
##
## Use it once per project: Project Settings > Import Defaults > Scene > Import Script, then reimport.
## (Or per file in the Import dock.) Godot's own automatic mesh LODs keep working inside each level.

## Fallback switch distances in metres, if a mesh carries no extras.
const DEFAULT_DISTANCES := [12.0, 25.0, 50.0]
## Overlap around each switch so units don't flicker at the boundary.
const MARGIN := 1.0


func _post_import(scene: Node) -> Object:
	for node in scene.find_children("*", "MeshInstance3D", true, false):
		var mesh := node as MeshInstance3D
		var range := _range_of(mesh)
		if range.is_empty():
			continue
		mesh.visibility_range_begin = range[0]
		mesh.visibility_range_end = range[1]
		mesh.visibility_range_begin_margin = MARGIN if range[0] > 0.0 else 0.0
		mesh.visibility_range_end_margin = MARGIN if range[1] > 0.0 else 0.0
	return scene


func _range_of(mesh: MeshInstance3D) -> Array:
	var extras: Dictionary = mesh.get_meta("extras", {})
	if extras.has("lod"):
		return [float(extras.get("lodBegin", 0.0)), float(extras.get("lodEnd", 0.0))]
	# No extras: infer from the name (<mesh>_LOD<n>) and the default distances.
	var found := RegEx.create_from_string("_LOD(\\d)$").search(mesh.name)
	if found != null:
		var level := int(found.get_string(1))
		var begin: float = DEFAULT_DISTANCES[level - 1]
		var end: float = DEFAULT_DISTANCES[level] if level < DEFAULT_DISTANCES.size() else 0.0
		return [begin, end]
	if mesh.get_parent() != null and mesh.get_parent().has_node(NodePath(String(mesh.name) + "_LOD1")):
		return [0.0, DEFAULT_DISTANCES[0]]
	return []
