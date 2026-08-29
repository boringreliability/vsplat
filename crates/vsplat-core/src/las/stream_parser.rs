/// Streaming LAS Point Data Record parser.
///
/// Bygger SoA-buffers (positions f32, intensity u16, rgb u8, classification u8)
/// ved at konsumere chunks af LAS-bytes. Holder en intern partial-buffer for at
/// håndtere chunk-grænser midt i en point record.

use crate::las::header::{parse_las_header_allow_compressed, LasError, LasHeader};
use crate::las::laz::{decode_batch, find_laz_vlr, Decompressor, LazDecoder};

/// Point Data Record Format — Ward 21 supporterer 0, 1, 2, 3, 6, 7
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum PdrfFormat {
    Format0, // xyz + intensity + classification
    Format1, // PDRF 0 + GPS time
    Format2, // PDRF 0 + RGB
    Format3, // PDRF 0 + GPS time + RGB
    Format6, // xyz + intensity + classification (v1.4 extended)
    Format7, // PDRF 6 + RGB
}

impl PdrfFormat {
    pub fn record_length(self) -> usize {
        match self {
            PdrfFormat::Format0 => 20,
            PdrfFormat::Format1 => 28,
            PdrfFormat::Format2 => 26,
            PdrfFormat::Format3 => 34,
            PdrfFormat::Format6 => 30,
            PdrfFormat::Format7 => 36,
        }
    }

    pub fn has_rgb(self) -> bool {
        matches!(self, PdrfFormat::Format2 | PdrfFormat::Format3 | PdrfFormat::Format7)
    }

    /// Byte offset of intensity within a single record (u16, little-endian)
    fn intensity_offset(self) -> usize { 12 }

    /// Byte offset of classification within a single record
    fn classification_offset(self) -> usize {
        match self {
            // PDRF 0-5: classification is the low 5 bits of byte 15
            PdrfFormat::Format0 | PdrfFormat::Format1 | PdrfFormat::Format2 | PdrfFormat::Format3 => 15,
            // PDRF 6-10: classification is byte 16 (dedicated field)
            PdrfFormat::Format6 | PdrfFormat::Format7 => 16,
        }
    }

    /// Byte offset of RGB within a single record (3 × u16 little-endian)
    fn rgb_offset(self) -> Option<usize> {
        match self {
            PdrfFormat::Format2 => Some(20),       // immediately after PDRF 0 base
            PdrfFormat::Format3 => Some(28),       // after PDRF 0 + GPS time (8B)
            PdrfFormat::Format7 => Some(30),       // after PDRF 6 base (30B)
            _ => None,
        }
    }

