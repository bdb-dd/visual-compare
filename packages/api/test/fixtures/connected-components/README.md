# Connected-components fixtures

These files are real or representative samples of what ImageMagick 7 emits for:

```
magick diff.png -threshold 1% \
  -define connected-components:format=json \
  -define connected-components:verbose=true \
  -connected-components 8 null:
```

(and the text variant, omitting `format=json`).

The parser is locked down with snapshot tests in
`test/connected-components.test.ts`. To refresh fixtures against the pinned
ImageMagick version, regenerate them from real diff images and rerun the
snapshot tests.

## Files

- `simple.json` — two distinct regions, JSON format, one region wraps in a
  string geometry, the other in an object geometry. Exercises both shapes.
- `simple.txt` — the same two regions in verbose text form.
- `wrapper.json` — IM-style wrapper with `image["connected components"]`
  containing the regions array.
- `noise.json` — many single-pixel regions plus one large background region;
  the parser should drop both.
- `empty.json` — `[]` (no regions reported).
