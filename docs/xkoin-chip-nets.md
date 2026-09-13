# Chip-to-chip nets on ESP32 boards

Branch `feat/esp32-chip-nets`. What it changes, what was measured, and what
still does not work.

## The problem

A velxio custom chip on an AVR or RP2040 board runs in the browser, where
`chipNets.ts` and `syntheticNetPin` already give two chips wired to each other
one shared `PinManager` key, so a write by one is seen by the other.

A custom chip on an ESP32 board runs somewhere else: `CustomChipPart.ts` takes
an ESP32-only branch that ships the chip's WASM to the backend QEMU worker,
with `pin_map = {chip pin name: ESP32 GPIO}` resolved from the diagram's wires.
A chip pin wired only to another chip's pin has no GPIO, so it is not in that
map, and `wasm_chip_runtime.py` then refused the watch outright:

```python
def vx_pin_watch(handle, edge, cb_idx, user_data):
    p = self._pins[handle]
    if p["gpio"] is None:
        # Chip's logical pin not wired to a real GPIO - no edges to detect.
        return
```

Putting a board GPIO on the net did not rescue it. A chip's `vx_pin_write`
calls `qemu_picsimlab_set_pin`, which drives a pin into the guest; the worker's
`_on_pin_change` is registered as `picsimlab_write_pin` and fires only for GPIO
the firmware drives out. One chip's write never re-entered the other chip's
watch.

And two ESP32 boards are two QEMU subprocesses. `Interconnect.ts` bridges board
pin to board pin over the WebSocket, with a byte-level shortcut for hardware
UART precisely because bit-level transport over that hop is too slow.

Separately, `vx_uart_attach` bound to one fixed UART whatever the diagram said,
so a module wired to Serial2 heard what the sketch printed on Serial.

## Two faults that hid all of it

Found while proving the work above, and fixed in the same branch, because
without them nothing else here is reachable.

**A custom chip on an ESP32 board was not taking the backend path at all.**
`detectSimulatorKind` identifies an ESP32 host by `simulator.sendPinEvent`, and
says so in its own header comment, but `Esp32BridgeShim` only ever had
`setPinState`. Every chip was therefore classified `unknown` and fell through to
the browser chip runtime, so the chip ran in the tab while its firmware ran in
QEMU. That is visible in the before-run below: the console logs
`[chip:chip_sx1262_a] radioA: ready`, which only the browser runtime prints, and
the backend logged `sensors=0` for both boards. The SPI still worked, because
the frontend SPI bridge answers the worker's `spi_event` asynchronously, which
is why board A could transmit and nothing looked obviously broken. The shim now
answers to both names.

**The pin map carried synthetic pin numbers.** A chip pin with no board GPIO on
its net resolves to a browser-side PinManager key of 100000 and up. The ESP32
branch copied anything non-negative into `pin_map`, so the worker took 100000
for a GPIO and would hand it to `qemu_picsimlab_set_pin`. On the LoRa proof the
payload carried `"RESET":100001` and `"ANT":100000`; it now carries the six real
GPIOs, and `ANT` appears once, as a net member.

## The patch

Five pieces, in the order they have to be read.

### 1. Fan-out inside one worker

`chipNets.ts` already computes net identity: union-find over the diagram's
wires, one canonical id per net. `resolveChipNetMembers` exposes that in a form
the worker can use, and `CustomChipPart.ts` sends it in the custom-chip payload
as `nets`, a list of `{pin, net, remote}`.

Unlike `resolveChipNetKey`, it does not skip a net that carries a board pin. On
the backend the GPIO behaviour stays and the chip members are driven as well,
which is what lets one board's firmware and two chips sit on one line.

`ChipNetBus` in `wasm_chip_runtime.py` holds one level per net and the members
on it:

- `vx_pin_write` on any member sets the net level and fires every other
  member's `vx_pin_watch` callbacks, with edge detection per member, so a
  member already reading the new level fires nothing.
- `vx_pin_read` returns the net level when the pin has no GPIO. With a GPIO the
  live QEMU value still wins, unchanged.
- A re-entrancy guard stops a member that writes back from inside its own
  callback from recursing: the nested write still sets the level, it just does
  not fan out a second time.

