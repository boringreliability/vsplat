/// Ward 021: LAS/LAZ Stream Ingestion.
///
/// LAS (ASPRS LIDAR data exchange format) header + streaming point-record parser.
/// LAZ (compressed LAS) decode tilføjes i Ward 25 via `laz`-modulet.

mod header;
pub mod laz;
mod stream_parser;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod laz_tests;

pub use header::{LasError, LasHeader, parse_las_header, parse_las_header_allow_compressed};
pub use laz::{find_laz_vlr, Decompressor, LazDecoder, LazVlrInfo, LAZ_BACKEND};
pub use stream_parser::{LasParser, ParseResult, PdrfFormat};
