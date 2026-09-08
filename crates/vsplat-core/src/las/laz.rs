//! Ward 025: LAZ (compressed LAS) decompression.
//!
//! Decoderen er `laz-rs` (crate `laz`), bygget uden default-features. Den
//! linker rent til `wasm32-unknown-unknown` og trækker kun `byteorder` +
//! `num-traits` med — ingen WASI, ingen rayon. Spec'ens strategi #2 (manuel
//! port) og #3 (`laz-perf` i JS) er derfor ikke i brug; hele vejen fra
//! komprimerede bytes til SoA-buffers lever i Rust.
//!
//! ## Hvorfor vi buffrer hele den komprimerede fil
//!
//! LAZ' chunk-table-offset er en **absolut** filoffset, og
//! `LasZipDecompressor` seeker til den ved konstruktion. Decoderen kan derfor
//! ikke fodres med et glidende vindue af filen. Dertil har `laz-rs` ingen
//! rollback hvis en decode rammer EOF midt i et punkt, så byte-granulær
//! streaming ville kræve chunk-checkpoints (umuligt med decoderens opake
//! state) eller gen-decode fra filstart (O(n²)).
//!
//! Vi buffrer i stedet de komprimerede bytes — LAZ fylder typisk 10-20 % af
//! den tilsvarende LAS-fil — og dekomprimerer i batches, så en caller kan
//! rapportere progress uden at blokere på hele filen ad gangen.

use std::io::{Cursor, Seek, SeekFrom};

use laz::laszip::{LasZipDecompressor, LazVlr};

use crate::las::header::{LasError, LasHeader};

/// Hvilken decoder-strategi Ward 25 landede på. Læses af T5.
pub const LAZ_BACKEND: &str = "laz-rs";

/// VLR-header-størrelse i LAS: reserved(2) + user_id(16) + record_id(2)
/// + record_length_after_header(2) + description(32).
const VLR_HEADER_SIZE: usize = 54;
const LASZIP_USER_ID: &[u8] = b"laszip encoded";
const LASZIP_RECORD_ID: u16 = 22204;

/// Antal punkter vi dekomprimerer per batch når `LasParser` driver decoderen.
/// Matcher LASzip's default chunk size, så vi typisk rammer chunk-grænserne.
const DECODE_BATCH: usize = 50_000;

/// Parametrene fra filens "laszip encoded" VLR.
#[derive(Debug, Clone)]
pub struct LazVlrInfo {
    /// Antal punkter per LAZ-chunk (LASzip default: 50 000).
    pub chunk_size: u32,
    /// Størrelsen af ét dekomprimeret point record, i bytes.
    pub items_size: u64,
    /// True for LAZ 1.4's variable-size chunks, hvor chunk-tabellen er påkrævet.
    pub variable_size_chunks: bool,
    /// Hvor punktdataen begynder — samme som headerens felt, gentaget her så
    /// decoderen kan seeke uden at bære headeren med rundt.
    pub point_data_offset: usize,
    /// Rå VLR-payload, så `LazVlr` kan genskabes uden at re-scanne filen.
    payload: Vec<u8>,
}

fn read_u16(bytes: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes([bytes[offset], bytes[offset + 1]])
}

/// Find og parse filens "laszip encoded" VLR (record_id 22204).
///
/// `file` skal indeholde bytes fra offset 0 til og med VLR-blokken.
pub fn find_laz_vlr(file: &[u8], header: &LasHeader) -> Result<LazVlrInfo, LasError> {
    let mut offset = header.header_size as usize;

    for _ in 0..header.num_vlrs {
        if file.len() < offset + VLR_HEADER_SIZE {
            return Err(LasError::BufferTooSmall);
        }
        let user_id = &file[offset + 2..offset + 18];
        let record_id = read_u16(file, offset + 18);
        let payload_len = read_u16(file, offset + 20) as usize;
        let payload_start = offset + VLR_HEADER_SIZE;

        // user_id er null-padded til 16 bytes
        let user_id_trimmed: &[u8] = match user_id.iter().position(|&b| b == 0) {
            Some(end) => &user_id[..end],
            None => user_id,
        };

        if user_id_trimmed == LASZIP_USER_ID && record_id == LASZIP_RECORD_ID {
            if file.len() < payload_start + payload_len {
                return Err(LasError::BufferTooSmall);
            }
            let payload = file[payload_start..payload_start + payload_len].to_vec();
            let vlr = LazVlr::from_buffer(&payload)
                .map_err(|e| LasError::LazDecode(format!("laszip VLR: {e}")))?;
            return Ok(LazVlrInfo {
                chunk_size: vlr.chunk_size(),
                items_size: vlr.items_size(),
                variable_size_chunks: vlr.uses_variable_size_chunks(),
                point_data_offset: header.point_data_offset as usize,
                payload,
            });
        }
        offset = payload_start + payload_len;
    }

    Err(LasError::MissingLazVlr)
}

/// Konsumerer komprimerede bytes og leverer rå LAS point records.
pub trait Decompressor {
    /// Fodrer komprimerede bytes i filrækkefølge, startende ved filens byte 0.
    /// Alle bytes skal være pushet før første `decompress_chunk`.
    fn push_compressed(&mut self, bytes: &[u8]);

