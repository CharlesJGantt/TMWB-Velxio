#!/usr/bin/env python3
"""Apply the ESP32 gpio_routing fix to an esp32_worker.py that does not have it.

Why: on the stock upstream Docker image the QEMU ESP32 worker never emits
`gpio_routing` events (the libqemu GPIO-matrix callback updates the
SignalRouter before the poll thread diffs it), so LEDC PWM never reaches its
pin and servos, dimmed LEDs and buzzers do nothing. See the fix commit
"fix(esp32): emit gpio_routing events so LEDC PWM reaches its pin".

This script makes the same two edits as that commit, by text replacement, so it
works on image builds whose line numbers differ from this tree. It is
idempotent and refuses to touch a file it does not recognise.

Usage (inside a running container, the worker is started fresh per run, so no
restart is needed):

    docker cp apply-esp32-routing-fix.py <container>:/tmp/
    docker exec <container> python3 /tmp/apply-esp32-routing-fix.py \
        /app/app/services/esp32_worker.py
"""
import shutil
import sys

path = sys.argv[1]
src = open(path, encoding="utf-8").read()

if "_emitted_routes" in src:
    print("already applied:", path)
    sys.exit(0)

a1 = "    _signal_router = SignalRouter()\n"
b1 = (
    "    _signal_router = SignalRouter()\n"
    "    # Routes already announced to the frontend as `gpio_routing` events.\n"
    "    # Kept separate from `_signal_router` on purpose: `_on_gpio_matrix` updates\n"
    "    # the router synchronously, so the router alone cannot tell the poll what\n"
    "    # still needs to be emitted.\n"
    "    _emitted_routes: dict[int, int] = {}\n"
)
a2 = (
    "            changed, cleared = _signal_router.replace_snapshot(snapshot)\n"
    "            for gpio_pin, signal_id in changed:\n"
)
b2 = (
    "            # Diff against what was last EMITTED. The libqemu GPIO-matrix\n"
    "            # callback (_on_gpio_matrix) updates `_signal_router` as soon as\n"
    "            # the firmware routes a pin, so by the time this poll runs the\n"
    "            # router already equals the chip's table and replace_snapshot()\n"
    "            # reports no change. No `gpio_routing` event was ever sent, the\n"
    "            # frontend's mirror stayed empty, and every LEDC consumer (servo,\n"
    "            # dimmed LED, buzzer) never received its PWM.\n"
    "            changed = [(g, sid) for g, sid in snapshot.items()\n"
    "                       if _emitted_routes.get(g) != sid]\n"
    "            cleared = [g for g in _emitted_routes if g not in snapshot]\n"
    "            _signal_router.replace_snapshot(snapshot)  # keep the router in sync\n"
    "            _emitted_routes.clear()\n"
    "            _emitted_routes.update(snapshot)\n"
    "            for gpio_pin, signal_id in changed:\n"
)

if src.count(a1) != 1 or src.count(a2) != 1:
    sys.exit("unrecognised esp32_worker.py (expected anchors not found exactly once); not modified")

shutil.copy(path, path + ".orig-before-routing-fix")
open(path, "w", encoding="utf-8", newline="").write(src.replace(a1, b1).replace(a2, b2))
print("patched:", path, "(backup:", path + ".orig-before-routing-fix)")
