/// Ward 021: LAS/LAZ Stream Ingestion.
///
/// LAS (ASPRS LIDAR data exchange format) header + streaming point-record parser.
/// LAZ (compressed LAS) er ikke i scope for dette modul — vurderes til Ward 25.

mod header;
mod stream_parser;
#[cfg(test)]
mod tests;

pub use header::{LasError, LasHeader, parse_las_header};
pub use stream_parser::{LasParser, ParseResult, PdrfFormat};