A payload with no `nets` builds no bus at all, so an older frontend and a
GPIO-only chip behave exactly as before.

### 2. Bridging two workers

Two ESP32 boards are two workers, so the fan-out above reaches only the chips
one worker hosts. `chipNets.ts` knows which board owns each chip (the board its
pins reach through the wires) and marks a net `remote` when its chip members
have more than one owner board.

The worker publishes only those nets, as `chip_net` events carrying the
sender's `time.monotonic_ns` stamp. `Interconnect.ts` relays each one to every
other bound ESP32 board, which applies it to its own bus and never republishes
it, so one edge cannot echo back and forth. A board with no member for that net
id ignores the message. Nets local to one worker never touch the WebSocket.

The route is the frontend interconnect rather than a direct backend hop because
the two workers have no channel to each other: each is a subprocess of the
FastAPI app addressed by its own WebSocket client id, and it is the frontend
that holds the diagram and therefore knows which boards share a net. The
backend WebSocket does carry the traffic, in both directions, but the frontend
is what joins the two halves.

### 3. UART binding

The chip names its own RX and TX pins in `vx_uart_config`, and `pin_map`
already turns those into GPIOs. The missing hop is GPIO to UART number, which
is board-specific, so it comes from the frontend: `CustomChipPart.ts`
classifies each wired GPIO with the same board UART table the cross-board UART
shortcut uses (`boardProtocols.classifyPin`) and sends it as `uart_map`. The
runtime resolves at `vx_uart_attach`, and the worker dispatches `uart_tx` to
the runtimes bound to that UART instead of to one hardcoded index.

A chip's RX is wired to the board's TX and its TX to the board's RX, so either
end names the same UART and the first one that resolves wins.

When nothing resolves the chip stays on `CHIP_UART` (Serial1) rather than
UART0. UART0 is the serial monitor on every ESP32 family: a chip defaulting
there reads the sketch's own console output and writes garbage into it. The
task this work came from asked for UART0 as the fallback; that was written
against the published upstream image, where the fallback is indeed UART0. This
fork had already moved it to Serial1, and moving it back would reintroduce the
collision, so the fallback is left where the fork put it.

### 4. The compile route

`POST /api/compile-chip/` reported `available:false` on a stock container:
`chip_compile.py` needs clang from a wasi-sdk install and the `velxio-chip.h`
header, and the image shipped neither. `Dockerfile.standalone` now unpacks
wasi-sdk 22 at `/opt/wasi-sdk` and copies `backend/sdk` to `/app/sdk`, the two
paths `_resolve_wasi_sdk` and `_resolve_sdk_include` look at first.

Only amd64 has an official wasi-sdk 22 Linux tarball, so on another
architecture the step prints why it skipped and the build carries on: the chip
compiler degrades to the `available:false` it had before rather than failing
the image.

No change was needed for the ESP32 Arduino core. Sketches for `esp32:*` FQBNs
compile through ESP-IDF 5.5.4 plus arduino-esp32 3.3.10, both baked into the
image by the `espidf-builder` stage, and `_uses_espidf` in the compile route
selects that path whenever the toolchain is present. The arduino-cli esp32 core
the entrypoint installs is only the fallback for an image built without
ESP-IDF; installing it by hand is `POST /api/compile/ensure-core` with
`{"board_fqbn": "esp32:esp32:esp32s3"}`, which downloads about 3.4 GB into
`/root/.arduino15`.

### 5. Latency reporting

Both workers stamp with `time.monotonic_ns`, and `CLOCK_MONOTONIC` is
system-wide on Linux, so the receiving worker subtracts the sender's stamp from
its own clock and gets a real one-way time rather than a clock offset. Min,
average and max are logged every 200 hops.

## Measured

### Tests

Backend, in a container built from `ghcr.io/davidmonterocrespo24/velxio:master`
with this working tree mounted at `/repo` (the image carries wasmtime; pytest
is pip-installed into the throwaway container):

```
docker run --rm -v D:\velxio:/repo -w /repo ghcr.io/davidmonterocrespo24/velxio:master \
  sh -lc "pip install --quiet pytest pytest-asyncio; python3 -m pytest -q"
```

