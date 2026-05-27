/// LAS Public Header Block parser.
///
/// LAS-headeren er bytes 0..header_size af filen. Mindste version (1.2) er 227 bytes,
/// 1.3 er 235 bytes, 1.4 er 375 bytes. Spec'en findes hos ASPRS:
/// https://www.asprs.org/divisions-committees/lidar-division/laser-las-file-format-exchange-activities

#[derive(Debug, Clone, PartialEq)]
pub enum LasError {
    /// First 4 bytes are not "LASF"
    MissingMagic,
    /// Version major.minor not in (1.2, 1.3, 1.4)
    UnsupportedVersion(u8, u8),
    /// Point Data Record Format ID not in (0, 1, 2, 3, 6, 7)
    UnsupportedFormat(u8),
    /// Header bytes truncated
    BufferTooSmall,
    /// File is LAZ-compressed (high bit of point_data_format is set).
    /// Ward 21 leverer kun ukomprimeret LAS; LAZ-decode er Ward 25's område.
    LazCompressed,
    /// Some other corruption with diagnostic
    Corrupt(String),
}

/// Parsed LAS Public Header Block — only the fields Ward 21 consumes.
#[derive(Debug, Clone)]
pub struct LasHeader {
    pub version_major: u8,
    pub version_minor: u8,
    pub header_size: u16,
    pub point_data_offset: u32,
    pub num_vlrs: u32,
    pub point_data_format: u8,
    pub point_data_record_length: u16,
    /// Number of point records — `legacy_number_of_point_records` (u32) for v1.2,
    /// `number_of_point_records` (u64) for v1.4
    pub number_of_point_records: u64,
    pub scale: [f64; 3],
    pub offset: [f64; 3],
    pub min: [f64; 3],
    pub max: [f64; 3],
}

const MIN_HEADER_SIZE: usize = 227;
const V14_HEADER_SIZE: usize = 375;

fn read_u16(bytes: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes([bytes[offset], bytes[offset + 1]])
}
fn read_u32(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes([
        bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3],
    ])
}
fn read_u64(bytes: &[u8], offset: usize) -> u64 {
    let mut a = [0u8; 8];
    a.copy_from_slice(&bytes[offset..offset + 8]);
    u64::from_le_bytes(a)
}
fn read_f64(bytes: &[u8], offset: usize) -> f64 {
    let mut a = [0u8; 8];
    a.copy_from_slice(&bytes[offset..offset + 8]);
    f64::from_le_bytes(a)
}

/// Parse a LAS Public Header Block from raw bytes.
pub fn parse_las_header(bytes: &[u8]) -> Result<LasHeader, LasError> {
    if bytes.len() < MIN_HEADER_SIZE {
        return Err(LasError::BufferTooSmall);
    }
    if &bytes[0..4] != b"LASF" {
        return Err(LasError::MissingMagic);
    }
    let version_major = bytes[24];
    let version_minor = bytes[25];
    if version_major != 1 || !matches!(version_minor, 2 | 3 | 4) {
        return Err(LasError::UnsupportedVersion(version_major, version_minor));
    }
    let header_size = read_u16(bytes, 94);
    if (header_size as usize) > bytes.len() {
        return Err(LasError::BufferTooSmall);
    }
    let point_data_offset = read_u32(bytes, 96);
    let num_vlrs = read_u32(bytes, 100);
    let point_data_format_raw = bytes[104];
    // High bit (0x80) signals LAZ compression — afvis eksplicit i stedet for at
    // silently strippe og parse komprimerede bytes som rå koordinater.
    if point_data_format_raw & 0x80 != 0 {
        return Err(LasError::LazCompressed);
    }
    let point_data_format = point_data_format_raw;
    if !matches!(point_data_format, 0 | 1 | 2 | 3 | 6 | 7) {
        return Err(LasError::UnsupportedFormat(point_data_format));
    }
    let point_data_record_length = read_u16(bytes, 105);
    let legacy_num_points = read_u32(bytes, 107) as u64;

    let scale = [read_f64(bytes, 131), read_f64(bytes, 139), read_f64(bytes, 147)];
    let offset = [read_f64(bytes, 155), read_f64(bytes, 163), read_f64(bytes, 171)];
    // LAS stores max BEFORE min for each axis (ASPRS quirk).
    let max = [read_f64(bytes, 179), read_f64(bytes, 195), read_f64(bytes, 211)];
    let min = [read_f64(bytes, 187), read_f64(bytes, 203), read_f64(bytes, 219)];

    // v1.4 has a 64-bit point count at offset 247.
    let number_of_point_records = if version_minor >= 4 && bytes.len() >= V14_HEADER_SIZE {
        let v14_count = read_u64(bytes, 247);
        if v14_count > 0 { v14_count } else { legacy_num_points }
    } else {
        legacy_num_points
    };

    Ok(LasHeader {
        version_major,
        version_minor,
        header_size,
        point_data_offset,
        num_vlrs,
        point_data_format,
        point_data_record_length,
        number_of_point_records,
        scale,
        offset,
        min,
        max,
    })
}
