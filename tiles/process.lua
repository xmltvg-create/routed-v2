-- PathPilot custom Tilemaker Lua profile
-- Extracts rich building metadata: height, levels, parts, roof, material

function node_function(node)
end

function way_function(way)
  local building = way:Find("building")
  local building_part = way:Find("building:part")
  local highway = way:Find("highway")

  if building ~= "" or building_part ~= "" then
    way:Layer("building", true)

    local height = tonumber(way:Find("height"))
    local min_height = tonumber(way:Find("min_height"))
    local levels = tonumber(way:Find("building:levels"))
    local min_levels = tonumber(way:Find("building:min_levels"))

    local render_height = height
    if render_height == nil and levels ~= nil then
      render_height = levels * 3.0
    end
    if render_height == nil then
      if building == "house" or building == "detached" or building == "residential" then
        render_height = 6
      elseif building == "apartments" or building == "commercial" then
        render_height = 15
      elseif building == "industrial" or building == "warehouse" then
        render_height = 10
      elseif building == "retail" then
        render_height = 5
      elseif building == "garage" or building == "shed" or building == "carport" then
        render_height = 3
      else
        render_height = 8
      end
    end

    local render_min_height = min_height
    if render_min_height == nil and min_levels ~= nil then
      render_min_height = min_levels * 3.0
    end
    if render_min_height == nil then
      render_min_height = 0
    end

    way:AttributeNumeric("render_height", render_height)
    way:AttributeNumeric("render_min_height", render_min_height)
    way:Attribute("building", building ~= "" and building or building_part)

    if building_part ~= "" then
      way:Attribute("is_part", "true")
    end
    if levels ~= nil then
      way:AttributeNumeric("levels", levels)
    end

    local roof_shape = way:Find("roof:shape")
    if roof_shape ~= "" then way:Attribute("roof_shape", roof_shape) end

    local material = way:Find("building:material")
    if material ~= "" then way:Attribute("material", material) end

    local colour = way:Find("building:colour")
    if colour ~= "" then way:Attribute("colour", colour) end

    local name = way:Find("name")
    if name ~= "" then way:Attribute("name", name) end

    way:MinZoom(13)
    return
  end

  if highway ~= "" then
    local dominated = {
      "pedestrian", "path", "footway", "cycleway", "steps",
      "track", "service", "bridleway", "construction"
    }
    for _, v in ipairs(dominated) do
      if highway == v then return end
    end

    way:Layer("transportation", false)
    way:Attribute("class", highway)

    local name = way:Find("name")
    if name ~= "" then
      way:Layer("transportation_name", false)
      way:Attribute("name", name)
      way:Attribute("class", highway)
    end

    if highway == "motorway" or highway == "trunk" then
      way:MinZoom(4)
    elseif highway == "primary" then
      way:MinZoom(7)
    elseif highway == "secondary" then
      way:MinZoom(9)
    elseif highway == "tertiary" then
      way:MinZoom(11)
    else
      way:MinZoom(12)
    end
  end
end

function relation_scan_function(relation)
  if relation:Find("type") == "multipolygon" then
    if relation:Find("building") ~= "" or relation:Find("building:part") ~= "" then
      relation:Accept()
    end
  end
end

function relation_function(relation)
  local building = relation:Find("building")
  local building_part = relation:Find("building:part")

  if building ~= "" or building_part ~= "" then
    relation:Layer("building", true)

    local height = tonumber(relation:Find("height"))
    local levels = tonumber(relation:Find("building:levels"))
    local render_height = height
    if render_height == nil and levels ~= nil then render_height = levels * 3.0 end
    if render_height == nil then render_height = 8 end

    local min_height = tonumber(relation:Find("min_height"))
    local min_levels = tonumber(relation:Find("building:min_levels"))
    local render_min_height = min_height
    if render_min_height == nil and min_levels ~= nil then render_min_height = min_levels * 3.0 end
    if render_min_height == nil then render_min_height = 0 end

    relation:AttributeNumeric("render_height", render_height)
    relation:AttributeNumeric("render_min_height", render_min_height)
    relation:Attribute("building", building ~= "" and building or building_part)

    local name = relation:Find("name")
    if name ~= "" then relation:Attribute("name", name) end

    relation:MinZoom(13)
  end
end
