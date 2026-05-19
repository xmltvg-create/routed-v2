function node_function()
end

function way_function(way)
  local building = way:Find("building")
  if building ~= "" then
    way:Layer("building", true)
    way:Attribute("render_height", "8")
    way:Attribute("render_min_height", "0")
    way:MinZoom(13)
  end
end

function relation_scan_function()
end

function relation_function()
end
