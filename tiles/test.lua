-- Minimal test profile

function node_function(node)
end

function way_function(way)
  local building = way:Find("building")
  if building ~= "" then
    way:Layer("building", true)
    way:Attribute("building_type", building)
    way:AttributeNumeric("render_height", 8)
    way:AttributeNumeric("render_min_height", 0)
    way:MinZoom(13)
  end
end

function relation_scan_function(relation)
end

function relation_function(relation)
end