    /// Dekomprimerer op til `max_points` records og returnerer dem som rå
    /// LAS point-record-bytes — præcis som de ville ligge i en ukomprimeret fil.
    fn decompress_chunk(&mut self, max_points: usize) -> Result<Vec<u8>, LasError>;

    /// Punkter der endnu ikke er dekomprimeret.
    fn points_remaining(&self) -> u64;

    /// True når hele filen er dekomprimeret.
    fn is_done(&self) -> bool;
}

/// `laz-rs`-baseret decoder.
pub struct LazDecoder {
    /// Komprimerede bytes indtil decoderen konstrueres; derefter tom (Vec'en
    /// flyttes ind i decoderens `Cursor` uden kopi).
    buffer: Vec<u8>,
    vlr_payload: Vec<u8>,
    point_data_offset: usize,
    record_len: usize,
    total_points: u64,
    decoded_points: u64,
    decompressor: Option<LasZipDecompressor<'static, Cursor<Vec<u8>>>>,
}

impl LazDecoder {
    pub fn new(header: &LasHeader, vlr: &LazVlrInfo) -> Result<Self, LasError> {
        let record_len = header.point_data_record_length as usize;
        if record_len == 0 {
            return Err(LasError::Corrupt("point_data_record_length is zero".to_string()));
        }
        if vlr.items_size as usize != record_len {
            return Err(LasError::LazDecode(format!(
                "laszip VLR items_size {} matcher ikke headerens record length {}",
                vlr.items_size, record_len
            )));
        }
        Ok(Self {
            buffer: Vec::new(),
            vlr_payload: vlr.payload.clone(),
            point_data_offset: vlr.point_data_offset,
            record_len,
            total_points: header.number_of_point_records,
            decoded_points: 0,
            decompressor: None,
        })
    }

    /// Antal komprimerede bytes vi har modtaget indtil videre.
    pub fn buffered_len(&self) -> usize {
        self.buffer.len()
    }

    fn parse_vlr(&self) -> Result<LazVlr, LasError> {
        LazVlr::from_buffer(&self.vlr_payload)
            .map_err(|e| LasError::LazDecode(format!("laszip VLR: {e}")))
    }

    /// Er der modtaget bytes nok til at dekomprimering kan begynde?
    ///
    /// Probet er ikke-destruktivt: vi konstruerer en decoder over et *lån* af
    /// bufferen. Konstruktionen læser chunk-tabellen, som ligger sidst i filen,
    /// så den lykkes først når filen reelt er hel. Lykkes den, smider vi probet
    /// væk og bygger den rigtige decoder over den flyttede Vec.
    pub fn is_ready(&self) -> bool {
        if self.decompressor.is_some() {
            return true;
        }
        if self.buffer.len() <= self.point_data_offset {
            return false;
        }
        let Ok(vlr) = self.parse_vlr() else { return false };
        let mut cursor = Cursor::new(&self.buffer[..]);
        if cursor.seek(SeekFrom::Start(self.point_data_offset as u64)).is_err() {
            return false;
        }
        LasZipDecompressor::new(cursor, vlr).is_ok()
    }

    fn ensure_decompressor(&mut self) -> Result<(), LasError> {
        if self.decompressor.is_some() {
            return Ok(());
        }
        let vlr = self.parse_vlr()?;
        let bytes = std::mem::take(&mut self.buffer);
        if bytes.len() <= self.point_data_offset {
            return Err(LasError::LazDecode(
                "komprimeret punktdata mangler — kun header/VLR modtaget".to_string(),
            ));
        }
        let mut cursor = Cursor::new(bytes);
        cursor
            .seek(SeekFrom::Start(self.point_data_offset as u64))
            .map_err(|e| LasError::LazDecode(format!("seek til point data: {e}")))?;
        let decompressor = LasZipDecompressor::new(cursor, vlr)
            .map_err(|e| LasError::LazDecode(format!("{e}")))?;
        self.decompressor = Some(decompressor);
        Ok(())
    }
}

impl Decompressor for LazDecoder {
    fn push_compressed(&mut self, bytes: &[u8]) {
        self.buffer.extend_from_slice(bytes);
    }

    fn decompress_chunk(&mut self, max_points: usize) -> Result<Vec<u8>, LasError> {
        self.ensure_decompressor()?;
        let remaining = self.points_remaining() as usize;
        let count = max_points.min(remaining);
        if count == 0 {
            return Ok(Vec::new());
        }
        let mut out = vec![0u8; count * self.record_len];
        let decompressor = self.decompressor.as_mut().expect("decompressor bygget ovenfor");
        decompressor
            .decompress_many(&mut out)
            .map_err(|e| LasError::LazDecode(format!("{e}")))?;
        self.decoded_points += count as u64;
        Ok(out)
    }

    fn points_remaining(&self) -> u64 {
        self.total_points.saturating_sub(self.decoded_points)
    }

    fn is_done(&self) -> bool {
        self.decoded_points >= self.total_points
    }
}

/// Batch-størrelsen `LasParser` bruger når den driver decoderen.
pub(crate) const fn decode_batch() -> usize {
    DECODE_BATCH
}