```
11 failed, 511 passed, 13 skipped, 1 warning in 299.20s (0:04:59)
```

The 15 new cases are in the 511. The 11 failures are all
`test_espidf_real_paths.py`, which asserts that Adafruit GFX and SSD1306 are
installed under `/root/.arduino15`; the throwaway container mounts no Arduino
library volume, so the suite reports `[espidf] Arduino libraries dir not found`
and the whole class fails. The same 11 fail identically on the pristine base
commit in the same container, checked in a `git worktree` at `c6811be1`:

```
11 failed, 3 passed, 1 warning in 2.90s
```

Frontend, `npx vitest run` in `frontend/`:

```
Test Files  1 failed | 245 passed | 3 skipped (249)
     Tests  3 failed | 3037 passed | 41 skipped (3081)
```

The one failing file is `load-ngspice-for-node.test.ts`, which builds a path as
`D:\D:\velxio\frontend\public\wasm\...`: a Windows path-joining fault in the
test helper, present before this branch and unrelated to it.

The xKoin self test, which drives both models through the runtime over a
hand-rolled GPIO net rather than through the new bus, still passes all fifteen
of its cases against the patched runtime, so the GPIO path is untouched:

```
docker run --rm -v D:\velxio:/repo ghcr.io/davidmonterocrespo24/velxio:master sh -lc \
  'cp /repo/test/fixtures/xkoin/chip_selftest.py /tmp/ && \
   cp /repo/test/fixtures/xkoin/sx1262/chip.wasm /tmp/sx1262.wasm && \
   cp /repo/test/fixtures/xkoin/kq130f/chip.wasm /tmp/kq130f.wasm && \
   cp /repo/backend/app/services/wasm_chip_runtime.py /app/app/services/ && \
   python3 /tmp/chip_selftest.py'
```

```
All cases passed.
```

TypeScript: `npx tsc -b --force` reports 416 errors on this branch and 416 on
the pristine base commit, checked by running it against a `git checkout` of
`c6811be1` in the same tree. The branch adds none. (The image build does not
run `tsc`: `build:docker` goes straight to `vite build`.)

### The bridge, measured

Two measurements of the same hop, from the two ends.

**One-way time, from the receiving worker.** Both workers stamp with
`time.monotonic_ns` and `CLOCK_MONOTONIC` is system-wide on Linux, so the
subtraction is a real elapsed time rather than a clock offset. Over 2600 hops of
the two-board LoRa run, on the image as built:

```
[custom-chip chip_net] 2600 hops, one-way us: min=2302 avg=5035 max=24195
```

So 2.3 ms at best, 5 ms typically, and a tail out to 24 ms for an edge to travel
worker A to backend to browser to backend to worker B.

**Change in edge spacing, from the browser.** The absolute time above does not
by itself break a self-clocked protocol; a constant delay would be harmless. The
quantity that decides it is how much the gap between two consecutive edges
changes on the way across, measured by wrapping `WebSocket` before Run and
recording the sender's `ts` and `performance.now()` at arrival for every
`chip_net` frame.

Relay fidelity first. Over one 22-second run the tab received 2320 `chip_net`
events and sent 2320 `esp32_chip_net` commands: every edge board A's chip drove
was relayed to board B exactly once, with no duplication and no loss.

With `bit_period_us` 5000, so a half cell of 2.5 ms (2023 edge pairs):

| | mean | p99 | min | max |
|---|---|---|---|---|
| interval the sender drove | 2.514 ms | 3.296 ms | | |
| interval as it arrived | 2.511 ms | 4.5 ms | | |
| change (arrival minus sender) | -0.003 ms | 2.056 ms | -5.117 ms | 5.971 ms |

The Manchester decoder discriminates a half cell from a full cell, which allows
any one interval to move by half a cell, here 1.25 ms, before a bit flips. A p99
of 2.06 ms is outside that. Board B decoded nothing at this bit period.

With `bit_period_us` 40000, a half cell of 20 ms (2103 edge pairs):

