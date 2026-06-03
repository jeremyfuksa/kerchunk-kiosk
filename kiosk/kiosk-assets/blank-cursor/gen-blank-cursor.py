#!/usr/bin/env python3
"""Generate a fully-transparent XCursor file ("blank" theme).

The kiosk runs cage (Wayland) + Chromium. CSS `cursor: none` only hides the
cursor *inside web content* — cage draws its own compositor pointer on top
(visible on the kiosk even with no mouse, because the HDMI-CEC link makes the
display register as a pointer device). cage 0.2.0 has no hide-cursor flag, so
we point XCURSOR_THEME at this blank theme and cage renders an invisible cursor.

This writes a single 1x1 fully-transparent image as the "left_ptr" cursor. The
XCursor binary format (see man xcursor / libXcursor) is:

  Header:  magic "Xcur", header size (16), version (1.0 => 0x00010000),
           ntoc (number of table-of-contents entries)
  TOC:     per chunk: type, subtype, position (byte offset of the chunk)
  Image chunk: header(36) | type(0xfffd0002) | subtype(=nominal size) |
               version(1) | width | height | xhot | yhot | delay |
               then width*height ARGB pixels (little-endian, premultiplied)

We avoid xcursorgen (not installed on the Pi) by writing the bytes directly,
so the cursor is reproducible from source. Run: python3 gen-blank-cursor.py
"""
import struct
import sys
from pathlib import Path

IMAGE_TYPE = 0xFFFD0002
SIZE = 1  # 1x1 image; nominal cursor size also 1


def build_blank_cursor() -> bytes:
    # One TOC entry pointing at one image chunk.
    header_size = 16
    ntoc = 1
    toc_entry_size = 12
    file_header = struct.pack("<4sIII", b"Xcur", header_size, 0x00010000, ntoc)

    image_chunk_pos = header_size + ntoc * toc_entry_size
    toc = struct.pack("<III", IMAGE_TYPE, SIZE, image_chunk_pos)

    # Image chunk: 36-byte chunk header (incl. type/subtype/version) + pixels.
    chunk_header_size = 36
    width = height = SIZE
    xhot = yhot = 0
    delay = 0
    pixels = struct.pack("<I", 0x00000000)  # fully transparent ARGB
    image_chunk = struct.pack(
        "<IIIIIIIII",
        chunk_header_size,
        IMAGE_TYPE,
        SIZE,          # subtype = nominal size
        1,             # version
        width,
        height,
        xhot,
        yhot,
        delay,
    ) + pixels

    return file_header + toc + image_chunk


def main() -> int:
    out_dir = Path(__file__).parent / "cursors"
    out_dir.mkdir(parents=True, exist_ok=True)
    blank = build_blank_cursor()
    # left_ptr is the default arrow; write the blank bytes there.
    (out_dir / "left_ptr").write_bytes(blank)
    print(f"wrote {out_dir / 'left_ptr'} ({len(blank)} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
