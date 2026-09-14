# Chip-nets fixture models

Two velxio custom chips (SX1262 and KQ-130F models by Martin Thuku), plus the functional
self test that drives them. They are here because they exercise the parts of
the ESP32 custom-chip runtime that nothing else in this repository does: a
pin wired only to another chip's pin, and a chip UART that is not UART0.

| Path | What it is |
|---|---|
| `sx1262/chip.c`, `chip.json`, `chip.wasm` | SX1262 model: SPI slave plus a synthetic `ANT` pin |
| `kq130f/chip.c`, `chip.json`, `chip.wasm` | KQ-130F model: 9600 8N1 UART plus a synthetic `LINE` pin |
| `chip_selftest.py` | 15 behavioural cases, run by hand inside a container |

Both models carry a Manchester-coded, self-clocked bit stream on the synthetic
pin: `ANT` is the air, `LINE` is the mains. Every chip wired to the same net
hears everything on it, collisions included, and a collision shows up as a
failed CRC rather than as anything cleverer.

The `.wasm` files were compiled by velxio's own `POST /api/compile-chip/`
route, which is why they are checked in: the tests load them directly rather
than needing a wasi-sdk on the machine running pytest.

`chip_selftest.py` is not collected by pytest. It is the standalone harness the
models were developed against, kept here as the reference for what the chips
are supposed to do; `test/backend/unit/test_chip_nets.py` and
`test_chip_uart_binding.py` are the pytest cases. To run the self test against
a container:

    docker cp test/fixtures/chip-nets/chip_selftest.py velxio:/tmp/
    docker cp test/fixtures/chip-nets/sx1262/chip.wasm velxio:/tmp/sx1262.wasm
    docker cp test/fixtures/chip-nets/kq130f/chip.wasm velxio:/tmp/kq130f.wasm
    docker exec velxio python3 /tmp/chip_selftest.py

## Licence

These chip models and the self test are MIT, copyright Martin Thuku, and are
vendored here with that licence intact: see `LICENSE` in this directory. The
rest of velxio is AGPLv3 (or the commercial licence); MIT is compatible with
both, so nothing in this directory changes the terms the surrounding project
ships under.