    pub fn from_u8(id: u8) -> Result<Self, LasError> {
        match id {
            0 => Ok(PdrfFormat::Format0),
            1 => Ok(PdrfFormat::Format1),
            2 => Ok(PdrfFormat::Format2),
            3 => Ok(PdrfFormat::Format3),
            6 => Ok(PdrfFormat::Format6),
            7 => Ok(PdrfFormat::Format7),
            other => Err(LasError::UnsupportedFormat(other)),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ParseResult {
    pub points_added: u32,
    pub done: bool,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum ParseState {
    NeedsHeader,
    SkippingToPointData,
    ReadingPoints,
    /// LAZ: samler komprimerede bytes indtil decoderen kan køre.
    /// Se `las::laz` for hvorfor hele filen skal være modtaget først.
    BufferingLaz,
    Done,
}

pub struct LasParser {
    state: ParseState,
    header: Option<LasHeader>,
    pdrf: Option<PdrfFormat>,
    positions: Vec<f32>,
    intensity: Vec<u16>,
    rgb: Vec<u8>,
    classification: Vec<u8>,
    /// Pending bytes that did not complete a record (or did not complete the header)
    pending: Vec<u8>,
    /// Bytes already consumed including header — used to know when to start point parsing
    cursor: u64,
    /// Point records emitted so far
    points_emitted: u64,
    /// LAZ: bytes fra filens offset 0 indtil laszip-VLR'en er lokaliseret.
    /// LAZ' chunk-table-offset er absolut, så decoderen skal se filen fra
    /// byte 0 — derfor beholder vi header + VLR-blok her.
    laz_prefix: Vec<u8>,
    laz_decoder: Option<LazDecoder>,
}

impl LasParser {
    pub fn new() -> Self {
        Self {
            state: ParseState::NeedsHeader,
            header: None,
            pdrf: None,
            positions: Vec::new(),
            intensity: Vec::new(),
            rgb: Vec::new(),
            classification: Vec::new(),
            pending: Vec::new(),
            cursor: 0,
            points_emitted: 0,
            laz_prefix: Vec::new(),
            laz_decoder: None,
        }
    }

    pub fn header(&self) -> Option<&LasHeader> { self.header.as_ref() }
    /// True hvis den indlæste fil var LAZ-komprimeret.
    pub fn is_compressed(&self) -> bool { self.header.as_ref().is_some_and(|h| h.compressed) }
    pub fn pdrf(&self) -> Option<PdrfFormat> { self.pdrf }
    pub fn positions(&self) -> &[f32] { &self.positions }
    pub fn intensity(&self) -> &[u16] { &self.intensity }
    pub fn rgb(&self) -> &[u8] { &self.rgb }
    pub fn classification(&self) -> &[u8] { &self.classification }

    /// Feed a chunk of bytes. First call must include the header at offset 0.
    ///
    /// LAS og LAZ deler denne indgang: er filen komprimeret, sendes bytes
    /// videre til `LazDecoder`, og de dekomprimerede records løber gennem
    /// præcis samme `emit_point` som ukomprimeret input.
    pub fn parse_chunk(&mut self, chunk: &[u8]) -> Result<ParseResult, LasError> {
        if self.state == ParseState::BufferingLaz {
            return self.parse_chunk_laz(chunk);
        }
        // Concat with pending — common branch for partial records / partial header.
        // Allocation cost is one Vec move per chunk; the pending buffer stays small.
        let mut buf = std::mem::take(&mut self.pending);
        buf.extend_from_slice(chunk);
        let mut cursor = 0usize;
        let mut points_added = 0u32;

        loop {
            match self.state {
                ParseState::NeedsHeader => {
                    if buf.len() - cursor < 227 {
                        // Not enough bytes for even a v1.2 header — stash and wait.
                        self.pending = buf.split_off(cursor);
                        return Ok(ParseResult { points_added, done: false });
                    }
                    let header = parse_las_header_allow_compressed(&buf[cursor..])?;
                    let header_size = header.header_size as usize;
                    if buf.len() - cursor < header_size {
                        self.pending = buf.split_off(cursor);
                        return Ok(ParseResult { points_added, done: false });
                    }
                    self.pdrf = Some(PdrfFormat::from_u8(header.point_data_format)?);
                    let compressed = header.compressed;
                    self.header = Some(header);
                    if compressed {
                        // LAZ: intet konsumeres her — decoderen skal se filen
                        // fra byte 0, fordi chunk-table-offsettet er absolut.
                        self.state = ParseState::BufferingLaz;
                        let rest = buf.split_off(cursor);
                        self.pending.clear();
                        return self.parse_chunk_laz(&rest);
                    }
                    self.cursor = header_size as u64;
                    cursor += header_size;
                    self.state = ParseState::SkippingToPointData;
                }

                ParseState::SkippingToPointData => {
                    let header = self.header.as_ref().expect("header parsed");
                    let target = header.point_data_offset as u64;
                    if self.cursor < target {
                        let remaining_to_skip = (target - self.cursor) as usize;
                        let available = buf.len() - cursor;
                        if available < remaining_to_skip {
                            self.cursor += available as u64;
                            cursor += available;
                            self.pending.clear();
                            return Ok(ParseResult { points_added, done: false });
                        }
                        cursor += remaining_to_skip;
                        self.cursor = target;
                    }
                    self.state = ParseState::ReadingPoints;
                }

                ParseState::ReadingPoints => {
                    let header = self.header.as_ref().expect("header parsed");
                    let pdrf = self.pdrf.expect("pdrf set");
                    let record_len = header.point_data_record_length as usize;
                    if record_len == 0 {
                        return Err(LasError::Corrupt(
                            "point_data_record_length is zero".to_string(),
                        ));
                    }

                    // Loop: emit as many full records as available
                    while buf.len() - cursor >= record_len
                        && self.points_emitted < header.number_of_point_records
                    {
                        let rec = &buf[cursor..cursor + record_len];
                        emit_point(
                            rec, pdrf, header,
                            &mut self.positions,
                            &mut self.intensity,
                            &mut self.rgb,
                            &mut self.classification,
                        );
                        cursor += record_len;
                        self.cursor += record_len as u64;
                        self.points_emitted += 1;
                        points_added += 1;
                    }

                    if self.points_emitted >= header.number_of_point_records {
                        self.state = ParseState::Done;
                        self.pending.clear();
                        return Ok(ParseResult { points_added, done: true });
                    }

                    // Partial record remaining — stash and wait
                    self.pending = buf.split_off(cursor);
                    return Ok(ParseResult { points_added, done: false });
                }

                ParseState::BufferingLaz => {
                    // Uopnåelig: `parse_chunk` router LAZ-input til
                    // `parse_chunk_laz` før løkken, og NeedsHeader-grenen
                    // returnerer direkte når headeren viser compression.
                    unreachable!("LAZ-state drives af parse_chunk_laz")
                }

                ParseState::Done => {
                    return Ok(ParseResult { points_added, done: true });
                }
            }
        }
    }
}

impl LasParser {
    /// Driver LAZ-stien: buffer → decoder → batch-vis decode → `emit_point`.
    fn parse_chunk_laz(&mut self, chunk: &[u8]) -> Result<ParseResult, LasError> {
        // Bytes går enten i prefix-bufferen (indtil VLR'en er fundet) eller
        // direkte i decoderen. Ingen af delene kopierer filen to gange.
        match self.laz_decoder.as_mut() {
            Some(decoder) => decoder.push_compressed(chunk),
            None => self.laz_prefix.extend_from_slice(chunk),
        }

        let header = self.header.as_ref().expect("header parsed");

        if self.laz_decoder.is_none() {
            match find_laz_vlr(&self.laz_prefix, header) {
                Ok(vlr) => {
                    let mut decoder = LazDecoder::new(header, &vlr)?;
                    // Hand prefixet videre og slip det: fra nu af ejer
                    // decoderen de komprimerede bytes.
                    decoder.push_compressed(&self.laz_prefix);
                    self.laz_prefix = Vec::new();
                    self.laz_decoder = Some(decoder);
                }
                // VLR-blokken er ikke modtaget endnu — vent på flere bytes.
                Err(LasError::BufferTooSmall) => {
                    return Ok(ParseResult { points_added: 0, done: false });
                }
                Err(e) => return Err(e),
            }
        }

        let decoder = self.laz_decoder.as_mut().expect("decoder sat ovenfor");
        if !decoder.is_ready() {
            return Ok(ParseResult { points_added: 0, done: false });
        }

        // Filen er hel: dekomprimér i batches så en caller kan rapportere
        // progress i stedet for at blokere på hele filen ad gangen.
        let pdrf = self.pdrf.expect("pdrf set");
        let record_len = header.point_data_record_length as usize;
        let mut points_added = 0u32;

        while !decoder.is_done() {
            let batch = decoder.decompress_chunk(decode_batch())?;
            for rec in batch.chunks_exact(record_len) {
                emit_point(
                    rec, pdrf, header,
                    &mut self.positions,
                    &mut self.intensity,
                    &mut self.rgb,
                    &mut self.classification,
                );
                self.points_emitted += 1;
                points_added += 1;
            }
        }

        self.state = ParseState::Done;
        Ok(ParseResult { points_added, done: true })
    }
}

impl Default for LasParser {
    fn default() -> Self { Self::new() }
}

fn read_i32_le(bytes: &[u8], offset: usize) -> i32 {
    i32::from_le_bytes([
        bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3],
    ])
}
fn read_u16_le(bytes: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes([bytes[offset], bytes[offset + 1]])
}

fn emit_point(
    rec: &[u8],
    pdrf: PdrfFormat,
    header: &LasHeader,
    positions: &mut Vec<f32>,
    intensity: &mut Vec<u16>,
    rgb: &mut Vec<u8>,
    classification: &mut Vec<u8>,
) {
    // XYZ: i32 → f64 (scale + offset applied in f64) → f32
    let xi = read_i32_le(rec, 0);
    let yi = read_i32_le(rec, 4);
    let zi = read_i32_le(rec, 8);
    let x = (xi as f64 * header.scale[0] + header.offset[0]) as f32;
    let y = (yi as f64 * header.scale[1] + header.offset[1]) as f32;
    let z = (zi as f64 * header.scale[2] + header.offset[2]) as f32;
    positions.push(x);
    positions.push(y);
    positions.push(z);

    // Intensity (u16 LE) at offset 12
    let i = read_u16_le(rec, pdrf.intensity_offset());
    intensity.push(i);

    // Classification — masking for PDRF 0-5, raw byte for PDRF 6-7
    let class_byte = rec[pdrf.classification_offset()];
    let class = match pdrf {
        PdrfFormat::Format0 | PdrfFormat::Format1 | PdrfFormat::Format2 | PdrfFormat::Format3 => {
            class_byte & 0x1F
        }
        PdrfFormat::Format6 | PdrfFormat::Format7 => class_byte,
    };
    classification.push(class);

    // RGB (3 × u16) — downsample to u8 by taking high byte
    if let Some(rgb_off) = pdrf.rgb_offset() {
        let r = read_u16_le(rec, rgb_off);
        let g = read_u16_le(rec, rgb_off + 2);
        let b = read_u16_le(rec, rgb_off + 4);
        rgb.push((r >> 8) as u8);
        rgb.push((g >> 8) as u8);
        rgb.push((b >> 8) as u8);
    }
}