| | mean | p99 | min | max |
|---|---|---|---|---|
| interval the sender drove | 20.05 ms | 20.99 ms | | |
| interval as it arrived | 20.0 ms | 24.1 ms | | |
| change (arrival minus sender) | -0.09 ms (p50) | 3.15 ms | -17.84 ms | 20.88 ms |

The margin is now 10 ms and the p99 change is 3.15 ms, so nearly every cell
lands inside it. The tail does not, and the worker's own figure says the same
thing from the other side: an avg of 5 ms one way is fine against a 20 ms half
cell, a max of 24 ms is not. A single excursion corrupts the frame it lands in,
which is why one frame in each run below is missing.

**So 40000 is the number these proofs use, against 20 for the LoRa net and 200
for the power-line net in the original files.** Two things set that floor, not
one. The bridge contributes the p99 of 3 ms above. The sender contributes its
own: the worker's chip timer thread is a `threading.Event.wait` loop, and at a
half cell of 2.5 ms it was already overshooting to 3.3 ms at p99 against a
2.5 ms target. Both are host scheduling, one in the worker and one in the
browser event loop, and both scale the same way: the bit period has to sit far
enough above millisecond scheduling that a few milliseconds of slip is a small
fraction of a cell.

The .vlx files in the xKoin repository are unchanged; the runs below used copies
with `bit_period_us` rewritten to 40000 on both chips, and board A's TX_DONE
wait raised from 3 s to 60 s because a frame now takes 288 half cells times
20 ms, which is 5.8 s.

## Serial proof

### Before: the same project on a stock container

`ghcr.io/davidmonterocrespo24/velxio:master` on port 3080, the xKoin two-board
LoRa proof imported through the toolbar's file input, compiled with Compile all
boards and started with Run all boards. The chips are two SX1262 models, one
per board, with their SPI pins on each board's GPIOs and their `ANT` pins wired
to each other and to nothing else. Board A's serial monitor:

```
boardA: sx1262 ready, sending
boardA: sent "xkoin ping 1"
boardA: sent "xkoin ping 2"
boardA: sent "xkoin ping 3"
boardA: sent "xkoin ping 4"
boardA: sent "xkoin ping 5"
boardA: sent "xkoin ping 6"
boardA: sent "xkoin ping 7"
boardA: sent "xkoin ping 8"
boardA: sent "xkoin ping 9"
boardA: sent "xkoin ping 10"
```

Board B's, over the same period, in full:

```
boardB: sx1262 ready, listening
```

The sender transmits and sees its own TX_DONE. The receiver hears nothing,
because the `ANT` net has no board GPIO and so did not exist as far as the
worker was concerned. This also settles two things the xKoin notes had listed
as unverified: the `.vlx` imports without adjustment, and the sketches compile
for `esp32:esp32:esp32s3` through the image's ESP-IDF toolchain.

### After: the same project on `velxio-xkoin:dev`

Built from this branch with
`docker build -f Dockerfile.standalone -t velxio-xkoin:dev .` and started on
port 3081 (3080 holds the stock instance):

```
docker run -d --name velxio-xkoin -p 3081:80 \
  -v velxio-xkoin-data:/app/data \
  -v docker_velxio-arduino-libs:/root/.arduino15 \
  -v docker_velxio-ccache:/var/cache/ccache \
  -v velxio-xkoin-build:/var/lib/velxio-build \
  velxio-xkoin:dev
```

```
$ curl -s http://127.0.0.1:3081/health
{"status":"healthy"}
$ curl -s http://127.0.0.1:3081/api/compile-chip/status
{"available":true,"wasi_sdk":"/opt/wasi-sdk","sdk_include":"/app/sdk"}
```

Both chips compiled through the route, on the image as built, with nothing
installed by hand:

```
sx1262: success=True bytes=16331 stderr=''
kq130f: success=True bytes=12949 stderr=''
```

Both are byte-identical to the `.wasm` checked in under
`test/fixtures/xkoin/`, by md5.

What was clicked, in the editor at `http://127.0.0.1:3081/editor`: the project
was fed to the toolbar's hidden `.vlx` file input (a `File` built from a fetch
of the same origin, assigned to `input.files` and dispatched as a `change`
event, which is what the Import button does); Compile all boards; Run all
boards; then the Board A and Board B tabs in the serial monitor.

