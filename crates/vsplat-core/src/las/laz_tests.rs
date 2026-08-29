#[cfg(test)]
mod laz_tests {
    use crate::las::header::{parse_las_header, parse_las_header_allow_compressed, LasError};
    use crate::las::laz::{find_laz_vlr, Decompressor, LazDecoder, LAZ_BACKEND};
    use crate::las::stream_parser::LasParser;

    // ─── Fixtures ───────────────────────────────────────────────────
    //
    // Genereret med `tests/fixtures/generate_fixtures.py` via laspy med
    // **LASzip C++ backend** — altså referenceimplementationen, ikke laz-rs.
    // Vores decoder er laz-rs. At komprimere med den ene og dekomprimere med
    // den anden gør T2 til en ægte kryds-implementeringstest, ikke en
    // round-trip gennem ét bibliotek.

    const PDRF3_V12_LAS: &[u8] =
        include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/pdrf3_v12.las"));
    const PDRF3_V12_LAZ: &[u8] =
        include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/pdrf3_v12.laz"));
    const PDRF6_V14_LAS: &[u8] =
        include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/pdrf6_v14.las"));
    const PDRF6_V14_LAZ: &[u8] =
        include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/pdrf6_v14.laz"));
    /// 120 000 points → 3 chunks à LASzip's default chunk_size på 50 000.
    /// Kun .laz er checket ind; den ukomprimerede reference ville være 2,4 MB,
    /// og generatorens formel (X=i, Y=2i, Z=3i, intensity=i%65536, class=i%32)
    /// lader os asserte eksakte værdier i stedet.
    const MULTICHUNK_LAZ: &[u8] = include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/pdrf0_v12_multichunk.laz"
    ));

    /// Kør en hel fil gennem LasParser i chunks af `chunk_size` bytes.
    /// Returnerer (parser, samlet antal points_added, done-flag ved sidste kald).
    fn parse_whole(bytes: &[u8], chunk_size: usize) -> (LasParser, u32, bool) {
        let mut parser = LasParser::new();
        let mut total = 0u32;
        let mut done = false;
        for chunk in bytes.chunks(chunk_size) {
            let r = parser.parse_chunk(chunk).expect("chunk parses");
            total += r.points_added;
            done = r.done;
        }
        (parser, total, done)
    }

    // ─── T1: laz_decoder_recognizes_compressed_input ────────────────

    #[test]
    fn t1_laz_decoder_recognizes_compressed_input() {
        // Given: en LAZ-fil (point_data_format har high bit sat)
        // Then: Ward 21's kontrakt er urørt — parse_las_header afviser stadig
        assert_eq!(
            parse_las_header(PDRF3_V12_LAZ).unwrap_err(),
            LasError::LazCompressed,
            "LasError::LazCompressed er Ward 21's kontrakt og må ikke ændres"
        );

        // When: vi parser med den LAZ-tolerante indgang
        let header = parse_las_header_allow_compressed(PDRF3_V12_LAZ)
            .expect("LAZ-header skal kunne parses når compression accepteres");

        // Then: filen er markeret komprimeret, og format-ID'et er maskeret rent
        assert!(header.compressed, "high bit (0x80) skal give compressed = true");
        assert_eq!(header.point_data_format, 3, "0x83 & 0x3F == 3");
        assert_eq!(header.point_data_record_length, 34);
        assert_eq!(header.number_of_point_records, 1000);

        // And: den ukomprimerede søsterfil er ikke markeret komprimeret
        let plain = parse_las_header_allow_compressed(PDRF3_V12_LAS).expect("LAS parses");
        assert!(!plain.compressed);
        assert_eq!(plain.point_data_format, 3);

        // And: en LAS 1.4 / PDRF 6 LAZ-fil detekteres på samme måde
        let v14 = parse_las_header_allow_compressed(PDRF6_V14_LAZ).expect("v1.4 LAZ parses");
        assert!(v14.compressed);
        assert_eq!(v14.point_data_format, 6, "0x86 & 0x3F == 6");
        assert_eq!(v14.version_minor, 4);
    }

    // ─── T2: laz_decoded_output_matches_uncompressed_reference ──────

    #[test]
    fn t2_laz_decoded_output_matches_uncompressed_reference() {
        // Kanon-par: samme punktdata, én ukomprimeret og én LASzip-komprimeret.
        for (name, las, laz) in [
            ("pdrf3_v12", PDRF3_V12_LAS, PDRF3_V12_LAZ),
            ("pdrf6_v14", PDRF6_V14_LAS, PDRF6_V14_LAZ),
        ] {
            // When: begge køres gennem den samme parser-indgang
            let (reference, ref_points, ref_done) = parse_whole(las, 4096);
            let (decoded, laz_points, laz_done) = parse_whole(laz, 4096);

            // Then: LAZ-stien producerer præcis samme SoA-buffers som LAS-stien
            assert!(ref_done && laz_done, "{name}: begge filer skal nå done");
            assert_eq!(ref_points, 1000, "{name}: reference point count");
            assert_eq!(laz_points, ref_points, "{name}: samme antal points");
            assert_eq!(
                decoded.positions(),
                reference.positions(),
                "{name}: positions skal være bit-identiske med den ukomprimerede reference"
            );
            assert_eq!(decoded.intensity(), reference.intensity(), "{name}: intensity");
            assert_eq!(decoded.rgb(), reference.rgb(), "{name}: rgb");
            assert_eq!(
                decoded.classification(),
                reference.classification(),
                "{name}: classification"
            );
        }
    }

    // ─── T3: laz_vlr_chunk_table_parsed ─────────────────────────────

    #[test]
    fn t3_laz_vlr_chunk_table_parsed() {
        // Given: en LAZ-fil med præcis én VLR ("laszip encoded", record_id 22204)
        let header = parse_las_header_allow_compressed(PDRF3_V12_LAZ).expect("header");

        // When: vi lokaliserer laszip-VLR'en
        let vlr = find_laz_vlr(PDRF3_V12_LAZ, &header).expect("laszip VLR skal findes");

        // Then: chunk-parametrene er læst fra VLR-payloaden
        assert_eq!(vlr.chunk_size, 50_000, "LASzip default chunk size");
        assert_eq!(vlr.items_size, 34, "items_size skal matche PDRF 3 record length");
        assert!(!vlr.variable_size_chunks, "fixed-size chunks i denne fixture");

        // And: point-data starter efter VLR-blokken
        assert_eq!(
            vlr.point_data_offset, header.point_data_offset as usize,
            "point_data_offset skal stemme med headerens felt"
        );

        // And: en fil uden laszip-VLR afvises eksplicit i stedet for at parse skrald
        let err = find_laz_vlr(PDRF3_V12_LAS, &parse_las_header(PDRF3_V12_LAS).unwrap())
            .expect_err("ukomprimeret fil har ingen laszip-VLR");
        assert_eq!(err, LasError::MissingLazVlr);
    }

    // ─── T4: streaming_laz_chunks_partial_decode ────────────────────

    #[test]
    fn t4_streaming_laz_chunks_partial_decode() {
        // Given: en LAZ-fil på 120 000 points fordelt over 3 LAZ-chunks,
        // fodret i små byte-chunks der ikke flugter med nogen intern grænse.
        let (parser, total, done) = parse_whole(MULTICHUNK_LAZ, 8192);

        // Then: alle points kommer ud, og parseren melder done præcis én gang til sidst
        assert!(done, "sidste chunk skal give done = true");
        assert_eq!(total, 120_000, "points_added skal summere til hele filen");
        assert_eq!(parser.positions().len(), 120_000 * 3);

        // And: værdier er korrekte HEN OVER LAZ-chunk-grænserne (50 000 / 100 000),
        // ikke bare i den første chunk. Formel: X=i, Y=2i, Z=3i (scale 0.01, offset
        // [1000, 2000, 30]), intensity = i % 65536, class = i % 32.
        let pos = parser.positions();
        let intensity = parser.intensity();
        let class = parser.classification();
        for i in [0usize, 49_999, 50_000, 99_999, 100_000, 119_999] {
            let expect = |v: i64, scale: f64, offset: f64| (v as f64 * scale + offset) as f32;
            assert_eq!(pos[i * 3], expect(i as i64, 0.01, 1000.0), "x @ {i}");
            assert_eq!(pos[i * 3 + 1], expect(2 * i as i64, 0.01, 2000.0), "y @ {i}");
            assert_eq!(pos[i * 3 + 2], expect(3 * i as i64, 0.01, 30.0), "z @ {i}");
            assert_eq!(intensity[i], (i % 65536) as u16, "intensity @ {i}");
            assert_eq!(class[i], (i % 32) as u8, "classification @ {i}");
        }

        // And: dekomprimering sker i batches, så en caller kan rapportere progress
        // i stedet for at blokere på hele filen ad gangen.
        let header = parse_las_header_allow_compressed(MULTICHUNK_LAZ).expect("header");
        let vlr = find_laz_vlr(MULTICHUNK_LAZ, &header).expect("vlr");
        let mut decoder = LazDecoder::new(&header, &vlr).expect("decoder");
        decoder.push_compressed(MULTICHUNK_LAZ);
        let first = decoder.decompress_chunk(1000).expect("første batch");
        assert_eq!(
            first.len(),
            1000 * header.point_data_record_length as usize,
            "decompress_chunk skal levere præcis det ønskede antal records"
        );
        assert!(!decoder.is_done(), "119 000 points mangler stadig");
        assert_eq!(decoder.points_remaining(), 119_000);
    }

    // ─── T5: laz_fallback_strategy_chosen ───────────────────────────

    #[test]
    fn t5_laz_fallback_strategy_chosen() {
        // Dokumenterer hvilken af spec'ens tre strategier vi valgte.
        //
        // Strategi #1 (laz-rs crate på wasm32-unknown-unknown) blev valgt:
        // spike'en viste at `laz 0.13` med default-features = false bygger rent
        // til wasm32-unknown-unknown og kun trækker byteorder + num-traits ind
        // — ingen WASI, ingen rayon. Strategi #2 (manuel port) og #3 (laz-perf
        // i JS) er dermed ikke i brug; #3 ville desuden bryde single-source-of-truth.
        assert_eq!(
            LAZ_BACKEND, "laz-rs",
            "decoderen skal være Rust-native; JS-side laz-perf var sidste udvej"
        );

        // Og decoderen skal kunne konstrueres og køre uden nogen JS-hjælp:
        // hele stien fra komprimerede bytes til SoA-buffers lever i Rust.
        let header = parse_las_header_allow_compressed(PDRF3_V12_LAZ).expect("header");
        let vlr = find_laz_vlr(PDRF3_V12_LAZ, &header).expect("vlr");
        let mut decoder = LazDecoder::new(&header, &vlr).expect("decoder");
        decoder.push_compressed(PDRF3_V12_LAZ);
        let records = decoder.decompress_chunk(1000).expect("decode");
        assert_eq!(records.len(), 1000 * 34);
        assert!(decoder.is_done());
        assert_eq!(decoder.points_remaining(), 0);

        // Og outputtet er rå LAS point records — byte-identiske med den
        // ukomprimerede fil fra samme punktdata.
        let plain = parse_las_header(PDRF3_V12_LAS).expect("las header");
        let start = plain.point_data_offset as usize;
        assert_eq!(
            records,
            PDRF3_V12_LAS[start..start + 1000 * 34],
            "decoded records skal matche den ukomprimerede fils point-data byte for byte"
        );
    }
}
