#!/usr/bin/env python3
"""Ward 025 — LAZ test fixture generator.

Fixtures are generated with laspy backed by the **LASzip C++ backend**
(`pip install laspy laszip`), i.e. the original reference implementation.
Our decoder is `laz-rs`. Compressing with one implementation and decompressing
with the other makes T2 a genuine cross-implementation check rather than a
round-trip through a single library.

Regenerate:
    pip install laspy laszip
    python3 crates/vsplat-core/tests/fixtures/generate_fixtures.py

All point values are deterministic functions of the point index i, so Rust
tests can assert expected values without shipping a large uncompressed
reference file (see MULTICHUNK below).
"""
import pathlib
import numpy as np
import laspy

OUT = pathlib.Path(__file__).parent
SCALE = [0.01, 0.01, 0.01]
OFFSET = [1000.0, 2000.0, 30.0]

assert laspy.LazBackend.Laszip.is_available(), "install `laszip` (C++ backend)"
assert not laspy.LazBackend.LazrsParallel.is_available(), \
    "lazrs backend present — fixtures would no longer be independent of laz-rs"


def new_header(version, pdrf):
    h = laspy.LasHeader(version=version, point_format=pdrf)
    h.scales = np.array(SCALE)
    h.offsets = np.array(OFFSET)
    return h


def write(las, stem):
    las.write(OUT / f"{stem}.las")
    las.write(OUT / f"{stem}.laz", laz_backend=laspy.LazBackend.Laszip)


# ── pdrf3_v12: LAS 1.2 / PDRF 3 (xyz + gps + rgb), 1 000 points ──────────────
# X=7i  Y=11i  Z=13i  intensity=(3i)%65536  class=i%32
# red=i%65536  green=(2i)%65536  blue=(3i)%65536  gps_time=0.5i
n = 1000
i = np.arange(n, dtype=np.int64)
las = laspy.LasData(new_header("1.2", 3))
las.X, las.Y, las.Z = i * 7, i * 11, i * 13
las.intensity = (i * 3) % 65536
las.classification = i % 32
las.red, las.green, las.blue = i % 65536, (i * 2) % 65536, (i * 3) % 65536
las.gps_time = i * 0.5
write(las, "pdrf3_v12")

# ── pdrf6_v14: LAS 1.4 / PDRF 6 — exercises the layered-chunked LAZ 1.4 path ─
# X=5i  Y=9i  Z=17i  intensity=(7i)%65536  class=i%256 (full byte in PDRF 6+)
las = laspy.LasData(new_header("1.4", 6))
las.X, las.Y, las.Z = i * 5, i * 9, i * 17
las.intensity = (i * 7) % 65536
las.classification = i % 256
write(las, "pdrf6_v14")

# ── pdrf0_v12_multichunk: 120 000 points → 3 chunks at LASzip's 50 000 default
# X=i  Y=2i  Z=3i  intensity=i%65536  class=i%32
# Only the .laz is checked in; the uncompressed reference would be 2.4 MB and
# the formula above lets Rust assert exact values instead.
n = 120_000
i = np.arange(n, dtype=np.int64)
las = laspy.LasData(new_header("1.2", 0))
las.X, las.Y, las.Z = i, i * 2, i * 3
las.intensity = i % 65536
las.classification = i % 32
las.write(OUT / "pdrf0_v12_multichunk.laz", laz_backend=laspy.LazBackend.Laszip)

for f in sorted(OUT.glob("*.la[sz]")):
    print(f"{f.name:34} {f.stat().st_size:>9,} bytes")