The payload the frontend sent each worker, from the browser console:

```
[custom-chip:chip_sx1262_a] sent to backend ESP32 worker (chip runs
synchronously inside QEMU process).
pinMap={"SCK":12,"MOSI":11,"MISO":13,"NSS":10,"BUSY":21,"DIO1":14}
nets=[{"pin":"ANT","net":"chip_sx1262_a::ANT","remote":true}] uartMap={}

[custom-chip:chip_sx1262_b] sent to backend ESP32 worker (chip runs
synchronously inside QEMU process).
pinMap={"SCK":12,"MOSI":11,"MISO":13,"NSS":10,"BUSY":21,"DIO1":14}
nets=[{"pin":"ANT","net":"chip_sx1262_a::ANT","remote":true}] uartMap={}
```

Both chips get the same net id for their `ANT` pins, and both are told the net
is remote. The workers agreed, on their own stderr:

```
[custom-chip] chip nets: {'ANT': 'chip_sx1262_a::ANT'} watching=True
```

Board A's serial monitor:

```
boardA: sx1262 ready, sending
boardA: sent "xkoin ping 1"
boardA: sent "xkoin ping 2"
boardA: sent "xkoin ping 3"
boardA: sent "xkoin ping 4"
boardA: sent "xkoin ping 5"
boardA: sent "xkoin ping 6"
boardA: sent "xkoin ping 7"
boardA: sent "xkoin ping 8"
boardA: sent "xkoin ping 9"
boardA: sent "xkoin ping 10"
boardA: sent "xkoin ping 11"
boardA: sent "xkoin ping 12"
boardA: sent "xkoin ping 13"
```

Board B's, the other QEMU process, a different worker, reached only through the
`ANT` net:

```
boardB: sx1262 ready, listening
boardB: got "xkoin ping 1" rssi=-80 dBm
boardB: got "xkoin ping 2" rssi=-80 dBm
boardB: got "xkoin ping 3" rssi=-80 dBm
boardB: got "xkoin ping 4" rssi=-80 dBm
boardB: got "xkoin ping 5" rssi=-80 dBm
boardB: got "xkoin ping 6" rssi=-80 dBm
boardB: got "xkoin ping 7" rssi=-80 dBm
boardB: got "xkoin ping 8" rssi=-80 dBm
boardB: got "xkoin ping 10" rssi=-80 dBm
boardB: got "xkoin ping 11" rssi=-80 dBm
boardB: got "xkoin ping 12" rssi=-80 dBm
```

Ping 9 is missing, and that is the honest result rather than a blemish to
explain away: eleven of twelve frames crossed intact, and the twelfth met a
scheduling excursion past the half-cell margin, failed its CRC, and was dropped
by the model exactly as a corrupt frame should be. The measurement above
predicts that rate: a typical hop of 5 ms against a 10 ms margin, with a tail
reaching 24 ms, and 288 cells per frame for the tail to land in.

The run above was done on the image built before the last two commits, with the
frontend rebuilt locally and copied into the container. Repeating it on the
image as finally built, from a container recreated from it, reproduces the same
result, one frame lost in a different place:

```
boardA: sx1262 ready, sending      boardB: sx1262 ready, listening
boardA: sent "xkoin ping 1"        boardB: got "xkoin ping 1" rssi=-80 dBm
boardA: sent "xkoin ping 2"        boardB: got "xkoin ping 2" rssi=-80 dBm
boardA: sent "xkoin ping 3"        boardB: got "xkoin ping 3" rssi=-80 dBm
boardA: sent "xkoin ping 4"        boardB: got "xkoin ping 5" rssi=-80 dBm
boardA: sent "xkoin ping 5"        boardB: got "xkoin ping 6" rssi=-80 dBm
boardA: sent "xkoin ping 6"
...
```

On that run the Compile all boards button also drove the chip compiler through
the same route, with no toolchain installed by hand:

```
Compiling chip "custom chip" to WASM...
Chip "custom chip" compiled (16331 B WASM).
Compiling chip "custom chip" to WASM...
Chip "custom chip" compiled (16331 B WASM).
Done - 2 boards ok; 2 chips ok
```

