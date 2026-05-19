function node_function()
end
function way_function(way)
  local b = way:Find("building")
  if b ~= "" then
    way:Layer("building", true)
  end
end
function relation_scan_function()
end
function relation_function()
end
