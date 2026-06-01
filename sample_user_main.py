# Z-Bot phase 2.8 BLE-flash spike — sample user_main.py
#
# Hand-written (NOT generated). Its only job is to be an OBSERVABLE proof that a
# Web Bluetooth upload landed and the robot rebooted into the new program:
#   - OLED shows a "Zbot" banner + a live loop counter
#   - a brief, safe forward nudge then stop (you see the motors twitch)
#   - ToF distance on port 1 if a sensor is attached (shows "--" otherwise)
#
# API surface matches the runtime ZBot facade (display / notify / drive / stop /
# tof) — see Zebra-VScode-Flasher/resources/runtime/main.py.

import uasyncio as asyncio


async def main(zbot):
    zbot.display("Zbot", "uploaded OK")
    zbot.notify("phase-2.8 sample running")

    # brief, safe motion so a successful flash is visible on the bench
    zbot.drive(35, 0)
    await asyncio.sleep_ms(600)
    zbot.stop()

    count = 0
    while True:
        count += 1
        distance = zbot.tof(1)
        if distance is None:
            zbot.display("Zbot", "loop {}".format(count), "tof: --")
        else:
            zbot.display("Zbot", "loop {}".format(count), "tof: {} mm".format(distance))
        await asyncio.sleep_ms(500)
