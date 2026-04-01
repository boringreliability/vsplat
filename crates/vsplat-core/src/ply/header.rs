/// PLY file header parser.
/// Reads the ASCII header to extract element count, property definitions,
/// and computes byte offsets for the binary section.

/// A single property in the PLY vertex element.
#[derive(Debug, Clone, PartialEq)]
pub struct PlyProperty {
    pub name: String,
    /// Byte offset of this property within a single vertex record
    pub offset: usize,
    /// Size in bytes (4 for float, 8 for double, 1 for uchar, etc.)
    pub size: usize,
}

/// Parsed PLY header metadata.
#[derive(Debug, Clone)]
pub struct PlyHeader {
    /// Number of vertices (splats)
    pub vertex_count: usize,
    /// Ordered list of properties with their offsets
    pub properties: Vec<PlyProperty>,
    /// Total bytes per vertex record (stride)
    pub stride: usize,
    /// Byte offset where binary data begins (after "end_header\n")
    pub data_offset: usize,
}

impl PlyHeader {
    /// Find a property by name, returns its offset within the vertex stride.
    pub fn property_offset(&self, name: &str) -> Option<usize> {
        self.properties.iter().find(|p| p.name == name).map(|p| p.offset)
    }
}

/// Size in bytes for a PLY property type.
fn property_size(type_name: &str) -> Result<usize, String> {
    match type_name {
        "float" | "float32" => Ok(4),
        "double" | "float64" => Ok(8),
        "uchar" | "uint8" => Ok(1),
        "char" | "int8" => Ok(1),
        "ushort" | "uint16" => Ok(2),
        "short" | "int16" => Ok(2),
        "uint" | "uint32" => Ok(4),
        "int" | "int32" => Ok(4),
        other => Err(format!("Unknown property type: {other}")),
    }
}

/// Parse a PLY ASCII header from raw bytes.
/// Returns the header metadata or an error description.
pub fn parse_header(bytes: &[u8]) -> Result<PlyHeader, String> {
    // Find end_header to determine where the ASCII header ends
    let header_end_marker = b"end_header\n";
    let header_end_pos = bytes
        .windows(header_end_marker.len())
        .position(|w| w == header_end_marker)
        .ok_or("Missing 'end_header' in PLY file")?;

    let data_offset = header_end_pos + header_end_marker.len();

    // Parse the ASCII header as UTF-8 lines
    let header_str = std::str::from_utf8(&bytes[..header_end_pos])
        .map_err(|e| format!("Invalid UTF-8 in PLY header: {e}"))?;

    let mut lines = header_str.lines();

    // First line must be "ply"
    let first_line = lines.next().ok_or("Empty PLY file")?;
    if first_line.trim() != "ply" {
        return Err(format!("Not a PLY file: first line is '{first_line}'"));
    }

    let mut format_found = false;
    let mut vertex_count: Option<usize> = None;
    let mut in_vertex_element = false;
    let mut properties: Vec<PlyProperty> = Vec::new();
    let mut current_offset: usize = 0;

    for line in lines {
        let line = line.trim();
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.is_empty() {
            continue;
        }

        match parts[0] {
            "format" => {
                if parts.len() < 2 || parts[1] != "binary_little_endian" {
                    return Err(format!(
                        "Unsupported PLY format: '{}'. Only binary_little_endian is supported",
                        parts.get(1).unwrap_or(&"<missing>")
                    ));
                }
                format_found = true;
            }
            "element" => {
                if parts.len() >= 3 && parts[1] == "vertex" {
                    vertex_count = Some(
                        parts[2]
                            .parse::<usize>()
                            .map_err(|e| format!("Invalid vertex count: {e}"))?,
                    );
                    in_vertex_element = true;
                } else {
                    // Another element type (e.g., "face") — stop collecting vertex properties
                    in_vertex_element = false;
                }
            }
            "property" => {
                if in_vertex_element && parts.len() >= 3 {
                    let type_name = parts[1];
                    let prop_name = parts[2];
                    let size = property_size(type_name)?;

                    properties.push(PlyProperty {
                        name: prop_name.to_string(),
                        offset: current_offset,
                        size,
                    });
                    current_offset += size;
                }
            }
            _ => {} // Skip comments and other lines
        }
    }

    if !format_found {
        return Err("Missing 'format' declaration in PLY header".to_string());
    }

    let count = vertex_count.ok_or("Missing 'element vertex' in PLY header")?;

    if properties.is_empty() {
        return Err("No vertex properties found in PLY header".to_string());
    }

    Ok(PlyHeader {
        vertex_count: count,
        stride: current_offset,
        properties,
        data_offset,
    })
}