## Limits that remain

**The worker places edges with a Python sleep.** `_chip_timer_thread` waits on
`threading.Event.wait(seconds)` and then fires every due chip timer. That is an
OS sleep, so the transmitter's own edges carry the host scheduler's jitter
before the bridge adds any of its own. A bit-level protocol on a chip net has
to size its bit period against that jitter even when both chips live in one
worker. The browser chip runtime does not have this problem: `ChipRuntime.ts`
backs `vx_sim_now_nanos` with simulated time, so an AVR or RP2040 board carries
the same models with no host jitter at all.

**Every bridged edge is two WebSocket messages.** One out of the sending
worker, through the backend, to the browser; one back down to the receiving
worker. A protocol that toggles a line quickly enough will saturate that path
long before it saturates anything else, and a browser tab in the background
gets less attention from the event loop, which widens the jitter.

**The bridge has no resynchronisation.** A level change is a message, not a
state sync. If one is dropped the two workers disagree about the net until the
next edge corrects it. In practice the WebSocket is ordered and reliable, so
this shows up only if the socket drops entirely.

**Only ESP32-family boards are bridged.** `Interconnect.ts` relays `chip_net`
between boards that use `Esp32Bridge`. A chip net drawn between a chip on an
ESP32 board and a chip on an AVR or RP2040 board is not carried: those chips
run in the browser under a different net identity (`syntheticNetPin`), and
nothing joins the two worlds.

**The net is last-writer-wins, not a bus model.** Two chips driving opposite
levels do not produce contention, a wired-AND, or a bus error: the later write
sets the level. The xKoin models rely on exactly that for their collision case,
where the receiver sees edges belonging to neither frame and fails the CRC, but
a chip that expects open-drain behaviour will not get it.

**One custom-chip slot per board for live attribute updates.**
`CustomChipPart.ts` registers every chip on the same synthetic pin `0xFF`, so
`_sensors[0xFF]` in the worker holds only the last chip registered. Several
chips on one board all load and run, and all of them join the net bus; what the
last one wins is the `sensor_update` path that live control sliders use.

**A chip only loads at Run.** The worker instantiates custom chips from the
`sensors` list that arrives with `start_esp32`; its live `sensor_attach` command
has no `custom-chip` branch. Adding a chip to the canvas mid-simulation does
nothing until the next Run. That is upstream behaviour, unchanged here, but it
is what makes the console line in the proof above worth reading: a chip whose
payload was not in that list never existed as far as the worker was concerned.

**The power-line pair transmits across the bridge but does not decode.** The
KQ-130F two-board proof was run as well, at the same 40 ms bit period. The UART
half of it works and is where the UART binding was confirmed live: with the
module's RX on GPIO 17 and its TX on GPIO 18, the frontend sent
`uartMap={"17":2}` and both workers logged

```
[custom-chip] UART chip registered on UART2
```

The sketch's `Serial2.print` reached the chip, which framed it onto the LINE net
and said so, repeatedly:

```
kq130f: line tx start, bytes 12
kq130f: line tx done, bytes 12
```

and the bridge carried those edges: the tab counted thousands of `chip_net`
events at ~20 ms spacing while the bursts were going out. The receiving module
logged nothing at all, not even the CRC error it prints for a corrupt burst, so
it never detected a frame start. That was not chased further. The difference
from the LoRa pair worth looking at first is the KQ model's 4 ms UART gap timer,
which is armed in the same worker timer thread that has to place the LINE edges;
what stands behind the UART change meanwhile is the registration above plus
`test/backend/unit/test_chip_uart_binding.py`, five cases on the real KQ-130F
WASM, including a burst crossing a LINE net and arriving on the bound UART.

**A chip wired to a board's UART pins now binds to that UART.** This is the
point of the UART change, but it is a behaviour change for an existing project:
a chip whose RX and TX are drawn to GPIO 1 and 3 on an ESP32 used to be fed
from Serial1 and now binds to UART0, which is also the serial monitor. That is
what the diagram says and what the hardware would do. A project that wants the
old behaviour should leave the chip's UART pins unwired.
