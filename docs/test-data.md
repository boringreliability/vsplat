# Test-data: åbne LAZ-filer

Kilder til rigtige LiDAR-filer til Ward 23's og Ward 25/26's visual verification.
Alle filer nedenfor er **verificeret mod vsplat's egen parser** (`LasParser::parse_chunk`,
native release-build), ikke bare mod laspy — tallene i tabellen er vores egne.

## Verificerede filer

| Fil | Størrelse | Punkter | Format | Parse (native) | Godt til |
|-----|-----------|---------|--------|----------------|----------|
| `sf_root.laz` | 146 KB | 11 056 | LAS 1.2 / PDRF 1 | 8 ms | Hurtig smoke — renderes der overhovedet noget? |
| `20170422_0071_usgs.copc.laz` | 9,3 MB | 1 560 330 | LAS 1.4 / PDRF 6 (COPC) | 829 ms | Intensity- og classification-ramper på ægte data |
| `20170422_0136_usgs.copc.laz` | 94 MB | 13 520 378 | LAS 1.4 / PDRF 6 (COPC) | 6 578 ms | Skala: memory-gaten, batching, framerate |

### URL'er

```
# SF-oversigt (Entwine root node — hele San Francisco, kraftigt udtyndet)
https://s3-us-west-2.amazonaws.com/usgs-lidar-public/CA_SanFrancisco_1_B23/ept-data/0-0-0-0.laz

# NOAA kystscanning, 1,5M punkter
https://noaa-nos-coastal-lidar-pds.s3.amazonaws.com/laz/geoid18/10005/20170422_0071_usgs.copc.laz

# NOAA kystscanning, 13,5M punkter
https://noaa-nos-coastal-lidar-pds.s3.amazonaws.com/laz/geoid18/10005/20170422_0136_usgs.copc.laz
```

## Hvad de indeholder

**NOAA-filerne** har rig klassifikation — ground (2), low vegetation (1), high vegetation (5),
building (6) og water (9) er alle rigeligt repræsenteret i 1,5M-filen. Det gør dem velegnede til
`MODE_CLASSIFICATION`. Intensity spænder 4–65521, altså hele u16-området, så Viridis/Inferno
har noget at arbejde med.

**SF-roden** er Entwine-hierarkiets øverste node: en udtyndet oversigt over hele datasættet
(13 milliarder punkter i alt). Dybere noder ligger under samme `ept-data/`-sti med nøgler som
`5-19-21-15.laz` — hierarkiet står i `ept-hierarchy/0-0-0-0.json`. Hver node er en selvstændig,
gyldig LAZ-fil, så de kan droppes direkte.

**Ingen af dem har RGB.** Til `MODE_RGB_DIRECT` findes kun repoets egen fixture
(`crates/vsplat-core/tests/fixtures/pdrf3_v12.laz`, 1000 punkter). En rigtig RGB-farvet
LiDAR-fil mangler stadig i test-sættet.

## To ting værd at vide

**COPC virker.** NOAA-filerne er Cloud Optimized Point Clouds — LAZ 1.4 med et ekstra VLR og
en anden chunk-organisering end almindelige LAZ-filer. Ward 25's decoder håndterer dem
transparent, uden at kende til COPC. Det var ikke givet på forhånd.

**13,5M punkter tager 6,6 s at parse native.** Wasm ligger typisk 1,2–2× derover, så Ward 23's
V1-budget ("visible first frame < 5 s") holder næppe for en fil af den størrelse. Dekomprimeringen
dominerer — se Ward 25's Gold Result: LAZ-decode kører ~1,9 Mpts/s mod LAS-parsens 26 Mpts/s.

## Andre kilder

Disse er ægte og velkendte, men **ikke verificeret her**, fordi udviklingsmiljøets netværkspolitik
blokerer dem:

- **OpenTopography** (`opentopography.org`) — bredeste udvalg, kræver gratis API-nøgle til bulk
- **USGS 3DEP via rockyweb** (`rockyweb.usgs.gov`) — de fulde LPC-tiles; bemærk at USGS'
  offentlige S3-mirror (`prd-tnm`) kun indeholder metadata og browse-billeder for de projekter
  vi kiggede på, ikke selve LAZ-filerne
- **Dataforsyningen** (`dataforsyningen.dk`) — Danmarks Højdemodel / Punktsky, kræver gratis
  brugerregistrering. Nærmeste ting til lokale data.

AWS-buckets (`*.amazonaws.com`) slipper igennem policyen; det er derfor de to kilder ovenfor
blev valgt.
